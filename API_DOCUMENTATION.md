# ORIN lead API

## `POST /api/integrations/n8n/connect`

Verifies an authenticated personal workspace, sends a connectivity event to an active n8n Cloud production webhook, encrypts the full webhook URL and a connector signing secret with AES-256-GCM, and atomically saves the private vault document and non-secret connection status. Only `https://*.n8n.cloud/webhook/*` production URLs are accepted. Test webhook URLs, redirects, credentials in URLs, non-standard ports, and self-hosted hosts are rejected.

The request body includes `workspaceId`, `webhookUrl`, `displayName`, and one or more supported `desiredChannels`. A successful response reports `connected` and `n8n_cloud` without returning the webhook URL or signing secret.

## `DELETE /api/integrations/n8n/connect`

Removes both the public n8n connection document and its encrypted vault record in one authenticated server operation. The request body only needs the signed-in user's personal `workspaceId`.

## `GET /api/integrations/capabilities`

Returns non-secret readiness flags for each provider. A `false` value makes ORIN AI show requirements or partner-access status instead of opening a misleading authorization flow. No app secret, access token, service-account value, or encryption key is returned.

## `GET /api/integrations/vault/health`

Requires a Firebase ID token and the signed-in personal workspace ID. The route verifies the encryption-key shape, exchanges the configured Firebase service credential for a short-lived Google access token, reads the workspace through the Firestore API, and confirms ownership. The integrations screen enables encrypted connectors only after this authenticated check succeeds.

## `POST|DELETE /api/integrations/website/connect`

Publishes or removes a signed-in workspace's website-chat connection. Publishing requires a ready AI agent configured for the Website channel, one to five exact allowed origins, and at least one supported website event. The server creates a public widget identity without exposing the workspace or agent identifier and returns a one-line script embed. Removing the connection disables the public widget immediately.

The allowed origins are enforced when a browser requests a widget session. Production origins must use HTTPS; localhost HTTP origins are accepted for development.

## `GET|POST /api/widget/session`

`GET` returns the public assistant name, business name, and greeting for an active widget. `POST` verifies the browser `Origin` against the widget's exact allowlist and returns a short-lived HMAC-signed session bound to that widget, origin, and a pseudonymous request-source hash. The session contains no provider credential, workspace identifier, or agent identifier.

## `POST /api/widget/message`

Accepts a signed widget session, an idempotent request identifier, and a customer message. The endpoint applies a server-side per-widget abuse limit, loads only the active agent's approved configuration and knowledge notes, and requests a structured response from the configured server-side AI provider. Customer and assistant messages are written to the unified inbox through the Firebase service identity. Unavailable or ungrounded AI responses fail safely into team handoff instead of inventing an answer.

The same endpoint accepts an authenticated `studio_test` mode for signed-in workspace owners. It verifies the Firebase session and personal workspace, loads the exact saved AI draft, applies a per-user rate limit, and returns a grounded test response plus its handoff decision. Studio tests are private and are never written to customer conversations, contacts, or analytics.

Authenticated `team_reply` and `mark_read` modes verify the Firebase owner and personal workspace. Website replies are written as deduplicated team messages, and a signed `widget_sync` mode lets that exact visitor session receive them while the page remains open.

Messenger and Instagram team replies resolve raw provider routing identifiers only from a server-owned conversation route, decrypt the workspace's Meta credential, enforce the standard reply window and a team rate limit, and call Meta with the Page token in an Authorization header. The provider must confirm a message ID before ORIN AI writes the team message or analytics event. Idempotency reservations prevent concurrent duplicate sends; provider IDs remain hashed in readable inbox records. A timeout is reported as unknown delivery so the team checks Meta before retrying. Providers without an approved outbound path remain read-only.

## `GET /api/integrations/meta/start`

Requires a Firebase ID token and the signed-in personal workspace ID. When the Meta app, server vault, and callback credentials are configured, the endpoint returns a Meta authorization URL and sets a ten-minute HttpOnly nonce cookie. The signed OAuth state binds the callback to the user and workspace.

## `DELETE /api/integrations/meta/start`

Disconnects Meta through the authenticated backend. It deletes the public connection, encrypted vault credential, provider-account routes, and the workspace's private Meta conversation delivery routes in one server commit. Removing the visible connection cannot leave usable Meta credentials behind.

## `GET /api/integrations/meta/callback`

