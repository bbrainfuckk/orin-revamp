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
  events/{eventId}
```

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

Every connector separates authorization, configuration, and health. OAuth begins on an authenticated server route, uses a ten-minute HMAC-signed state value tied to an HttpOnly nonce cookie, and finishes on a provider callback. A provider is not shown as connected until authorization and webhook health both succeed. Webhooks require provider signature verification and idempotency before an event enters ORIN AI.

Initial connector groups:

- Meta: Facebook Pages, Messenger, and Instagram use Meta authorization and signed webhooks.
- TikTok, Shopee, and Lazada remain partner-access integrations until production API credentials are approved.
- Shopify receives its own OAuth connection rather than being hidden inside a generic commerce card.
- Airbnb remains partner-access only where official account/API access permits.
- Web: website chat and forms
- Automation: n8n Cloud production webhooks can be verified and linked through the encrypted connector vault. Self-hosted n8n remains visibly marked “Coming soon” and is rejected by the server until its deployment and network policy are ready.

The interface must never imply that a connector is active until its authorization and health check have succeeded.

## Analytics

Workspace analytics are calculated from first-party ORIN AI events: inquiries received, first-response time, conversations resolved, conversations escalated, leads captured, attributed orders or bookings, and hours estimated as returned. Financial figures remain estimates unless an external commerce source provides verified transaction data.

## Deployment

Vite builds the client for Vercel. A rewrite sends non-API routes to `index.html` so `/login` and `/app/*` work on direct load. Firebase client configuration uses `VITE_FIREBASE_*` variables. Service-account, encryption, OAuth, and connector secrets use server-only Vercel environment variables listed in `.env.example` and must never use the `VITE_` prefix.
