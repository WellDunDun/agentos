# Outbound HTTP Middleware

Status: API and semantically known guest-JavaScript path implemented; streaming
callback transport, raw TCP classification, guest-owned TLS interception, and
managed certificate authority remain proposed

Audience: agentOS client, sidecar, networking, actor, security, and test owners

## Implementation status

The current implementation ships the minimal TypeScript and Rust configuration
shape, exact/catch-all routing, pre-callback network permission checks,
generation-scoped host callbacks, request/response validation, stable
500/503/504 mapping, and interception for guest `fetch`, `node:http`, and
`node:https`. Request and response bodies are currently collected across the
callback boundary.

The bidirectional credit-based body protocol, raw TCP HTTP/1 classification,
Python/WASM interception, guest-owned TLS termination, generated CA/trust
projection, and transport-level observability described below are still the
normative completion design. Until those sections are implemented,
`outbound` is not a complete egress boundary and body streams do not preserve
incremental delivery.

## Decision

agentOS will expose the smallest useful host-side outbound HTTP middleware API:
one catch-all middleware and one exact-host middleware map.

```ts
export type OutboundMiddleware = (
	request: Request,
) => Response | Promise<Response>;

export interface AgentOsOptions {
	/**
	 * Handles outbound HTTP requests that do not match `outboundByHost`.
	 *
	 * Return `fetch(request)` to forward the request, a different `Response`
	 * to short-circuit it, or throw to fail it.
	 */
	outbound?: OutboundMiddleware;

	/**
	 * Handles outbound HTTP requests for exact hostnames or IP literals.
	 *
	 * Exact-host middleware takes precedence over `outbound`.
	 */
	outboundByHost?: Readonly<Record<string, OutboundMiddleware>>;
}
```

There is no registration function, middleware registry, rule language, request
decision type, or LLM-specific API. Middleware functions use the standard
`Request`, `Response`, `Headers`, `ReadableStream`, and host `fetch` APIs.

Middleware does not imply a built-in ordered chain in version one. Exactly one
function is selected for a request: an exact-host entry or the catch-all.
Calling `fetch(request)` is the continuation operation; returning another
`Response` short-circuits it. Applications that need composition can compose
ordinary functions inside that one configured callback without expanding the
agentOS API.

`outbound` means catch-all for HTTP that agentOS can classify; it is not a
complete egress-security boundary for arbitrary raw TCP or guest-owned TLS.
Exact `outboundByHost` routes are the fail-closed enforcement primitive.
The transport limitations are normative below.

The TypeScript and Rust clients must ship this capability together and remain
behaviorally identical. The Rust client mirrors the same shape with an async,
`Send + Sync`, VM-scoped middleware over streaming `http::Request` and
`http::Response` bodies:

```rust
pub type OutboundBodyError =
    Box<dyn std::error::Error + Send + Sync + 'static>;
pub type OutboundMiddlewareError = OutboundBodyError;

/// Inserted into every Rust middleware request's extensions.
///
/// `cancelled()` resolves when the guest cancels, a deadline expires, the VM
/// is disposed, or the sidecar/client connection closes.
pub struct OutboundCancellation { /* private */ }

pub type OutboundRequestBody =
    http_body_util::combinators::BoxBody<bytes::Bytes, OutboundBodyError>;
pub type OutboundResponseBody =
    http_body_util::combinators::BoxBody<bytes::Bytes, OutboundBodyError>;

pub type OutboundMiddleware = std::sync::Arc<
    dyn Fn(
            http::Request<OutboundRequestBody>,
        ) -> futures::future::BoxFuture<
            'static,
            Result<http::Response<OutboundResponseBody>, OutboundMiddlewareError>,
        >
        + Send
        + Sync,
>;

pub struct AgentOsConfig {
    // Existing fields omitted. These callbacks are process-local client
    // options and are never part of the serializable CreateVmConfig.
    pub outbound: Option<OutboundMiddleware>,
    pub outbound_by_host:
        std::collections::BTreeMap<String, OutboundMiddleware>,
}
```

The client provides helpers for empty, byte, and stream bodies so finite
requests and responses do not require callers to construct `BoxBody` directly.
The representation difference must not change routing, header, failure,
cancellation, backpressure, or streaming behavior. Rust middleware functions
obtain an `OutboundCancellation` from `request.extensions()`. Cancellation
drops the middleware future if it has not returned headers; after headers, it
drops the response body and signals the token.

## Goals

- Let trusted host code inspect, mutate, forward, or answer guest HTTP requests.
- Preserve the minimal Cloudflare-compatible `outbound` and `outboundByHost`
  surface.
- Support ordinary HTTP APIs, synthetic services, mock LLM providers, and
  embedded LLM gateways without provider-specific runtime code.
- Preserve incremental request uploads and response downloads end to end.
- Transparently cover sidecar-owned and semantically known HTTP paths, plus
  guest-owned TLS used by curl, Git, and Linux-in-WASM software.
- Keep credentials and host resources outside the untrusted VM.
- Keep all queues, buffers, caches, handshakes, callbacks, and stream state
  bounded, observable, cancelable, and generation-scoped.
- Preserve existing direct TCP behavior when no middleware matches, except the
  documented client-first classification tradeoff introduced by a catch-all.

## Terminology

The public feature name is **Outbound HTTP Middleware**. It retains the minimal
Cloudflare-compatible `outbound` / `outboundByHost` property names while using
middleware as the agentOS concept. The public guide has the same title.

- **Outbound traffic** is the broader category of traffic leaving a VM.
- **Outbound HTTP middleware** is trusted host code that intercepts eligible
  guest HTTP or HTTPS traffic.
- **Middleware function** is one configured `OutboundMiddleware` callback.
- **Programmable egress proxy** may describe what the middleware does.
- **Outbound handler** refers only to the corresponding Cloudflare prior art,
  not the agentOS feature or type name.
- **Outbound proxy** is reserved for internal implementation discussion where a
  literal proxy component is meant. It is not the API or documentation title,
  because it implies broader raw-TCP/TLS coverage than version one provides.
- **Outbound request** describes one request, not the feature.

## Non-goals

Version one does not provide:

- raw TCP, UDP, WebSocket, CONNECT, or arbitrary TLS middleware;
- downstream HTTP/2 interception, h2c, or HTTP/2 prior knowledge;
- informational responses or HTTP trailers;
- byte-transparent compressed response forwarding;
- custom or user-supplied interception CAs or private keys;
- runtime middleware mutation;
- an ordered middleware stack or a `next()` argument;
- a host allow/deny DSL or destination rule language;
- middleware names, middleware parameters, or an invocation context argument;
- provider-aware parsing, token accounting, or LLM-specific events.

These exclusions do not include request uploads, streamed JSON, or SSE. Both
request and response bodies stream in version one.

## Basic usage

Forward every matched HTTP request through trusted host networking:

```ts
const agentOS = await AgentOs.create({
	outbound: (request) => fetch(request),
});
```

Mutate requests for one host:

```ts
const agentOS = await AgentOs.create({
	outboundByHost: {
		"api.github.com": (request) => {
			const headers = new Headers(request.headers);
			headers.set("authorization", `Bearer ${githubToken}`);

			return fetch(new Request(request, { headers }));
		},
	},
});
```

Return a response from the host without making an upstream connection:

```ts
const agentOS = await AgentOs.create({
	outboundByHost: {
		"state.agentos": async (request) => {
			const key = await request.text();
			return Response.json(await state.get(key));
		},
	},
});
```

Middleware functions are process-local values supplied only to
`AgentOs.create()`. They are not serialized into VM configuration, stored in a
preconfigured VM, or exposed through a dynamic registration API. The client
retains the closures and sends the sidecar only raw route keys and opaque
callback capability IDs. The sidecar is the sole authority that validates and
canonicalizes routes.

Registration is ephemeral and bound to the live client plus VM generation. If
that client disconnects, an already-configured generation fails matching
requests with 503 until the owner reconnects or the VM is disposed; it never
falls through to direct egress. On reconnect or recreation, the live client
re-registers the metadata. A VM created solely from serialized/preconfigured
VM data as a new generation has no outbound middleware routes and uses the
policy explicitly supplied to that new `AgentOs.create()` call.

Automatic reconnect applies only while the same live `AgentOs` instance still
retains the closures. After a host process restart, application code must
reconstruct the middleware functions and explicitly create or reattach the
owning instance. Closures are never recovered from VM state; until
reattachment, an existing generation that had routes remains fail-closed.

A middleware-enabled live VM generation cannot be resumed or executed from
durable runtime state without that live registration. Filesystem/layer
snapshots remain usable to create a new VM generation, but `AgentOs.create()`
options define that new generation's policy; middleware configuration is never
inferred from the snapshot. Traffic from a new generation that a trusted caller
deliberately creates without middleware uses ordinary direct behavior.

`AgentOs.create()` must receive one readiness acknowledgement before guest
execution starts. It covers the ephemeral capabilities, canonical routes,
virtual DNS mappings, CA generation, trust-bundle projection, environment
hints, and sidecar virtual/base verifier views. Any partial failure rolls the
registration back, fails creation, and runs no guest code. The internal
registration is transport lifecycle state, not part of `CreateVmConfig`,
durable VM state, or a public runtime registration API.

