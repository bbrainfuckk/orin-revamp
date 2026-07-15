# ORIN AI application API

## `GET /api/analytics/summary`

Requires a Firebase ID token and verifies the caller's workspace membership with the server-side Firestore identity. The endpoint accepts `workspaceId`, `days` (`7`, `30`, or `90`), and the browser's timezone offset. It reads only events inside the selected and immediately preceding periods, caps each period at the most recent 5,000 events, and returns current/prior metrics, daily activity, channel mix, response-time percentiles, automation failures, and currency-separated attributed value. The response is private and never cached.

“Handled by ORIN AI” means a conversation received a confirmed automatic response and did not record a human escalation in the selected period. It is not inferred from generated text or an event type that connectors do not produce. High-volume truncation is returned explicitly so incomplete data is never presented as a full-period total.

## `POST /api/integrations/n8n/connect`

Verifies an authenticated personal or shared workspace, sends a connectivity event to an active n8n Cloud production webhook, encrypts the full webhook URL and a connector signing secret with AES-256-GCM, and atomically saves the private vault document and non-secret connection status. Owners, admins, and editors may link or rotate the outcome token; only owners and admins may disconnect. Only `https://*.n8n.cloud/webhook/*` production URLs are accepted. Test webhook URLs, redirects, credentials in URLs, non-standard ports, and self-hosted hosts are rejected.

The request body includes `workspaceId`, `webhookUrl`, `displayName`, and one or more supported `desiredChannels`. A successful response reports `connected` and `n8n_cloud` without returning the webhook URL or signing secret.

## `DELETE /api/integrations/n8n/connect`

Removes both the public n8n connection document and its encrypted vault record in one authenticated owner/admin server operation. The request body only needs the selected `workspaceId`.

## `GET /api/integrations/capabilities`

Returns non-secret readiness flags for each provider. A `false` value makes ORIN AI show requirements or partner-access status instead of opening a misleading authorization flow. No app secret, access token, service-account value, or encryption key is returned.

## `GET /api/integrations/vault/health`

Requires a Firebase ID token and a personal or shared workspace ID. The route verifies the encryption-key shape, exchanges the configured Firebase service credential for a short-lived Google access token, then confirms both the workspace and the caller's owner, admin, editor, or viewer membership through the Firestore API. It returns only a readiness boolean; connector secrets remain server-only. The integrations screen enables encrypted connectors only after this authenticated check succeeds.

## `POST|DELETE /api/integrations/website/connect`

Publishes or removes a signed-in workspace's website-chat connection. Personal and shared workspaces use the same route: owners, admins, and editors may publish or update a widget, while owners and admins may disconnect it. Publishing requires a ready AI agent configured for the Website channel, one to five exact allowed origins, and at least one supported website event. The server creates a public widget identity without exposing the workspace or agent identifier and returns a one-line script embed. Removing the connection disables the public widget immediately.

The allowed origins are enforced when a browser requests a widget session. Production origins must use HTTPS; localhost HTTP origins are accepted for development.

## `GET|POST /api/widget/session`

`GET` returns the public assistant name, business name, and greeting for an active widget. `POST` verifies the browser `Origin` against the widget's exact allowlist and returns a short-lived HMAC-signed session bound to that widget, origin, and a pseudonymous request-source hash. The session contains no provider credential, workspace identifier, or agent identifier.

## `POST /api/widget/message`

Accepts a signed widget session, an idempotent request identifier, and a customer message. The endpoint applies a server-side per-widget abuse limit, loads only the active agent's approved configuration and knowledge notes, and requests a structured response from the configured server-side AI provider. Customer and assistant messages are written to the unified inbox through the Firebase service identity. Unavailable or ungrounded AI responses fail safely into team handoff instead of inventing an answer.

The same endpoint accepts an authenticated `studio_test` mode for workspace owners, admins, and editors. It verifies Firebase identity plus active workspace membership, loads the exact saved AI draft, applies a per-user rate limit, returns a grounded test response and handoff decision, and records only the test timestamp, actor, and outcome on that AI. Test messages and answers stay out of customer conversations, contacts, and analytics.

Authenticated `team_reply`, `mark_read`, and `resume_ai` modes verify Firebase identity plus an owner, admin, or editor membership in the selected workspace. Website replies are written as deduplicated team messages, and a signed `widget_sync` mode lets that exact visitor session receive them while the page remains open. A Meta team reply places that conversation in persistent team-takeover mode so later customer messages do not trigger the AI; `resume_ai` explicitly returns only that conversation to automatic handling.

Authenticated `team_access` mode manages workspace discovery, invitations, roles, removals, and notification receipts without adding another public function. Invitations are bound to a normalized email and are accepted only after Firebase confirms that exact Google account email. Membership and invitation writes use the server identity, idempotent request records, role checks, and mutation preconditions; the browser cannot create or promote members directly. Pending invitations expire after 14 days. Notification receipts can be changed only by their recipient.

