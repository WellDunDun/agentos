# agentOS Apps: Mandatory Namespaces + Engine/Cloud Provisioning

Status: proposal (from the apps-builder-ui demo work).

## Problem

Today `deployApp()` runs every app in the host's namespace by default; namespaces
are only created with the opt-in `createNamespace: true`, which reuses the host
connection token and assumes it can list/create namespaces. There is:

- no isolation by default (all apps + all releases share the host namespace,
  separated only by per-app runner pools),
- one code path that behaves very differently against a self-hosted engine
  (admin token, direct `/namespaces` calls work) vs Rivet Cloud (namespace
  management belongs to the Cloud control plane), with no mode awareness and
  no useful error when the wrong kind of token is used,
- no scoped runtime credentials: whatever token provisioned the namespace is
  the token everything runs with.

## Goals

1. **A deployed app always has a namespace.** Either one agentOS Apps
   provisions, or a predefined namespace the caller names. The
   share-the-host-namespace default is removed (no back-compat shims, per repo
   policy).
2. **Two explicit provisioning modes** with typed cross-mode errors:
   - `engine` (default): direct engine `/namespaces` calls using the engine
     endpoint token. Default because local dev and self-hosted deployments can
     assume the admin engine token is at hand.
   - `cloud`: provisioning goes through the Rivet Cloud API with a cloud
     token.
3. **Clear, typed, doc-linked errors** when the configuration and the target
   don't match (self-hosted flow against Cloud, cloud flow against a local
   engine, insufficient token scope).
4. **Scoped token issuance** so the admin/cloud token is only used at
   provisioning time; the app's runtime uses a namespace-scoped token.

## API

```ts
await deployApp({
  appId: "my-app",
  files,

  // Optional: run in a predefined namespace. agentOS Apps verifies it exists
  // and never creates or deletes it.
  namespace: "team-prod",

  // Optional: how namespaces (and scoped tokens) are provisioned when
  // `namespace` is not given. Default: { mode: "engine" }.
  provisioning:
    | { mode: "engine" }                    // engine endpoint token from env
    | { mode: "cloud"; token?: string },    // default: RIVET_CLOUD_TOKEN env
});
```

- `createNamespace` is **removed**.
- When `namespace` is omitted, agentOS Apps provisions (idempotently) the
  app's namespace `agentos-app-<appId>-<hash>` — same naming as today. The
  hash suffix is the first 10 hex chars of
  `sha256(<issuing host namespace> + "\0" + <appId>)`, with the appId part
  truncated so the full name fits 63 chars.
- **The derived name is keyed to the namespace that issued it.** The same
  appId deployed from a different host namespace derives a *different* app
  namespace. The docs must call this out explicitly: if you move a deployment
  to a new host namespace and want to keep the app's existing namespace (and
  its actor state), pass it explicitly via `namespace:` — the derived name
  will not match. The `agentOSAppsApp` actor already enforces
  namespace-stability per appId (`agentos_apps_namespace_changed`).
- One namespace per appId, stable across releases (confirmed direction), so
  actor state survives redeploys.
- `Deployment` continues to return `{ appId, release, namespace, pool,
  regions }`; server-side callers that need to connect a client to the app's
  actors use `deployment.namespace` + `deployment.pool` as before.

### Mode selection

- Explicit `provisioning.mode` always wins.
- With nothing configured, mode is `engine` and the connection is today's
  `resolveDefaultRivetConnection()` (`RIVET_ENGINE`/`RIVET_ENDPOINT` incl.
  `namespace:token@host` auth, `RIVET_NAMESPACE`, `RIVET_TOKEN`). This is the
  local-dev/self-hosted assumption: the token on the engine endpoint is an
  admin token and may create namespaces.
- Setting `RIVET_CLOUD_TOKEN` in the environment selects `cloud` mode without
  code changes (explicit `provisioning` still overrides).

### Error contract

All typed `AgentOSAppsError`s, each with a docs link in the message
(`https://agentos-sdk.dev/docs/apps#namespaces`):