Middleware functions may capture credentials, storage clients, rate limiters,
or other trusted process-local values available where `AgentOs.create()` is
called. Captured values are never copied into the VM or sidecar. The minimal
request-only API does not introduce an actor-context argument or per-instance
middleware factory.

Middleware functions may run concurrently and have no ordering guarantee.
Captured mutable state must be concurrency-safe.

## LLM use cases

### Mock LLM

A mock can replace a provider without changing the guest SDK's provider URL,
DNS configuration, or credentials:

```ts
const agentOS = await AgentOs.create({
	outboundByHost: {
		"api.anthropic.com": async (request) => {
			const input = await request.json();

			return new Response(createAnthropicEventStream(input), {
				headers: {
					"content-type": "text/event-stream",
					"cache-control": "no-cache",
				},
			});
		},
	},
});
```

The mock may return finite JSON or an incremental OpenAI- or Anthropic-shaped
SSE stream. agentOS does not parse the payload or SSE framing.

### Embedded LLM gateway

A gateway can retain credentials on the trusted host, enforce policy, rewrite
the destination, and stream the upstream response:

```ts
const agentOS = await AgentOs.create({
	outboundByHost: {
		"api.openai.com": async (request) => {
			const headers = new Headers(request.headers);
			headers.delete("authorization");
			headers.set("authorization", `Bearer ${gatewayToken}`);

			const upstream = new URL(request.url);
			upstream.protocol = gatewayOrigin.protocol;
			upstream.host = gatewayOrigin.host;

			// The first clone changes headers while retaining the original
			// streaming-request state. The second changes only the URL.
			const forwarded = new Request(request, { headers });
			return fetch(new Request(upstream, forwarded));
		},
	},
});
```

The host should construct the forwarding origin from trusted configuration,
rather than allowing an untrusted guest to select arbitrary host destinations.
The original path, query, method, and body may still be forwarded without
materializing the body.

The gateway path is:

```text
guest SDK
  -> guest HTTP/TLS
  -> agentOS sidecar interception
  -> trusted host middleware
  -> host fetch or embedded service
  -> streaming Response
  -> sidecar
  -> guest SDK
```

Calling `fetch()` inside a middleware uses the application runtime's host fetch. It
does not recursively enter the agentOS outbound middleware. Host-fetch redirects
also do not re-enter the middleware.

## Configuration and selection

Middleware is fixed when the agentOS instance is created. Version one has no
`setOutboundMiddleware` or `setOutboundByHost` method.

At creation, the client enumerates raw keys and the sidecar authoritatively
canonicalizes every `outboundByHost` key:

- Only own enumerable string properties are read. Prototype properties and
  hostile names such as `__proto__` are not treated as middleware.
- DNS names are converted to their ASCII IDNA form, lowercased, and stripped of
  one trailing dot.
- IPv4 literals use canonical dotted-decimal form.
- IPv6 literals use canonical bracketless form.
- A key containing a scheme, credentials, port, path, query, fragment,
  wildcard, or empty label is rejected.
- Two keys that canonicalize to the same identity are rejected.

For each eligible request:

1. Enforce restricted-address policy against the physical destination, if one
   exists, without opening an upstream socket.
2. Recover and canonicalize the logical HTTP authority from the source matrix
   below.
3. Enforce the guest's logical hostname/port network permission.
4. Select the exact `outboundByHost` middleware, if present.
5. Otherwise select `outbound`, if present.
6. Otherwise use the existing direct network path.

Host matching ignores scheme, port, path, query, and method. Exact-host
middleware always takes precedence over catch-all middleware.

The permission check must complete before middleware invocation. A denied guest
request never invokes trusted host code. After invocation, networking performed
by the trusted host middleware is a new trusted-host action: it is not constrained
by the guest's DNS pin or egress policy. This is consistent with the agentOS
trust model, but means middleware authors are responsible for host-side SSRF,
redirect, credential, and destination policy.

## Virtual exact hosts

An exact middleware may use a name with no public DNS record, such as
`state.agentos`. Supporting that name requires more than matching HTTP headers:
curl, Git, and arbitrary WASM clients normally resolve a name before opening a
socket and no longer carry that name into `connect(IP)`.

When an exact DNS host middleware is configured, agentOS installs a
VM-generation-scoped virtual resolution route:

1. Sidecar-owned DNS returns a reserved virtual address for the exact name
   without consulting external DNS.
2. The VM socket table maps that virtual address back to the canonical logical
   hostname and requested port.
3. A connection to the virtual address can only enter outbound HTTP
   interception; it can never reach a host or external network address.
4. The route is bounded by the number of exact middleware keys and is removed on
   VM teardown.
5. A private resolver that bypasses agentOS DNS does not receive this behavior.

The logical hostname, rather than the reserved address, is used for middleware
selection, permission checks, URL construction, SNI, and certificate SANs.
Both A and AAAA query behavior must be deterministic and must not allow the
reserved identity to escape the VM.

The reserved virtual range cannot be configured as an IP-literal middleware key.
A literal or stale reserved address without a live generation mapping fails
with `EHOSTUNREACH`; it never selects a middleware or reaches the host network.

## Eligible transports

The sidecar owns classification because agentOS is a transparent TCP
interceptor, not an explicit HTTP proxy.

### Semantically known HTTP

When a guest API already identifies a connection as HTTP, the sidecar routes it
directly into the HTTP interception engine. No byte sniffing is required.

### Cleartext TCP

For otherwise raw TCP, the sidecar peeks a bounded prefix. A valid HTTP/1
request line and headers enter the interception engine. A prefix proven not to
be HTTP is replayed byte-for-byte into the existing direct TCP path.
If parsed HTTP has no matching exact or catch-all middleware, the entire preserved
prefix is likewise replayed into the direct path without rewriting it.

The HTTP/2 prior-knowledge preface and an h2c upgrade are recognizable HTTP.
When a middleware selects the authority, version one claims the connection and
fails closed as unsupported; it does not send selected HTTP/2 traffic through
the direct path.

Classification has explicit byte and time limits. Ambiguous input that reaches
either limit fails with a typed error; it is not buffered without bound.

The catch-all cannot transparently preserve a server-first raw protocol while
also guaranteeing that a later HTTP short circuit opens no upstream socket.
Version one deliberately chooses the latter: raw connections eligible only
because `outbound` is configured are client-first. agentOS does not
speculatively open upstream, and a server-first protocol such as SSH or SMTP
times out during classification. Exact virtual routes and semantically known
HTTP remain deterministic; raw TCP compatibility outside a catch-all route
uses the existing direct path immediately.

### Guest-owned TLS

For curl, Git, and other guest software that performs TLS itself, the sidecar
peeks a bounded TLS ClientHello. Python paths already brokered as semantically
known HTTP do not use this guest-TLS route.

An exact middleware selected by retained virtual identity or ClientHello SNI
claims TLS on every port, including a nonstandard port with no ALPN. The
catch-all middleware claims TLS when:

- ALPN offers `http/1.1` or `h2`; or
- the destination uses the conventional HTTPS port and omits ALPN.

Once agentOS presents a generated certificate and accepts downstream TLS,
interception is irreversible. A selected connection that turns out to be
non-HTTP, pinned, nested TLS, malformed, or otherwise unsupported fails
closed. It never silently falls back to the original TLS stream.

Selected `h2`-only traffic is claimed and fails closed with
`no_application_protocol`; it never bypasses the middleware. Unmatched TLS remains
end-to-end and uses the existing direct path. TLS on a nonstandard port without
an HTTP ALPN identifier is not intercepted by the catch-all middleware in version
one. Every exact host is an explicit HTTP interception route and therefore
fails closed on non-HTTP traffic.

TLS 1.3 early data/0-RTT is disabled for intercepted connections. Encrypted
ClientHello is unsupported. If an exact virtual identity establishes selection,
ECH fails closed; a catch-all cannot recover a hidden authority on a
nonstandard route and does not claim it.

Consequently, catch-all guest TLS on a nonstandard port without HTTP ALPN, and
nonstandard ECH whose identity is not already fixed by an exact virtual route,
can remain on the direct path. `outbound` must not be used as the sole control
for deny-by-default egress. Configure exact hosts and ordinary agentOS network
permissions for security enforcement.

### Sidecar-owned TLS

The Node-compatible TLS implementation already owns plaintext and rustls state
inside the sidecar. It must not perform a second TLS MITM handshake. For a
matched request, the TLS capability transfers its plaintext side to the HTTP
interception engine before creating an upstream TLS connection.

Before reporting success, it performs a virtual handshake:

1. Generate or load the managed leaf for the canonical authority.
2. Validate that leaf using the guest/interception trust view.
3. Apply the guest's `servername`, explicit `ca`, `rejectUnauthorized`, and
   supported hostname/pinning callback behavior.