The same mode lets an owner or admin connect and disconnect one generic verified webhook. ORIN AI accepts only public HTTPS destinations on the standard port, rejects URL credentials, fragments, redirects, local/internal names, private or reserved IPs, and hostnames resolving to any non-public address. Verification sends a random challenge over an HTTPS connection pinned to a validated public DNS result and requires the endpoint to echo it in a small JSON response. The full URL and HMAC secret are encrypted in the connector vault; the secret is returned only after verification and shown once.

Messenger and Instagram team replies resolve raw provider routing identifiers only from a server-owned conversation route, decrypt the workspace's Meta credential, enforce the standard reply window and a team rate limit, and call Meta with the Page token in an Authorization header. The provider must confirm a message ID before ORIN AI writes the team message or analytics event. Idempotency reservations prevent concurrent duplicate sends; provider IDs remain hashed in readable inbox records. A timeout is reported as unknown delivery so the team checks Meta before retrying. Providers without an approved outbound path remain read-only.

WhatsApp team replies follow the same server-owned routing and idempotency rules. ORIN AI enforces the 24-hour customer-service window before sending a free-form reply, calls the official `/{Phone-Number-ID}/messages` endpoint with the encrypted business token, and requires a returned `wamid` before recording delivery. Outside that window the inbox asks the team to use an approved template in WhatsApp Manager instead of pretending a free-form reply was sent.

Shopee team and automatic replies resolve the raw shop and buyer IDs only from a signed Webchat Push and a server-owned conversation route. Every `/api/v2/sellerchat/send_message` request uses Shopee's shop-level HMAC signature, a renewable encrypted shop credential, an idempotent outbound reservation, and a confirmed provider message ID before the inbox records delivery. Shopee duplicate-content, Chat Distribution, permission, and rate-limit errors remain visible instead of being reported as sent.

## `GET /api/integrations/meta/start`

Requires a Firebase ID token, the signed-in personal workspace ID, and the selected ORIN AI ID. Before returning a Meta authorization URL, the backend verifies that the AI has all six required decisions and includes Messenger or Instagram. The ten-minute signed OAuth state binds the callback to the user, workspace, selected AI, and an HttpOnly nonce.

## `DELETE /api/integrations/meta/start`

Disconnects Meta through the authenticated backend. It deletes the public connection, encrypted vault credential, provider-account routes, and the workspace's private Meta conversation delivery routes in one server commit. Removing the visible connection cannot leave usable Meta credentials behind.

## `GET /api/integrations/meta/callback`

Validates the signed state and nonce, exchanges the Meta authorization code, revalidates the selected AI, discovers eligible Pages and linked Instagram professional accounts, and automatically subscribes each discovered account to supported message events. Provider tokens are encrypted with AES-256-GCM and stored in the server-only Firestore vault. The same atomic commit publishes and assigns the selected AI, records its approved Meta auto-reply channels, and creates private provider-account routes used to resolve later webhooks to the authorized workspace. The public connection document contains names, IDs, AI assignment, per-account subscription status, authorization state, and health metadata but never an access token. A partial provider subscription is reported as attention required instead of connected.

## `GET|DELETE /api/integrations/whatsapp/start`

`GET` requires a signed-in personal workspace and a complete ORIN AI configured for WhatsApp. It returns only the public Meta app/configuration values and a ten-minute signed state required to launch Meta's official Embedded Signup in the browser. The state is bound to the user, workspace, selected AI, and an HttpOnly nonce. The user is never asked for a WABA ID, phone-number ID, token, or webhook secret.

`DELETE` removes the readable WhatsApp connection, encrypted credential, all private phone-number routes, and every private WhatsApp conversation route. It does not revoke the shared Meta app grant because doing so could also disconnect the workspace's Facebook and Instagram connector; the owner remains in control of app access in Meta Business Settings.

## `POST /api/integrations/whatsapp/callback`

Accepts the one-time code returned by Embedded Signup, revalidates Firebase identity plus the signed state and nonce, exchanges and debugs the Meta token, requires both WhatsApp management and messaging scopes, and rejects account IDs not granted to the token. The server discovers every eligible WABA and phone number, subscribes each WABA once for all of its number webhooks, encrypts the token and raw asset IDs with AES-256-GCM, creates private hashed phone routes, publishes the assigned AI, and returns only account/phone counts. Partial subscription or missing webhook configuration is reported as attention required instead of connected.

## `GET|POST /api/webhooks/whatsapp`

Uses Meta's webhook verification challenge and verifies `X-Hub-Signature-256` over the exact raw body before parsing. Signed text, media, interactive, location, contact, reaction, and order messages are normalized into the unified inbox; status-only notifications, system notices, unknown types, and replays do not create customer messages. Raw phone-number IDs and customer WhatsApp IDs remain in server-only routes. New conversations can trigger n8n and guarded automatic replies, and the first verified delivery marks a fully subscribed connection healthy.

## `GET|DELETE /api/integrations/tiktok/start`

