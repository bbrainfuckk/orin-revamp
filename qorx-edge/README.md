# ORIN Qorx Edge

Stateless Cloudflare Worker built from the current OG Qorx Void Rust retrieval and proof design.

- `POST /v1/context/resolve` accepts approved documents for one request and returns a bounded proof pack.
- Raw documents are neither logged nor persisted by this service.
- The worker makes zero model-provider calls.
- `QORX_SHARED_SECRET` is required as a Cloudflare secret and as a bearer token from the ORIN server.

```powershell
cargo test --manifest-path .\qorx-edge\Cargo.toml
worker-build --release --no-panic-recovery --manifest-path .\qorx-edge\Cargo.toml
wrangler secret put QORX_SHARED_SECRET --config .\qorx-edge\wrangler.toml
wrangler deploy --config .\qorx-edge\wrangler.toml
```