4. Negotiate only an implemented downstream ALPN and disable early data.
5. Emit `secureConnect` only after those checks succeed.
6. Expose deterministic generated peer-certificate, protocol, ALPN, and cipher
   metadata through the existing Node-compatible TLS APIs.

An explicit custom `ca` that excludes the managed CA, hostname callback
rejection, or pinning therefore fails exactly as it does for guest-owned TLS.
There is exactly one middleware invocation for each HTTP request regardless of
whether TLS was sidecar-owned or guest-owned.

Real unmatched sidecar-owned TLS uses a separate base/custom root view that
excludes the managed CA. The guest/interception view is used only for the
virtual managed leaf. A server signed only by the interception CA must never
authenticate as a real upstream server.

### HTTP versions

Version one intercepts downstream HTTP/1.0 and HTTP/1.1. Generated TLS server
configurations advertise only `http/1.1`.

- A client offering HTTP/2 and HTTP/1.1 negotiates HTTP/1.1.
- An HTTP/2-only client receives a deterministic unsupported-protocol failure.
- Selected h2c and HTTP/2 prior knowledge fail closed as unsupported.
- Unmatched direct HTTP/2 traffic remains unaffected.
- Host `fetch` may independently use HTTP/1.1, HTTP/2, or HTTP/3 upstream.

This covers mainstream LLM SDKs and SSE without introducing downstream HTTP/2
multiplexing into the first implementation.

## Authority binding

There is no global `IP -> hostname` provenance map: shared CDN addresses,
concurrent DNS results, refresh, and rebinding make such a map ambiguous.
agentOS obtains logical authority from exactly one of these sources:

| Connection path | Authoritative logical identity |
| --- | --- |
| semantically known HTTP API | API URL |
| exact virtual route | generation-scoped virtual-route identity |
| guest-owned TLS | ClientHello SNI, or destination IP for a true IP URL |
| cleartext HTTP | absolute request target or `Host`; retained virtual identity when present |

The physical destination IP is still range-checked before agentOS opens any
host socket. Logical hostname/port permission is enforced after the authority
is recovered, before callback invocation, before leaf-cache lookup or signing,
and before any upstream socket. Exact virtual short circuits have no physical
external address to range-check.

For TLS, ClientHello SNI must agree with an exact virtual identity when one
exists. After HTTP parsing, the request URL authority or `Host` header must also
agree with the authoritative identity.

A mismatch fails closed before middleware invocation. It must not allow an
intercepted connection selected for one provider to invoke a middleware for a
different provider. HTTP connection reuse cannot cross canonical authorities
in version one.

IP destinations use an IP identity and IP SAN. They do not send DNS SNI.
Hostname and port must both agree after normalizing default ports. HTTP/1.0
without `Host` uses the retained/API/virtual identity; when `Host` is present,
it must agree.

## Middleware request contract

The middleware receives one standard `Request` with:

- the original `http:` or `https:` URL;
- canonical hostname or IP and explicit non-default port;
- original path and query;
- method and end-to-end headers;
- a bounded, incremental body stream;
- an `AbortSignal` scoped to the invocation.

Hop-by-hop headers, proxy authentication headers, HTTP transfer framing,
`Content-Length`, and the wire `Host` header are removed before constructing
the `Request`. Host fetch recalculates framing from the streamed body;
authority is represented by `request.url`. Conflicting `Content-Length` and
`Transfer-Encoding`, invalid headers, request smuggling forms, or an authority
mismatch fail before middleware invocation.

agentOS invokes the middleware after validating and admitting request headers; it
does not wait for the body to finish. `Request.body` is a live `ReadableStream`
whose pulls grant byte credit through the client to the sidecar. A slow or
paused middleware therefore stops sidecar reads from the guest before any
agentOS-owned queue can grow without bound.

For requests with bodies, the client constructs the Web `Request` with
streaming-fetch semantics equivalent to `duplex: "half"`. This is a
construction requirement, not an additional public property, and ensures the
minimal `(request) => fetch(request)` POST middleware works in Node-compatible
hosts.

`limits.outboundHttp.maxRequestBodyBytes` is a total transfer limit, not a
buffering requirement. If a streamed body crosses the limit after middleware
invocation, agentOS aborts `request.signal`, cancels any forwarding fetch, and
returns 413 if response headers have not started. If response bytes already
started, it aborts the response/connection.

The downstream HTTP engine may automatically emit `100 Continue` when required
to begin streaming that body, but informational responses are not exposed to
the host middleware.

Valid HTTP/1 inputs that cannot be represented by a Fetch `Request` fail before
middleware invocation. Version one rejects:

- GET or HEAD with nonzero content length or transfer-encoded body framing;
- CONNECT, TRACE, and TRACK;
- an absolute-form target containing credentials;
- a method, URL, or header set rejected by the host `Request` constructor.

The body crosses the agentOS protocol once under bounded credit.
`Request.clone()` and the Web Streams tee created inside the trusted host
runtime may retain bytes for a slow clone branch; those post-delivery
allocations are the trusted host application's responsibility and are not
charged as sidecar memory.

The middleware may:

- inspect or consume the request;
- clone it;
- construct a replacement `Request`;
- call host `fetch`;
- return a synthetic `Response`;
- throw or reject.

Request bodies are one-shot according to standard Web API rules. The middleware
must construct or clone a request before consuming a body it intends to
forward.

Returning response headers does not by itself abandon the request stream. A
forwarding host `fetch` may resolve a `Response` while it still owns and
consumes `request.body`; in that case upload and download continue concurrently
under independent credit and timeout rules.

If the middleware returns and the incomplete request body has no active host
consumer, the client cancels the request stream. The client determines this
from the underlying stream's reader/lock and pull/cancel state, not merely from
middleware-promise completion. A disturbed but unlocked incomplete body is
abandoned; a body still locked by a forwarding fetch remains active. For
HTTP/1, abandonment marks the downstream connection non-reusable. agentOS
never drains an unconsumed or unbounded upload merely to preserve keep-alive.
If the response body reaches a terminal state before that retained upload, the
client cancels the remaining upload and likewise makes the connection
non-reusable.

`request.signal` aborts when:

- the guest closes or cancels the request;
- the VM generation is disposed;
- the request body crosses its total-byte or read-idle limit;
- the middleware-response deadline expires;
- the response idle or downstream-backpressure deadline expires;
- the sidecar/client connection closes.

A host fetch that uses this signal is therefore canceled with the guest
request. Middleware code that deliberately omits it owns the resulting host work.

## Middleware response contract

The middleware promise resolves when response status and headers are available.
The response body has an independent lifetime and crosses
client -> sidecar -> guest incrementally.

- The guest must observe early bytes before the producer closes.
- Byte order and content are preserved.
- Chunk boundaries may be split or coalesced.
- Empty, finite, binary, JSON, and long-lived streaming bodies are supported.
- SSE receives no special parsing or buffering.
- A streaming body has no synthesized `Content-Length`.
- Slow guest reads apply backpressure to client-side `ReadableStream` pulls.
- Guest cancellation calls `cancel()` on the returned body and aborts a
  forwarding host fetch when its signal/body is wired normally.

Web `Response` bodies are treated as semantic representation bytes, not
byte-transparent HTTP transfer payloads. The bridge:

- strips hop-by-hop and transfer-framing headers;
- discards `Content-Length` and lets the downstream HTTP engine frame the
  actual returned body;
- removes `Content-Encoding`, because common host fetch implementations expose
  decoded response bytes while retaining upstream encoding headers;
- removes body validators and range metadata invalidated by decoded or
  transformed bytes: `Content-MD5`, `Digest`, `Content-Digest`, `Repr-Digest`,
  `ETag`, `Accept-Ranges`, and `Content-Range`;
- preserves end-to-end headers where the Web `Headers` API can represent them.

Consequently, returning an intentionally pre-compressed encoded body is not
supported in version one. The middleware should return decoded bytes.

Informational responses and trailers are not representable in version one.
WebSocket and CONNECT upgrades are rejected.

Before `OutboundResponseStart`, the client rejects an invalid status/header
set or a locked/disturbed response body. Response bodies are suppressed for
HEAD and statuses 204, 205, and 304 even if the middleware supplied one. Rejected
or suppressed bodies are canceled, and the invocation signal is aborted when
the response itself is rejected, so an upstream fetch or custom producer
cannot continue unnoticed. The bridge transports status, semantic headers, and
body only; `Response.url`, `redirected`, `type`, and other host-fetch metadata
do not cross to the guest. HTTP reason phrases are not semantic and use the
downstream engine's canonical value rather than transporting `statusText`.

Web `Headers` cannot preserve arbitrary raw header ordering and duplicates, so
fidelity means semantic Web-header fidelity rather than byte-for-byte header
fidelity. Multiple `Set-Cookie` values are transported separately using
`Headers.getSetCookie()` or the runtime's equivalent when available.

Redirects followed inside host `fetch` do not re-enter agentOS. A middleware that
returns a manual 3xx to the guest may cause the guest SDK to issue a new HTTP
request; that new request goes through normal middleware selection.

