#!/usr/bin/env node
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';

const version = '0.2.0';
const configPath = join(homedir(), '.orin', 'config.json');
const mascotPath = join(dirname(fileURLToPath(import.meta.url)), 'assets', 'orin.txt');

async function config(required = true) {
  let saved = {};
  try { saved = JSON.parse(await readFile(configPath, 'utf8')); } catch {}
  const baseUrl = (process.env.ORIN_BASE_URL || saved.baseUrl || 'https://www.orin.work').replace(/\/+$/, '');
  const apiKey = process.env.ORIN_API_KEY || saved.apiKey || '';
  if (required && !apiKey) throw new Error('ORIN is not connected. Run `orin setup` or set ORIN_API_KEY.');
  return { baseUrl, apiKey };
}

async function request(path, options = {}) {
  const connection = await config();
  const response = await fetch(`${connection.baseUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${connection.apiKey}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `ORIN request failed (${response.status}).`);
  return payload;
}

async function banner() {
  const mascot = await readFile(mascotPath, 'utf8').catch(() => '');
  process.stderr.write(`\x1b[2m${mascot}\x1b[0m\nORIN AI by IDRA — Marvin Sarreal Villanueva\n\n`);
}

function option(args, name, fallback = '') {
  const index = args.indexOf(name);
  return index >= 0 && typeof args[index + 1] === 'string' ? args[index + 1] : fallback;
}

function output(value, json = false) {
  if (json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else if (Array.isArray(value)) console.table(value);
  else process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
}

async function jsonInput(value, required = true) {
  if (!value && required) throw new Error('Provide JSON or @path/to/file.json.');
  const text = value?.startsWith('@') ? await readFile(value.slice(1), 'utf8') : value || '{}';
  try { return JSON.parse(text); } catch { throw new Error('Input is not valid JSON.'); }
}

function query(parameters) {
  const values = new URLSearchParams(Object.entries(parameters).filter(([, value]) => value !== '' && value !== undefined).map(([key, value]) => [key, String(value)]));
  return values.toString() ? `?${values}` : '';
}

async function prompt(question, fallback = '') {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  return await new Promise((resolve) => terminal.question(`${question}${fallback ? ` [${fallback}]` : ''}: `, (answer) => {
    terminal.close();
    resolve(answer.trim() || fallback);
  }));
}

async function setup() {
  await banner();
  const current = await config(false);
  const baseUrl = await prompt('ORIN base URL', current.baseUrl);
  const apiKey = await prompt('Paste the one-time API key from ORIN Settings');
  if (!/^orin_live_[A-Za-z0-9_-]{14}_[A-Za-z0-9_-]{43}$/.test(apiKey)) throw new Error('That is not a valid ORIN API key.');
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify({ baseUrl: baseUrl.replace(/\/+$/, ''), apiKey }, null, 2)}\n`, { mode: 0o600 });
  await chmod(configPath, 0o600).catch(() => {});
  const result = await request('/api/orin/v1/status');
  process.stdout.write(`Connected to ${result.workspace?.name || 'ORIN AI'}.\n`);
}

async function status(args) {
  const result = await request('/api/orin/v1/status');
  output(result.workspace, args.includes('--json'));
}

async function inbox(args) {
  const result = await request('/api/orin/v1/inbox');
  output(result.conversations || [], args.includes('--json'));
}

async function analytics(args) {
  const days = Math.min(366, Math.max(1, Number(option(args, '--days', '30')) || 30));
  const result = await request(`/api/orin/v1/analytics?days=${days}&timezoneOffset=${new Date().getTimezoneOffset()}`);
  output(result.summary, args.includes('--json'));
}

async function campaigns(args) {
  const result = await request('/api/orin/v1/campaigns');
  output(result.campaigns || [], args.includes('--json'));
}

async function logs(args) {
  const maximum = Math.min(200, Math.max(1, Number(option(args, '--limit', '50')) || 50));
  const follow = args.includes('--follow');
  const seen = new Set();
  do {
    const result = await request(`/api/orin/v1/logs?limit=${maximum}`);
    const rows = (result.logs || []).filter((entry) => !seen.has(entry.id));
    rows.forEach((entry) => seen.add(entry.id));
    if (rows.length) output(rows, args.includes('--json'));
    if (!follow) return;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  } while (true);
}

async function resources(args) {
  const result = await request('/api/orin/v1/schema');
  output(result.controlPlane, args.includes('--json'));
}

async function getResource(args) {
  const [resource, id = ''] = args.filter((item, index) => !item.startsWith('--') && (index === 0 || args[index - 1] !== '--parent') && (index === 0 || args[index - 1] !== '--limit'));
  if (!resource) throw new Error('Usage: orin get <resource> [id] [--parent id] [--limit 100]');
  const result = await request(`/api/orin/v1/resource${query({ resource, id, parentId: option(args, '--parent'), limit: option(args, '--limit', '100') })}`);
  output(result.item ?? result.items ?? null, args.includes('--json'));
}

async function exportWorkspace(args) {
  const schema = (await request('/api/orin/v1/schema')).controlPlane;
  const selected = option(args, '--resources').split(',').map((item) => item.trim()).filter(Boolean);
  const definitions = (schema?.resources || []).filter((resource) => !resource.parent && (!selected.length || selected.includes(resource.name)));
  const exported = { exportedAt: new Date().toISOString(), controlPlaneVersion: schema?.version || '', resources: {} };
  for (const definition of definitions) {
    const result = await request(`/api/orin/v1/resource${query({ resource: definition.name, limit: option(args, '--limit', '200') })}`);
    exported.resources[definition.name] = result.item ?? result.items ?? null;
  }
  const out = option(args, '--out');
  if (out) {
    await writeFile(out, `${JSON.stringify(exported, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`Exported ${definitions.length} resources to ${out}.\n`);
  } else output(exported, true);
}

async function changeSet(args) {
  const source = args.find((item) => !item.startsWith('--'));
  const parsed = await jsonInput(source?.startsWith('@') ? source : source ? `@${source}` : '');
  const operations = Array.isArray(parsed) ? parsed : parsed.operations;
  if (!Array.isArray(operations)) throw new Error('Change file must be an array or an object with an operations array.');
  return { operations, requestId: parsed.requestId || crypto.randomUUID().replaceAll('-', '') };
}

async function plan(args) {
  const changes = await changeSet(args);
  const result = await request('/api/orin/v1/plan', { method: 'POST', body: JSON.stringify({ operations: changes.operations }) });
  output(result.plan, true);
}

async function apply(args) {
  const changes = await changeSet(args);
  if (!args.includes('--yes')) {
    const result = await request('/api/orin/v1/plan', { method: 'POST', body: JSON.stringify({ operations: changes.operations }) });
    output(result.plan, true);
    process.stderr.write('Plan only. Re-run with --yes to apply these changes.\n');
    return;
  }
  const result = await request('/api/orin/v1/apply', { method: 'POST', body: JSON.stringify(changes) });
  output(result, true);
}

async function api(args) {
  const method = (args[0] || 'GET').toUpperCase();
  const path = args[1] || '';
  const data = option(args, '--data');
  output(await apiRequest(method, path, data ? await jsonInput(data) : undefined), true);
}

async function apiRequest(method, path, data) {
  const normalizedMethod = String(method || 'GET').toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(normalizedMethod) || !/^\/api\/[A-Za-z0-9_?&=./%-]+$/.test(path) || path.includes('..')) throw new Error('Only same-origin ORIN /api/ paths are allowed.');
  return request(path, { method: normalizedMethod, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
}

function positional(args) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index].startsWith('--')) { if (!['--json', '--yes'].includes(args[index])) index += 1; continue; }
    values.push(args[index]);
  }
  return values;
}

async function reply(args) {
  const [conversationId] = positional(args);
  const message = option(args, '--message');
  if (!conversationId || !message) throw new Error('Usage: orin reply CONVERSATION_ID --message "..."');
  output(await apiRequest('POST', '/api/widget/message', { mode: 'team_reply', conversationId, message, requestId: crypto.randomUUID().replaceAll('-', '') }), true);
}

async function conversation(args) {
  const [conversationId] = positional(args);
  const action = option(args, '--action');
  if (!conversationId || !action) throw new Error('Usage: orin conversation ID --action mark-read|resume-ai|assign|resolve|reopen|priority|tags|note');
  const modes = { 'mark-read': 'mark_read', 'resume-ai': 'resume_ai' };
  const crmActions = { assign: 'assign_to_me', resolve: 'resolve', reopen: 'reopen', priority: 'set_priority', tags: 'set_tags', note: 'add_note' };
  const body = modes[action]
    ? { mode: modes[action], conversationId }
    : crmActions[action]
      ? { mode: 'crm_update', action: crmActions[action], conversationId, priority: option(args, '--value'), tags: option(args, '--value').split(',').map((item) => item.trim()).filter(Boolean), note: option(args, '--value') }
      : null;
  if (!body) throw new Error('Unknown conversation action.');
  output(await apiRequest('POST', '/api/widget/message', { ...body, requestId: crypto.randomUUID().replaceAll('-', '') }), true);
}

async function task(args) {
  const [taskId] = positional(args);
  const status = option(args, '--status');
  if (!taskId || !['open', 'completed'].includes(status)) throw new Error('Usage: orin task TASK_ID --status open|completed');
  output(await apiRequest('POST', '/api/widget/message', { mode: 'task_update', taskId, action: status === 'completed' ? 'complete_task' : 'reopen_task', requestId: crypto.randomUUID().replaceAll('-', '') }), true);
}

async function agent(args) {
  const [action, agentId] = positional(args);
  if (action !== 'test' || !agentId || !option(args, '--message')) throw new Error('Usage: orin agent test AGENT_ID --message "..."');
  output(await apiRequest('POST', '/api/widget/message', { mode: 'studio_test', agentId, message: option(args, '--message'), history: [] }), true);
}

async function publish(args) {
  const text = option(args, '--text');
  const channels = option(args, '--channels').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  const mediaUrl = option(args, '--image');
  const scheduledAt = option(args, '--at');
  const recurrence = option(args, '--repeat', 'none');
  const maxRuns = Number(option(args, '--runs', recurrence === 'none' ? '1' : '2'));
  if ((!text && !mediaUrl) || !channels.length) throw new Error('Use --text and --channels facebook,instagram. Add --image or --at when needed.');
  const result = await request('/api/social/publish', {
    method: 'POST',
    body: JSON.stringify({
      text,
      mediaUrl,
      targets: channels.map((provider) => ({ provider })),
      scheduledAt,
      recurrence,
      maxRuns,
      requestId: crypto.randomUUID().replaceAll('-', ''),
    }),
  });
  output(result, args.includes('--json'));
}

const tools = [
  {
    name: 'orin_workspace_status',
    description: 'Inspect the connected ORIN AI workspace, agents, and integrations.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'orin_list_inbox',
    description: 'List recent ORIN AI customer conversations and their channel, account, priority, and unread state.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'orin_analytics_summary',
    description: 'Read ORIN AI operational and channel analytics for a date range.',
    inputSchema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 366, default: 30 } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'orin_list_campaigns',
    description: 'List recent, scheduled, pending, delivered, and failed ORIN AI publishing campaigns.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'orin_list_logs',
    description: 'Read sanitized ORIN AI operational events, including model, token, cost-estimate, latency, delivery, handoff, and CRM activity metadata.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'orin_describe_control_plane',
    description: 'Describe every ORIN AI workspace resource, writable boundary, and typed external action available to developer clients.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'orin_get_resource',
    description: 'Read one sanitized ORIN AI workspace resource or item. Nested messages, notes, and knowledge sources require parentId.',
    inputSchema: { type: 'object', required: ['resource'], properties: { resource: { type: 'string' }, id: { type: 'string' }, parentId: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200, default: 100 } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'orin_plan_changes',
    description: 'Validate and preview an atomic ORIN workspace change set without changing data.',
    inputSchema: { type: 'object', required: ['operations'], properties: { operations: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', required: ['resource', 'action'], properties: { resource: { type: 'string' }, action: { type: 'string', enum: ['upsert', 'update', 'delete'] }, id: { type: 'string' }, data: { type: 'object' } }, additionalProperties: false } } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'orin_apply_changes',
    description: 'Apply an explicit, validated ORIN workspace change set atomically. Use orin_plan_changes first and obtain user confirmation for destructive changes.',
    inputSchema: { type: 'object', required: ['requestId', 'operations'], properties: { requestId: { type: 'string', minLength: 12, maxLength: 128 }, operations: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', required: ['resource', 'action'], properties: { resource: { type: 'string' }, action: { type: 'string', enum: ['upsert', 'update', 'delete'] }, id: { type: 'string' }, data: { type: 'object' } }, additionalProperties: false } } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'orin_api_request',
    description: 'Call an authenticated, same-origin ORIN API endpoint for inbox replies, CRM actions, agent tests, knowledge, credentials, commerce, communications, publishing, or integration operations. Never sends the ORIN key to another origin.',
    inputSchema: { type: 'object', required: ['method', 'path'], properties: { method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }, path: { type: 'string', pattern: '^/api/' }, data: { type: 'object' } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'orin_create_campaign',
    description: 'Publish or schedule one ORIN AI campaign to connected social channels.',
    inputSchema: {
      type: 'object',
      required: ['channels'],
      properties: {
        text: { type: 'string', maxLength: 10000 },
        imageUrl: { type: 'string', format: 'uri' },
        channels: { type: 'array', minItems: 1, items: { type: 'string', enum: ['facebook', 'instagram', 'tiktok', 'youtube', 'linkedin', 'threads', 'pinterest', 'x', 'google_business', 'reddit', 'bluesky', 'mastodon', 'telegram'] } },
        scheduledAt: { type: 'string', format: 'date-time' },
        recurrence: { type: 'string', enum: ['none', 'daily', 'weekdays', 'weekly', 'monthly'], default: 'none' },
        maxRuns: { type: 'integer', minimum: 1, maximum: 365, default: 1 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
];

async function callTool(name, args = {}) {
  if (name === 'orin_workspace_status') return (await request('/api/orin/v1/status')).workspace;
  if (name === 'orin_list_inbox') return (await request('/api/orin/v1/inbox')).conversations;
  if (name === 'orin_analytics_summary') return (await request(`/api/orin/v1/analytics?days=${Math.min(366, Math.max(1, Number(args.days) || 30))}`)).summary;
  if (name === 'orin_list_campaigns') return (await request('/api/orin/v1/campaigns')).campaigns;
  if (name === 'orin_list_logs') return (await request(`/api/orin/v1/logs?limit=${Math.min(200, Math.max(1, Number(args.limit) || 50))}`)).logs;
  if (name === 'orin_describe_control_plane') return (await request('/api/orin/v1/schema')).controlPlane;
  if (name === 'orin_get_resource') {
    const result = await request(`/api/orin/v1/resource${query({ resource: args.resource, id: args.id, parentId: args.parentId, limit: args.limit || 100 })}`);
    return result.item ?? result.items ?? null;
  }
  if (name === 'orin_plan_changes') return (await request('/api/orin/v1/plan', { method: 'POST', body: JSON.stringify({ operations: args.operations }) })).plan;
  if (name === 'orin_apply_changes') return await request('/api/orin/v1/apply', { method: 'POST', body: JSON.stringify({ requestId: args.requestId, operations: args.operations }) });
  if (name === 'orin_api_request') return await apiRequest(args.method, args.path, args.data);
  if (name === 'orin_create_campaign') {
    return await request('/api/social/publish', {
      method: 'POST',
      body: JSON.stringify({
        text: args.text || '',
        mediaUrl: args.imageUrl || '',
        targets: (args.channels || []).map((provider) => ({ provider })),
        scheduledAt: args.scheduledAt || '',
        recurrence: args.recurrence || 'none',
        maxRuns: Number(args.maxRuns) || 1,
        requestId: crypto.randomUUID().replaceAll('-', ''),
      }),
    });
  }
  throw new Error(`Unknown ORIN tool: ${name}`);
}

function rpcResult(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function rpcError(id, cause) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code: -32000, message: cause instanceof Error ? cause.message : 'ORIN tool failed.' } })}\n`);
}

async function mcpServer() {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { rpcError(null, new Error('Invalid JSON-RPC message.')); continue; }
    if (message.method === 'notifications/initialized') continue;
    try {
      if (message.method === 'initialize') {
        rpcResult(message.id, {
          protocolVersion: message.params?.protocolVersion || '2025-11-25',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'orin-ai', title: 'ORIN AI by IDRA', version },
        });
      } else if (message.method === 'ping') rpcResult(message.id, {});
      else if (message.method === 'tools/list') rpcResult(message.id, { tools });
      else if (message.method === 'tools/call') {
        const result = await callTool(message.params?.name, message.params?.arguments || {});
        rpcResult(message.id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result });
      } else if (message.id !== undefined) rpcError(message.id, new Error(`Method not found: ${message.method}`));
    } catch (cause) {
      rpcError(message.id, cause);
    }
  }
}

