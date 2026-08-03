# ORIN Qorx Edge

Stateless Cloudflare Worker built from the current OG Qorx Void Rust retrieval and proof design.

- `POST /v1/context/resolve` accepts approved documents for one request and returns a bounded proof pack.
- The v2 response adds Grounding Gate telemetry and a B2C-inspired evidence portfolio ranked by proof utility per estimated token, with omission-risk and hard-budget controls.
- Raw documents are neither logged nor persisted by this service.
- The worker makes zero model-provider calls.
- `QORX_SHARED_SECRET` is required as a Cloudflare secret and as a bearer token from the ORIN server.
- `QORX_PORTFOLIO_SECRET` is an optional second bearer token for Marvin's public portfolio backend. It does not replace or expose ORIN's primary secret.

```powershell
cargo test --manifest-path .\qorx-edge\Cargo.toml
worker-build --release --no-panic-recovery --manifest-path .\qorx-edge\Cargo.toml
wrangler secret put QORX_SHARED_SECRET --config .\qorx-edge\wrangler.toml
wrangler secret put QORX_PORTFOLIO_SECRET --config .\qorx-edge\wrangler.toml
wrangler deploy --config .\qorx-edge\wrangler.toml
```
