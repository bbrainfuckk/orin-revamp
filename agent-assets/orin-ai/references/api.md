# ORIN AI API

Base URL: `https://www.orin.work`

Create an owner-scoped key in ORIN AI Settings. Send it only in the header:

```text
Authorization: Bearer orin_live_...
```

Never place a key in a URL. The CLI stores its key in `~/.orin/config.json` with user-only file permissions. `ORIN_API_KEY` and `ORIN_BASE_URL` override that file.

## Read endpoints

- `GET /api/orin/v1/status`
- `GET /api/orin/v1/inbox`
- `GET /api/orin/v1/analytics?days=30&timezoneOffset=0`
- `GET /api/orin/v1/campaigns`

Read keys have `workspace:read`, `inbox:read`, `analytics:read`, and `publishing:read`. Automation keys add `publishing:write`. The key determines its workspace, so clients do not choose or override the workspace ID.

## Publish or schedule

`POST /api/social/publish`

```json
{
  "requestId": "one-unique-id-for-this-exact-campaign",
  "text": "Master copy",
  "mediaUrl": "https://optional-public-image.example/image.jpg",
  "scheduledAt": "2026-07-19T01:00:00.000Z",
  "recurrence": "none",
  "maxRuns": 1,
  "targets": [
    { "provider": "facebook" },
    { "provider": "instagram", "variant": "Instagram-specific copy" }
  ]
}
```

Valid recurrence values are `none`, `daily`, `weekdays`, `weekly`, and `monthly`. Recurring campaigns require a future first publish time and 2–365 runs. Immediate delivery returns provider-level results. Scheduled state means queued, not delivered.

## Owner key management

The Settings UI calls `/api/orin/v1/keys` with the signed-in owner's Firebase identity. Raw API keys are returned only once at creation. Revocation immediately disables API and MCP access.

## Machine-readable contract

Load `/orin-openapi.json` from the ORIN deployment. Treat that file as newer than this reference.
