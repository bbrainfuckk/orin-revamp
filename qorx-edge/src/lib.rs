mod core;

use serde_json::json;
use worker::{event, Context, Env, Method, Request, Response, Result};

use crate::core::{resolve_context, ResolveRequest, MAX_BODY_BYTES};

fn json_response(value: &impl serde::Serialize, status: u16) -> Result<Response> {
    let mut response = Response::from_json(value)?.with_status(status);
    response.headers_mut().set("Cache-Control", "no-store")?;
    response
        .headers_mut()
        .set("X-Content-Type-Options", "nosniff")?;
    Ok(response)
}

fn error_response(status: u16, code: &str) -> Result<Response> {
    json_response(&json!({ "ok": false, "error": code }), status)
}

fn constant_time_equal(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.as_bytes()
        .iter()
        .zip(right.as_bytes())
        .fold(0u8, |diff, (a, b)| diff | (a ^ b))
        == 0
}

fn authorized(req: &Request, env: &Env) -> Result<bool> {
    let expected = env.secret("QORX_SHARED_SECRET")?.to_string();
    let supplied = req
        .headers()
        .get("Authorization")?
        .and_then(|value| value.strip_prefix("Bearer ").map(str::to_string))
        .unwrap_or_default();
    Ok(constant_time_equal(&supplied, &expected))
}

#[event(fetch)]
pub async fn main(mut req: Request, env: Env, _ctx: Context) -> Result<Response> {
    let path = req.url()?.path().to_string();
    if req.method() == Method::Get && path == "/health" {
        return json_response(
            &json!({
                "ok": true,
                "engine": "qorx-og-void-rust",
                "schema": "qorx.orin-edge.health.v1",
                "provider_calls": 0,
                "persistence": "none"
            }),
            200,
        );
    }
    if path != "/v1/context/resolve" {
        return error_response(404, "NOT_FOUND");
    }
    if req.method() != Method::Post {
        return error_response(405, "METHOD_NOT_ALLOWED");
    }
    if !authorized(&req, &env)? {
        return error_response(401, "UNAUTHORIZED");
    }
    if req
        .headers()
        .get("Content-Length")?
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|length| length > MAX_BODY_BYTES)
    {
        return error_response(413, "REQUEST_TOO_LARGE");
    }
    let body = req.bytes().await?;
    if body.len() > MAX_BODY_BYTES {
        return error_response(413, "REQUEST_TOO_LARGE");
    }
    let input = match serde_json::from_slice::<ResolveRequest>(&body) {
        Ok(input) => input,
        Err(_) => return error_response(400, "INVALID_REQUEST"),
    };
    match resolve_context(input) {
        Ok(report) => json_response(&report, 200),
        Err(code) => error_response(400, code),
    }
}
