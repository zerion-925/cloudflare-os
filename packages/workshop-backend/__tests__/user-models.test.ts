import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { AiModelConfig } from "@gadgets/workshop-shared/api";
import type { UserDurableObject } from "../src/user.js";
import { getModel } from "../src/ai-models.js";
import { getModelTokenLimits } from "../src/agent-compaction.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

const PROFILE = { type: "agent" as const, id: "my-model", name: "My Model" };
const CONFIG: AiModelConfig = {
  provider: "openai",
  model: "my-model",
  apiToken: "sk-secret",
  apiUrl: "https://proxy.example/v1",
  extraHeaders: { "X-Proxy-Key": "proxy-secret", "X-Empty": "" },
};

type ModelMethods = Pick<UserDurableObject, "addModel" | "getModelConfig" | "updateModel">;

let userCounter = 0;
async function userWithModel() {
  const stub = env.TEST_USER.getByName(`user-models-${++userCounter}`);
  // Calls go through runInDurableObject rather than the stub's RPC, whose rejections workerd
  // reports as uncaught exceptions even once the test has handled them.
  const inDo = <T>(f: (user: UserDurableObject) => Promise<T>) => runInDurableObject(stub, f);
  const user: ModelMethods = {
    addModel: (...args) => inDo(u => u.addModel(...args)),
    getModelConfig: (...args) => inDo(u => u.getModelConfig(...args)),
    updateModel: (...args) => inDo(u => u.updateModel(...args)),
  };
  const stored = (id: string) => inDo(async u =>
      (u as unknown as { storage: { aiModels: { get(id: string): unknown } } }).storage.aiModels.get(id));
  await user.addModel(PROFILE, CONFIG);
  return { user, stored };
}

describe("UserDurableObject model editing", () => {
  it("replaces secrets that are supplied, and drops headers that are omitted", async () => {
    const { user, stored } = await userWithModel();
    await user.updateModel(PROFILE, {
      ...CONFIG, apiToken: "sk-new", extraHeaders: { "X-Proxy-Key": null, "X-New": "v" },
    });
    expect(await stored(PROFILE.id)).toEqual({
      profile: PROFILE,
      config: { ...CONFIG, apiToken: "sk-new", extraHeaders: { "X-Proxy-Key": "proxy-secret", "X-New": "v" } },
    });
  });

  it("refuses to keep a secret for a header that isn't stored", async () => {
    const { user } = await userWithModel();
    await expect(user.updateModel(PROFILE, { ...CONFIG, extraHeaders: { "x-proxy-key": null } }))
        .rejects.toThrow("no stored");
  });

  it("refuses to keep secrets when the API URL changes", async () => {
    const { user, stored } = await userWithModel();
    const { config } = await user.getModelConfig(PROFILE.id);
    await expect(user.updateModel(PROFILE, { ...config, apiUrl: "https://attacker.example" }))
        .rejects.toThrow("re-enter");
    await expect(user.updateModel(PROFILE, { ...config, apiUrl: undefined }))
        .rejects.toThrow("re-enter");
    expect(await stored(PROFILE.id)).toEqual({ profile: PROFILE, config: CONFIG });

    // Supplying every secret afresh is fine.
    const moved = { ...CONFIG, apiUrl: "https://other.example", apiToken: "sk-2", extraHeaders: {} };
    await user.updateModel(PROFILE, moved);
    expect(await stored(PROFILE.id)).toEqual({ profile: PROFILE, config: moved });
  });

  it("refuses to change the provider or model", async () => {
    const { user } = await userWithModel();
    const { config } = await user.getModelConfig(PROFILE.id);
    await expect(user.updateModel(PROFILE, { ...config, model: "other" })).rejects.toThrow("can't be changed");
    await expect(user.updateModel(PROFILE, { ...CONFIG, provider: "anthropic" })).rejects.toThrow("can't be changed");
  });

  it("refuses to edit a model that doesn't exist", async () => {
    const { user } = await userWithModel();
    await expect(user.getModelConfig("nope")).rejects.toThrow("No such");
    await expect(user.updateModel({ ...PROFILE, id: "nope" }, CONFIG)).rejects.toThrow("No such");
  });

  it("copies withheld secrets when cloning to the same endpoint", async () => {
    const { user, stored } = await userWithModel();
    const { config } = await user.getModelConfig(PROFILE.id);
    const clone = { type: "agent" as const, id: "clone", name: "Clone" };
    await user.addModel(clone, { ...config, model: "clone" }, PROFILE.id);
    expect(await stored("clone")).toEqual({ profile: clone, config: { ...CONFIG, model: "clone" } });
  });

  it("refuses to clone secrets to another endpoint or over an existing model", async () => {
    const { user } = await userWithModel();
    const { config } = await user.getModelConfig(PROFILE.id);
    const clone = { type: "agent" as const, id: "clone", name: "Clone" };
    await expect(user.addModel(clone, { ...config, provider: "anthropic" }, PROFILE.id))
        .rejects.toThrow("re-enter");
    await expect(user.addModel(PROFILE, config, PROFILE.id)).rejects.toThrow("already exists");
    await expect(user.addModel(clone, config, "nope")).rejects.toThrow("No such");
  });

  it("refuses to add over an existing model", async () => {
    const { user, stored } = await userWithModel();
    await expect(user.addModel({ ...PROFILE, name: "Other" }, { ...CONFIG, apiToken: "sk-other" }))
        .rejects.toThrow("already exists");
    expect(await stored(PROFILE.id)).toEqual({ profile: PROFILE, config: CONFIG });
  });

  it("requires every secret when adding without a source", async () => {
    const { user } = await userWithModel();
    const clone = { type: "agent" as const, id: "clone", name: "Clone" };
    await expect(user.addModel(clone, { ...CONFIG, apiToken: null })).rejects.toThrow("required");
  });
});