Backpressure bounds agentOS-owned buffers and applies when a trusted producer
honors Web stream pull/desired-size semantics. agentOS cannot bound arbitrary
memory deliberately retained or enqueued internally by trusted middleware code.

## Callback transport

The existing one-shot JSON host-callback protocol is not sufficient for
streaming bodies. The sidecar protocol will add an ownership-scoped outbound
HTTP callback and bidirectional body-stream extension on the required
full-duplex fd 3 lane.

Before VM execution, the owning client registers generation-scoped opaque
capability IDs for the catch-all and raw exact-host keys. The sidecar validates
and canonicalizes the keys, rejects canonical duplicates, installs virtual
routes, and acknowledges the complete bounded set atomically; partial
registration never becomes visible. The acknowledgement contains a sidecar
issued registration epoch and digest of the canonical route set.

A reconnect proves ownership of the live VM generation, uses a fresh
registration epoch plus fresh capability/invocation/stream IDs, and may replace
capabilities only for the identical route digest. Adding or removing a route
requires a new VM generation. Old-epoch frames are rejected as stale, and
identifiers are never reused within an epoch.

The body-stream protocol consists of:

```text
OutboundRequestStart
  invocation id, VM id, generation, registration epoch,
  selected middleware capability id,
  method, URL, ordered headers,
  optional declared request body length, optional request body stream id

OutboundRequestChunk
  request stream id, sequence, bytes

OutboundRequestEnd
  request stream id

OutboundResponseStart
  invocation id, status, ordered headers, optional response stream id

OutboundResponseChunk
  stream id, sequence, bytes

OutboundResponseEnd
  stream id

OutboundStreamCredit
  stream id, additional byte credit

OutboundStreamCancel
  stream id, typed reason

OutboundStreamError
  stream id, typed public reason

OutboundInvocationCancel
  invocation id, typed reason
```

The generated BARE protocol must define concrete types for these messages; they
must not remain untyped JSON envelopes in the shipped implementation.

Protocol invariants:

- Every identifier is scoped by VM id, generation, and registration epoch.
- The client dispatches only the selected opaque capability ID; it does not
  independently repeat hostname matching.
- A response-start path is reserved before dispatching the request.
- The client invokes the middleware after `OutboundRequestStart`, without waiting
  for `OutboundRequestEnd`, and constructs its request `ReadableStream` from
  subsequent request stream frames.
- A client request-body pull grants credit to the sidecar. The sidecar reads
  from the guest only while credit and VM buffer reservations are available.
- Request upload and response download may progress concurrently. A middleware may
  return response headers or body bytes before the request reaches EOF.
- A request or response body stream receives bytes only while it owns byte
  credit granted by the next consumer.
- Credit is issued only after the consumer has reserved corresponding space.
- Chunks are no larger than `limits.outboundHttp.maxChunkBytes`.
- Sequence numbers are contiguous; duplicate, skipped, stale-generation, or
  post-terminal chunks are rejected and logged.
- End, error, and cancel are terminal and idempotent.
- `OutboundInvocationCancel` aborts `request.signal` and the Rust invocation
  token before or after response start. After response start, it is accompanied
  by `OutboundStreamCancel` for every active request and response stream.
- Guest cancellation during overlapping upload/download is one logical
  transition: the sidecar sends invocation cancel first, then cancel for both
  stream IDs, and closes or resets the guest HTTP exchange. The client aborts
  the invocation signal and cancels both stream controllers idempotently, which
  aborts a normally wired forwarding fetch.
- If a middleware returns while an active host consumer still owns the request
  body, request frames continue. If no consumer owns the incomplete body, the
  client cancels it; the sidecar stops reading and makes the downstream HTTP/1
  connection non-reusable.
- Control and response-start frames have scheduler priority over body frames.
  Because fd 3 is one physical byte stream, they may be delayed by at most one
  already-writing bounded frame, never an unbounded body or queue.
- No Tokio worker performs a blocking channel send.
- One slow stream cannot prevent callback responses, shutdown control,
  heartbeats, or unrelated streams from advancing.
- Client or sidecar loss cancels all streams owned by that connection.
- The old client's local transport-loss watcher aborts its middleware signals and
  bodies without waiting for cancel frames on the dead connection.

`OutboundResponseStart`, invocation cancel, and transport loss contend on one
atomic invocation state transition:

- If cancel or loss commits first, response start and every later body frame are
  rejected as terminal or unknown; IDs are never reused within an epoch. The
  client cancels any late middleware/response body.
- If response start commits first, pre-response replacement is no longer
  possible. Cancellation proceeds through the invocation token and every active
  request/response stream, and the guest observes a truncated/erroring response.

This transition determines whether callback loss yields a pre-header 503 or a
post-header body/connection abort.

Configuration validation requires every encoded start/control frame and
`maxChunkBytes` plus framing overhead to fit the existing physical protocol
frame limit. The sidecar rejects an incompatible limit configuration before VM
creation.

`maxInFlightMiddlewareInvocations` is held from callback admission through
`OutboundResponseStart`. A long-lived body releases that middleware slot and holds
only its connection, active-stream, and byte reservations. The request stream
may remain active during an early response and retains its own reservations
until it ends or is canceled.

The implementation uses the process's existing shared Tokio runtime. It must
not create a proxy-owned runtime, a per-VM runtime, a per-connection thread, a
polling timer, or an unbounded channel.

## TLS and certificate authority

### Lifecycle

When at least one outbound middleware is configured, agentOS creates one
cryptographically random ECDSA P-256 interception CA for that VM generation.

- The CA is stable for the life of one VM generation.
- Different VMs and recreated generations receive different CAs.
- The private key and signing issuer exist only in trusted sidecar memory.
- The private key never appears in VFS, environment variables, protocol
  frames, logs, traces, SQLite, snapshots, exported layers, agentOS diagnostic
  attachments, or host callback arguments.
- The CA, leaf cache, and pending signing work are dropped on generation
  teardown. Late completions are generation-checked and discarded.
- No custom CA, private-key import, or private-key export API exists in version
  one.

This non-persistence promise covers state and diagnostics created by agentOS.
An operating-system core dump or full process-memory dump can contain any
in-memory secret; production sidecar launch must disable such dumps or protect
them as secrets. Dropping the issuer is not claimed to prove memory
zeroization.

The CA has:

- ECDSA P-256/SHA-256 key and signature;
- critical `BasicConstraints CA=true` with path length zero;
- critical `keyCertSign` key usage;
- a 128-bit cryptographically random positive serial;
- `notBefore = creation - 5 minutes`;
- `notAfter = creation + 10 years`.

The effective CA lifetime remains the VM generation because its key is not
persisted. A still-running generation warns 30 days before CA expiry and must
be recreated before expiry; it never silently continues with an expired CA.

### Public trust material

The following public files are projected into the VM:

```text
/etc/agentos/certs/outbound-proxy-ca.crt
    managed public interception CA only

/etc/ssl/certs/ca-certificates.crt
    effective base/custom VM roots plus the managed public CA

/etc/ssl/cert.pem
    symlink to certs/ca-certificates.crt
```

The managed layer is ephemeral, read-only even to guest root, and never
captured into a durable root snapshot. Guest writes to its files or symlink
fail with `EROFS`; trust changes must be supplied through the caller-owned base
root for a new generation. On restore or recreation, stale managed CA bytes are
removed before the new generation's CA is projected.

To determine the caller's base roots, agentOS resolves the effective root
filesystem immediately before applying the ephemeral interception layer:

- A regular file at either conventional path is parsed as PEM.
- A symlink is resolved through VFS-safe beneath-root traversal.
- If both paths resolve to different valid bundles, their certificates are
  unioned and deduplicated.
- An invalid PEM bundle or unsafe/broken symlink fails VM creation when middleware
  are enabled.

agentOS then constructs an ephemeral merged view containing the base roots and
managed public CA. It does not discard or mutate the caller's source layer.
The ephemeral layer intentionally makes `/etc/ssl/cert.pem` the conventional
symlink shown above while interception is enabled.

Directories are root-owned mode `0755`, public certificate files are root-owned
mode `0644`, and the symlink is non-writable metadata. VFS-safe merge and
symlink resolution are mandatory.

The sidecar/runtime, not the thin clients, supplies conventional guest
environment hints where the runtime honors them:

```text
SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
CURL_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
GIT_SSL_CAINFO=/etc/ssl/certs/ca-certificates.crt
NODE_EXTRA_CA_CERTS=/etc/agentos/certs/outbound-proxy-ca.crt
```

Additional package-manager-specific aliases may point to the same public
bundle. The environment never contains a private-key path.

An explicit caller-provided environment value wins over a runtime hint in
guest software that honors that variable. Such a value may select a trust store
that omits the managed CA and therefore cause guest-owned interception to fail,
which is preferable to silently overriding caller input. The sidecar-owned
Node-compatible virtual verifier applies explicit Node TLS `ca`/hostname/pin
options and the same startup trust inputs that its unmatched Node path actually
supports; it does not claim that unrelated guest environment variables alter
that verifier.

