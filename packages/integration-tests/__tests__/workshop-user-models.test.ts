import { afterAll, beforeAll, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type { AiModelConfig } from "@gadgets/workshop-shared/api";
import { loadAllChatHistory, openAgentSession } from "../src/agent-session.js";
import { type Harness, startHarness, TEST_GATEKEEPER_DIR, TEST_GATEKEEPER_BINDING, TEST_VENDOR_ID } from "../src/harness.js";
import { scriptedChatCompletions } from "../src/mock-model.js";
import { type Handler, NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, nextUsernames, signUp, waitForIdleChat, waitFor, withOwnerWorkspace,
  restartWorkspace, RpcTarget, WorkpieceRecorder, stubFor,
} from "../src/rpc-client.js";

const MODEL_ORIGIN = "https://model-secrets.test";
const TOKEN = "model-token-secret";
const HEADER_SECRET = "header-secret";

const model = scriptedChatCompletions([{ text: "Secrets retained." }]);
const providerRequests: { authorization: string | null; providerSecret: string | null }[] = [];
// The only handler, so a request sent anywhere else is recorded as unmocked.
const recordingHandler: Handler = (url, method, headers, request) => {
  if (url.origin !== MODEL_ORIGIN) return null;
  providerRequests.push({
    authorization: headers.get("authorization"),
    providerSecret: headers.get("x-provider-secret"),
  });
  return model.handler(url, method, headers, request);
};
const SHARED_ID = "managed:cliproxy:gpt-5.5";
const SHARED_KEY = "synthetic-workshop-only-key";
const SHARED_PROFILE = { type: "agent" as const, id: SHARED_ID, name: "CLIProxy GPT-5.5" };
type SharedStep = { text: string } | { tool: string; args: object } | { pending: true } |
  { status: number };
const sharedSteps: SharedStep[] = [];
const sharedRequests: { body: any; headers: Headers }[] = [];
const quickRequests: unknown[] = [];
let responseIndex = 0;

// Bounded Responses SSE fixtures drive the actual SDK/agent, not a mocked getModel implementation.
function responsesStream(step: { text: string } | { tool: string; args: object }): Response {
  const n = ++responseIndex;
  const item = "text" in step
    ? { type: "message", id: `msg_${n}`, role: "assistant", content: [{ type: "output_text", text: step.text }] }
    : { type: "function_call", id: `fc_${n}`, call_id: `call_${n}`, name: step.tool, arguments: JSON.stringify(step.args) };
  const events = [
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [], arguments: "" } },
    "text" in step
      ? { type: "response.output_text.delta", output_index: 0, delta: step.text }
      : { type: "response.function_call_arguments.delta", output_index: 0, delta: JSON.stringify(step.args) },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: `resp_${n}`, status: "completed", output: [item],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
  ];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } });
}

const sharedHandler: Handler = async (url, method, headers, request) => {
  if (url.href !== "https://proxy-api.buchan.cloud/v1/responses" || method !== "POST") return null;
  expect(headers.get("authorization")).toBe(`Bearer ${SHARED_KEY}`);
  const body: any = await request.json();
  expect(body).toMatchObject({ model: "gpt-5.5", store: false, max_output_tokens: 4096 });
  expect(JSON.stringify(body)).not.toContain(SHARED_KEY);
  const prompt = body.input?.[0]?.content?.[0]?.text;
  if (typeof prompt === "string" && (prompt.startsWith("Generate a brief, descriptive title") ||
      prompt.startsWith("Below is the log of a chat session") || prompt.startsWith("Choose a short"))) {
    quickRequests.push(body);
    return responsesStream({ text: "Shared title" });
  }
  sharedRequests.push({ body, headers });
  const step = sharedSteps.shift();
  if (!step) throw new Error("Unexpected shared model request");
  if ("status" in step) return new Response(SHARED_KEY, { status: step.status,
    headers: step.status === 302 ? { Location: "https://credential-trap.test/stolen" } : {} });
  if ("pending" in step) return new Promise<Response>((_resolve, reject) => {
    request.signal.addEventListener("abort", () => reject(new Error("Test request aborted")), { once: true });
  });
  return responsesStream(step);
};
const network = new NetworkInterceptor({ handlers: [recordingHandler, sharedHandler] });

