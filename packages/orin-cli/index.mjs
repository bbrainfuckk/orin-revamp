#!/usr/bin/env node
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';

const version = '0.1.0';
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
  if (!/^orin_live_[A-Za-z0-9_-]{12,24}_[A-Za-z0-9_-]{32,80}$/.test(apiKey)) throw new Error('That is not a valid ORIN API key.');
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
  const result = spawnSync(executable, args, { stdio: 'inherit', shell: false });
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
  orin publish --text "..." --channels facebook,instagram [--image https://...] [--at ISO]
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
  if (command === 'publish') return publish(args);
  if (command === 'mcp' && args[0] === 'install' && ['codex', 'claude'].includes(args[1])) return installMcp(args[1]);
  if (command === 'mcp') return mcpServer();
  return help();
}

main().catch((cause) => {
  process.stderr.write(`ORIN: ${cause instanceof Error ? cause.message : 'Command failed.'}\n`);
  process.exitCode = 1;
});