This one CA covers curl, Git, Node-compatible runtimes, and arbitrary WASM
software within the VM generation when they use the canonical bundle or
environment hints. Brokered Python HTTP enters the semantically known path and
does not require a guest TLS CA. Leaf certificates cover destination
identities, not runtimes. A client using `--cacert`, a Node `ca` option, SPKI
pinning, NSS/JKS, an embedded root store, or another private trust mechanism
may exclude the managed CA and will fail interception.

### Leaf certificates

Leaf certificates:

- have a subject CN equal to the canonical DNS or IP identity and exactly one
  matching canonical DNS SAN or IP SAN; the SAN remains authoritative;
- contain no wildcard and do not copy upstream certificate identity fields;
- use server-auth EKU and digital-signature key usage;
- have a unique ECDSA P-256 key and 128-bit random positive serial;
- use `notBefore = issuance - 5 minutes` and
  `notAfter = min(issuance + 24 hours, CA notAfter)`;
- never outlive the CA;
- use algorithms supported by the existing rustls/aws-lc and guest mbedTLS
  stacks.

Leaf private keys follow the same in-memory-only and generation-scoped rules as
the CA private key.

Leafs are stored in a bounded per-VM LRU cache keyed by canonical DNS or IP
identity. Concurrent issuance for one identity is single-flight. Key generation
and certificate signing use the shared bounded blocking executor, never a Tokio
runtime worker. A cached leaf is atomically replaced when it has less than six
hours remaining.

`maxCertificateCacheBytes` accounts exact owned hostname, certificate DER, and
private-key bytes; it does not use an estimate for opaque allocator state.
Opaque fixed-shape rustls server-configuration allocations are bounded by
`maxCertificateCacheEntries`, with no attacker-controlled collection inside
each entry. Metrics distinguish the exact byte ledger from the entry-count
bound rather than presenting estimated memory as a hard byte guarantee.

### Upstream trust

Matched requests have no automatic sidecar upstream connection. If a middleware
forwards, the trusted host's `fetch` owns DNS, TLS, redirects, connection
pooling, and upstream verification.

agentOS does not install the managed interception CA into the host process
trust store or mutate host TLS environment variables. A future sidecar-owned
forwarding helper must build its upstream verifier from the effective base
roots before adding the managed CA to the guest view; the interception CA must
never authenticate an upstream server.

### Unsupported TLS behavior

The following fail closed for matched traffic and never silently retry through
direct TCP:

- certificate pinning or a trust store that excludes the managed CA;
- malformed, oversized, fragmented-over-limit, or stalled ClientHello;
- unsupported ALPN or TLS version;
- SNI, logical destination, and HTTP authority disagreement;
- non-HTTP plaintext after an intercepted TLS handshake;
- CONNECT, WebSocket upgrade, or nested TLS;
- middleware failure, timeout, overload, or limit exhaustion.

Guest code receives the protocol-native TLS/network failure when HTTP has not
started. Once an HTTP request is available, the HTTP failure mapping below
applies. Trusted logs receive the typed agentOS error with VM, generation,
request, and canonical host identifiers but never request bodies, credentials,
private keys, or sensitive headers.

End-to-end guest client-certificate identity is not preserved. A middleware that
needs upstream mTLS must configure a host-side client identity for its own
fetch client. agentOS may not detect a guest certificate that was configured
but never requested; it does guarantee that a real upstream mTLS requirement
cannot be transparently satisfied using proof from the separate guest-side
handshake.

## Limits and backpressure

The two middleware properties remain the complete normal-use API. Tunable safety
limits live under the existing VM `limits` configuration:

```ts
interface OutboundHttpLimits {
	maxExactMiddlewareRoutes?: number;
	maxExactMiddlewareKeyBytes?: number;
	maxExactMiddlewareTotalBytes?: number;
	maxConnections?: number;
	maxInFlightMiddlewareInvocations?: number;
	maxActiveResponseStreams?: number;
	maxClassificationPrefixBytes?: number;
	maxRequestTargetBytes?: number;
	maxRequestHeaderCount?: number;
	maxRequestHeaderBytes?: number;
	maxRequestBodyBytes?: number;
	maxBufferedRequestBytes?: number;
	maxTotalBufferedRequestBytes?: number;
	maxResponseHeaderCount?: number;
	maxResponseHeaderBytes?: number;
	maxBufferedResponseBytes?: number;
	maxTotalBufferedResponseBytes?: number;
	maxChunkBytes?: number;
	maxClientHelloBytes?: number;
	maxCertificateCacheEntries?: number;
	maxCertificateCacheBytes?: number;
	maxPendingCertificateIssuance?: number;
	classificationTimeoutMs?: number;
	tlsHandshakeTimeoutMs?: number;
	requestReadIdleTimeoutMs?: number;
	connectionIdleTimeoutMs?: number;
	middlewareQueueTimeoutMs?: number;
	middlewareResponseTimeoutMs?: number;
	responseIdleTimeoutMs?: number;
	downstreamBackpressureTimeoutMs?: number;
}

interface AgentOsLimits {
	outboundHttp?: OutboundHttpLimits;
}
```

These limits must exist in the shared VM config and generated TypeScript and
Rust client types. Defaults are sidecar-owned; omitted wire fields mean use the
sidecar defaults:

| Field | Version-one default |
| --- | ---: |
| `maxExactMiddlewareRoutes` | 128 |
| `maxExactMiddlewareKeyBytes` | 255 bytes |
| `maxExactMiddlewareTotalBytes` | 32 KiB |
| `maxConnections` | 128 |
| `maxInFlightMiddlewareInvocations` | 32 |
| `maxActiveResponseStreams` | 128 |
| `maxClassificationPrefixBytes` | 64 KiB |
| `maxRequestTargetBytes` | 16 KiB |
| `maxRequestHeaderCount` | 128 |
| `maxRequestHeaderBytes` | 64 KiB |
| `maxRequestBodyBytes` | 16 MiB total transfer per request |
| `maxBufferedRequestBytes` | 1 MiB in flight per request |
| `maxTotalBufferedRequestBytes` | 16 MiB in flight per VM |
| `maxResponseHeaderCount` | 128 |
| `maxResponseHeaderBytes` | 64 KiB |
| `maxBufferedResponseBytes` | 1 MiB per response |
| `maxTotalBufferedResponseBytes` | 16 MiB per VM |
| `maxChunkBytes` | 64 KiB |
| `maxClientHelloBytes` | 64 KiB |
| `maxCertificateCacheEntries` | 256 |
| `maxCertificateCacheBytes` | 8 MiB |
| `maxPendingCertificateIssuance` | 8 |
| `classificationTimeoutMs` | 10,000 |
| `tlsHandshakeTimeoutMs` | 10,000 |
| `requestReadIdleTimeoutMs` | 30,000 |
| `connectionIdleTimeoutMs` | 60,000 |
| `middlewareQueueTimeoutMs` | 5,000 |
| `middlewareResponseTimeoutMs` | 300,000 |
| `responseIdleTimeoutMs` | 300,000 |
| `downstreamBackpressureTimeoutMs` | 300,000 |

Each default must be added to the limits inventory with its rationale in the
implementation change.

The per-stream and per-VM buffered request and response values are sliding
in-flight bounds, not total transferred sizes. A request can transfer up to
`maxRequestBodyBytes`, and a long response can transfer without a total byte or
duration limit while agentOS-owned memory stays bounded.

Before response headers, exactly one progress clock runs:

- While the middleware has an outstanding request-body pull and the sidecar is
  waiting for guest bytes, `requestReadIdleTimeoutMs` runs.
- Otherwise, `middlewareResponseTimeoutMs` runs from invocation and resets
  whenever the middleware consumes request-body bytes.

This lets a middleware stream a long but progressing upload to host `fetch`
without allowing a middleware that neither pulls nor returns to occupy a slot
forever. Once request EOF arrives, only `middlewareResponseTimeoutMs` remains.

After response headers, upload and download clocks operate independently:

- Until request EOF or cancellation, `requestReadIdleTimeoutMs` bounds lack of
  positive upload consumption whether the sidecar is waiting for guest bytes
  or the host consumer has stopped pulling.
- `responseIdleTimeoutMs` bounds lack of positive producer progress while the
  guest has response credit.
- `downstreamBackpressureTimeoutMs` bounds continuous time with no response
  credit from the guest.

The last bound prevents a hostile guest from retaining a middleware-created host
fetch, socket, callback, or stream reservation forever merely by stopping
reads. It must be high enough for intended paused-client behavior and is
raiseable like every other limit.

Only positive body bytes or an end/error/cancel terminal transition count as
progress. Zero-length chunks, redundant credit, and nonterminal control frames
do not reset any progress clock.

`maxExactMiddlewareRoutes` also bounds virtual DNS routes.
`maxExactMiddlewareTotalBytes` includes canonical keys and route metadata.
`maxClassificationPrefixBytes` bounds cleartext sniffing.
`maxClientHelloBytes` bounds ClientHello reassembly; existing
`limits.tls.maxBufferedBytes` continues to bound the complete TLS handshake and
record state. Header count and byte limits both apply, so many empty headers
cannot escape accounting.

