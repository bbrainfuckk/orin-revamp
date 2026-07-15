# ORIN AI application architecture

## Product surfaces

- `/` remains the public ORIN AI story, calculator, and resumable configuration brief.
- `/login` is the account entry point. Google is the first identity provider.
- `/app` is the authenticated workspace for AI agents, inbox, contacts, automations, integrations, analytics, and settings.
- `/app/agents/new` is the full AI studio. The public brief can be imported after sign-in.

## Trust boundaries

The browser uses Firebase Authentication for identity and Firestore for tenant-scoped product data. Every privileged Vercel API route receives a Firebase ID token in the `Authorization: Bearer <token>` header and verifies it with the Firebase Admin SDK before reading or changing workspace data.

Social-platform access tokens, n8n credentials, webhook signing secrets, and service-account credentials are server-only. They must never be returned to the browser or stored in a client-readable Firestore document. Connection documents expose status and metadata only.

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
  events/{eventId}
```

Membership roles are `owner`, `admin`, `editor`, and `viewer`. Firestore rules require membership for workspace reads and an editing role for writes. Connector callbacks and webhook ingestion run through verified server routes and use the Admin SDK.

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

Every connector moves through explicit states: `available`, `authorizing`, `connected`, `attention_required`, or `disconnected`. OAuth begins on an authenticated server route, uses a short-lived signed state value, and finishes on a provider callback. Webhooks require signature verification and idempotency keys before an event enters ORIN AI.

Initial connector groups:

- Meta: Facebook Pages, Messenger, Instagram
- Commerce: TikTok, Shopee, Lazada, Shopify
- Hospitality: Airbnb where account/API access permits
- Web: website chat and forms
- Automation: n8n webhook and API credentials

The interface must never imply that a connector is active until its authorization and health check have succeeded.

## Analytics

Workspace analytics are calculated from first-party ORIN AI events: inquiries received, first-response time, conversations resolved, conversations escalated, leads captured, attributed orders or bookings, and hours estimated as returned. Financial figures remain estimates unless an external commerce source provides verified transaction data.

## Deployment

Vite builds the client for Vercel. A rewrite sends non-API routes to `index.html` so `/login` and `/app/*` work on direct load. Firebase client configuration uses `VITE_FIREBASE_*` variables. Admin and connector secrets use server-only Vercel environment variables.
