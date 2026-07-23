use super::*;
use crate::bindings::select_outbound_http_middleware_registration;
use crate::protocol::{
    HostCallbackRequest, OwnershipScope, RegisterHostCallbacksRequest, SidecarRequestPayload,
    SidecarResponsePayload,
};
use crate::state::SharedSidecarRequestClient;
use base64::Engine;
use serde::Deserialize;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const OUTBOUND_HTTP_CALLBACK_JOB_OVERHEAD_BYTES: usize = 64 * 1024;
#[derive(Clone, Copy)]
pub(crate) struct OutboundHttpRuntimeLimits {
    request_target_bytes: usize,
    request_header_count: usize,
    request_header_bytes: usize,
    request_body_bytes: usize,
    response_header_count: usize,
    response_header_bytes: usize,
    buffered_response_bytes: usize,
    middleware_response_timeout: Duration,
}

impl OutboundHttpRuntimeLimits {
    pub(crate) fn from_vm_limits(limits: &crate::limits::VmLimits) -> Self {
        let limits = &limits.outbound_http;
        Self {
            request_target_bytes: limits.max_request_target_bytes,
            request_header_count: limits.max_request_header_count,
            request_header_bytes: limits.max_request_header_bytes,
            request_body_bytes: limits.max_request_body_bytes,
            response_header_count: limits.max_response_header_count,
            response_header_bytes: limits.max_response_header_bytes,
            buffered_response_bytes: limits.max_buffered_response_bytes,
            middleware_response_timeout: Duration::from_millis(
                limits.middleware_response_timeout_ms,
            ),
        }
    }
}

#[derive(Clone)]
pub(crate) struct OutboundHttpRuntimeContext {
    pub(crate) ownership: OwnershipScope,
    pub(crate) sidecar_requests: SharedSidecarRequestClient,
    pub(crate) registration: Option<Arc<RegisterHostCallbacksRequest>>,
    pub(crate) limits: OutboundHttpRuntimeLimits,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OutboundHttpBridgeRequest {
    #[serde(default)]
    probe: bool,
    #[serde(default = "default_http_method")]
    method: String,
    url: String,
    #[serde(default)]
    headers: Vec<(String, String)>,
    #[serde(default)]
    body_base64: Option<String>,
}

fn default_http_method() -> String {
    String::from("GET")
}

pub(crate) fn dispatch_outbound_http_bridge_request<B>(
    bridge: &SharedBridge<B>,
    vm_id: &str,
    process: &ActiveProcess,
    context: OutboundHttpRuntimeContext,
    value: Value,
) -> Result<JavascriptSyncRpcServiceResponse, SidecarError>
where
    B: NativeSidecarBridge + Send + 'static,
    BridgeError<B>: fmt::Debug + Send + Sync + 'static,
{
    let mut request: OutboundHttpBridgeRequest =
        serde_json::from_value(value).map_err(|error| {
            SidecarError::InvalidState(format!(
                "invalid outbound HTTP middleware bridge request: {error}"
            ))
        })?;
    let url = Url::parse(&request.url).map_err(|error| {
        SidecarError::InvalidState(format!("invalid outbound HTTP URL: {error}"))
    })?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(SidecarError::Unsupported(format!(
            "unsupported outbound HTTP URL scheme: {}",
            url.scheme()
        )));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(SidecarError::InvalidState(String::from(
            "outbound HTTP URL credentials are not supported",
        )));
    }
    let method = http::Method::from_bytes(request.method.as_bytes()).map_err(|error| {
        SidecarError::InvalidState(format!("invalid outbound HTTP method: {error}"))
    })?;
    if matches!(method.as_str(), "CONNECT" | "TRACE" | "TRACK") {
        return Err(SidecarError::Unsupported(format!(
            "unsupported outbound HTTP middleware method: {}",
            request.method
        )));
    }
    let host = url
        .host_str()
        .ok_or_else(|| SidecarError::InvalidState(String::from("outbound HTTP URL has no host")))?;
    let callback_key = match context.registration.as_deref() {
        Some(registration) => select_outbound_http_middleware_registration(registration, host)?,
        None => None,
    };
    let Some(callback_key) = callback_key else {
        return Ok(json!({ "matched": false }).into());
    };
    let port = url.port_or_known_default().ok_or_else(|| {
        SidecarError::InvalidState(String::from("outbound HTTP URL has no effective port"))
    })?;
    bridge.require_network_access(
        vm_id,
        NetworkOperation::Http,
        format_tcp_resource(host, port),
    )?;
    if request.url.len() > context.limits.request_target_bytes {
        return Ok(
            outbound_http_error_response(414, "Outbound HTTP request target too large").into(),
        );
    }
    if request.headers.len() > context.limits.request_header_count
        || outbound_http_header_bytes(&request.headers) > context.limits.request_header_bytes
    {
        return Ok(
            outbound_http_error_response(431, "Outbound HTTP request headers too large").into(),
        );
    }
    validate_outbound_http_headers(
        &request.headers,
        "maxRequestHeader",
        context.limits.request_header_count,
        context.limits.request_header_bytes,
    )?;
    normalize_outbound_http_request_headers(&mut request.headers);
    let decoded_body_bytes = if let Some(body) = request.body_base64.as_deref() {
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(body)
            .map_err(|error| {
                SidecarError::InvalidState(format!(
                    "invalid outbound HTTP request body encoding: {error}"
                ))
            })?;
        if decoded.len() > context.limits.request_body_bytes {
            return Ok(
                outbound_http_error_response(413, "Outbound HTTP request body too large").into(),
            );
        }
        decoded.len()
    } else {
        0
    };
    if decoded_body_bytes > 0 && matches!(method, http::Method::GET | http::Method::HEAD) {
        return Ok(
            outbound_http_error_response(400, "Outbound HTTP request body is not allowed").into(),
        );
    }
    if request.probe {
        return Ok(json!({ "matched": true }).into());
    }