All counters and byte reservations belong to the VM resource ledger. Every
queue and cache:

- has item and byte bounds where applicable;
- warns and emits a structured metric near its threshold;
- stops pulling or reading at capacity;
- releases its reservation on completion, cancel, error, or teardown;
- fails with a typed error that names the exact `limits.outboundHttp.*` field
  and how to raise it.

Admission is fair across VMs. A long-lived SSE response consumes a bounded
connection, active-stream, and byte reservation after response start, but not
an in-flight-middleware slot. It must not monopolize a runtime worker or prevent
short requests from progressing.

### Limit outcomes

Every limit has one owning phase and deterministic outcome:

| Limit | Outcome at exhaustion | Middleware invoked? |
| --- | --- | --- |
| `maxExactMiddlewareRoutes`, key bytes, or total bytes | reject `AgentOs.create()` with the exact field | no |
| `maxConnections` | HTTP-known connection gets 503 with `Retry-After: 1`; unclassified TCP is reset with typed host error | no |
| `maxInFlightMiddlewareInvocations` | wait only through `middlewareQueueTimeoutMs`, then 503 with `Retry-After: 1` | no |
| `maxActiveResponseStreams` | middleware response cannot start: 503 with `Retry-After: 1` | yes |
| `maxClassificationPrefixBytes` or `classificationTimeoutMs` | ambiguous TCP is reset; recognized selected HTTP fails closed | no |
| `maxRequestTargetBytes` | 414 | no |
| request header count/bytes | 431 | no |
| `maxRequestBodyBytes` total transfer | 413 before response start; otherwise abort body/connection | yes |
| per-request or per-VM buffered request bytes | stop credit and guest reads; a producer protocol violation aborts the request | yes |
| response header count/bytes | 500 invalid middleware response | yes |
| per-response or total buffered response bytes | stop credit/pulls/admission; a producer protocol violation aborts the body | yes |
| `maxChunkBytes` or physical frame mismatch | reject config; oversized runtime frame is a terminal typed protocol error | no new invocation |
| `maxClientHelloBytes` or `tlsHandshakeTimeoutMs` | TLS alert/reset with typed host error | no |
| certificate cache entries | evict LRU before issuance | no, until TLS succeeds |
| certificate cache bytes | evict LRU; a single non-fitting leaf fails TLS | no |
| pending certificate issuance | TLS internal-error/overload | no |
| `requestReadIdleTimeoutMs` | 408 before response start; otherwise abort body/connection | yes |
| `connectionIdleTimeoutMs` | close idle keep-alive connection without a synthetic response | no |
| `middlewareQueueTimeoutMs` | 503 with `Retry-After: 1` seconds | no |
| `middlewareResponseTimeoutMs` | 504 and invocation cancel | yes |
| `responseIdleTimeoutMs` | abort body/connection after response start | yes |
| `downstreamBackpressureTimeoutMs` | cancel host response stream/fetch and abort body/connection | yes |

Existing TLS ciphertext/plaintext and protocol-frame limits retain their own
canonical configuration fields. The outbound error references that existing
field rather than inventing a duplicate `outboundHttp` field.

## Failure semantics

The limit-outcomes table above is the single authoritative mapping for limit
and timeout failures. The remaining pre-response failures are:

| Failure | Guest HTTP result |
| --- | --- |
| middleware throws, rejects, or returns an invalid response | 500 |
| client callback is unavailable or closes before response headers | 503 |
| internal interception protocol failure | 500 |

A guest network-policy denial never invokes the middleware or opens an upstream
socket, and it is not converted to an HTTP status. A semantically known,
virtual-route, or physical-IP-known path fails its connect/request operation
with `EACCES`. For raw cleartext or ordinary guest TLS whose logical hostname
is learned only from `Host` or SNI after the local socket connected, the first
classified write or TLS handshake fails and the trusted typed cause is
`EACCES`; curl or a TLS library may expose that as its normal wrapping
network/TLS error. Cloudflare returns an explicit HTTP response for its own
policy denial, but agentOS preserves the closest Linux-facing error available
at each transport phase.

A valid `Response` returned by the middleware is passed through after the
normalization described above, including an explicit 4xx or 5xx status.
agentOS does not synthesize 502 for a rejected middleware promise. In the minimal
API, it cannot distinguish a failed upstream host `fetch` from any other
middleware exception. A forwarding middleware that wants gateway semantics catches
that failure and explicitly returns a 502 response:

```ts
try {
	return await fetch(request);
} catch {
	return new Response("Bad Gateway", { status: 502 });
}
```

This follows the ownership boundary in the reference implementations:
Cloudflare directly propagates its outbound-handler result, while Hudsucker and
OpenAI Codex use 502 for failures in upstream forwarding that their proxy
layers own. agentOS owns no upstream connection after middleware invocation;
the host middleware does.

Synthetic error responses contain a stable public agentOS error code and a
short non-sensitive message. Default structured logs contain only the stable
error code/class and request identifiers. Raw middleware exception messages and
stack traces are not logged because arbitrary exception text may itself contain
credentials or bodies; they require an explicit trusted debug opt-in. URLs with
credentials, bodies, authorization headers, cookies, private keys, and host
secrets are never returned to the guest.

After response headers or body bytes have started, a later failure cannot
replace the status. agentOS aborts the HTTP body/connection, cancels the host
stream, records the typed failure, and releases reservations. The guest
observes a truncated/erroring body rather than a false successful completion.

Malformed TLS and failures before HTTP parsing use TLS alerts, connection reset,
or the closest existing POSIX error rather than a fabricated HTTP response.

## Implementation libraries

agentOS will use libraries one level below a complete proxy framework:

- `tokio`: existing shared asynchronous runtime;
- `rustls` and `tokio-rustls`: downstream TLS records, handshake, ALPN, and
  certificate presentation;
- `rcgen`: ephemeral CA and per-identity leaf construction;
- `hyper`: downstream HTTP/1 parsing, framing, keep-alive, body handling, and
  upgrades needed to reject unsupported forms correctly;
- `httparse`: bounded cleartext prefix recognition before handing the complete
  connection to hyper;
- `hyper-util`: Tokio I/O adapters and connection utilities;
- `http`, `bytes`, and `http-body-util`: request, response, header, and body
  types.

The native sidecar already depends on Tokio, rustls, tokio-rustls, `http`,
`bytes`, and `h2`. The expected new focused dependencies are `hyper`,
`hyper-util`, `http-body-util`, `httparse`, and `rcgen`.

Hudsucker and OpenAI's Codex network proxy are implementation references, not
runtime dependencies:

- Codex is the reference for ephemeral in-memory CA ownership, public trust
  bundle projection, and ecosystem trust hints.
- Hudsucker is the reference for hyper/rustls interception and bounded dynamic
  certificate caching.
- mitmproxy is the behavioral reference for TLS and HTTP interception edge
  cases.
- mkcert is the compatibility reference for trust-store differences.

agentOS must not introduce Hudsucker's listener-owned proxy topology, an
internal loopback proxy, Rama as a second networking framework, a private Tokio
runtime, or hand-written HTTP/TLS/cryptographic parsing.

For matched requests, hyper is a downstream server engine. It is not an
automatic upstream client: the trusted middleware's host `fetch` performs
forwarding.

### Prior art

- Cloudflare Sandbox outbound handlers define the public `outbound` and
  `outboundByHost` shape. Its implementation returns the handler result
  directly rather than translating handler rejection into 502:
  <https://developers.cloudflare.com/sandbox/guides/outbound-traffic/>
  <https://github.com/cloudflare/containers/blob/main/src/lib/container.ts>
- OpenAI Codex supplies the closest Rust reference for managed CA lifecycle,
  public trust bundles, host certificate isolation, and 502 for proxy-owned
  upstream failures:
  <https://github.com/openai/codex/tree/main/codex-rs/network-proxy>
- Hudsucker supplies the closest embeddable Rust reference for hyper/rustls
  interception, dynamic certificate caching, and 502 for proxy-owned upstream
  client failures:
  <https://github.com/omjadas/hudsucker>
- mitmproxy documents mature interception behavior and TLS edge cases:
  <https://docs.mitmproxy.org/stable/concepts/how-mitmproxy-works/>
- mkcert documents the differences among system, Node, NSS, Java, and
  application-specific trust stores:
  <https://github.com/FiloSottile/mkcert>

## Public documentation

The implementation change must ship public documentation with the API. The
primary guide is a new source document:

```text
website/src/content/docs/docs/outbound-http-middleware.mdx
```

It is published at `/docs/outbound-http-middleware` with the title **Outbound
HTTP Middleware**. It owns the user-facing explanation and must cover:

- the minimal `outbound` and `outboundByHost` API and exact-host precedence;
- the single-selected-function model, with host `fetch` as continuation and no
  built-in `next()` chain;
- process-local `AgentOs.create()` lifecycle, reconnect behavior, and the fact
  that middleware functions are not serialized into preconfigured VMs;
- forwarding with host `fetch`, request mutation, synthetic responses, and
  explicit 502 handling for host-owned upstream failures;
