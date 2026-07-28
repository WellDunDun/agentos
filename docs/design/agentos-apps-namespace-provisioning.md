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
    | { mode: "engine"; endpoint?: string; token?: string }
    | { mode: "cloud"; token?: string; project?: string; org?: string },
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
- **Precedence everywhere: explicit field > environment > default.** The
  environment is only the default source; every endpoint/token can be
  overridden per call:

| Setting | Env default | Explicit override |
| --- | --- | --- |
| Engine endpoint | `RIVET_ENGINE` / `RIVET_ENDPOINT` (else `http://localhost:6420`) | `provisioning.endpoint` |
| Engine token (namespace create; runtime fallback) | token embedded in the endpoint URL, else `RIVET_TOKEN` | `provisioning.token` (engine mode) |
| Cloud token | `RIVET_CLOUD_TOKEN` | `provisioning.token` (cloud mode) |
| Cloud project / org | resolved from the token via `GET /tokens/api/inspect` → `{ project, organization }` | `provisioning.project` / `provisioning.org` |

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

### Runner pool provisioning (required in BOTH modes)

Creating the namespace is not sufficient: the app's **serverless runner
pool** must also be provisioned so the engine can reach the app's compute —
the runner config that points pool `agentos-apps-<hash>` at the agentOS Apps
gateway URL (`ensureServerlessRunnerConfig` /
`configureAppNamespaceRunner` today, written after a healthy release
activates, updated on every flip, per-region in the target architecture).
This is an **engine API** write in both modes:

- **Engine mode:** exactly today's behavior — runner config written against
  the engine endpoint with the connection token (scoped token once the
  engine can mint one).
- **Cloud mode:** after `POST …/namespaces` + `POST …/tokens/secret`, the
  runner config is written against the **engine** endpoint (api.rivet.dev)
  using the minted namespace-scoped secret token and — critically — the
  `access.engineNamespaceName` from the cloud namespace response, which is
  the engine-facing name and may differ from the cloud-facing one. All
  engine-plane calls (runner config, deploys, clients) use the engine name;
  only provisioning calls use the cloud name.

**Not to be confused with Cloud "managed pools"** (`…/managed-pools/…` on
the Cloud API): those are Rivet Compute container pools. agentOS Apps does
not create managed pools in either mode — its pool is a serverless runner
config, and the compute behind it is the app actor's replicas.

### Cloud token scopes — validated against rivet-ee

The namespace ACL roles the Cloud API provisions (verified in
`platform/api/src/domain/namespaces/acl/`):

| Token | Route | Engine permissions | Lifetime |
| --- | --- | --- | --- |
| Secret (`secret_…`) | `POST …/tokens/secret` | `runner: create`; `actor: CRUDL`; `actor_gateway: CRUDL` | long-lived (get-or-create) |
| Cloud/access | `POST …/tokens/access` | everything secret has **plus** `runner_config: CRUDL`, `namespace: read`, `runner: CRUDL`, `datacenter: list/read`, `actor_kv: read` | returns `expiresAt` (expiring) |
| Publishable (`pk_…`) | `POST …/tokens/publishable` | client-facing subset | long-lived |

**Consequence: the long-lived secret token cannot write runner configs**
(`runner_config` is only on the cloud/access role), and it also cannot list
datacenters (relevant for region discovery in the target architecture). So
cloud-mode deploys use **two engine tokens**:

- **Deploy-time:** mint a fresh access token (`tokens/access`) per deploy and
  use it for `ensureServerlessRunnerConfig` (and datacenter listing). Expiry
  is fine — it only needs to outlive the deploy.
- **Runtime:** the secret token for everything the host does continuously
  (actors, runners, gateway) — its scope covers exactly that.

Alternative worth raising with the Rivet side: add `runner_config` ops to the
secret role so one token suffices. Until then the two-token flow works with
APIs that exist today. Remaining open item: how cloud mode discovers the
engine endpoint (constant `api.rivet.dev` vs. returned by the API).

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
namespaces.

### Concept parallels (put this table in apps.md)