    let invocation_id = format!(
        "outbound-http:{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    let request_is_head = request.method.eq_ignore_ascii_case("HEAD");
    let input = json!({
        "type": "outbound_http",
        "method": request.method,
        "url": request.url,
        "headers": request.headers,
        "bodyBase64": request.body_base64,
    })
    .to_string();
    let sidecar_requests = context.sidecar_requests;
    let ownership = context.ownership;
    let limits = context.limits;
    let callback_timeout = limits.middleware_response_timeout;
    let callback_job_bytes = OUTBOUND_HTTP_CALLBACK_JOB_OVERHEAD_BYTES
        .saturating_add(input.len())
        .saturating_add(limits.buffered_response_bytes.saturating_mul(4) / 3);
    let (completion, receiver) = tokio::sync::oneshot::channel();
    process
        .runtime_context
        .blocking()
        .submit(callback_job_bytes, move || {
            let result = sidecar_requests.invoke(
                ownership,
                SidecarRequestPayload::HostCallback(HostCallbackRequest {
                    invocation_id: invocation_id.clone(),
                    callback_key,
                    input,
                    timeout_ms: callback_timeout.as_millis() as u64,
                }),
                callback_timeout,
            );
            let result = match result {
                Ok(SidecarResponsePayload::HostCallbackResult(response)) => {
                    if let Some(error) = response.error {
                        let status = if error.contains("UNAVAILABLE") {
                            503
                        } else if error.to_ascii_lowercase().contains("timed out") {
                            504
                        } else {
                            500
                        };
                        Ok(json!({
                            "matched": true,
                            "response": {
                                "status": status,
                                "statusText": "",
                                "headers": [["content-type", "text/plain; charset=utf-8"]],
                                "bodyBase64": base64::engine::general_purpose::STANDARD
                                    .encode("Outbound HTTP middleware failed"),
                            }
                        }))
                    } else if let Some(result) = response.result {
                        match serde_json::from_str::<Value>(&result).and_then(|response| {
                            validate_outbound_http_response(response, limits, request_is_head)
                        }) {
                            Ok(response) => {
                                Ok(json!({ "matched": true, "response": response }))
                            }
                            Err(error) => {
                                eprintln!(
                                    "ERR_AGENTOS_OUTBOUND_MIDDLEWARE_RESPONSE: invalid response: {error}"
                                );
                                Ok(outbound_http_error_response(
                                    500,
                                    "Outbound HTTP middleware failed",
                                ))
                            }
                        }
                    } else {
                        eprintln!(
                            "ERR_AGENTOS_OUTBOUND_MIDDLEWARE_RESPONSE: callback returned neither a response nor an error"
                        );
                        Ok(outbound_http_error_response(
                            500,
                            "Outbound HTTP middleware failed",
                        ))
                    }
                }
                Ok(_) => {
                    eprintln!(
                        "ERR_AGENTOS_OUTBOUND_MIDDLEWARE_RESPONSE: unexpected callback response"
                    );
                    Ok(outbound_http_error_response(
                        500,
                        "Outbound HTTP middleware failed",
                    ))
                }
                Err(error) => {
                    let timed_out = error.to_string().to_ascii_lowercase().contains("timed out");
                    let status = if timed_out { 504 } else { 503 };
                    eprintln!("ERR_AGENTOS_OUTBOUND_MIDDLEWARE_UNAVAILABLE: {error}");
                    Ok(outbound_http_error_response(
                        status,
                        if timed_out {
                            "Outbound HTTP middleware failed"
                        } else {
                            "Outbound HTTP middleware unavailable"
                        },
                    ))
                }
            };
            if completion.send(result).is_err() {
                eprintln!(
                    "ERR_AGENTOS_OUTBOUND_MIDDLEWARE_COMPLETION_DROPPED: guest stopped waiting"
                );
            }
        })
        .map_err(SidecarError::from)?;
    Ok(JavascriptSyncRpcServiceResponse::Deferred {
        receiver,
        timeout: Some(
            limits
                .middleware_response_timeout
                .saturating_add(Duration::from_secs(1)),
        ),
        task_class: agentos_runtime::TaskClass::Socket,
    })
}

fn outbound_http_error_response(status: u16, message: &str) -> Value {
    json!({
        "matched": true,
        "response": {
            "status": status,
            "statusText": "",
            "headers": [["content-type", "text/plain; charset=utf-8"]],
            "bodyBase64": base64::engine::general_purpose::STANDARD.encode(message),
        }
    })
}

fn outbound_http_limit_error(field: &str, limit: usize) -> SidecarError {
    SidecarError::InvalidState(format!(
        "limits.outboundHttp.{field} exceeded {limit}; raise limits.outboundHttp.{field}"
    ))
}

fn validate_outbound_http_headers(
    headers: &[(String, String)],
    field_prefix: &str,
    max_count: usize,
    max_bytes: usize,
) -> Result<(), SidecarError> {
    if headers.len() > max_count {
        return Err(outbound_http_limit_error(
            &format!("{field_prefix}Count"),
            max_count,
        ));
    }
    let bytes = outbound_http_header_bytes(headers);
    if bytes > max_bytes {
        return Err(outbound_http_limit_error(
            &format!("{field_prefix}Bytes"),
            max_bytes,
        ));
    }
    for (name, value) in headers {
        if name.is_empty()
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte))
        {
            return Err(SidecarError::InvalidState(format!(
                "invalid outbound HTTP header name: {name:?}"
            )));
        }
        if value
            .bytes()
            .any(|byte| (byte < b' ' && byte != b'\t') || byte == 0x7f)
        {
            return Err(SidecarError::InvalidState(format!(
                "invalid outbound HTTP header value for {name:?}"
            )));
        }
    }
    Ok(())
}