- bidirectional request/response streaming, cancellation, and backpressure;
- credential injection and host responsibility for SSRF, redirect, DNS, TLS,
  and upstream policy;
- mock LLM and embedded LLM gateway patterns;
- the managed public CA paths, automatic trust behavior for curl, Git,
  Node-compatible code, Python, and WASM, plus pinning/private-store limits;
- the distinction between exact fail-closed routes and the catch-all's
  client-first, ALPN, ECH, raw-TCP, and nonstandard-port limitations;
- interaction with network permissions and the path-specific denial behavior;
- the stable 500/503/504 behavior, explicit middleware responses, raiseable
  `limits.outboundHttp.*` fields, and relevant observability;
- TypeScript and Rust examples and parity expectations.

Runnable documentation examples must come from checked files under:

```text
examples/outbound-http-middleware/
```

At minimum, checked examples demonstrate catch-all forwarding, exact-host
mutation/credential injection, a streaming mock LLM, and the two-step embedded
gateway rewrite. The guide embeds them with `<CodeSnippet>`; it does not
duplicate runnable examples inline.

The same change must update:

- `website/src/content/docs/docs/networking.mdx` with a short **Outbound HTTP
  middleware** section that distinguishes guest-to-host egress interception
  from host-to-guest `httpRequest` and previews, then links to the dedicated
  guide;
- `website/src/content/docs/docs/architecture/networking.mdx` with the
  sidecar-owned interception point, host callback path, TLS classification,
  and a link to the public guide;
- `website/src/content/docs/docs/permissions.mdx` to state that permission
  checks run before middleware invocation and link to the guide;
- `website/src/content/docs/docs/resource-limits.mdx` with the
  `limits.outboundHttp.*` inventory and link to the guide;
- `website/src/content/docs/docs/architecture/tls-ssl.mdx` with the generated
  interception CA/trust-overlay behavior and link to the guide;
- `website/src/content/docs/docs/llm-gateway.mdx` with a link to the embedded
  gateway pattern rather than duplicating its API contract;
- `website/docs.config.mjs` so **Outbound HTTP Middleware** appears next to
  **Networking & Previews** in navigation.

Generated public Markdown and route/registry artifacts must be regenerated by
the website tooling rather than edited as independent sources. Documentation
validation runs the checked example type checks and `pnpm --dir website build`;
broken navigation, snippets, or links fail the implementation change.

## Observability

Each intercepted request records structured, redacted events for:

- selection outcome: exact, catch-all, or direct;
- logical hostname, scheme, and port;
- sidecar-owned or guest-owned TLS path;
- middleware queue and execution durations;
- first-response-byte and completion durations;
- request and response byte counts;
- cancellation or typed failure;
- current connection, middleware, stream, buffer, and certificate-cache pressure.

The default trace never records request/response bodies, authorization,
cookies, private keys, or complete sensitive URLs. Near-limit warnings reach
stderr or structured tracing and identify the configuration field.

Acceptance tests capture real stderr and structured traces and assert selection
mode, TLS ownership, queue time, first-byte/completion time, cancellation,
pressure, and near-limit warning records. They inject credentials, cookies,
body canaries, and exception-message canaries and require every default log and
trace field to remain free of those values.

## Verification strategy

Tests use only deterministic local fixtures. Required gates must not depend on
the public internet, external DNS, production credentials, or insecure TLS
flags.

### Unit and property tests

Cover:

- DNS IDNA/case/trailing-dot normalization and IP canonicalization;
- invalid and duplicate normalized middleware keys;
- own-property enumeration, hostile prototype keys, exact-middleware count, and
  canonical/total key-byte boundaries;
- exact, catch-all, and direct precedence;
- logical destination/SNI/Host agreement;
- HTTP header validation, hop-by-hop stripping, smuggling inputs, and response
  framing normalization;
- CA uniqueness, leaf CN/SAN/EKU/key usage/serial/validity, and wrong-host
  rejection;
- CA public paths and absence of private material from every serializable type;
- leaf-cache count/byte LRU bounds, single-flight issuance and renewal with an
  injected clock, churn, and teardown;
- ClientHello fragmentation, malformed input, byte/time limits, and ALPN;
- callback protocol codec round trips;
- atomic registration readiness, canonical route digests, epoch replacement,
  response-start/cancel/loss races, and rejection of every stale old-epoch
  frame;
- failure injection at each registration, virtual-DNS, CA, VFS projection, and
  verifier-readiness step proves atomic rollback and that no guest code starts;
- request and response stream credit, sequence, end/error/cancel, stale
  generation, and exact-boundary/one-over-limit behavior;
- zero-byte chunks, redundant credit, and nonterminal control frames never
  reset progress clocks;
- request-body chunk/frame aggregation, physical frame-cap validation, and
  invocation cancellation before response start;
- error redaction and typed limit messages.

Property/fuzz targets include hostname inputs, HTTP/1 request heads,
ClientHello classification, callback stream frame sequences, and cancellation
at every state transition.

### Native sidecar integration tests

Run against the real shared Tokio reactor with deterministic callback and
network fixtures. Prove:

- no additional Tokio runtime, polling timer, per-connection thread, or
  unbounded queue is introduced;
- sidecar-owned and guest-owned TLS invoke exactly one middleware;
- slow host request consumption stops guest reads at the request byte-credit
  bound and resumes in order;
- slow guests stop response-stream pulls at the byte-credit bound;
- a guest that withholds response credit past
  `downstreamBackpressureTimeoutMs` cancels the host fetch and releases every
  reservation;
- an upstream that returns response headers before request EOF continues
  consuming the locked upload while the response downloads concurrently;
- response-start and cancellation have scheduler priority and are delayed by
  no more than one bounded already-writing frame while body lanes are full;
- VM/client teardown cancels handshake, callback wait, and active SSE work;
- generation-stale DNS routes, certificates, callbacks, and chunks cannot
  affect a recreated VM;
- permission denial precedes leaf lookup/issuance and cannot churn the signing
  queue or cache;
- all resource gauges return to baseline after completion and cancellation;
- partial headers, partial fixed/chunked bodies, and idle keep-alive connections
  time out without leaking reservations;
- a test issuer blocked on the bounded signing executor cannot delay heartbeat,
  shutdown, unrelated requests, or another VM.

### Reusable outbound origin fixture

One fixture provides:

- HTTP and HTTPS listeners;
- a test root plus valid, wrong-host, expired, and self-signed leaves;
- echo and binary-body endpoints;
- deterministic barrier-controlled streaming and SSE endpoints;
- slow-reader and slow-writer endpoints;
- abrupt close and malformed response behavior;
- optional mTLS;
- connection, request, byte, cancellation, and concurrency counters.

Additional helpers provide:

- synthetic exact-host DNS routing without a loopback bypass;
- certificate decoding and verification;
- a host middleware recorder with invocation and active-stream counters;
- OpenAI- and Anthropic-compatible finite and SSE llmock responses;
- a generic shipped WASM HTTP/TLS client in addition to curl, wget, and Git.

The Git fixture performs a real HTTPS smart-protocol operation. Python coverage
uses the shipped guest `urllib.request` and `requests` paths rather than a host
Python process. The generic WASM artifact is a real Linux-in-WASM HTTP/TLS
program using the canonical VM trust bundle, not a host compatibility stub.

### Public client end-to-end tests

These tests spawn the real built native sidecar through the public client and
execute real guest code. CI prerequisites are mandatory; a missing sidecar or
runtime artifact fails required CI rather than silently skipping it.

The P0 matrix is:

