# ORIN AI application architecture

## Product surfaces

- `/` remains the public ORIN AI story, calculator, and resumable configuration brief.
- `/login` is the account entry point. Google is the first identity provider.
- `/app` is the authenticated workspace for AI agents, inbox, contacts, automations, integrations, analytics, and settings.
- `/app/agents/new` is the full AI studio. The public brief can be imported after sign-in.

## Trust boundaries

The browser uses Firebase Authentication for identity and Firestore for tenant-scoped product data. Every privileged Vercel API route receives a Firebase ID token in the `Authorization: Bearer <token>` header and validates it with Firebase Authentication before reading or changing workspace data.

Social-platform access tokens, n8n credentials, webhook signing secrets, and service-account credentials are server-only. Provider tokens are encrypted with AES-256-GCM before the server writes them to `connectorVault`; Firestore rules deny every client read and write to that collection. Connection documents expose status and non-secret metadata only.

## Tenant model

```text
users/{uid}
workspaces/{workspaceId}
  members/{uid}
  agents/{agentId}
  contacts/{contactId}
  conversations/{conversationId}
    messages/{messageId}
  automations/{automationId}
  connections/{connectionId}
  connectorVault/{providerId}   # server-only encrypted credentials
  providerEvents/{eventId}      # server-only replay protection
  events/{eventId}
  automationRuns/{runId}
```

`connectorRoutes/{providerAccountId}` is a top-level, server-only index created during provider authorization. Webhook payloads never supply a workspace ID; the backend derives the destination workspace exclusively from this index.

Website chat uses separate top-level, server-only `publicWidgets/{widgetKey}` and `widgetRateLimits/{bucketId}` records. The random widget key is public, but workspace and agent identifiers remain server-side. A short-lived signed session binds each browser to an exact allowed origin before a message can enter the workspace.

Membership roles are `owner`, `admin`, `editor`, and `viewer`. Firestore rules require membership for workspace reads and an editing role for writes. OAuth callbacks use a Firebase service account through the Firestore REST API; the service account bypasses client rules only inside server functions.

## Agent configuration

An agent is built from seven decisions:

1. Purpose and business outcome
2. Customer channels
3. Approved knowledge sources
4. Capabilities and responsibilities
5. Voice, tone, and languages
6. Operating and escalation rules
7. Review, test, and activation

Drafts save locally for anonymous visitors and to the authenticated workspace once an account exists. Publishing is separate from saving: an agent cannot become active until its required knowledge and at least one channel connection are ready.

## Connector lifecycle

Every connector separates authorization, configuration, and health. OAuth begins on an authenticated server route, uses a ten-minute HMAC-signed state value tied to an HttpOnly nonce cookie, and finishes on a provider callback. A provider is not shown as connected until authorization and webhook health both succeed. Webhooks require provider signature verification, a server-owned provider-account route, and idempotency before an event enters ORIN AI.

Initial connector groups:

- Meta: Facebook Pages, Messenger, and Instagram use Meta authorization and signed webhooks.
- WhatsApp Business uses Meta Embedded Signup. ORIN AI discovers shared business accounts and phone numbers, subscribes each WABA once, encrypts tokens and raw asset IDs, and exposes only verified names, business display numbers, counts, and hashed routes to workspace members.
- TikTok Login Kit connects and verifies account identity with the minimum basic-profile scope. Customer messaging and TikTok Shop remain separate partner-access products until TikTok approves them.
- Shopee Customer Service remains approval-gated. Once Shopee issues production Partner credentials, ORIN AI uses the current seller authorization page, discovers every selected shop from the main-account token response, and prepares one seller-chat inbox without asking the seller for technical identifiers.
- Lazada uses the official seller OAuth flow. ORIN AI automatically discovers every authorized country shop, stores access and refresh tokens only in the encrypted vault, and exposes only hashed seller identifiers to the dashboard.
- Shopify receives its own OAuth connection rather than being hidden inside a generic commerce card.
- Airbnb remains partner-access only where official account/API access permits.
- Web: website chat and forms
- Automation: n8n Cloud production webhooks can be verified and linked through the encrypted connector vault. Self-hosted n8n remains visibly marked “Coming soon” and is rejected by the server until its deployment and network policy are ready.

The interface must never imply that a connector is active until its authorization and health check have succeeded.

