# ORIN AI normalized events

Common event types:

- `message.received`
- `message.sent`
- `conversation.started`
- `conversation.responded`
- `conversation.escalated`
- `lead.captured`
- `order.created`
- `order.paid`

Events are workspace-scoped and may include provider, channel, conversation, contact, occurrence time, and a non-sensitive preview. Provider account identifiers and customer routing identifiers remain server-only.

## Handoff

`conversation.escalated` means ORIN AI has determined that the team is needed. It is not a failure. A team reply puts supported messaging conversations into team takeover until a teammate explicitly resumes ORIN AI.

## Delivery truth

A generated response is not a sent event. ORIN AI records `message.sent` only after the provider confirms delivery. Automation and publishing results can be partial; preserve each target's state.

## Webhook handling

When receiving an ORIN signed webhook:

1. Verify the signature over the exact raw request body.
2. Reject replays using the event identifier.
3. Acknowledge quickly.
4. Process idempotently.
5. Report the durable outcome back through the configured ORIN outcome route when applicable.

