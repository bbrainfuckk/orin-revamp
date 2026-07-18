---
name: orin-ai
description: Operate a real ORIN AI workspace through the official CLI, MCP server, or API. Use for ORIN inbox, customer operations, analytics, publishing campaigns, agents, automations, commerce, or connected-provider status.
---

# ORIN AI

Use the official ORIN CLI or loaded `orin_*` MCP tools. They connect to a live ORIN AI workspace; never simulate a successful operation.

## Connect

Prefer already-loaded MCP tools. Otherwise:

1. Check `orin doctor`.
2. If the CLI is missing, install it with `npm install -g https://www.orin.work/downloads/orin-cli.tgz`.
3. If it is disconnected, ask the workspace owner to create a key in **ORIN AI → Settings → ORIN CLI, API & MCP**, then run `orin setup` themselves. Never ask them to paste the key into chat.
4. Add the local MCP server with `orin mcp install codex` or `orin mcp install claude`.

Environment-based automation may use `ORIN_BASE_URL` and `ORIN_API_KEY` from the host secret manager.

## Commands

- Workspace and integrations: `orin status --json`
- Inbox: `orin inbox --json`
- Advanced analytics: `orin analytics --days 30 --json`
- Publishing queue: `orin campaigns --json`
- Publish or schedule: `orin publish --text "..." --channels facebook,instagram [--image URL] [--at ISO]`
- MCP stdio server: `orin mcp`

Read `references/api.md` for the HTTP contract and `references/events.md` for normalized events.

## Safety and delivery truth

1. Read current state before a mutation when it affects the action.
2. Ask for confirmation before publishing, scheduling, or changing anything externally visible unless the user already gave the exact content, targets, and time.
3. Generate one request ID per campaign; reuse it only to retry that exact campaign.
4. A saved or scheduled campaign is not a delivered campaign. Report the provider-confirmed status returned by ORIN.
5. Never describe a provider as connected unless its returned state is connected and healthy.
6. Never expose ORIN keys or downstream provider credentials in output, logs, URLs, or generated files.
7. Do not infer sensitive traits—including age—from names, messages, photos, or activity.
8. Do not invent prices, inventory, quotations, payment results, or customer details.

## Short workflows

- Customer question: inspect inbox state and customer context, then reply or hand off only when requested.
- Analytics: select the requested period, report operational metrics and channel mix, and preserve availability notes.
- Publishing: inspect connections and queue, confirm the actual targets, then create one idempotent campaign.
- Automation: use ORIN guided automations for standard work; use connected n8n only for advanced orchestration.
- Integrations: report the exact authorization, app-review, credential, or provider gate instead of pretending it is ready.