Validates the signed state and nonce, exchanges the Meta authorization code, discovers eligible Pages and linked Instagram professional accounts, and automatically subscribes each discovered account to supported message events. Provider tokens are encrypted with AES-256-GCM and stored in the server-only Firestore vault. The same atomic commit creates private provider-account routes used to resolve later webhooks to the authorized workspace. The public connection document contains names, IDs, per-account subscription status, authorization state, and health metadata but never an access token. A partial provider subscription is reported as attention required instead of connected.

## `GET|POST /api/webhooks/meta`

`GET` handles Meta's webhook verification challenge using `META_WEBHOOK_VERIFY_TOKEN`. `POST` requires the `X-Hub-Signature-256` HMAC generated with the Meta app secret and rejects unsigned, oversized, or malformed payloads.

Accepted Messenger, Instagram, and Facebook Lead payloads are normalized into provider-neutral records. The server resolves the provider account through the private OAuth route, hashes external identifiers used as document IDs, rejects replayed provider events, and writes the contact, conversation, message, and analytics event through the Firebase service identity. For messages, raw provider account and customer identifiers are isolated in a server-only conversation delivery route and never copied into member-readable inbox records. A first accepted delivery marks a fully subscribed Meta connection healthy. Matching n8n subscriptions and active “Send to n8n” automations receive a signed normalized event; each delivery result is written to `automationRuns`.

Clients may read contacts, conversations, messages, analytics events, and automation-run status only as workspace members. Firestore rules deny client writes to those server-owned collections and deny all client access to provider routes, private conversation routes, outbound idempotency and rate-limit records, provider-event records, and connector vaults.

## `GET /api/integrations/shopify/start`

Requires a Firebase ID token, the signed-in personal workspace ID, and a permanent `*.myshopify.com` store domain. The route creates a ten-minute signed OAuth state and HttpOnly nonce cookie, then returns Shopify's authorization URL. ORIN AI requests only the store scopes configured in `SHOPIFY_SCOPES`.

## `GET /api/integrations/shopify/callback`

Validates both Shopify's callback HMAC and ORIN AI's signed state and nonce before exchanging the code. The backend verifies the resulting store identity with the versioned GraphQL Admin API, encrypts the offline token, and atomically creates the private shop route and non-secret connection record. The connection remains in webhook-pending status until Shopify delivers a verified event.

## `DELETE /api/integrations/shopify/connect`

Removes the authenticated workspace's Shopify connection, encrypted token, and private shop route in one server operation. Shopify app removal in the Shopify admin remains the merchant's authoritative uninstall control.

## `POST /api/webhooks/shopify`

Reads the raw request body, validates `X-Shopify-Hmac-Sha256`, validates the permanent shop domain, resolves the workspace only through the server-owned shop route, and deduplicates deliveries using `X-Shopify-Webhook-Id`. Verified order and customer events update provider-neutral analytics and contacts and mark the connection healthy. App-uninstall and shop-redaction deliveries disable the connector; customer-redaction deliveries remove the corresponding hashed contact record.

Shopify's app-specific webhook subscriptions and mandatory compliance topics must be configured in the Shopify Dev Dashboard to target this endpoint before `SHOPIFY_WEBHOOKS_CONFIGURED` is set to `true`.

## `POST /api/submit-form`

The endpoint validates a lead and forwards it to `SHEET_WEBHOOK_URL`. It never reports success unless the configured webhook accepts the payload.

### Request

```json
{
  "name": "Juan Dela Cruz",
  "business_name": "Sample Store",
  "email": "juan@example.com",
  "ai_role": "Sales and support",
  "configuration": "{\"channels\":[\"Messenger\"],\"knowledge_sources\":[\"Website and FAQ pages\"],\"responsibilities\":[\"Answer customer questions\"],\"languages\":[\"English\"],\"tone_notes\":\"Warm and concise\",\"handoff_rules\":[\"The customer asks for a team member\"]}",
  "company_website": ""
}
```

`configuration` is an optional JSON string containing the visitor's saved AI-builder choices, including purpose, approved knowledge sources, channels, capabilities, languages, voice notes, operating rules, and escalation rules.

`company_website` is a honeypot and must remain empty.

### Responses

- `200` — delivered successfully, or silently accepted as spam when the honeypot is filled.
- `400` — required fields are missing or the email is invalid.
- `405` — only `POST` is supported.
- `503` — `SHEET_WEBHOOK_URL` is not configured.
- `502` — the configured webhook rejected or failed to receive the lead.
