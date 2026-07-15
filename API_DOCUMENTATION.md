# ORIN lead API

## `POST /api/submit-form`

The endpoint validates a lead and forwards it to `SHEET_WEBHOOK_URL`. It never reports success unless the configured webhook accepts the payload.

### Request

```json
{
  "name": "Juan Dela Cruz",
  "business_name": "Sample Store",
  "email": "juan@example.com",
  "ai_role": "Sales and support",
  "configuration": "{\"channels\":[\"Messenger\"],\"tone_notes\":\"Warm and concise\"}",
  "company_website": ""
}
```

`configuration` is an optional JSON string containing the visitor's saved AI-builder choices, including channels, responsibilities, voice notes, and human escalation rules.

`company_website` is a honeypot and must remain empty.

### Responses

- `200` — delivered successfully, or silently accepted as spam when the honeypot is filled.
- `400` — required fields are missing or the email is invalid.
- `405` — only `POST` is supported.
- `503` — `SHEET_WEBHOOK_URL` is not configured.
- `502` — the configured webhook rejected or failed to receive the lead.
