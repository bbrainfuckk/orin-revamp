import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

function isPrivateIpv4(address: string) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
    || a >= 224;
}

function isPrivateIpv6(address: string) {
  const normalized = address.toLowerCase();
  return normalized === '::'
    || normalized === '::1'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || normalized.startsWith('fe8')
    || normalized.startsWith('fe9')
    || normalized.startsWith('fea')
    || normalized.startsWith('feb');
}

function isPrivateAddress(address: string) {
  const version = isIP(address);
  return version === 4 ? isPrivateIpv4(address) : version === 6 ? isPrivateIpv6(address) : true;
}

export async function validatePublicWebhookUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('INVALID_WEBHOOK_URL');

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('INVALID_WEBHOOK_URL');
  }

  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw new Error('INVALID_WEBHOOK_URL');
  }

  const hostname = url.hostname.toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new Error('INVALID_WEBHOOK_URL');
  }

  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error('PRIVATE_WEBHOOK_URL');
    return url;
  }

  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('PRIVATE_WEBHOOK_URL');
  }

  return url;
}