TikTok authorization stores access and refresh tokens only in the encrypted vault and exposes hashed provider identifiers in the member-readable connection. Its signed webhook currently handles account deauthorization and removes local access atomically. Because public Login Kit does not provide a live customer-DM inbox, the dashboard reports the account as synced with messaging access under review rather than connected for customer service.

Shopify uses a standalone authorization-code flow tied to an exact `myshopify.com` domain. The callback verifies Shopify's query HMAC in addition to ORIN AI's state and nonce, verifies the shop through the versioned GraphQL Admin API, and encrypts the offline token. App-specific webhooks use one HTTPS handler that verifies the raw-body HMAC, routes by a private hashed shop index, deduplicates `X-Shopify-Webhook-Id`, and marks the connection healthy only after a valid delivery.

Lazada seller authorization is tied to a ready ORIN AI configured for the Lazada channel. The callback signs the token exchange using Lazada's canonical HMAC-SHA256 algorithm, encrypts renewable credentials and raw seller identifiers, creates one private route per discovered shop, and removes stale routes on reconnection. IM pushes must pass Lazada's `Authorization` body signature before buyer messages can enter the shared inbox. Seller echoes, recalled messages, system pushes, and unsupported event categories are ignored; accepted messages are hashed, idempotent, and mark the connection healthy only after the first verified push. Team replies and guarded automatic replies sign `/im/message/send` server-side, refresh expiring access from the encrypted vault, obey private session routes, reserve idempotent outbound records before delivery, and never report a message as sent without a Lazada message ID. New conversations and handoffs can also reach the signed n8n Cloud event pipeline.

Shopee seller authorization is tied to a ready ORIN AI configured for Shopee and remains unavailable until Shopee grants Customer Service App access. The callback accepts either a single shop or main account, exchanges the one-time code, expands the authorized shop list, obtains one renewable credential per shop, verifies shop identity, and stores raw IDs and tokens only in the encrypted vault/private route index. Webchat Push authorization covers the exact callback URL plus raw body; accepted buyer messages become hashed, idempotent inbox records, while seller echoes and Shopee chatbot replies cannot start an auto-reply loop. Team and automatic responses use the signed `v2.sellerchat.send_message` API, refresh only the target shop credential, reserve delivery idempotently, surface Shopee's distribution/duplication limits, and require a provider message ID before reporting success.

WhatsApp Embedded Signup is tied to a ready ORIN AI configured for WhatsApp. The browser runs Meta's official signup dialog, while the backend exchanges and debugs the returned code, verifies WhatsApp management and messaging scopes, discovers granted WABAs and phone numbers, subscribes each WABA, and encrypts the token plus raw asset IDs. Signed webhook messages enter the same hashed inbox model, while status-only updates and unsupported/system events are acknowledged without becoming conversations. Automatic and team replies use the official Cloud API, require a returned message ID, and enforce WhatsApp's 24-hour free-form reply window.

Website chat is published only from an active, ready agent configured for the Website channel. The embed script requests an origin-bound session, loads an isolated iframe, and sends messages through a server endpoint with idempotency and abuse controls. The backend loads recent conversation context and approved agent knowledge, then persists both sides of the exchange into the same provider-neutral inbox and analytics model used by social connectors. If inference is unavailable or the approved information is insufficient, the response is marked for team handoff.

## Event pipeline

Verified provider deliveries are normalized into a small internal event vocabulary before persistence. A Messenger or Instagram message updates one hashed contact record, one channel conversation, its immutable message record, and the corresponding analytics events. Facebook Lead events update the contact record and create a `lead.captured` analytics event. Provider replay IDs are committed with the data so duplicate deliveries cannot inflate the inbox or analytics.

The same normalized event can trigger a healthy n8n Cloud destination directly through its selected event subscriptions or through an active “Send to n8n” automation. ORIN AI signs the outbound body, refuses redirects, records the response status, and keeps failures visible in automation delivery history. Other automation actions remain drafts until their destination implementation is available.

## Analytics

Workspace analytics are calculated from first-party ORIN AI events: inquiries received, first-response time, conversations resolved, conversations escalated, leads captured, attributed orders or bookings, and hours estimated as returned. Financial figures remain estimates unless an external commerce source provides verified transaction data.

## Deployment

Vite builds the client for Vercel. A rewrite sends non-API routes to `index.html` so `/login` and `/app/*` work on direct load. Firebase client configuration uses `VITE_FIREBASE_*` variables. Service-account, encryption, OAuth, and connector secrets use server-only Vercel environment variables listed in `.env.example` and must never use the `VITE_` prefix.
