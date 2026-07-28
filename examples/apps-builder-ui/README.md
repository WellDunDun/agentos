# agentOS Apps: App Builder UI

A Lovable-style builder on top of agentOS Apps: a landing screen listing
deployed apps, and an editor with an agent chat on the left, the live deployed
app in an iframe on the right, and an Open Inspector button for the app's
Rivet actor.

There is no dev VM: `deploy` runs the real TypeScript build in an agentOS VM
via `deployApp()` (a failed build never replaces the live release), and the
agent then tests the **live deployment** with HTTP probes, captured runtime
logs, and a headless-browser check before replying.

## Run it

```sh
# Terminal 1 — API + apps host (port 3001)
cd examples/apps-builder-ui/server
pnpm install --ignore-workspace
ANTHROPIC_API_KEY=... pnpm start

# Terminal 2 — frontend dev server (port 3000, proxies /api and /apps to 3001)
cd examples/apps-builder-ui/frontend
pnpm install --ignore-workspace
pnpm dev
```

Open http://localhost:3000/. RivetKit starts its local Engine automatically;
against an existing Rivet deployment use the standard Rivet connection
variables (`RIVET_ENGINE` / `RIVET_ENDPOINT`, `RIVET_NAMESPACE`, `RIVET_TOKEN`).

Both packages install standalone from published npm packages
(`--ignore-workspace`) so the example runs without building the repo's
workspace toolchain.

## Architecture

- **Frontend** (`frontend/`): Vite + React + TanStack Router/Query SPA.
  `src/api.ts` is the only transport layer — REST for app CRUD, SSE for the
  agent event stream.
- **Server** (`server/`): Hono host that mounts `appsRouter` (live apps at
  `/apps/:appId/`), the builder API, and the agent loop.
- **Actors** (SQLite state, one schema owner each):
  - `builderDirectory` (singleton) — the apps index for the landing screen.
  - `builderApp` (per app) — chat messages, staged files, runtime logs.
  - `agentOSAppsApp` / scaler / replica — owned by `@rivet-dev/agentos-apps`.
- **Agent** (`server/src/agent.ts`): Anthropic tool-runner loop
  (`claude-opus-5`) with tools: `write_files` → `deploy` (deployApp; build
  diagnostics on failure) → `http_request` (probe the live app) → `read_logs`
  → `browser_test` (headless Chromium; set `BROWSERBASE_CONNECT_URL` to run
  the session on Browserbase when the deployment is publicly reachable). The
  system prompt is `server/src/systemPrompt.ts`, viewable in the UI.
- **Log capture** (`server/src/logs.ts`): the apps replica actor broadcasts
  guest stdout/stderr as `processOutput` events; the server subscribes to
  every replica observed serving a request (via the `x-agentos-app-replica`
  response header) and bulk-writes lines into the app's SQLite log table for
  the `read_logs` tool.

Agent runs stream typed `AgentEvent`s over SSE (`POST /api/apps/:id/messages`)
and every exchange is persisted through the `builderApp` actor, so reloading
the page recovers history even if the stream is dropped mid-run.