| Code | When | Message sketch |
| --- | --- | --- |
| `agentos_apps_cloud_requires_cloud_token` | `engine` mode but the target is Rivet Cloud (detected from the namespace-create response / endpoint identity) | "This engine is managed by Rivet Cloud. Configure `provisioning: { mode: \"cloud\" }` with a cloud token — see <docs>/apps#cloud." |
| `agentos_apps_engine_token_unauthorized` | `engine` mode, self-hosted engine refused namespace create/list | "The engine token cannot manage namespaces. Use the engine admin token or a token with namespace create permission — see <docs>/apps#self-hosted." |
| `agentos_apps_cloud_mode_without_cloud` | `cloud` mode but the endpoint is a plain self-hosted/local engine | "Rivet Cloud provisioning is configured but the endpoint is a self-hosted engine. Remove `provisioning.mode: \"cloud\"` or point at Rivet Cloud — see <docs>/apps#cloud." |
| `agentos_apps_cloud_token_invalid` | `cloud` mode, Cloud API rejected the token | "The Rivet Cloud token was rejected — mint one at <dashboard> and pass it via RIVET_CLOUD_TOKEN — see <docs>/apps#cloud." |
| `agentos_apps_namespace_missing` | `namespace` was provided but does not exist | "Namespace \"team-prod\" does not exist; predefined namespaces are never created automatically — see <docs>/apps#namespaces." |

Detection should classify from the provisioning call's actual failure rather
than a pre-flight probe where possible (fewer round trips, no false
negatives); an endpoint-identity probe is a fallback if the error responses
are not distinguishable.

Additionally, every `AgentOSAppsError` that is a platform/configuration
failure (all of the table above, plus runner/replica infrastructure failures)
gains `serverFault: true`, distinguishing them from user-code failures like
`agentos_apps_build_failed`. Agent loops use this to stop rewriting app code
when the platform is at fault — the apps-builder-ui demo already reads this
field off deploy errors.

### Cloud mode: concrete contract (verified against rivet-ee)

The Rivet Cloud API (`cloud-api.rivet.dev`, `platform/api` in rivet-ee)
already exposes everything cloud mode needs:

| Call | Purpose |
| --- | --- |
| `POST /projects/{project}/namespaces?org=…` | Create the app namespace |
| `GET /projects/{project}/namespaces?org=…` | Idempotency lookup |
| `POST /projects/{project}/namespaces/{ns}/tokens/secret?org=…` | Mint (get-or-create) the **engine secret token scoped to that namespace** — returns `{ token }` |
| `DELETE /projects/{project}/namespaces/{ns}?org=…` | Teardown (future `destroyApp()`) |

Token semantics (already documented in Rivet's Compute docs):
`RIVET_CLOUD_TOKEN` is a `cloud_api_*` **management token** for
`cloud-api.rivet.dev`; `pk_*` publishable keys are scoped to the Engine API
and 401 against the Cloud API. Cloud-mode provisioning therefore needs
`{ token, project, org }` — the CLI resolves project from the token, so
agentOS Apps should do the same where the API allows and accept explicit
`project`/`org` fields otherwise:

```ts
provisioning: { mode: "cloud", token?, project?, org? }
```

Flow: create/lookup the namespace → `tokens/secret` to get-or-create the
namespace-scoped engine token → use *that* token for the runner config and
all engine calls for this app. The `cloud_api_*` token never touches the
engine data plane.

Token prefixes also give us cheap, reliable **error classification**:

- engine mode + token starts with `cloud_api_*` → `agentos_apps_cloud_requires_cloud_token`
- cloud mode + endpoint is a plain engine / token isn't `cloud_api_*` → `agentos_apps_cloud_mode_without_cloud`
- `pk_*` passed where a management or secret token is required → dedicated message pointing at the dashboard's Connect flow

### Scoped tokens

Provisioning mints a **namespace-scoped runtime token** alongside the
namespace:

- `cloud` mode: `POST …/tokens/secret` above — solved, exists today.
- `engine` mode: the self-hosted engine does not currently expose equivalent
  scoped-token minting from this repo's vantage; fall back to the connection
  token (acceptable in the self-hosted trust model, where it is the admin
  token by assumption) and record the engine feature request.

The scoped token is stored in the deployment actor's configuration and used
for the app's runner config and callbacks. It is not returned to callers by
default.

## Releases, scaling, and routing (existing mechanics, for the docs)

Documented here because the docs update should explain them alongside
namespaces:

- **A release is a content hash over everything**: files + entrypoint +
  build plan + toolchain identity + deployment identity (regions, scaling,
  warmTimeoutMs, namespace, runtime pool, usesRivetKit) —
  `canonicalDeploymentHash()`. Changing *only* the scaling config therefore
  produces a new release and goes through the full rollout (build is
  artifact-cached, replicas re-warm, envoy version bumps).
- **Exactly one release is active per app.** `activeRelease` flips only after
  the new release's replicas warm in every region (and, for rivetkit apps,
  after the runner config is upserted — with rollback if that fails). Old
  scalers are then retired (graceful drain). There is no traffic splitting or
  blue/green between releases, and no manual scale-down of old releases —
  retirement is automatic on flip.
