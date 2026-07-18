---
name: orin-ai
description: Operate an ORIN AI workspace through its loaded API for agents, customer conversations, CRM, publishing, automations, commerce, analytics, and integrations. Use when a user asks a frontier model to inspect or act on ORIN AI data.
---

# ORIN AI

Use ORIN AI as the customer-operations system. Prefer the loaded ORIN OpenAPI tools. If they are not loaded, use the HTTP contract in `references/api.md`.

## Required context

Before any request, obtain:

- `ORIN_BASE_URL` (normally `https://www.orin.work`)
- `ORIN_WORKSPACE_ID`
- a current Firebase ID token supplied through the host's secret manager

Never request, print, log, or persist provider secrets. Never place an ID token in a URL.

## Operating rules

1. Read before mutating when the current state affects the action.
2. Send `Authorization: Bearer <Firebase ID token>` and `Content-Type: application/json`.
3. Include `workspaceId` in every workspace-scoped call.
4. Generate a unique `requestId` for mutations and reuse it only when retrying the exact same action.
5. Treat provider status as authoritative. Never describe a channel as connected unless ORIN reports it connected and healthy.
6. Treat delivery as successful only when ORIN returns provider-confirmed delivery.
7. Do not infer age, gender, ethnicity, health, finances, or other sensitive traits from names, messages, or images.
8. Ask for confirmation before cancelling a scheduled campaign, disconnecting an integration, sending a bulk message, or changing a paid order.

## Choose the shortest workflow

- Customer question or handoff: inspect the conversation, customer context, and status; reply or assign only when requested.
- Publish: verify connected targets, compose master copy and optional channel variants, then publish or schedule.
- Automation: use ORIN's guided automation for standard triggers and actions; use n8n only for advanced orchestration.
- Commerce: use catalog and order actions. Never invent a price, stock count, payment result, or quotation.
- Analytics: report the selected range and disclose any returned truncation or unavailable data.
- Integration: read capabilities first. If approval or app credentials are missing, explain the exact gate rather than simulating a connection.

Read `references/api.md` for request patterns and `references/events.md` for normalized events.

