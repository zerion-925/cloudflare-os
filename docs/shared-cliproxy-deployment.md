# Deploy the shared CLIProxy patch

This is source publication, **not a deployed instance**. The native local application previously passed two-user shared selection, streamed text and harmless tool-result continuation. Browser UI, real Cloudflare Access and production routing remain unproven. No inference, deployment or secret installation was performed for publication.

## 1. Reproduce the exact sources

- Publication: [zerion-925/cloudflare-os, `fm/cfos-fork-publish`](https://github.com/zerion-925/cloudflare-os/tree/fm/cfos-fork-publish), not either repository's default branch.
- Official OS base: [`1045d2e1ceac7be29e1a6f056c936fb31aa00851`](https://github.com/cloudflare/cloudflare-os/commit/1045d2e1ceac7be29e1a6f056c936fb31aa00851).
- Official starter base: [`3d211477ad009e13a98d863d843e5c12a29ad02b`](https://github.com/cloudflare/cloudflare-os-starter/commit/3d211477ad009e13a98d863d843e5c12a29ad02b).

Use the **full published commit from this guide's immutable `/blob/<SHA>/...` URL** for `OS_COMMIT` below. The guide and companion must come from that same revision. A branch name alone is not an immutable pin; do not substitute current upstream `main`.

```sh
OS_COMMIT='<PUBLISHED_OS_COMMIT>' # full SHA from the immutable guide URL

git clone --branch fm/cfos-fork-publish https://github.com/zerion-925/cloudflare-os.git os-publication
git -C os-publication checkout --detach "$OS_COMMIT"
PUBLICATION_DIR="$(cd os-publication && pwd -P)"

git clone https://github.com/cloudflare/cloudflare-os-starter.git os-deployment
cd os-deployment
git checkout --detach 3d211477ad009e13a98d863d843e5c12a29ad02b
git submodule update --init cloudflare-os
git -C cloudflare-os fetch https://github.com/zerion-925/cloudflare-os.git "$OS_COMMIT"
git -C cloudflare-os checkout --detach "$OS_COMMIT"
test "$(git -C cloudflare-os rev-parse HEAD)" = "$OS_COMMIT"

git apply --check "$PUBLICATION_DIR/docs/shared-cliproxy-starter.patch"
git apply "$PUBLICATION_DIR/docs/shared-cliproxy-starter.patch"
```

Use a fresh deployment checkout; never apply this over private or modified configuration. The [companion patch](shared-cliproxy-starter.patch) applies only to the pinned starter base and deliberately excludes the old submodule gitlink change. Pinning the **published OS commit**, not its official base alone, preserves the actual feature.

The companion includes all required prepared starter changes:

| Paths | Why included |
| --- | --- |
| `scripts/deployment-config.ts`, `scripts/deploy.ts`, `scripts/deploy.test.ts` | Typed `sharedAi`, strict validation, Workshop-only catalog/required-secret generation and regressions |
| `deployment.jsonc`, `README.md`, `docs/customization.md` | Public placeholder configuration and supported controls |
| `packages/custom-gatekeeper/src/custom.ts` | Selected OS requires the credential-free `commitReconnect` contract |
| Both starter `packages/*/vite.config.ts` files | Existing task cache settings must use Vite+ 1's `cache` nesting |
| `pnpm-workspace.yaml`, `packages/error-reporter/package.json`, `pnpm-lock.yaml` | Selected OS catalog/manifest/locked dependency alignment, including the existing OS scripts workspace; not new shared-provider logic |

Application/test sources are the previously validated checkpoint, unchanged. Starter documentation inside the patch describes the earlier local-patch stage; the publication/pinning and validation status in **this guide** supersede those historical statements. Licenses and upstream attribution are unchanged.

## 2. Prerequisites and private configuration

Use Node **24.19+** and the declared **pnpm 11.17.0**. Install the two frozen dependency sets sequentially from the starter root, not concurrently:

```sh
pnpm install --frozen-lockfile
pnpm --dir cloudflare-os install --frozen-lockfile
export PATH="$PWD/cloudflare-os/node_modules/.bin:$PATH"
# Only if Node 26's experimental web storage breaks existing jsdom tests:
# export NODE_OPTIONS=--no-experimental-webstorage
pnpm exec wrangler --version
pnpm exec wrangler whoami
# If needed, authenticate privately using your own approved identity:
# pnpm exec wrangler login
```

Frozen versions are starter Wrangler **4.145.0** and OS Wrangler **4.138.0**. Do not upgrade dependencies to reproduce this checkpoint. Authentication success is not proof of billing/runtime readiness.

Before any deployment, approve and confirm:

- A Cloudflare account with **Workers Paid** for Dynamic Workers/Worker Loader/Facets; actual runtime readiness for Worker Loader/Facets and Browser Rendering. Also Workers, Durable Objects, KV and R2 permissions/availability. The `WORKERS_AI` binding remains required for document-to-Markdown conversion even with AI Gateway disabled. Artifacts is optional and off by default.
- Six unique, stable, owned Worker names with collision checks: Router, Workshop, Context, Scheduler, custom Gatekeeper and Error Reporter. Do not adopt an existing unrelated Worker or overwrite an existing application's state.
- A Router hostname in an active Cloudflare zone, e.g. `<PUBLIC_HOSTNAME>`, and its exact `https://<PUBLIC_HOSTNAME>` origin. No conflicting DNS/CNAME. `publicBaseUrl: null` derives the origin from the custom domain; an explicit value must match exactly (no path/trailing slash).
- A self-hosted Access application covering the Router hostname, exact team issuer `https://<ACCESS_TEAM>.cloudflareaccess.com`, application AUD `<ACCESS_AUD>`, narrowly scoped allow policies, intended two allowed users and a denied test user. No bypass policy. `<ADMIN_EMAIL>` is an Access-verified admin allowlist entry, not permission for every allowed user to administer the deployment.
- Privately authorized client access/quota for the **fixed endpoint below**. A source checkout does not grant provider access or promise free inference. Set operator spending controls outside this patch.

Edit your deployment checkout's `deployment.jsonc` privately. Replace **every active placeholder**, including `<CLOUDFLARE_ACCOUNT_ID>`, all six Worker names, Access inputs/admins, and example integration `<ORGANIZATION_DISPLAY_NAME>`/`<ORGANIZATION_GUIDANCE>`. Keep this personalized file out of any commit, report or public patch. The shipped placeholders are deliberately **not deployment-ready**. Use `null` KV/R2 values only for a new authorized deployment; reusing data requires explicit owned storage IDs/names and a migration plan. Keep the Context sharing boundary stable.

Only Router may have a public route. The generated Workshop, Context, Scheduler, custom Gatekeeper and Error Reporter configs must have `workers_dev: false`, no public routes, and `preview_urls: false`; Router previews must also be off. Router forwards `/api/*` and `/blueprint-screenshot/*` to private Workshop and `/gatekeeper/<name>/*` to private Gatekeepers via service bindings. Do not expose the backend directly to make setup easier. The starter builds the frontend with `VITE_CF_ACCESS_MODE=true` and sets Workshop `CF_ACCESS_ISS`, `CF_ACCESS_AUD`, `ADMINS` and `PUBLIC_BASE_URL`.

Retain exactly this supported AI configuration:

```jsonc
"aiGateway": { "enabled": false },
"sharedAi": {
  "baseUrl": "https://proxy-api.buchan.cloud/v1",
  "models": [{ "model": "gpt-5.5", "name": "CLIProxy GPT-5.5" }]
}
```

**The literal endpoint is a fixed implementation restriction, not a configurable example.** Only one `gpt-5.5` entry works; alternate endpoints/models, headers, discovery or credential selectors are rejected. Supported application caps are **128,000 context / 4,096 output tokens**, text/tools only; image/PDF input is rejected. Protocol: streamed, stateless OpenAI Responses POST to that base's `/responses`, with `store:false`. Do not substitute a placeholder URL into runtime source or claim arbitrary CLIProxy instances work.

The starter emits public `SHARED_AI_MODELS` only on Workshop and unions **`CLIPROXY_API_KEY`** into Workshop's `secrets.required`, retaining any other requirements. The key is a **Workshop-only Worker secret**, never a `vars` value, deployment JSON, frontend flag, Gatekeeper credential or user's personal provider. Selection ID is `managed:cliproxy:gpt-5.5`. Managed entries are read-only and shared across authenticated users subject to existing workspace permissions. Personal providers and explicit No-agent choices remain separate; quick title/naming usage stays off until each user opts in.

## 3. First Worker and secret bootstrap (separate deployment approval)

Required-secret checks make the full Workshop deployment fail if the key is missing. Do **not** remove `secrets.required`, put a dummy key in the full app, or disable auth to get around that check.

For a **new, proven-absent Workshop name only**, first create a private route-free bootstrap Worker under the intended identity. This is a real infrastructure write requiring approval; never deploy this stub over an existing Workshop. Create these two files in a private temporary directory outside the source repositories:

`workshop-bootstrap.js`:

```js
export default { fetch() { return new Response("Not ready", { status: 503 }); } };
```

`wrangler.jsonc` in the same temporary directory (replace the two placeholders privately):

```jsonc
{
  "name": "<WORKSHOP_WORKER_NAME>",
  "account_id": "<CLOUDFLARE_ACCOUNT_ID>",
  "main": "workshop-bootstrap.js",
  "compatibility_date": "2026-09-04",
  "workers_dev": false,
  "preview_urls": false,
  "routes": []
}
```

From the installed starter root:

```sh
BOOTSTRAP_CONFIG='<ABSOLUTE_PRIVATE_BOOTSTRAP_DIRECTORY>/wrangler.jsonc'
# NEW Worker only; stop if that identity is already in use:
pnpm exec wrangler deploy --config "$BOOTSTRAP_CONFIG"
# Interactive masked prompt: enter the raw client key privately, without "Bearer ".
pnpm exec wrangler secret put CLIPROXY_API_KEY --config "$BOOTSTRAP_CONFIG"
pnpm exec wrangler secret list --config "$BOOTSTRAP_CONFIG"
```

Verify names/required-secret presence, not secret values. For an existing approved Workshop, skip bootstrap deployment and target its verified account/name using a private operator config; never use an upstream example name. Install any other required secrets privately on their actual consumers.

**`wrangler secret put` creates a version and deploys it immediately.** It is not just storage. It can also offer to create a missing Worker; do not accept an unexpected identity/bootstrap prompt. Pinned Wrangler refuses ordinary secret edits when the latest version is not deployed, rather than accidentally rolling it out.

For staging/rotation on an existing Worker, use the versioned sequence instead (same verified private operator config, not a stub redeployment):

```sh
pnpm exec wrangler versions secret put CLIPROXY_API_KEY --config "$BOOTSTRAP_CONFIG"
# Record and inspect the returned secret-bearing VERSION_ID privately:
pnpm exec wrangler versions view '<SECRET_BEARING_VERSION_ID>' --config "$BOOTSTRAP_CONFIG"
# Separate approved rollout; this changes live traffic:
pnpm exec wrangler versions deploy '<SECRET_BEARING_VERSION_ID>@100' --config "$BOOTSTRAP_CONFIG"
```

`versions secret put` **stages only**; the key is not active until rollout. It edits the latest uploaded version, so confirm its code/settings are the intended ones before deployment. First-time Worker creation and Durable Object migrations are not a reason to guess a gradual rollout: the starter's full `pnpm deploy` uses normal deploys to apply the pinned migrations. Do not mix a pending version rollout and ordinary secret edits blindly.

## 4. Configured preflight and full deployment

After configuration, runtime readiness and secret bootstrap are approved, run from the starter root:

```sh
pnpm check
# Inspect preflight output; if anything failed, stop. Deployment needs separate approval:
pnpm deploy
```

`pnpm check` runs starter tests, sequential builds, and all six Wrangler **dry runs**. It validates configuration but is not deployed Access/AI acceptance and must not be assumed to prove the remote key exists. Real `wrangler deploy`/`versions upload` enforce required secrets; verify the target Worker contains `CLIPROXY_API_KEY` before starting the full deploy.

The script creates temporary `wrangler.prod.jsonc` files from the pinned bases and removes them even on failure. Do not hand-edit generated files. It deploys Error Reporter, Context, Scheduler, custom Gatekeeper, Workshop, then Router. With null storage values Wrangler provisions resources; custom-domain deployment configures DNS/TLS. These are real account/resource/billing side effects, not part of source publication. A failure can leave earlier Workers updated: record version IDs, storage bindings and progress privately before retrying. There is no transactional six-Worker rollout.

## 5. Future acceptance and rollback

Existing local mocked regressions and native local text/tool/two-user acceptance are reused, not rerun for this publication. For a separately authorized rollout:

1. Local: run the existing focused backend/model/user and frontend provider/composer regressions with synthetic keys. For an authorized live check, keep calls bounded to short text and one harmless calculation; do not copy synthetic fixtures into production secrets.
2. Deployed: use two distinct allowed Access users with no personal AI key. Both must see/select the managed entry, get streamed text, and complete one harmless `6 * 7` tool-result continuation. Keep quick usage off unless explicitly testing opt-in. Confirm personal coexistence and No-agent behavior.
3. Denied user must not reach authenticated APIs over HTTP or WebSocket. A nonadmin allowed user must not obtain admin capability. Confirm private backend/gatekeeper URLs and preview URLs cannot bypass Router/Access. Browser editing/cloning/deleting managed entries must be unavailable; public metadata/history must contain no client credential. Never record secret-bearing headers/bodies in acceptance evidence.
4. Before broader use, separately exercise opt-in quick titles, restart/background/approval/external flows, disable behavior and rotation/revocation. No deployed acceptance is claimed here.

Preserve the published commit, companion patch, previous deployment version IDs, private config and exact storage/sharing identities. The original starter's OS gitlink was `6478a1448a11524e2f7c2575ad66fab0bc47c433`; that is a source-history fact, **not a safe deployed data downgrade**. Do not reset or discard retained copies to roll back.

To disable the shared catalog, omit `sharedAi` or use `models: []`, then run an approved preflight/rollout. Saved managed references fail unavailable; stored preferences remain. The browser's existing invalid-choice fallback may select another listed model, so recheck the picker and avoid unintended paid calls. Disabling or rolling back code **does not revoke the upstream client key**.

For an authorized Worker rollback, use its recorded compatible version with `pnpm exec wrangler rollback '<PREVIOUS_VERSION_ID>' --config '<PRIVATE_WORKER_OPERATOR_CONFIG>'`, coordinating all affected Workers and migration/storage compatibility. A rollback can reintroduce an older secret. For rotation, verify the new secret-bearing version, drain old/in-flight work as appropriate, then revoke the old key at the provider. For emergency revocation, revoke provider-side and remove the Worker binding under approval; `secret delete` deploys immediately, while `versions secret delete` requires rollout. Keep revocation separate from source cleanup.

## Operator references

Current Cloudflare guidance was consulted without executing account actions:

- [Secrets and required-secret validation](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Wrangler Worker/secret/version commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/)
- [Gradual deployments and Durable Object migrations](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/)
- [Dynamic Workers: Workers Paid prerequisite](https://developers.cloudflare.com/dynamic-workers/pricing/)
- [Cloudflare Access applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)
