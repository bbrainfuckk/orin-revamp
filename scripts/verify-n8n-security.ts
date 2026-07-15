import assert from 'node:assert/strict';
import { validateN8nCloudWebhook } from '../api/integrations/n8n/connect';

const production = validateN8nCloudWebhook('https://marvin.app.n8n.cloud/webhook/orin-events');
assert.equal(production.hostname, 'marvin.app.n8n.cloud');
assert.equal(production.pathname, '/webhook/orin-events');

const rejected = [
  'http://marvin.app.n8n.cloud/webhook/orin-events',
  'https://localhost:5678/webhook/orin-events',
  'https://automation.example.com/webhook/orin-events',
  'https://marvin.app.n8n.cloud/webhook-test/orin-events',
  'https://marvin.app.n8n.cloud/webhook/',
  'https://user:password@marvin.app.n8n.cloud/webhook/orin-events',
  'https://marvin.app.n8n.cloud:8443/webhook/orin-events',
];

for (const value of rejected) {
  assert.throws(() => validateN8nCloudWebhook(value), /INVALID_WEBHOOK_URL/);
}

console.log('n8n Cloud URL security checks passed.');