describe("deployment-managed user models", () => {
  const ID = "managed:cliproxy:gpt-5.5";
  const CATALOG = [{ model: "gpt-5.5", name: "CLIProxy GPT-5.5" }];

  it("resolves independently for two empty users without storing credentials or enabling quick tasks", async () => {
    for (const name of ["shared-user-a", "shared-user-b"]) {
      const stub = env.TEST_USER.getByName(name);
      await runInDurableObject(stub, async user => {
        const impl = user as unknown as { env: Cloudflare.Env; storage: {
          aiModels: { list(): Iterable<unknown> };
        } };
        impl.env = { ...impl.env, SHARED_AI_MODELS: CATALOG, CLIPROXY_API_KEY: "synthetic-shared" };
        const [profile] = await user.listModels();
        expect(profile).toEqual({ type: "agent", id: ID, name: "CLIProxy GPT-5.5" });
        expect(await user.getQuickModel()).toBeNull();
        expect((await user.getChatContext(null)).aiModel).toBeUndefined();
        expect((await user.getChatContext(ID)).quickModel).toBeUndefined();
        expect((await user.getExternalMessageChatContext(null)).aiModel?.profile).toEqual(profile);
        await user.setPreferredModel(ID);
        await user.setQuickModel(ID);
        const context = await user.getChatContext(ID);
        expect(await user.getPreferredModel()).toBe(ID);
        expect(await user.getQuickModel()).toBe(ID);
        expect(context.quickModel).toEqual(context.aiModel?.config);
        expect(getModelTokenLimits(context.aiModel!.config))
            .toEqual({ inputBudget: 123904, maxOutputTokens: 4096 });
        expect(JSON.stringify(context)).not.toContain("synthetic-shared");
        expect([...impl.storage.aiModels.list()]).toEqual([]);

        // Stored selections and facet props survive serialization without a credential.
        const restored = JSON.parse(JSON.stringify(context.aiModel!.config));
        expect(getModel(impl.env, restored, context.profile).model.id).toBe("gpt-5.5");
        impl.env.SHARED_AI_MODELS = [];
        expect(await user.listModels()).toEqual([]);
        await expect(user.getChatContext(ID)).rejects.toThrow("No such model");
        await expect(user.getExternalMessageChatContext(ID)).rejects.toThrow("No such model");
        expect(() => getModel(impl.env, restored, context.profile)).toThrow("unavailable");
        expect(await user.getQuickModel()).toBeNull();
        expect(await user.getPreferredModel()).toBe(ID); // no destructive preference migration
      });
    }
  });

  it("protects read/edit/delete/clone and routing inputs even when the catalog is disabled", async () => {
    const { user } = await userWithModel();
    const stub = env.TEST_USER.getByName(`user-models-${userCounter}`);
    await runInDurableObject(stub, async u => {
      for (const id of [ID, "managed:unknown:anything"]) {
        await expect(u.addModel({ ...PROFILE, id }, CONFIG)).rejects.toThrow("read-only");
        await expect(u.updateModel({ ...PROFILE, id }, CONFIG)).rejects.toThrow("read-only");
        await expect(u.getModelConfig(id)).rejects.toThrow("read-only");
        await expect(u.deleteModel(id)).rejects.toThrow("read-only");
        await expect(u.addModel({ ...PROFILE, id: "clone" }, CONFIG, id)).rejects.toThrow("read-only");
        await expect(u.setQuickModel(id)).rejects.toThrow("No such");
      }
    });
    for (const fields of [{ managedModelId: ID }, { userGateway: {} }, { headers: {} },
        { model: ID }, { managedModelId: undefined }]) {
      const config = { ...CONFIG, ...fields };
      await expect(user.addModel({ ...PROFILE, id: "forged" }, config)).rejects.toThrow("read-only");
      await expect(user.updateModel(PROFILE, config)).rejects.toThrow("read-only");
    }
    await expect(user.addModel({ ...PROFILE, id: "forged", managedModelId: ID } as typeof PROFILE,
        CONFIG)).rejects.toThrow("read-only");
  });

  it("preserves personal same-model identity, order, credentials, and saved preferences", async () => {
    const stub = env.TEST_USER.getByName(`user-models-${++userCounter}`);
    await runInDurableObject(stub, async user => {
      const impl = user as unknown as { env: Cloudflare.Env };
      const personal = { ...PROFILE, id: "gpt-5.5" };
      await user.addModel(personal, { ...CONFIG, model: "gpt-5.5" });
      await user.setPreferredModel(personal.id);
      impl.env = { ...impl.env, SHARED_AI_MODELS: CATALOG };
      expect((await user.listModels()).map(model => model.id)).toEqual([personal.id, ID]);
      expect((await user.getExternalMessageChatContext(null)).aiModel?.profile.id).toBe(personal.id);
      expect((await user.getChatContext(personal.id)).aiModel?.config.apiToken).toBe(CONFIG.apiToken);
      await expect(user.getModelConfig(ID)).rejects.toThrow("read-only");
      await user.updateModel(personal, { ...CONFIG, model: "gpt-5.5", apiToken: "replaced" });
      await user.deleteModel(personal.id);
      expect((await user.listModels()).map(model => model.id)).toEqual([ID]);
    });
  });
});

