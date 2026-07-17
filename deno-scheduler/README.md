# ORIN Deno scheduler

This production-only Deno Deploy app wakes ORIN once per minute. It receives no
customer content or provider credentials. Both callback routes require the same
`ORIN_SCHEDULER_SECRET` stored in Vercel.

Required Deno environment variables:

- `ORIN_BASE_URL=https://www.orin.work`
- `ORIN_SCHEDULER_SECRET=<same 32+ character value as Vercel>`

Use the new Deno Deploy platform. Deno Deploy Classic is not supported.