function installMcp(client) {
  const executable = process.platform === 'win32' ? `${client}.cmd` : client;
  const args = client === 'codex'
    ? ['mcp', 'add', 'orin', '--', 'orin', 'mcp']
    : ['mcp', 'add', '--scope', 'user', 'orin', '--', 'orin', 'mcp'];
  const result = process.platform === 'win32'
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', executable, ...args], { stdio: 'inherit', shell: false })
    : spawnSync(executable, args, { stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${client} could not add the ORIN MCP server.`);
}

async function doctor() {
  const connection = await config();
  const result = await request('/api/orin/v1/status');
  output({
    cli: version,
    baseUrl: connection.baseUrl,
    credentials: 'loaded',
    workspace: result.workspace?.name || 'connected',
    mcpCommand: 'orin mcp',
  }, true);
}

async function help() {
  await banner();
  process.stdout.write(`Usage:
  orin setup
  orin doctor
  orin status [--json]
  orin inbox [--json]
  orin analytics [--days 30] [--json]
  orin campaigns [--json]
  orin logs [--limit 50] [--follow] [--json]
  orin resources [--json]
  orin get <resource> [id] [--parent id] [--limit 100] [--json]
  orin export [--resources agents,contacts] [--out backup.json]
  orin plan changes.json
  orin apply changes.json [--yes]
  orin reply CONVERSATION_ID --message "..."
  orin conversation ID --action mark-read|resume-ai|assign|resolve|reopen|priority|tags|note [--value ...]
  orin task TASK_ID --status open|completed
  orin agent test AGENT_ID --message "..."
  orin publish --text "..." --channels facebook,instagram [--image https://...] [--at ISO]
  orin api METHOD /api/path [--data JSON|@file]
  orin mcp
  orin mcp install codex|claude

Environment overrides: ORIN_BASE_URL, ORIN_API_KEY
`);
}

async function main() {
  const [command = 'help', ...args] = process.argv.slice(2);
  if (command === 'setup') return setup();
  if (command === 'doctor') return doctor();
  if (command === 'status') return status(args);
  if (command === 'inbox') return inbox(args);
  if (command === 'analytics') return analytics(args);
  if (command === 'campaigns') return campaigns(args);
  if (command === 'logs') return logs(args);
  if (command === 'resources') return resources(args);
  if (command === 'get') return getResource(args);
  if (command === 'export') return exportWorkspace(args);
  if (command === 'plan') return plan(args);
  if (command === 'apply') return apply(args);
  if (command === 'reply') return reply(args);
  if (command === 'conversation') return conversation(args);
  if (command === 'task') return task(args);
  if (command === 'agent') return agent(args);
  if (command === 'publish') return publish(args);
  if (command === 'api') return api(args);
  if (command === 'mcp' && args[0] === 'install' && ['codex', 'claude'].includes(args[1])) return installMcp(args[1]);
  if (command === 'mcp') return mcpServer();
  return help();
}

main().catch((cause) => {
  process.stderr.write(`ORIN: ${cause instanceof Error ? cause.message : 'Command failed.'}\n`);
  process.exitCode = 1;
});