| agentOS Apps | Kubernetes analog | Notes |
| --- | --- | --- |
| App (`appId`) | Deployment | Long-lived identity; owns the namespace, releases, and history |
| Release (content hash) | ReplicaSet @ image digest | Immutable; hash covers files **and** deploy config (scaling, regions, namespace, runtime) |
| `activeRelease` | the RS at scale | Exactly one release serves at a time |
| Rollout | Blue/green with prewarm | Build → warm all regions → atomic flip → auto-retire previous. No canary/percentage split |
| Scaler (app+release+region) | Knative KPA / KEDA http pool | Admission-based autoscaling, scale-to-zero, warm-idle drain |
| Replica (+agentOS VM) | Pod | Immutable per release; stateless |
| `revision` counter | `deployment.kubernetes.io/revision` | Bookkeeping |
| `RIVET_ENVOY_VERSION` | Node-pool version (cordon/drain) | Engine drains the app's actors from old-version runners to new |

### Rollout strategy (document as-is for now)

**Roll-forward only.** `activeRelease` always moves to the most recent
successful `deploy()`. There is no rollback API; "rolling back" is
redeploying the previous inputs — the identical content hash reactivates the
stored release (artifact cache hit ⇒ fast), but it is mechanically a new
roll-forward and mints a fresh (higher) envoy version so the engine's drain
ordering stays monotonic. Failure at any stage (build, regional warm, runner
config) never moves `activeRelease`; partially-warmed new scalers are retired
and the previous release keeps serving. Up to `maxVersions` releases are
retained in the app actor's SQLite for hash reuse; only the active one
receives traffic.

### Current admission flow (superseded — see "Target architecture" below)

The scaler exists **per (appId, release, region)** because replicas are
immutable per release — a replica runs exactly one artifact — so capacity is
managed as per-release pools, which is what makes the atomic flip and the
targeted retirement of the old pool possible. Release selection is trivial
and centralized: the app actor reads `state.activeRelease` at request time
and asks *that release's* scaler for admission. Per request:

1. App actor: `activeRelease` → `scaler(appId, release, region).acquire()`.
2. Scaler: cold-start a replica if the pool is empty; pick the least-loaded
   non-draining replica (round-robin among ties); if the least-loaded is at
   `targetConcurrency - 1` and the pool is under `maxReplicas`, warm another
   replica in the background; grant a leased admission
   (`admissionLeaseMs`, reconciled on expiry so abandoned requests can't leak
   capacity; hard cap `maxAdmissions`).
3. App actor forwards the request to the admitted replica over the guest-RPC
   bridge and releases the admission when the response completes.

During a flip, in-flight requests finish on the old release's replicas
(draining pool); new admissions go to the new release the moment
`activeRelease` moves. An idle draining replica can be resurrected if the
pool would otherwise have no capacity.

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

## Target architecture: regional data plane

Two problems with the current shape: (a) every request/response byte transits
the `agentOSAppsApp` actor, which is **global — one instance per app** — so
edge regions route through wherever that actor lives, defeating edge
replicas; (b) the scaler is keyed by release, so a router cannot address it
without first asking the app actor which release is active. The redesign:
**the app actor is control plane only and appears nowhere on the request
path; the router talks to the regional scaler, then routes directly to the
replica.**

### Actors

| Actor | Key | Role |
| --- | --- | --- |
| `agentOSAppsApp` | `[appId]` | Control plane only: builds, release/artifact storage, rollout coordination across regional scalers, namespace pinning, engine serverless-runner callbacks (phase 1 — see open items). Never on the HTTP request path. |
| `agentOSAppsScaler` | `[appId, region]` — **release removed from the key** | Regional data-plane authority: current active release (pushed on rollout), replica pools per release internally (active + draining), scaling config, artifact locator, admission leases. Actions: `admit()`, `release(admissionId)`, `prepareRelease(release, scaling, artifactRef)`, `activateRelease(release)`, `retireRelease(release)`. |
| `agentOSAppsReplica` | `[appId, release, region, index]` | Unchanged: one VM pinned to one release's artifact; additionally validates a scaler-issued admission token (pool-scoped secret handed over at spawn, checked in memory). |

