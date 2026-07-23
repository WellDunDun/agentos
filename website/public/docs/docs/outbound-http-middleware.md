# Outbound HTTP Middleware

Inspect, mutate, forward, or answer HTTP requests made by code inside an agentOS VM.

Outbound HTTP middleware lets trusted host code intercept HTTP requests made by guest JavaScript. Use one catch-all `outbound` function, exact `outboundByHost` routes, or both:

```ts
type OutboundMiddleware = (
  request: Request,
) => Response | Promise<Response>;
```

An exact host route wins over the catch-all. Host keys ignore scheme, port, path, query, and method; they are canonicalized as DNS names or IP literals when the VM is created. Wildcards, URLs, credentials, ports, paths, and duplicate canonical keys are rejected.

## Forward a request

There is no middleware chain or `next()` function. Calling host `fetch(request)` is the explicit continuation:

Middleware functions are process-local configuration on `AgentOs.create()`. They are not serialized into a VM image or installed dynamically from guest code. A new VM generation must register them again.

## Add host-owned credentials

Exact routes are useful for virtual provider hosts and fail closed: agentOS selects the route before opening an upstream socket, so the hostname does not need to resolve. The guest's network permission is checked first; denied requests never invoke host code.

The host callback runs outside the guest network policy. Middleware authors own host-side SSRF, redirect, DNS, TLS, credential, and destination policy. Catch host-fetch failures and return an explicit response—usually `502`—when that is the API behavior you want the guest to observe.

## Mock an LLM

A middleware response may use a `ReadableStream`, so provider-compatible JSON and SSE responses use the normal Fetch API:

The current bridge collects request and response bodies before crossing the host callback boundary. A `ReadableStream` is accepted, but the guest receives its bytes only after the stream closes; the default collected response cap is `limits.outboundHttp.maxBufferedResponseBytes = 1 MiB`. Incremental upload/download backpressure and cancellation are not implemented yet.

## Embed an LLM gateway

An embedded gateway can accept a provider-shaped request, make its own routing decision, and return a provider-compatible response:

The same route can meter usage, select a model, inject credentials, redact input, or return a deterministic test response.

## Errors and transport scope

If middleware throws, agentOS returns a generic `500` response without exposing the trusted host error to the guest. An unavailable host callback returns `503`; a callback deadline returns `504`. A middleware may return any explicit HTTP error response itself.

The current interception surface covers guest `fetch`, `node:http`, and `node:https`. HTTPS is intercepted before a guest TLS connection is created, so this path does not install an interception CA and does not expose certificate material. Raw TCP, HTTP/2, Python sockets, and WASM tools continue through the ordinary socket/TLS path and are not classified by this API yet. `outbound` therefore is not a complete arbitrary-egress security boundary; use network permissions for that boundary.

TypeScript and Rust clients register the same VM-scoped routes. The Rust API uses streaming `http::Request` and `http::Response` bodies, exposes `OutboundCancellation` in request extensions, and provides `outbound_empty_body`, `outbound_body_from_bytes`, and `outbound_body_from_stream` helpers.