# ORIN AI API patterns

Base URL: `ORIN_BASE_URL`

Authentication header:

```text
Authorization: Bearer <Firebase ID token>
```

The token is a user identity, not a provider credential. ORIN verifies workspace membership and role on the server.

## Publishing

`POST /api/social/publish`

```json
{
  "workspaceId": "workspace-id",
  "requestId": "unique-id",
  "text": "Master copy",
  "mediaUrl": "https://optional-public-image",
  "scheduledAt": "2026-07-19T01:00:00.000Z",
  "recurrence": "none",
  "maxRuns": 1,
  "targets": [
    { "provider": "facebook", "variant": "" },
    { "provider": "instagram", "variant": "Instagram-specific copy" }
  ]
}
```

Valid recurrence values are `none`, `daily`, `weekdays`, `weekly`, and `monthly`. Recurring campaigns require 2–365 runs and a future first publish time.

Use `POST /api/social/cancel` with `workspaceId` and `postId` to cancel a pending campaign. Use `POST /api/social/retry` only for a failed or partially delivered campaign.

## Analytics

`GET /api/analytics/summary?workspaceId=<id>&days=30&timezoneOffsetMinutes=480`

Valid ranges are 7, 30, and 90 days. Preserve the response's truncation and data-availability flags in any report.

## Agent operations

`POST /api/agents/ai`

The route supports authenticated studio tests and scheduler sweeps. Use the product UI for agent creation until a public agent-management contract is included in the loaded OpenAPI specification.

## Inbox and CRM

`POST /api/widget/message` supports authenticated workspace modes including:

- `team_reply`
- `mark_read`
- `resume_ai`
- `crm_update`
- `team_access`

For `team_reply`, include `workspaceId`, `conversationId`, `requestId`, and `message`. For `crm_update`, include an approved action and only its required fields. Do not use public website-widget sessions for team operations.

## n8n

`POST /api/integrations/n8n/connect` verifies and stores an n8n Cloud production webhook. Only `https://*.n8n.cloud/webhook/*` URLs are accepted.

`DELETE /api/integrations/n8n/connect` requires owner or admin access.

Read `/api/integrations/capabilities` and `/api/integrations/vault/health` before presenting connection actions.

## Complete machine-readable contract

Load `/orin-openapi.json` from the ORIN deployment. Treat the loaded contract as newer than this reference.