fn outbound_http_header_bytes(headers: &[(String, String)]) -> usize {
    headers.iter().fold(0usize, |total, (name, value)| {
        total
            .saturating_add(name.len())
            .saturating_add(value.len())
            .saturating_add(4)
    })
}

fn normalize_outbound_http_request_headers(headers: &mut Vec<(String, String)>) {
    let connection_tokens = connection_header_tokens(headers);
    headers.retain(|(name, _)| {
        let name = name.to_ascii_lowercase();
        !matches!(
            name.as_str(),
            "connection"
                | "content-length"
                | "host"
                | "keep-alive"
                | "proxy-authenticate"
                | "proxy-authorization"
                | "proxy-connection"
                | "te"
                | "trailer"
                | "transfer-encoding"
                | "upgrade"
        ) && !connection_tokens.iter().any(|token| token == &name)
    });
}

fn connection_header_tokens(headers: &[(String, String)]) -> Vec<String> {
    headers
        .iter()
        .filter(|(name, _)| name.eq_ignore_ascii_case("connection"))
        .flat_map(|(_, value)| value.split(','))
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(str::to_ascii_lowercase)
        .collect()
}

fn validate_outbound_http_response(
    mut response: Value,
    limits: OutboundHttpRuntimeLimits,
    request_is_head: bool,
) -> Result<Value, serde_json::Error> {
    let invalid = |message: &str| {
        serde_json::Error::io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            message.to_owned(),
        ))
    };
    let object = response
        .as_object()
        .ok_or_else(|| invalid("outbound middleware response must be an object"))?;
    let status = object
        .get("status")
        .and_then(Value::as_u64)
        .ok_or_else(|| invalid("outbound middleware response status must be an integer"))?;
    if !(200..=599).contains(&status) {
        return Err(invalid(
            "outbound middleware response status must be between 200 and 599",
        ));
    }
    let headers = object
        .get("headers")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("outbound middleware response headers must be an array"))?;
    let mut parsed_headers = Vec::with_capacity(headers.len());
    for header in headers {
        let pair = header
            .as_array()
            .filter(|pair| pair.len() == 2)
            .ok_or_else(|| invalid("outbound middleware response header must be a pair"))?;
        parsed_headers.push((
            pair[0]
                .as_str()
                .ok_or_else(|| invalid("outbound middleware response header name must be text"))?
                .to_owned(),
            pair[1]
                .as_str()
                .ok_or_else(|| invalid("outbound middleware response header value must be text"))?
                .to_owned(),
        ));
    }
    validate_outbound_http_headers(
        &parsed_headers,
        "maxResponseHeader",
        limits.response_header_count,
        limits.response_header_bytes,
    )
    .map_err(|error| invalid(&error.to_string()))?;
    let connection_tokens = connection_header_tokens(&parsed_headers);
    parsed_headers.retain(|(name, _)| {
        let name = name.to_ascii_lowercase();
        !matches!(
            name.as_str(),
            "accept-ranges"
                | "connection"
                | "content-digest"
                | "content-encoding"
                | "content-length"
                | "content-md5"
                | "content-range"
                | "digest"
                | "etag"
                | "keep-alive"
                | "proxy-authenticate"
                | "proxy-authorization"
                | "proxy-connection"
                | "repr-digest"
                | "te"
                | "trailer"
                | "transfer-encoding"
                | "upgrade"
        ) && !connection_tokens.iter().any(|token| token == &name)
    });
    let body = object
        .get("bodyBase64")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("outbound middleware response bodyBase64 must be text"))?;
    let body = base64::engine::general_purpose::STANDARD
        .decode(body)
        .map_err(|error| {
            invalid(&format!(
                "invalid outbound middleware response body: {error}"
            ))
        })?;
    if body.len() > limits.buffered_response_bytes {
        return Err(invalid(&format!(
            "limits.outboundHttp.maxBufferedResponseBytes exceeded {}; raise limits.outboundHttp.maxBufferedResponseBytes",
            limits.buffered_response_bytes
        )));
    }
    let object = response
        .as_object_mut()
        .ok_or_else(|| invalid("outbound middleware response must be an object"))?;
    object.insert(String::from("headers"), json!(parsed_headers));
    if request_is_head || matches!(status, 204 | 205 | 304) {
        object.insert(String::from("bodyBase64"), Value::String(String::new()));
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_limits() -> OutboundHttpRuntimeLimits {
        OutboundHttpRuntimeLimits {
            request_target_bytes: 1024,
            request_header_count: 16,
            request_header_bytes: 1024,
            request_body_bytes: 1024,
            response_header_count: 16,
            response_header_bytes: 1024,
            buffered_response_bytes: 16,
            middleware_response_timeout: Duration::from_secs(1),
        }
    }

    #[test]
    fn request_header_normalization_removes_framing_and_connection_tokens() {
        let mut headers = vec![
            (String::from("Host"), String::from("api.example.com")),
            (
                String::from("Connection"),
                String::from("x-private, keep-alive"),
            ),
            (String::from("X-Private"), String::from("secret")),
            (String::from("Content-Length"), String::from("4")),
            (String::from("Authorization"), String::from("Bearer token")),
        ];

        normalize_outbound_http_request_headers(&mut headers);

        assert_eq!(
            headers,
            vec![(String::from("Authorization"), String::from("Bearer token"))]
        );
    }

    #[test]
    fn response_normalization_removes_invalidated_metadata() {
        let response = json!({
            "status": 200,
            "statusText": "OK",
            "headers": [
                ["connection", "x-private"],
                ["x-private", "secret"],
                ["content-length", "4"],
                ["content-encoding", "gzip"],
                ["etag", "\"stale\""],
                ["x-end-to-end", "kept"]
            ],
            "bodyBase64": base64::engine::general_purpose::STANDARD.encode("body"),
        });

        let normalized =
            validate_outbound_http_response(response, test_limits(), false).expect("response");

        assert_eq!(normalized["headers"], json!([["x-end-to-end", "kept"]]));
        assert_eq!(
            normalized["bodyBase64"],
            base64::engine::general_purpose::STANDARD.encode("body")
        );
    }

    #[test]
    fn head_and_bodyless_statuses_suppress_response_bodies() {
        for (status, is_head) in [(200, true), (204, false), (205, false), (304, false)] {
            let response = json!({
                "status": status,
                "statusText": "",
                "headers": [],
                "bodyBase64": base64::engine::general_purpose::STANDARD.encode("hidden"),
            });
            let normalized = validate_outbound_http_response(response, test_limits(), is_head)
                .expect("response");
            assert_eq!(normalized["bodyBase64"], "");
        }
    }

    #[test]
    fn response_validation_enforces_status_headers_and_body_limits() {
        let invalid_status = json!({
            "status": 700,
            "statusText": "",
            "headers": [],
            "bodyBase64": "",
        });
        assert!(
            validate_outbound_http_response(invalid_status, test_limits(), false)
                .expect_err("status")
                .to_string()
                .contains("between 200 and 599")
        );

        let too_many_headers = json!({
            "status": 200,
            "statusText": "",
            "headers": (0..17).map(|index| [format!("x-{index}"), String::new()]).collect::<Vec<_>>(),
            "bodyBase64": "",
        });
        assert!(
            validate_outbound_http_response(too_many_headers, test_limits(), false)
                .expect_err("headers")
                .to_string()
                .contains("maxResponseHeaderCount")
        );

        let oversized_body = json!({
            "status": 200,
            "statusText": "",
            "headers": [],
            "bodyBase64": base64::engine::general_purpose::STANDARD.encode([0_u8; 17]),
        });
        assert!(
            validate_outbound_http_response(oversized_body, test_limits(), false)
                .expect_err("body")
                .to_string()
                .contains("maxBufferedResponseBytes")
        );
    }

    #[test]
    fn header_validation_rejects_smuggling_control_bytes() {
        for headers in [
            vec![(String::from("bad name"), String::from("value"))],
            vec![(
                String::from("x-test"),
                String::from("value\r\nx-injected: true"),
            )],
        ] {
            assert!(
                validate_outbound_http_headers(&headers, "maxRequestHeader", 16, 1024).is_err()
            );
        }
    }
}
