mod common;

use std::collections::BTreeMap;
use std::sync::Arc;

use agentos_client::{
    outbound_body_from_bytes, AgentOs, AgentOsConfig, ExecOptions, OutboundCancellation,
    OutboundMiddleware, PatternPermissions, PermissionMode, Permissions,
};
use http_body_util::BodyExt;

#[tokio::test]
async fn rust_client_intercepts_virtual_https_fetch() {
    if !common::require_sidecar("rust_client_intercepts_virtual_https_fetch") {
        return;
    }
    common::ensure_sidecar_env();

    let middleware: OutboundMiddleware = Arc::new(|request| {
        Box::pin(async move {
            let (parts, body) = request.into_parts();
            let body = body.collect().await?.to_bytes();
            let response = serde_json::json!({
                "method": parts.method.as_str(),
                "path": parts.uri.path(),
                "hasCancellation": parts.extensions.get::<OutboundCancellation>().is_some(),
                "body": String::from_utf8_lossy(&body),
            })
            .to_string();
            Ok(http::Response::builder()
                .status(201)
                .header("content-type", "application/json")
                .header("content-encoding", "gzip")
                .header("content-length", "999")
                .header("x-rust-middleware", "true")
                .body(outbound_body_from_bytes(response))?)
        })
    });
    let fallback: OutboundMiddleware = Arc::new(|_| {
        Box::pin(async move {
            Ok(http::Response::builder()
                .status(202)
                .body(outbound_body_from_bytes("fallback"))?)
        })
    });

    let os = AgentOs::create(AgentOsConfig {
        permissions: Some(Permissions {
            network: Some(PatternPermissions::Mode(PermissionMode::Allow)),
            ..Default::default()
        }),
        outbound: Some(fallback),
        outbound_by_host: BTreeMap::from([(String::from("API.Example.COM."), middleware)]),
        ..Default::default()
    })
    .await
    .expect("create VM");

    let source = [
        "(async () => {",
        "  const response = await fetch('https://api.example.com/v1/chat', {",
        "    method: 'POST',",
        "    body: 'hello',",
        "  });",
        "  console.log(JSON.stringify({",
        "    status: response.status,",
        "    middleware: response.headers.get('x-rust-middleware'),",
        "    contentEncoding: response.headers.get('content-encoding'),",
        "    contentLength: response.headers.get('content-length'),",
        "    body: await response.json(),",
        "  }));",
        "})().catch((error) => { console.error(error?.stack ?? String(error)); process.exit(1); });",
    ]
    .join("\n");
    let result = os
        .exec_argv(
            "node",
            &[String::from("-e"), source],
            ExecOptions::default(),
        )
        .await
        .expect("run guest fetch");

    assert_eq!(result.exit_code, 0, "{}", result.stderr);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(result.stdout.trim()).expect("guest JSON"),
        serde_json::json!({
            "status": 201,
            "middleware": "true",
            "contentEncoding": null,
            "contentLength": null,
            "body": {
                "method": "POST",
                "path": "/v1/chat",
                "hasCancellation": true,
                "body": "hello",
            },
        })
    );

    os.shutdown().await.expect("shutdown");
}