`GET` requires a Firebase ID token and the signed-in personal workspace. It returns TikTok's official Login Kit authorization URL for the minimum `user.info.basic` scope. The ten-minute HMAC-signed state binds the callback to the user and workspace, and an HttpOnly nonce prevents a valid state from being replayed in another browser session.

`DELETE` decrypts the server-side credential, attempts TikTok's official token revocation, and always removes the local connection, encrypted vault record, and private account route. No TikTok token or raw account identifier is returned to the browser.

## `GET /api/integrations/tiktok/callback`

Validates the signed state and nonce, exchanges the authorization code at TikTok's OAuth v2 token endpoint, requires the basic account scope, and verifies the account through TikTok's User Info API. Access and refresh tokens, raw OpenID and UnionID values, and the profile avatar are encrypted with AES-256-GCM. The readable connection record contains only the display name, hashed provider identifiers, token-expiry metadata, and access status.

This authorization proves account identity only. TikTok customer messaging and TikTok Shop are separate partner products and remain `partner_approval_required`; ORIN AI does not claim those channels are live from Login Kit authorization alone.

## `POST /api/webhooks/tiktok`

Requires TikTok's `TikTok-Signature` HMAC over the exact raw body and rejects signatures more than five minutes old. The payload's client key must match this deployment. The current public event pipeline handles `authorization.removed`: it resolves the workspace through a private hashed OpenID route, records the event idempotently, and atomically removes the connection, encrypted tokens, and route. Unsupported event types are acknowledged without being misrepresented as customer messages.

## `GET|POST /api/webhooks/meta`

`GET` handles Meta's webhook verification challenge using `META_WEBHOOK_VERIFY_TOKEN`. `POST` requires the `X-Hub-Signature-256` HMAC generated with the Meta app secret and rejects unsigned, oversized, or malformed payloads.

Accepted Messenger, Instagram, and Facebook Lead payloads are normalized into provider-neutral records. The server resolves the provider account through the private OAuth route, hashes external identifiers used as document IDs, rejects replayed provider events, and writes the contact, conversation, message, and analytics event through the Firebase service identity. For messages, raw provider account and customer identifiers are isolated in a server-only conversation delivery route and never copied into member-readable inbox records. A first accepted delivery marks a fully subscribed Meta connection healthy.

For an accepted Messenger or Instagram message, a Vercel `waitUntil` task keeps Meta's webhook acknowledgement fast while ORIN AI processes the response in the background. The worker collapses message bursts to the newest inbound message, stops when a team member has already answered, verifies the assigned AI and subscribed provider account, loads only approved AI configuration and knowledge notes, and generates a structured grounded response. An idempotency reservation is created before provider delivery. The AI reply is written to the inbox and analytics only after Meta confirms a message ID; provider identifiers remain hashed in member-readable records. A generation or delivery failure escalates the conversation for team review instead of inventing an answer or retrying blindly.

Matching n8n subscriptions and active “Send to n8n” automations also run after the webhook acknowledgement and receive a signed normalized event; each delivery result is written to `automationRuns`.

An active “Call a verified webhook” automation re-resolves the verified hostname before every delivery, pins the HTTPS connection to that validated public address, refuses redirects, signs the exact JSON body in `X-ORIN-Signature-256`, and records the HTTP outcome. A destination that becomes private, unreachable, or unhealthy produces a visible failed run.

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

## `GET|DELETE /api/integrations/shopee/start`

`GET` requires a signed-in personal workspace and a complete ORIN AI configured for Shopee. It returns Shopee's current seller-authorization URL with a ten-minute HMAC-signed state and HttpOnly nonce. A shop account can authorize one shop; a main account can select multiple shops in the same Shopee journey. The seller is never asked for a shop ID, Partner key, access token, refresh token, or webhook secret.

`DELETE` removes the readable connection, encrypted multi-shop credential, private hashed shop routes, and Shopee conversation-delivery routes. Seller Center remains the authoritative place to revoke the Shopee app grant.

## `GET /api/integrations/shopee/callback`

Validates the signed state and nonce, exchanges the one-time code, accepts either Shopee's `shop_id` or `main_account_id`, automatically expands the returned `shop_id_list`, and obtains a separate renewable token for every authorized shop. Each shop is verified through `v2.shop.get_shop_info`; raw shop IDs and tokens are encrypted with AES-256-GCM, while the dashboard receives names, counts, regions, health, and hashed route IDs only. The connection remains webhook-pending until Shopee delivers a valid signed push.

## `POST /api/webhooks/shopee`

Validates the `Authorization` HMAC over the exact configured callback URL, a pipe separator, and the untouched raw request body before parsing. Webchat Push code 10 buyer messages are normalized into the unified inbox; seller echoes, provider auto-replies, unrelated push codes, malformed messages, and replays do not create customer messages. A verified first message marks the connection healthy, can trigger n8n, and can schedule a guarded grounded ORIN AI reply. The route returns an empty 204 response to satisfy Shopee's push success requirements.

Shopee Customer Service App access is an external approval gate. ORIN AI keeps this connector visibly locked until production Partner credentials are installed; it never treats a draft or generic seller login as messaging approval.

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
