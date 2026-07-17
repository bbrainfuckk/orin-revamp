import { runSweep, schedulerConfig } from './scheduler.ts';

const config = schedulerConfig();

Deno.cron('ORIN scheduled delivery', '* * * * *', {
  backoffSchedule: [5_000, 15_000, 30_000],
}, async () => {
  const startedAt = new Date().toISOString();
  const results = await runSweep(config);
  console.log(JSON.stringify({ event: 'orin.scheduler.sweep', startedAt, results }));
});

Deno.serve((request) => {
  const url = new URL(request.url);
  if (url.pathname !== '/health') return new Response('Not found', { status: 404 });
  return Response.json({ ok: true, service: 'orin-deno-scheduler', provider: 'deno', cron: '* * * * *' }, {
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
});