### Scaler state budget

- **In-memory (`vars`, never persisted):** admission leases, per-replica
  in-flight counts, selection cursor, warming flags. `admit()`/`release()`
  perform **zero database writes** — this is a change from today's scaler,
  which keeps admissions in durable state (a persisted write per request).
- **Durable (`state`/SQLite, low-churn):** active release, scaling config,
  replica pool membership, artifact locator — mutated on rollouts and scale
  events only.
- **Restart semantics:** in-flight requests are unaffected (already routed
  router→replica). The lost lease table is rebuilt by the first `reconcile`
  (query replicas for live counts, or start at zero and let lease expiry
  converge). Worst case is briefly optimistic admission past
  `targetConcurrency` — a soft target, not a correctness bound.

### Request path (one acquire hop, all in-region)

```
 Client        Host router (region R)     Scaler [appId, R]        Replica [appId, rel, R, i]     Guest VM
   │                  │                        │                           │                        │
   │ GET /apps/a/x    │                        │                           │                        │
   │─────────────────>│                        │                           │                        │
   │                  │ 1. admit()             │                           │                        │
   │                  │───────────────────────>│ activeRelease (local)     │                        │
   │                  │                        │ least-loaded replica in   │                        │
   │                  │                        │ active pool; lease (mem); │                        │
   │                  │                        │ maybe warm one (async)    │                        │
   │                  │  {replicaKey, token}   │                           │                        │
   │                  │<───────────────────────│                           │                        │
   │                  │ 2. fetch(req, x-agentos-admission: token)          │                        │
   │                  │───────────────────────────────────────────────────>│ validate token (mem)  │
   │                  │                        │                           │───── guest-RPC ──────>│ app.fetch()
   │                  │        streamed response (head/chunks/end)         │<──────────────────────│
   │<─────────────────│<───────────────────────────────────────────────────│                        │
   │                  │ 3. (async) release(admissionId) — or lease expiry + reconcile               │
```

Both hops are engine-routed actor calls pinned to region R
(`createInRegion`), so an edge deployment serves entirely in-region; only
deploys cross regions. `admit()` on an app with no active release in that
region returns a typed 404/503 — the scaler is now the authority for "not
deployed here".

### Rollout path (two-phase across regions)

```
 deployApp()      App actor [appId]                    Scaler [appId, r] ∀ regions
     │                 │                                       │
     │ deploy(files)   │ build → artifact stored               │
     │────────────────>│ phase 1: prepareRelease(rel, scaling, artifactRef) → warm pool per region
     │                 │   any region fails → retireRelease(rel) where prepared; no flip anywhere
     │                 │ phase 2: activateRelease(rel) → per-region atomic flip; drain old pool
     │                 │ retire previous release's pools       │
```

Per-region flips stay atomic; globally there is a short skew window where
regions serve different releases — inherent to removing the global hop, and
behaviorally equivalent to the existing drain window. Roll-forward-only
semantics are preserved (failed prepare anywhere ⇒ no flip anywhere).

### Consequences and open items

- **Artifact distribution:** replicas currently pull artifact chunks from the
  app actor's SQLite — a cross-region cold-boot cost at the edge.
  `prepareRelease` should carry the artifact (or a regional cache locator) so
  cold starts stay in-region.
- **Admission bypass protection** moves from "only the app actor reaches
  replicas" to the scaler-issued admission token, validated replica-side in
  memory.
- **Engine serverless-runner path** (`.agentos/apps/rivet`, the app's own
  rivetkit actors) still terminates on the app actor in phase 1. Phase 2
  should regionalize it — per-region runner configs pointing at the regional
  scaler, ideally with a gateway redirect to the replica rather than
  scaler-proxied streams; depends on engine gateway capabilities.
- The `Which release serves a request` section above documents the current
  implementation for reference; apps.md should document only the target
  architecture once it ships.

## Design notes from review

### Compatibility

No backwards compatibility of any kind (protocol, SQLite layouts,
scaler keys, existing deployments). Existing apps are redeployed; legacy
release-keyed scaler state is abandoned, not migrated.