let harness: Harness | undefined;

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    gatekeepers: [{ binding: TEST_GATEKEEPER_BINDING, dir: TEST_GATEKEEPER_DIR }],
    enableGadgetExecution: true,
    patchWorkshop: config => {
      config.vars = { ...config.vars,
        SHARED_AI_MODELS: [{ model: "gpt-5.5", name: SHARED_PROFILE.name }],
        CLIPROXY_API_KEY: SHARED_KEY,
      };
    },
  });
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

it("editing a model keeps its secrets usable without returning them", async () => {
  if (harness === undefined) throw new Error("Workshop harness did not start");
  const [name] = nextUsernames("modelsecrets");
  using publicApi = connect(harness.url);
  using api = await signUp(publicApi, name);
  // Gateway routing ignores a model's own credentials.
  expect(await api.getAiConfig()).toEqual({ enabled: false, managedModelIds: [SHARED_ID] });

  const PROFILE = { type: "agent" as const, id: "secret-model", name: "Secret model" };
  const config: AiModelConfig = {
    provider: "ollama",
    model: "secret-model",
    apiUrl: MODEL_ORIGIN,
    apiToken: TOKEN,
    extraHeaders: { "X-Provider-Secret": HEADER_SECRET, "X-Empty": "" },
  };
  await api.addModel(PROFILE, config);
  const redacted = { ...config, apiToken: null, extraHeaders: { "X-Provider-Secret": null, "X-Empty": "" } };
  expect(await api.getModelConfig(PROFILE.id)).toEqual({ profile: PROFILE, config: redacted });

  const RENAMED = { ...PROFILE, name: "Renamed secret model" };
  await api.updateModel(RENAMED, { ...redacted, contextWindow: 1000 });
  expect(await api.listModels()).toContainEqual(RENAMED);
  expect(await api.getModelConfig(PROFILE.id))
      .toEqual({ profile: RENAMED, config: { ...redacted, contextWindow: 1000 } });

  await expect(api.updateModel(RENAMED,
      { ...redacted, contextWindow: 1000, apiUrl: "https://attacker.test" }))
      .rejects.toThrow(/since the provider or API URL changed/);

  using ws = await api.newGadget();
  const chatId = await ws.newChat("Prove the saved credentials work.", PROFILE.id);
  await waitForIdleChat(ws, chatId);
  const history = await loadAllChatHistory(before => ws.getChatHistory(chatId, before));
  expect(history.filter(message => message.type === "message" && message.author.type === "agent"))
      .toEqual([expect.objectContaining({ message: "Secrets retained." })]);
  expect(model.requests).toHaveLength(1);
  for (const request of providerRequests) {
    expect(request).toEqual({ authorization: `Bearer ${TOKEN}`, providerSecret: HEADER_SECRET });
  }
});

it("two authenticated accounts use shared text/tools without personal providers and cannot mutate or read it", async () => {
  const [alice, bob] = nextUsernames("sharedalice", "sharedbob");
  for (const name of [alice, bob]) {
    using publicApi = connect(harness!.url);
    using api = await signUp(publicApi, name);
    expect(await api.listModels()).toEqual([SHARED_PROFILE]);
    expect(await api.getAdminApi()).toBeNull();
    expect(await api.getQuickModel()).toBeNull();
    await api.setPreferredModel(SHARED_ID);
    expect(await api.getPreferredModel()).toBe(SHARED_ID);
    const personal: AiModelConfig = { provider: "openai", model: "gpt-5.5", apiToken: "personal" };
    await expect(api.getModelConfig(SHARED_ID)).rejects.toThrow("read-only");
    await expect(api.addModel(SHARED_PROFILE, personal)).rejects.toThrow("read-only");
    await expect(api.updateModel(SHARED_PROFILE, personal)).rejects.toThrow("read-only");
    await expect(api.deleteModel(SHARED_ID)).rejects.toThrow("read-only");
    await expect(api.addModel({ ...SHARED_PROFILE, id: "clone" }, personal, SHARED_ID)).rejects.toThrow("read-only");
    await expect(api.addModel({ ...SHARED_PROFILE, id: "forged" },
      { ...personal, managedModelId: SHARED_ID } as AiModelConfig)).rejects.toThrow();
    const before = sharedRequests.length;
    sharedSteps.push({ tool: "executeCode", args: { code: 'export default function() { console.log("42"); }' } },
      { text: `Hello ${name}` });
    using ws = await api.newGadget();
    const noAgent = await ws.newChat("No agent requested", null);
    await waitForIdleChat(ws, noAgent);
    expect(sharedRequests).toHaveLength(before);
    const chatId = await ws.newChat("Use the shared model", SHARED_ID);
    await waitForIdleChat(ws, chatId);
    const history = await loadAllChatHistory(before => ws.getChatHistory(chatId, before));
    expect(history).toContainEqual(expect.objectContaining({ type: "message", message: `Hello ${name}` }));
    expect(sharedRequests).toHaveLength(before + 2);
    expect(sharedRequests[before + 1].body.input).toContainEqual(expect.objectContaining({
      type: "function_call_output", output: expect.stringContaining("42"),
    }));
    expect(quickRequests).toHaveLength(0);
    expect(JSON.stringify([await api.getAiConfig(), await api.whoami(), await ws.listChats(), history]))
      .not.toContain(SHARED_KEY);
    expect(await api.listModels()).toEqual([SHARED_PROFILE]);
    // Personal same-model registration doesn't collide and remains editable.
    await api.addModel({ ...SHARED_PROFILE, id: "gpt-5.5", name: "Personal" }, personal);
    expect((await api.listModels()).map(p => p.id)).toEqual(["gpt-5.5", SHARED_ID]);
    await api.deleteModel("gpt-5.5");
  }
});