describe("UserDurableObject hidden gateway models", () => {
  const HIDDEN_ID = "claude-opus-5";

  // Every call runs in one invocation, since the gateway env is only overridden on this instance.
  function inGatewayUser<T>(f: (user: UserDurableObject) => Promise<T>) {
    const stub = env.TEST_USER.getByName(`user-models-${++userCounter}`);
    return runInDurableObject(stub, user => {
      const impl = user as unknown as { env: Cloudflare.Env };
      impl.env = {
        ...impl.env,
        CF_AI_GATEWAY: "platform-gateway",
        CF_AI_GATEWAY_ACCOUNT_ID: "account-id",
        CF_AI_GATEWAY_API_TOKEN: "gateway-token",
        CF_AI_GATEWAY_PROVIDERS: "anthropic",
      };
      return f(user);
    });
  }

  it("refuses to add a model that a hidden gateway model would shadow", () => inGatewayUser(async user => {
    await expect(user.addModel({ ...PROFILE, id: HIDDEN_ID }, { ...CONFIG, model: HIDDEN_ID }))
        .rejects.toThrow("already exists");
  }));

  it("keeps an existing chat on a hidden model", () => inGatewayUser(async user => {
    const context = await user.getExternalMessageChatContext(HIDDEN_ID);
    expect(context.aiModel?.profile.id).toBe(HIDDEN_ID);
  }));

  it("starts a new conversation on the first offered model when the preference is hidden",
      () => inGatewayUser(async user => {
    await user.setPreferredModel(HIDDEN_ID);
    const [first] = await user.listModels();
    expect(first.id).not.toBe(HIDDEN_ID);
    const context = await user.getExternalMessageChatContext(null);
    expect(context.aiModel?.profile.id).toBe(first.id);
  }));
});
