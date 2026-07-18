import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const child = spawn(process.execPath, ['packages/orin-cli/index.mjs', 'mcp'], { stdio: ['pipe', 'pipe', 'inherit'] });
let output = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => { output += chunk; });
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'orin-self-test', version: '1' } } })}\n`);
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
child.stdin.end();
await once(child, 'close');
const responses = output.trim().split(/\r?\n/).map((line) => JSON.parse(line));
assert.equal(responses[0].result.serverInfo.name, 'orin-ai');
assert.equal(responses[0].result.protocolVersion, '2025-11-25');
assert.ok(responses[1].result.tools.some((tool) => tool.name === 'orin_create_campaign'));
assert.ok(responses[1].result.tools.some((tool) => tool.name === 'orin_list_inbox'));
console.log(`ORIN CLI MCP self-test passed (${responses[1].result.tools.length} tools).`);