it("admin settings and public config never expose shared credentials", async () => {
  using publicApi = connect(harness!.url);
  using api = await signUp(publicApi, "admin");
  using admin = await api.getAdminApi();
  expect(admin).not.toBeNull();
  expect(JSON.stringify([await admin!.getSettings(), await api.getAiConfig(), await publicApi.getServerConfig()]))
    .not.toContain(SHARED_KEY);
});

it("quick titles and a persisted model binding opt in without serializing a credential", async () => {
  const [name] = nextUsernames("sharedquick");
  using publicApi = connect(harness!.url);
  using api = await signUp(publicApi, name);
  await api.setQuickModel(SHARED_ID);
  expect(await api.getQuickModel()).toBe(SHARED_ID);
  sharedSteps.push({ text: "Chat complete" });
  using ws = await api.newGadget();
  const chatId = await ws.newChat("Name this chat", SHARED_ID);
  await waitForIdleChat(ws, chatId);
  await waitFor("shared quick title", async () => quickRequests.length > 0 || null);
  using binding = await ws.newAiModelGatekeeper(SHARED_ID);
  using session = await binding.openSession() as RpcStub<RpcTarget & { run(options: { prompt: string }): Promise<string> }>;
  sharedSteps.push({ text: "Bound result" });
  expect(await session.run({ prompt: "Use the managed binding" })).toBe("Bound result");
  expect(JSON.stringify(await binding.describe())).not.toContain(SHARED_KEY);
  await api.setQuickModel(null);
  expect(await api.getQuickModel()).toBeNull();
});

