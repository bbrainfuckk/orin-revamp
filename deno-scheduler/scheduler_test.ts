import { runSweep, schedulerConfig, sweepPaths } from './scheduler.ts';

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

Deno.test('validates scheduler configuration', () => {
  const values = new Map([['ORIN_BASE_URL', 'https://www.orin.work/'], ['ORIN_SCHEDULER_SECRET', 'x'.repeat(32)]]);
  const config = schedulerConfig({ get: (name) => values.get(name) });
  assert(config.baseUrl === 'https://www.orin.work', 'base URL should be normalized');
  assert(config.secret.length === 32, 'secret should be retained');
  let rejected = false;
  try { schedulerConfig({ get: (name) => name === 'ORIN_BASE_URL' ? 'http://www.orin.work' : 'x'.repeat(32) }); } catch { rejected = true; }
  assert(rejected, 'insecure origins must be rejected');
});

Deno.test('calls both signed ORIN sweep endpoints', async () => {
  const calls: Array<{ url: string; secret: string }> = [];
  const fakeFetch = ((input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), secret: headers.get('X-ORIN-Scheduler') || '' });
    return Promise.resolve(Response.json({ ok: true, checked: 2 }));
  }) as typeof fetch;
  const results = await runSweep({ baseUrl: 'https://www.orin.work', secret: 's'.repeat(32) }, fakeFetch);
  assert(results.length === sweepPaths.length, 'both job types should run');
  assert(calls.every((call) => call.secret === 's'.repeat(32)), 'every request must be signed');
  assert(calls.map((call) => new URL(call.url).pathname + new URL(call.url).search).join(',') === sweepPaths.join(','), 'only approved sweep routes should be called');
});

Deno.test('fails the cron run when ORIN reports a delivery failure', async () => {
  const fakeFetch = (() => Promise.resolve(Response.json({ ok: false }, { status: 200 }))) as typeof fetch;
  let rejected = false;
  try { await runSweep({ baseUrl: 'https://www.orin.work', secret: 's'.repeat(32) }, fakeFetch); } catch { rejected = true; }
  assert(rejected, 'failed jobs must trigger Deno retry backoff');
});