### Router region discovery

Actors know their region (`c.region` in the actor context) — that covers the
scaler and replicas. **The host router is not an actor**, and rivetkit's env
handling has no `RIVET_REGION`; nothing currently tells the Hono process
which region it runs in. Flagged: the target architecture needs a defined
source — proposal: `RIVET_REGION` env set at host deploy time, falling back
to a datacenter-list lookup at boot (note: datacenter list/read requires the
cloud/access role, not the secret token). Until set, single-region behavior
(`"default"`) applies.

### Coordinator failure during rollout

The app actor coordinates the two-phase rollout; it can die between phases.
Failure analysis:

- **During build / phase 1 (prepare):** no scaler has flipped; `deploy()`
  fails at the caller; previous release serves everywhere. Prepared-but-never-
  activated pools are garbage: replicas drain via the warm-idle timeout even
  if `retireRelease` was never sent. Safe by default.
- **Between phase 1 and phase 2, or mid-phase 2 (partial activate):** some
  regions flipped, some didn't — a persistent split, since nothing retries.
- **Chosen mitigation: queue-driven idempotent rollout handler** (plain
  `run` + `c.queue.iter()`, no workflow machinery). Depends on the upcoming
  rivetkit queue release adding **redelivery (at-least-once with ack)**;
  current queues are at-most-once after receive (`actors/queues.mdx`:
  removed on receive, `completable` only notifies the sender). With
  redelivery, the rollout message is the durable unit: `deploy()` builds
  synchronously (diagnostics to the caller), records `requestedRelease`,
  and enqueues `{release, regions, envoyVersion}`; the run loop processes
  one message at a time and acks on completion. A crash mid-rollout
  redelivers the message and the handler re-runs from the top — safe
  because every op is an idempotent ensure (`prepareRelease` no-ops when
  warm, `ensureServerlessRunnerConfig` is documented idempotent,
  `activateRelease` no-ops when active, retirement is an
  everything-except-active sweep). Supersede: drop any message whose
  release ≠ `requestedRelease` (stale drain), and re-check between phases.
  Structural guarantees: one rollout at a time (run loop), converge-to-
  latest supersede, single writer of `activeRelease`, crash recovery via
  redelivery + idempotency. Deploy callers get their result by polling
  release status (a waiting sender still times out if the actor dies
  mid-rollout). **The discipline that never goes away:** at-least-once
  means the handler re-runs from the top, so every scaler/runner-config op
  must stay idempotent — redelivery replaces the reconcile-on-wake trigger,
  not the idempotency requirement.
- *Alternative considered:* a workflow loop (`ctx.loop` +
  `loopCtx.queue.next`, the docs-recommended workflow shape) with durable
  steps per region-phase. Wins per-step inspector visibility and built-in
  step retry; loses on machinery (step naming/versioning) and adds a
  dependency on workflow-primitive maturity. Revisit if rollout progress
  UI or step-level retries become requirements.
- **Split of sync vs durable:** the build stays synchronous inside `deploy()`
  (callers — including the builder agent — need diagnostics on the reply);
  the rollout (prepare/activate/retire) is the workflow, and `deployApp()`
  awaits its outcome, falling back to polling release status if the
  connection drops.
- **Conflicting rollouts.** Today the entire `deploy()` body runs inside
  `serialized("app:" + actorId)` (actors.ts:1833) — rollouts are strictly
  FIFO per app, so conflicts are impossible but a stale deploy runs to
  completion (full wasted rollout, and the obsolete release briefly serves)
  before the newer one starts. The workflow design must keep the invariant
  and add supersede:
  1. **At most one rollout workflow active per app** (app actor tracks
     `currentRollout`; a new one never starts while one is live).
  2. **Cancel-at-step-boundary:** `deploy(B)` sets `requestedRelease = B`;
     the in-flight rollout re-checks `requestedRelease` **before every
     step** and aborts into its durable compensation path at the next
     boundary (~seconds), instead of a single mid-flight check.
  3. **Commit is a CAS** — `recordActiveIfStillRequested(release)` — so even
     a maximally stale rollout cannot move `activeRelease` past a newer
     request.
  An aborted release stays built/cached; re-requesting it later reactivates
  cheaply via the hash.