it("spawned background calls resume after a real workspace DO restart using only the saved managed ID", async () => {
  const callerCode = `import { DurableObject } from "cloudflare:workers";
    export class Gadget extends DurableObject {
      async dispatch(text) {
        this.agent ??= await this.env.SPAWNER.spawnCallable("Shared task", {
          types: "interface Task { process(text: string): void; }", mainType: "Task",
        });
        await this.agent.process(text);
      }
    }`;
  const before = sharedRequests.length;
  sharedSteps.push(
    { tool: "createGadget", args: { title: "Shared caller", bindingName: "CALLER" } },
    { tool: "writeFile", args: { workpiece: "CALLER", filename: "server.js", content: callerCode } },
    { text: "Caller built" }, { pending: true },
    { text: "First background call resumed" }, { text: "Second background call handled" },
  );
  await using session = await openAgentSession(harness!.url, {
    modelId: SHARED_ID, usernamePrefix: "sharedspawn",
  });
  expect((await session.runTurn("Build a callable agent client")).outcome).toEqual({ status: "completed" });
  await session.acceptChanges();
  let spawnedId = 0;
  await withOwnerWorkspace(harness!.url, session.username, async ws => {
    {
      const pieces = new WorkpieceRecorder();
      using subscriber = stubFor(pieces);
      using _subscription = await ws.subscribeToWorkpieces(subscriber);
      await pieces.loaded;
      const caller = [...pieces.summaries.values()].find(p => p.type === "gadget" && p.title === "Shared caller");
      expect(caller).toBeDefined();
      using spawner = await ws.newAgentSpawnerGatekeeper({ displayName: "Shared spawner", modelId: SHARED_ID, env: {} });
      using gadget = await ws.getGadget(caller!.id);
      await gadget.bind("SPAWNER", await spawner.getId());
      using modelBinding = await ws.newAiModelGatekeeper(SHARED_ID);
      await gadget.bind("MODEL", await modelBinding.getId());
      await gadget.setBlueprintAnnotation("MODEL", { title: "Shared model", description: "Use deployment AI", suggestValue: true });
      await gadget.setBlueprintAnnotation("SPAWNER", { title: "Shared agent", description: "Use deployment AI", suggestValue: true });
      const blueprint = await gadget.createBlueprint("Shared model metadata", "Local regression only");
      using publicApi = connect(harness!.url);
      const blueprintMetadata = await publicApi.getBlueprint(blueprint.id);
      expect(blueprintMetadata?.metadata.bindings).toMatchObject({
        MODEL: { type: "aiModel", suggestedModel: { provider: "openai", modelName: "gpt-5.5" } },
        SPAWNER: { type: "agentSpawner", suggestedModel: { provider: "openai", modelName: "gpt-5.5" } },
      });
      expect(JSON.stringify(blueprintMetadata)).not.toContain("managedModelId");
      expect(JSON.stringify(blueprintMetadata)).not.toContain(SHARED_KEY);
      using client = await gadget.connectToGadget() as RpcStub<RpcTarget & { dispatch(text: string): Promise<void> }>;
      await client.dispatch("first");
      const spawned = await waitFor("shared background turn", async () => {
        const chat = (await ws.listChats()).find(c => c.spawnerName === "Shared spawner");
        return sharedRequests.length === before + 4 && chat?.activeAgent ? chat : null;
      });
      spawnedId = spawned.id;
      await client.dispatch("second");
    }
    await restartWorkspace(harness!.url, ws);
  });
  await waitFor("shared workspace restart", async () => session.connectionDrops > 0 || null);
  await withOwnerWorkspace(harness!.url, session.username, async ws => {
    await waitFor("both shared background calls", async () => sharedRequests.length === before + 6 || null);
    await waitForIdleChat(ws, spawnedId);
    const history = await loadAllChatHistory(before => ws.getChatHistory(spawnedId, before));
    expect(history.filter(m => m.type === "agentCallback")).toHaveLength(2);
    expect(history).toContainEqual(expect.objectContaining({ type: "message", message: "First background call resumed" }));
    expect(history).toContainEqual(expect.objectContaining({ type: "message", message: "Second background call handled" }));
    expect(sharedRequests[before + 4].body).toEqual(sharedRequests[before + 3].body);
    expect(JSON.stringify([history, await ws.listChats()])).not.toContain(SHARED_KEY);
  });
  expect(sharedSteps).toEqual([]);
});

it("approval resume re-resolves the shared model and provider errors/redirects stay sanitized", async () => {
  sharedSteps.push({ tool: "executeCode", args: {
    code: 'export default async function(self, env) { await env.TEST_AMBIENT.writeValue(7); }',
  } }, { text: "Approved and resumed" });
  await using session = await openAgentSession(harness!.url, {
    modelId: SHARED_ID, ambientVendorIds: [TEST_VENDOR_ID], usernamePrefix: "sharedapproval",
  });
  await session.runTurn("Write the test value");
  const { entries } = await session.listActions({ filter: "pending" });
  expect(entries).toHaveLength(1);
  const resumed = await session.approveActionsAndWait([entries[0].id]);
  expect(resumed.outcome).toEqual({ status: "completed" });
  expect(resumed.history).toContainEqual(expect.objectContaining({ type: "message", message: "Approved and resumed" }));
  for (const status of [401, 302]) {
    sharedSteps.push({ status });
    const failed = await session.runTurn("Exercise sanitized failure");
    expect(JSON.stringify(failed)).not.toContain(SHARED_KEY);
    expect(JSON.stringify(failed)).toContain("Deployment-managed AI request failed");
  }
  // NetworkInterceptor records and rejects any credential-following redirect to the trap host.
  expect(network.getUnmockedCalls()).toEqual([]);
});
