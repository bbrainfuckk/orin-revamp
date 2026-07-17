# ORIN AI communications platform plan

## Product decision

ORIN AI owns its social publishing API. Ayrshare, Buffer, Hootsuite, Metricool, and Repurpose.io are competitors or optional import sources, never runtime dependencies.

ORIN keeps one customer experience across publishing, inbox, CRM, automations, calls, and SMS. Each provider adapter translates that internal model to an official provider API; provider tokens remain encrypted in the existing connector vault.

## Current baseline

Already live:

- Google sign-in, tenant workspaces, roles, and team access
- ORIN AI builder, private tests, activation, Website Chat, inbox, contacts, CRM, analytics, and ROI attribution
- n8n Cloud, verified webhooks, automation execution, and delivery history
- secure connector foundations for Meta, WhatsApp, TikTok, Shopee, Lazada, Shopify, and Airbnb

Still required:

- direct social publishing, media storage, scheduling, approval, delivery history, and post analytics
- inbound and outbound AI phone calls
- transactional and campaign SMS with country-aware routing and compliance
- billing, quotas, provider onboarding, and production app approvals

## Direct social publishing

### Internal contract

Every provider implements the same small contract:

```text
authorize -> discoverAccounts -> validate -> publish -> inspect -> delete -> readMetrics
```

ORIN stores only three new resource types under each workspace:

```text
socialAssets/{assetId}       uploaded media and validated renditions
socialPosts/{postId}         master copy, per-channel variants, schedule, approval state
socialDeliveries/{deliveryId} one target account, provider result, attempts, cost, metrics cursor
usageMeters/{provider_day}   daily request, quota, traffic, unit, and cost counters
```

Existing resources remain authoritative:

- `connections` and `connectorVault` for account metadata and encrypted credentials
- `events` for analytics and attributed revenue
- `automationRuns` for retry/audit history
- `contacts`, `conversations`, and `messages` for comments and direct messages when providers allow them

### Connection modes

Every supported provider offers the simplest mode it permits:

- **Connect with ORIN** is the default. The customer signs in on the provider's official consent screen, selects the accounts ORIN may manage, and returns to a verified connection. ORIN owns the approved provider application and refresh lifecycle.
- **Bring your own credentials** is an Advanced option. A customer can supply an approved API key or OAuth application credentials when the provider permits it. ORIN shows the exact callback URL and required scopes, validates the credentials server-side, and encrypts them in the existing workspace vault.
- BYOK never bypasses provider approval, policy, consent, rate limits, or account eligibility. It changes whose provider project and quota are used.
- A connection is marked ready only after ORIN discovers at least one manageable destination and completes a harmless permission/health check.

### Platform rollout

| Wave | Platforms | First supported output | External gate |
| --- | --- | --- | --- |
| 1 | Facebook Pages, Instagram, TikTok, YouTube | page posts, photos, reels/video, Shorts/video | Meta review; TikTok Direct Post audit; YouTube upload audit |
| 2 | LinkedIn, Threads, Pinterest, X, Google Business Profile | text, image/video, documents where supported, Pins, local offers/events | provider app review, approved scopes, and X usage plan |
| 3 | Reddit, Bluesky, Mastodon, Telegram | subreddit posts, posts with supported media, and threads | Reddit-approved Data API access or an eligible Devvit installation; user authorization; Telegram bot must be a channel admin |
| Access-gated | Snapchat | only capabilities approved by the provider | Snap Public Profile partner access |

The interface never promises a post type that the selected account cannot publish. Provider limits are discovered at compose time and shown before approval.

Threads uses Meta's official Threads OAuth and container/publish flow as its own direct adapter. Reddit automation supports only explicitly selected communities and provider-approved posting methods; ORIN will collect the required title, subreddit, post type, flair, NSFW/spoiler state, and any community-specific confirmation instead of blindly cross-posting generic content. No scraping, stored browser sessions, or simulated clicks are part of either connector.

### Customer journey

1. Connect a social account through the provider's official consent screen.
2. ORIN discovers the pages, profiles, channels, boards, or locations the user may manage.
3. Create one master post or ask ORIN AI to repurpose existing media.
4. ORIN creates editable channel variants and validates every caption, aspect ratio, duration, disclosure, and permission.
5. Publish now, add to a queue, or choose a workspace-local schedule.
6. Optional team approval prevents publishing until an owner, admin, or designated approver accepts the exact revision.
7. Delivery history shows accepted, processing, published, failed, and retrying states with the provider's real post URL or actionable failure.
8. Analytics joins post metrics to ORIN leads, conversations, orders, and bookings without inventing attribution.

### API consumption and cost controls

ORIN meters every provider call made through its gateway, including managed and BYOK connections. Daily counters roll into workspace and provider views for:

- requests, successes, failures, retries, and provider quota units
- upload/download bytes and media processing work
- rate-limit remaining/reset values when the provider returns them
- SMS segments, voice seconds, and AI input/output tokens where applicable
- estimated provider cost and currency using a versioned pricing snapshot

The dashboard labels numbers precisely:

- **Measured usage** comes from ORIN gateway activity and signed callbacks.
- **Estimated spend** is calculated from known public or configured rates.
- **Provider billed** appears only when a provider billing endpoint or imported invoice confirms it.

Workspace owners can set warning thresholds and hard automation caps per provider. BYOK activity is still metered, but the provider bills the customer's account directly.

### Scheduling and media

- Firebase Storage receives direct browser uploads; Firestore stores metadata, hashes, ownership, and validation results.
- The publisher uses provider pull-from-URL flows where supported and resumable/chunked provider uploads where required.
- Deno Deploy runs one signed sweep each minute and calls the existing Vercel dispatcher. Firestore remains the source of truth; Deno receives no provider credentials or customer content.
- Retries are idempotent. A retry can never create a second provider post after a successful provider ID has been recorded.
- Large video transcoding moves to a dedicated worker only when real upload volume proves that the serverless path is insufficient.

### API and deployment shape

The Vercel Hobby project already uses all 12 physical functions. Social routes therefore reuse the existing integration and webhook dispatchers:

```text
/api/social/:action   -> existing integration dispatcher
/api/webhooks/social  -> existing provider webhook dispatcher
```

Initial actions are `start`, `callback`, `accounts`, `draft`, `publish`, `schedule`, `cancel`, `status`, `metrics`, and `usage`. Native `fetch`, Web Crypto, and existing Firebase helpers are preferred over a new SDK for every provider.

## AI calls

Launch with ElevenLabs Agents for inbound/outbound calls, tools, transfers, post-call webhooks, and SIP/Twilio connectivity. Grok Voice is a selectable bring-your-own-provider option after the common call model is live. ORIN owns agent configuration, CRM context, consent, call history, outcomes, and human transfer rules; the voice model remains replaceable.

Core records:

```text
phoneNumbers/{numberId}
calls/{callId}
callEvents/{eventId}
```

Call transcripts and recordings default to the shortest configured retention; healthcare workspaces require explicit compliance configuration before activation.

## SMS

- Beta: workspace-owned Twilio credentials for international SMS and Semaphore for Philippine routes.
- Managed scale: Infobip CPaaS X, because it supplies tenant isolation, scoped resources, webhooks, routing, and per-customer reporting.
- Optional adapters: PhilSMS and other approved local providers after the common contract is proven.

The SMS contract is `send -> receiveStatus -> receiveReply -> optOut`. Every message records sender identity, consent source, purpose, country, encoding/segment count, cost/currency, provider ID, and delivery state. Philippine messages require a registered sender ID, opt-in/opt-out handling, approved URLs where applicable, and compliant sending windows.

## Delivery order

### Phase 1 — publishing core

- Publishing navigation, calendar, composer, media library, channel variants, approvals, and delivery history
- normalized provider contract, managed/BYOK account connections, encrypted credentials, capability validation, idempotency, scheduler, usage meters, limits, and security checks
- Meta and TikTok sandbox/private-mode adapters using the existing connector foundations

### Phase 2 — first production networks

- complete Meta review and TikTok audit
- YouTube uploads and audit
- LinkedIn, Threads, and Pinterest adapters, including automated Threads variants
- normalized post analytics and ORIN revenue attribution

### Phase 3 — coverage and repurposing

- X, Google Business Profile, Reddit, Bluesky, Mastodon, and Telegram
- source-to-destination repurposing recipes, queues, evergreen rules, watermark policy, and per-channel AI revisions
- comments and social engagement routed into the existing inbox where official APIs allow it

### Phase 4 — voice and SMS

- ElevenLabs call setup, numbers, call inbox, transfer, summaries, outcomes, and safety controls
- Twilio/Semaphore beta SMS, opt-out ledger, templates, campaigns, delivery dashboards, and country routing
- Infobip managed onboarding after commercial access is approved

### Phase 5 — hardening

- billing and quotas, cost controls, provider health, token refresh alerts, audit exports, data retention, abuse controls, load tests, and disaster recovery
- Snapchat only after written provider access confirms the exact production capabilities

## Non-negotiable trust rules

- official OAuth/consent only; ORIN never asks for a social password or browser cookie
- least-privilege scopes, PKCE/state verification, encrypted refresh tokens, signed webhooks, and replay protection
- workspace roles and exact-revision approvals on every publish mutation
- no hidden publishing, fake metrics, silent fallbacks, or "connected" state before a real authorization and health check
- explicit AI-generated-content and commercial-content disclosures whenever a provider requires them
- consent, STOP handling, quiet hours, sender registration, and country policy validation before SMS campaigns