- The regional skew window during a *healthy* phase 2 is inherent and
  bounded (seconds); the workflow ledger exists for the crash case.

### App environment variables & secrets (design sketch)

The largest functional gap: generated/deployed apps cannot receive
configuration or credentials (an app that needs an external API key has no
way to get one). Sketch:

- `deployApp({ appId, files, env?: Record<string,string>, secrets?: Record<string,string> })`.
- Both are injected into the guest process environment at replica spawn
  (alongside the auto-injected `RIVET_*` vars).
- `env` is part of the release content hash — changing it is a rollout,
  exactly like K8s pod-template env. `secrets` are **excluded from the hash**
  and versioned separately (rotating a secret should not look like a code
  change; it triggers replica recycling, not a new release).
- Storage: app actor SQLite. The host is trusted (security model: client and
  sidecar are trusted; the guest is not), so host-side encryption is not
  load-bearing — but secrets must never appear in release artifacts, logs,
  `read_logs` output, build diagnostics, or the builder UI's file views.
- Later: vault-style egress substitution (secret never enters the guest) is
  the upgrade path once the platform grows it; the API shape above doesn't
  preclude it.

## Functionality gaps (observed while building the apps-builder-ui demo)

Not all in scope for this change; recorded so the namespace work lands in a
coherent roadmap. K8s analogies for orientation:

| Gap | K8s analog | Notes |
| --- | --- | --- |
| No gradual rollout | RollingUpdate / canary | Flip is all-or-nothing after warm; fine for now, but no percentage split or surge control |
| No first-class rollback | `kubectl rollout undo` | Redeploying old files reactivates the cached release (same hash), but there's no `activateRelease(appId, release)` API or release listing |
| No release inspection API | `rollout history` | Releases + build errors live in the app actor's SQLite but aren't queryable by callers |
| No app env vars / secrets | ConfigMap / Secret | Generated apps can't receive configuration or credentials; pairs with the vault/token discussion |
| No ongoing health checks | liveness/readiness probes | Warm check gates the flip; nothing monitors a serving replica |
| No per-app resource limits | requests/limits | Replica VM sizing is global |
| No log/metrics API | `kubectl logs`, metrics-server | The demo scrapes replica `processOutput` broadcasts; apps.md already lists error reporting as planned |
| No `destroyApp()` | `kubectl delete deploy` + ns GC | Becomes owed once namespaces are mandatory |
| No custom domains/routes | Ingress | Apps are path-prefixed under the host router only |

## Open questions

1. ~~Per-app vs per-release namespaces~~ — **resolved: per-app**, stable
   across releases; upstream already enforces appId↔namespace stability.
2. ~~Cloud API contract~~ — **resolved**: namespace create/list/delete and
   `tokens/secret` exist on `cloud-api.rivet.dev` (see table above), and
   `GET /tokens/api/inspect` resolves `{ project, organization }` from the
   `cloud_api_*` token, so cloud mode needs only the token by default;
   `project`/`org` stay as optional overrides.
3. **Engine token issuance.** Self-hosted engine equivalent of
   `tokens/secret` — engine feature request; until then engine mode uses the
   connection (admin) token at runtime.
4. **Namespace lifecycle.** With mandatory namespaces we likely also owe a
   `destroyApp()` that tears down the app's namespace (cloud: the DELETE
   route exists); predefined namespaces are never destroyed.
5. **Secret-token rotation.** `tokens/secret` is get-or-create; rotating a
   leaked namespace token and re-pointing live runner configs needs a story
   (likely: rotate via Cloud API + redeploy).
6. **Dependency: rivetkit queue redelivery.** The rollout design assumes the
   next rivetkit release's at-least-once queue mode (ack + redelivery on
   failure). Today's queues are at-most-once after receive, and
   `completable` only notifies the sender (`queues.mdx`). If this work lands
   before that release, the interim fallback is the reconcile-on-wake
   variant (durable desired state, queue as nudge) — same idempotent ops,
   different retrigger.
