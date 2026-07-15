# ORIN lead API

## `GET /api/session`

Verifies a Firebase Authentication ID token before a privileged ORIN AI API request is accepted.

```http
Authorization: Bearer <firebase-id-token>
```

Successful responses return the verified user identifier and basic Google account claims. The endpoint never returns credentials, provider access tokens, or Firebase configuration secrets.

## `POST /api/integrations/n8n/test`

Sends a signed-in workspace's one-time connectivity event to a public HTTPS n8n webhook. The URL is validated against local, private, link-local, reserved, credential-bearing, non-HTTPS, redirecting, and nonstandard-port targets before delivery.

```http
Authorization: Bearer <firebase-id-token>
Content-Type: application/json

{
  "workspaceId": "personal_<firebase-uid>",
  "webhookUrl": "https://example.app.n8n.cloud/webhook/orin-connection-test"
}
```

The current endpoint accepts n8n Cloud hosts under `*.n8n.cloud`. Self-hosted n8n delivery is deliberately unavailable until the server deployment and credential-vault path are ready. The endpoint does not persist the webhook URL. A successful response proves only that the endpoint accepted a test event; it does not mark a production connector as healthy or active.

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
