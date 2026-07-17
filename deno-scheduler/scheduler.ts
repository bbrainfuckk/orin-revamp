export type SchedulerConfig = { baseUrl: string; secret: string };
export type SweepResult = { path: string; checked: number; ok: boolean };

export const sweepPaths = ['/api/social/sweep', '/api/agents/ai?action=sweep'] as const;

export function schedulerConfig(environment: Pick<typeof Deno.env, 'get'> = Deno.env): SchedulerConfig {
  const baseUrl = (environment.get('ORIN_BASE_URL') || 'https://www.orin.work').replace(/\/+$/, '');
  const secret = environment.get('ORIN_SCHEDULER_SECRET') || '';
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new Error('ORIN_BASE_URL must be an HTTPS origin.');
  }
  if (secret.length < 32) throw new Error('ORIN_SCHEDULER_SECRET must contain at least 32 characters.');
  return { baseUrl, secret };
}

export async function runSweep(config: SchedulerConfig, request: typeof fetch = fetch): Promise<SweepResult[]> {
  const results = await Promise.all(sweepPaths.map(async (path) => {
    const response = await request(`${config.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ORIN-Scheduler': config.secret },
      body: '{}',
      signal: AbortSignal.timeout(50_000),
    });
    const payload = await response.json().catch(() => ({})) as { ok?: boolean; checked?: number; error?: string };
    if (!response.ok || payload.ok === false) throw new Error(`${path} failed with ${response.status}: ${payload.error || 'sweep failed'}`);
    return { path, checked: Number.isFinite(payload.checked) ? Number(payload.checked) : 0, ok: true };
  }));
  return results;
}