| Area | Required end-to-end proof |
| --- | --- |
| Selection | exact beats catch-all; catch-all beats direct; no middleware leaves the existing path unchanged |
| Virtual host | a genuinely non-resolvable exact host works over HTTP and HTTPS without external DNS or upstream sockets |
| Shared address | two concurrent DNS names sharing one A/AAAA address never swap permission, SNI, SAN, authority, or middleware identity |
| Request fidelity | method, URL, port, path, query, headers, and empty/fixed/chunked/unknown-length binary and JSON bodies arrive correctly |
| Mutation | middleware changes method, URL, headers, and body; downstream framing is recalculated |
| Short circuit | middleware returns status, headers, finite body, and streamed body without opening upstream |
| Error | throw, rejection, timeout, malformed response, oversize, and mid-body failure match the failure table |
| Plain HTTP | real Node-compatible fetch and a shipped WASM client traverse the middleware |
| Raw TCP | catch-all sniffing replays a non-HTTP prefix exactly once, preserves bidirectional data and half-close, and never invokes the middleware |
| Server-first TCP | with only exact routes, SSH/SMTP-style banners retain direct behavior; with `outbound`, the client-first classification deadline fires without opening upstream |
| HTTPS trust | sidecar-owned Node TLS and guest-owned curl, wget, Git, and generic WASM accept the generated CA without insecure flags; brokered Python routing also invokes the middleware |
| TLS path behavior | mutation, short circuit, error, and streaming work through both sidecar-owned and guest-owned TLS paths |
| CA isolation | private CA key is absent from VFS, environment, protocol capture, logs, SQLite, snapshots, layers, and persisted artifacts |
| CA lifecycle | public CA is stable within one generation, unique across VMs, and replaced on recreation |
| Trust merge | caller roots and managed CA both remain trusted while caller source layers/snapshots remain unchanged |
| Trust overlay writes | guest root receives `EROFS` when modifying projected trust paths; snapshot/restore contains no managed bytes and a new generation rotates the CA |
| TLS negative | custom trust excluding the CA, pinning, upstream mTLS requiring guest identity, bad authority, unsupported ALPN, malformed TLS, CONNECT, and nested TLS fail closed |
| Root separation | native verifier tests prove the managed CA is absent from the real-upstream root view without exporting its key; public E2E rejects an independently untrusted origin |
| Permissions | denied guest egress never invokes the middleware or signing work; semantic/virtual paths expose `EACCES`, while raw Host/SNI-classified paths expose the documented wrapped write/handshake failure |
| Request streaming | a barrier proves the host receives upload chunk A before the guest produces chunk B or ends the request |
| Response streaming | a barrier proves the guest receives response chunk A before the host produces chunk B or closes the stream |
| Backpressure | a paused host stops guest upload reads, and a paused guest stops host response pulls, at configured tiny byte bounds; both resume in order |
| Cancellation | guest abort during upload or download sets `request.signal`, cancels request and response streams plus forwarding fetch, closes fixture sockets, and frees reservations |
| Full duplex | an upstream returns response headers before request EOF, continues consuming the upload, and both directions complete without premature cancellation |
| Registration lifecycle | disconnect before dispatch, before headers, and after headers has the specified 503/abort result; owner loss cancels both directions; later matches never fall through; same-instance same-digest re-registration restores handling; every old-epoch frame is rejected |
| Timeout phases | queued callback, middleware that neither pulls nor returns, outstanding upload pull, post-EOF unresolved middleware, pre-first-response-byte, idle SSE gap, partial head/body, and idle keep-alive each cancel with the specified result |
| Fairness | one open SSE stream does not block short requests, a second stream, another VM, heartbeat, or shutdown |
| Teardown | dispose during classification, TLS handshake, callback wait, and SSE cancels within a bounded deadline |
| Limits | exact-boundary and one-over tests name the limit and how to raise it |
| HTTP edges | HEAD, 204/205/304, HTTP/1.0 close/keep-alive, Set-Cookie, gzip normalization, and invalid Rust responses follow the contract |
| Redirects | host-followed redirects do not re-enter; a manual 3xx followed by the guest does re-enter |
| Observability | required events/metrics appear, and injected credentials, cookies, bodies, and exception secrets do not |
| Parity | TypeScript and Rust clients have identical routing, streaming, cancellation, and error behavior |

Streaming assertions are barrier- and counter-based, not timing-only. Producer
chunk boundaries are not asserted because legal transports may split or
coalesce them; byte order, early visibility, backpressure, and cancellation are
asserted.

Overlapping-stream timeout tests keep upload progress flowing while the
response deadline fires, then keep response progress flowing while the upload
deadline fires. Each test proves the other direction does not reset the owning
clock and that both directions are canceled at the terminal transition.

The TLS routing matrix also covers exact real, exact virtual, and catch-all
destinations on standard and nonstandard ports with HTTP/1.1 ALPN, no ALPN, and
h2-only ALPN. It covers IPv6 authority brackets/default ports, DNS refresh and
public-to-restricted rebinding, and proves an unmatched direct HTTP/2
connection remains functional while another host has a middleware.

Native integration slowloris tests use barriers and an injected clock: partial
headers, partial fixed-length bodies, partial chunked bodies, and idle
keep-alive each hold a phase open while the clock advances past the configured
deadline. Public-client E2E against the real release sidecar instead uses tiny
configured deadlines, barrier-confirmed phase entry, a generous outer timeout,
and asserts the outcome rather than exact elapsed time; no production test-clock
hook is added.

Cancellation before validated request headers invokes no middleware. Cancellation
during a streamed upload aborts the already-invoked middleware, opens no additional
upstream socket, and releases every reservation.

### Mock LLM acceptance

At least one OpenAI path and one Anthropic path run through real provider SDK
code using their canonical HTTPS provider hostnames:

1. `outboundByHost` returns finite provider-compatible JSON.
2. `outboundByHost` returns multiple provider-compatible SSE events.
3. No base-URL override, loopback exemption, external DNS result, or upstream
   provider connection is used.
4. The mock observes request model, headers, JSON, and streaming flag.
5. The guest observes the first event before later events are released.
6. Guest cancellation invokes the mock stream's `cancel()` and frees all
   resources.
7. Concurrent conversations remain isolated.

SDKs receive dummy values for any syntactically required guest API-key
configuration. No real credential is used, and the dummy value is not accepted
as an upstream credential.

### Embedded LLM gateway acceptance

A real packaged Pi/ACP provider adapter uses its ordinary provider endpoint.
The middleware:

1. matches the canonical provider hostname;
2. removes any guest credential and injects a host-only test credential;
3. rewrites to a trusted local llmock origin;
4. forwards with host `fetch`;
5. preserves the finite SDK request body and streams the provider response back
   to the guest;
6. optionally transforms a response header or SSE event.

The test asserts that the local upstream sees the injected credential and
preserved path/query/body, while the guest VFS, environment, response, logs, and
trace never contain that credential. Host fetch and its redirects must not
recursively invoke the middleware.

The Pi/provider SDK test proves finite request fidelity; it does not claim the
SDK exposes a controllable streaming upload. Dedicated Node-compatible and
generic WASM streaming clients provide the bidirectional upload barriers. If
the Pi test transforms SSE, a barrier proves the first transformed event
reaches the guest before upstream EOF.

The complete required path is:

```text
real guest agent
  -> real provider SDK
  -> guest TLS
  -> real sidecar interception
  -> public client middleware
  -> embedded gateway policy
  -> local llmock
  -> streamed response
  -> completed agent turn
```

The actor adapter passes its process-local configured closures to the
`AgentOs.create()` call it owns; they are never serialized into actor or VM
durable state. The same configured closure can be reused by multiple actor
instances, so it must not assume that captured mutable state is instance-local.
Access to per-instance actor context would require a separate future factory or
context API and is outside this minimal surface.

Nightly acceptance runs the same gateway path through the real Rivet actor
runtime and proves actor disposal cancels the upload, host fetch, response
stream, and callback registration.

### CI tiers

Required PR CI remains under the repository's ten-minute target and includes:

- normalization, certificate, HTTP validation, codec, stream-state, and limit
  unit tests;
- TypeScript and Rust public API parity plus registration metadata and wire
  protocol parity;
- one real-sidecar Node HTTP/HTTPS mutation and short-circuit test;
- the exact `request => fetch(request)` streaming POST forwarding case in the
  Node-compatible public client;
- the documented two-step URL/header rewrite example in Node-compatible and
  actor-host runtimes;
- one real-sidecar WASM HTTPS CA-trust test;
- deterministic request-stream, SSE, bidirectional-backpressure, and
  cancellation tests;
- permission denial, private-key non-persistence, and CA-isolation checks;
- checked outbound-middleware example type checks and the website build;
- architecture guards.

Nightly CI includes:

- the full Node/curl/wget/Git/Python/generic-WASM matrix;
- mock OpenAI and Anthropic SDK tests;
- the real packaged Pi embedded-gateway turn;
- the full TLS negative matrix;
- concurrency, fairness, keep-alive, cancellation races, cache churn, and
  configured-small-limit tests.

Explicit ignored soak tests include:

- repeated VM create/dispose with active streams;
- thousands of sequential keep-alive requests;
- maximum configured concurrent streams and certificate churn;
- client/sidecar disconnect races;
- multi-VM fairness under sustained slow consumers.

Soak tests assert bounded heap, fd, socket, task, callback, stream, and buffer
gauges and require them to return to baseline. They remain opt-in because tests
that prove the absence of a resource bound by saturation do not belong in the
default suite.

Release validation runs the P0 and nightly matrix against the stripped release
sidecar and packed software artifacts with no skips. It also verifies generated
protocol fixtures, fixed committed versions, TypeScript/Rust parity, and the
absence of new runtimes, thread-per-connection code, polling timers, and
unbounded channels.

## Release gates

The feature is not production-ready until:

- both clients expose the two middleware properties;
- exact virtual hosts work from Node-compatible and generic WASM clients;
- HTTPS interception works without insecure flags through the documented CA
  paths;
- request and response streaming, including SSE, are incremental, bounded,
  cancelable, and fair;
- mock LLM and embedded-gateway acceptance tests pass through a real provider
  SDK and real sidecar;
- the **Outbound HTTP Middleware** guide, checked examples,
  networking/permissions/TLS cross-links, navigation entry, and generated docs
  artifacts ship with the API;
- all matched TLS failures are fail-closed;
- no CA private key or stale generation state is persisted;
- all configured limits warn, fail with typed raiseable errors, and release
  reservations;
- required PR CI remains within the repository wall-clock budget.