- **Scaling within a release** is the scaler actor's job: replicas spin on
  demand between `minReplicas`/`maxReplicas` against `targetConcurrency`;
  idle replicas drain after the warm-idle timeout.
- **Two routing planes share the same guest processes:**
  1. *HTTP serving*: `appsRouter` → app actor → scaler admission → replica
     VM → guest-RPC bridge into the app's fetch handler.
  2. *RivetKit actors*: the app's namespace has a serverless runner config
     whose URL points back through the engine gateway into the app actor
     (`/gateway/<appActorId>/request/.agentos/apps/rivet`, authenticated by a
     per-app callback secret; the engine identifies itself via
     `RivetEngine/` user-agent and hits `/api/rivet/metadata` + `/start`).
     The **engine** owns actor storage, placement, and routing; the guest is
     just the compute that runs actor code, registered at the release's
     `RIVET_ENVOY_VERSION` (a monotonic per-app counter, auto-injected into
     the guest env). On upgrade the engine associates old actors with the
     old envoy version and moves work to runners registering the new one —
     actor state travels because it lives engine-side, not in the replica.

## Docs to update (same change)

All in `website/public/docs/docs/` unless noted:

1. **`apps.md`** — replace the `createNamespace` paragraph + config table row
   with a **"Namespaces"** section:
   - namespaces are mandatory; default derived name and *exactly how it is
     derived* (issuing host namespace + appId), with the explicit warning:
     *"the derived namespace is keyed to the namespace that issued it — if
     you deploy the same appId from a different host namespace, pass
     `namespace:` explicitly to keep the app's existing namespace and
     state"*;
   - engine mode (default; local dev/self-hosted, admin token assumption);
   - cloud mode: `RIVET_CLOUD_TOKEN` (`cloud_api_*`, from dashboard →
     Connect → Rivet Cloud), `provisioning: { mode: "cloud", project?, org? }`;
   - predefined `namespace:` semantics (verified, never created/destroyed);
   - the typed error table with the fix for each.
2. **`apps.md` → "Releases & scaling"** (new short section) — release =
   content hash incl. scaling/regions; one active release; automatic
   retirement; envoy-version upgrade semantics for the app's own actors
   (`RIVET_ENVOY_VERSION` auto-injected).
3. **`deployment.md`** — Rivet Cloud target: where to get the token, that
   agentOS Apps provisions namespaces through the Cloud API, link to Rivet's
   Compute docs for the dashboard Connect flow.
4. **`authentication.md`** — one paragraph distinguishing the three token
   kinds agentOS Apps may see (engine token, `cloud_api_*` management token,
   `pk_*` publishable key) and where each is valid.
5. **`examples/apps-builder-ui/README.md`** — reflect whichever mode the demo
   runs (engine mode, local).
6. Rivet-side (rivet-ee docs, separate PR): Compute doc gains an agentOS Apps
   subsection mirroring #3.

## Open questions

1. ~~Per-app vs per-release namespaces~~ — **resolved: per-app**, stable
   across releases; upstream already enforces appId↔namespace stability.
2. ~~Cloud API contract~~ — **resolved**: namespace create/list/delete and
   `tokens/secret` exist on `cloud-api.rivet.dev` (see table above).
   Remaining sub-question: can `project`/`org` be resolved from the
   `cloud_api_*` token server-side (the CLI does this), or must deployApp
   accept them explicitly?
3. **Engine token issuance.** Self-hosted engine equivalent of
   `tokens/secret` — engine feature request; until then engine mode uses the
   connection (admin) token at runtime.
4. **Namespace lifecycle.** With mandatory namespaces we likely also owe a
   `destroyApp()` that tears down the app's namespace (cloud: the DELETE
   route exists); predefined namespaces are never destroyed.
5. **Secret-token rotation.** `tokens/secret` is get-or-create; rotating a
   leaked namespace token and re-pointing live runner configs needs a story
   (likely: rotate via Cloud API + redeploy).
