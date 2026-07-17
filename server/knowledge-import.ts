import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  commitWrites,
  documentName,
  fieldInteger,
  fieldString,
  fieldTimestamp,
  getDocument,
  integerValue,
  listDocuments,
  stringValue,
  timestampValue,
} from './server-data.js';

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const CHUNK_CHARS = 36_000;
const validId = (value: string) => /^[A-Za-z0-9_-]{8,128}$/.test(value);

export type KnowledgeSourceSummary = {
  id: string;
  title: string;
  sourceType: 'file' | 'url' | 'text';
  url: string;
  characters: number;
  chunkCount: number;
  updatedAt: string;
};

export type StoredKnowledgeDocument = {
  id: string;
  title: string;
  content: string;
  status: 'active';
};

function clean(value: unknown, maximum: number) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, maximum) : '';
}

function documentId(document: { name?: string }) {
  return String(document.name || '').split('/').pop() || '';
}

function privateIp(address: string) {
  const value = address.toLowerCase().split('%')[0];
  if (isIP(value) === 4) {
    const [a, b] = value.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 0 || b === 168))
      || (a === 198 && (b === 18 || b === 19));
  }
  if (isIP(value) === 6) {
    if (value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') || /^fe[89ab]/.test(value)) return true;
    const mapped = value.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    return mapped ? privateIp(mapped) : false;
  }
  return true;
}

async function publicUrl(value: unknown) {
  let url: URL;
  try { url = new URL(clean(value, 2_000)); } catch { throw new Error('INVALID_KNOWLEDGE_URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) throw new Error('INVALID_KNOWLEDGE_URL');
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) throw new Error('INVALID_KNOWLEDGE_URL');
  const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true, verbatim: true }).catch(() => []);
  if (!addresses.length || addresses.some(({ address }) => privateIp(address))) throw new Error('INVALID_KNOWLEDGE_URL');
  return url;
}

function decodeEntities(value: string) {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Math.min(0x10ffff, Number(number))))
    .replace(/&#x([\da-f]+);/gi, (_, number) => String.fromCodePoint(Math.min(0x10ffff, Number.parseInt(number, 16))));
}

export function extractKnowledgeText(body: string, contentType = 'text/plain') {
  const type = contentType.toLowerCase();
  if (type.includes('json')) {
    try { return JSON.stringify(JSON.parse(body), null, 2); } catch { throw new Error('KNOWLEDGE_PAGE_UNREADABLE'); }
  }
  const text = type.includes('html')
    ? decodeEntities(body
      .replace(/<(script|style|noscript|svg|template)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<(br|p|div|li|h[1-6]|tr|section|article)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '))
    : body;
  return text.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function responseText(response: Response) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_SOURCE_BYTES || !response.body) throw new Error('KNOWLEDGE_PAGE_TOO_LARGE');
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_SOURCE_BYTES) {
      await reader.cancel();
      throw new Error('KNOWLEDGE_PAGE_TOO_LARGE');
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return new TextDecoder().decode(bytes);
}

export async function importPublicKnowledgeUrl(value: unknown) {
  let url = await publicUrl(value);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const response = await fetch(url, {
      redirect: 'manual',
      headers: { Accept: 'text/html, text/plain, application/json, text/csv, application/xml;q=0.9', 'User-Agent': 'ORIN-AI-Knowledge-Importer/1.0' },
      signal: AbortSignal.timeout(12_000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location || redirects === 3) throw new Error('KNOWLEDGE_PAGE_UNREADABLE');
      url = await publicUrl(new URL(location, url).toString());
      continue;
    }
    if (!response.ok) throw new Error('KNOWLEDGE_PAGE_UNREADABLE');
    const contentType = response.headers.get('content-type') || '';
    if (!/(text\/|application\/(json|xml|xhtml\+xml))/.test(contentType.toLowerCase())) throw new Error('KNOWLEDGE_PAGE_UNSUPPORTED');
    const body = await responseText(response);
    const title = contentType.toLowerCase().includes('html')
      ? decodeEntities(body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim()
      : '';
    const content = extractKnowledgeText(body, contentType);
    if (content.length < 20) throw new Error('KNOWLEDGE_PAGE_UNREADABLE');
    return { title: clean(title, 300) || url.hostname, url: url.toString(), content };
  }
  throw new Error('KNOWLEDGE_PAGE_UNREADABLE');
}

function splitContent(content: string) {
  const chunks: string[] = [];
  let remaining = content;
  while (remaining) {
    let end = Math.min(CHUNK_CHARS, remaining.length);
    if (end < remaining.length) {
      const boundary = remaining.lastIndexOf('\n', end);
      if (boundary > end / 2) end = boundary;
    }
    const chunk = remaining.slice(0, end).trim();
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(end).trim();
  }
  return chunks;
}

function searchTerms(content: string) {
  const terms = new Set<string>();
  for (const match of content.toLowerCase().matchAll(/[\p{L}\p{N}][\p{L}\p{N}_'-]{1,63}/gu)) {
    terms.add(match[0]);
    if (terms.size >= 8_000) break;
  }
  return [...terms].join(' ').slice(0, 80_000);
}

export async function upsertKnowledgeSource(input: {
  projectId: string;
  accessToken: string;
  workspaceId: string;
  agentId: string;
  sourceId: string;
  title: unknown;
  sourceType: unknown;
  url?: unknown;
  content: unknown;
  createdBy: string;
}) {
  if (!validId(input.agentId) || !validId(input.sourceId)) throw new Error('INVALID_KNOWLEDGE_SOURCE');
  const title = clean(input.title, 300);
  const sourceType = clean(input.sourceType, 20) as KnowledgeSourceSummary['sourceType'];
  const url = clean(input.url, 2_000);
  const content = typeof input.content === 'string' ? input.content.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim() : '';
  if (!title || !['file', 'url', 'text'].includes(sourceType) || !content || Buffer.byteLength(content, 'utf8') > MAX_SOURCE_BYTES) throw new Error('INVALID_KNOWLEDGE_SOURCE');
  const path = `workspaces/${input.workspaceId}/agents/${input.agentId}/knowledgeSources/${input.sourceId}`;
  const existing = await getDocument(input.projectId, input.accessToken, path);
  const previousChunks = fieldInteger(existing, 'chunkCount');
  const chunks = splitContent(content);
  const now = new Date().toISOString();
  const writes: unknown[] = [{
    update: { name: documentName(input.projectId, path), fields: {
      title: stringValue(title), sourceType: stringValue(sourceType), url: stringValue(url), characters: integerValue(content.length), chunkCount: integerValue(chunks.length), searchTerms: stringValue(searchTerms(`${title}\n${content}`)), createdBy: stringValue(input.createdBy), updatedAt: timestampValue(now), createdAt: timestampValue(now),
    } },
  }];
  chunks.forEach((chunk, index) => writes.push({ update: { name: documentName(input.projectId, `${path}/chunks/${String(index).padStart(4, '0')}`), fields: { content: stringValue(chunk), chunkIndex: integerValue(index), updatedAt: timestampValue(now) } } }));
  for (let index = chunks.length; index < previousChunks; index += 1) writes.push({ delete: documentName(input.projectId, `${path}/chunks/${String(index).padStart(4, '0')}`) });
  await commitWrites(input.projectId, input.accessToken, writes);
  return { id: input.sourceId, title, sourceType, url, characters: content.length, chunkCount: chunks.length, updatedAt: now } satisfies KnowledgeSourceSummary;
}

export async function listKnowledgeSources(projectId: string, accessToken: string, workspaceId: string, agentId: string) {
  if (!validId(agentId)) throw new Error('INVALID_KNOWLEDGE_SOURCE');
  const documents = await listDocuments(projectId, accessToken, `workspaces/${workspaceId}/agents/${agentId}/knowledgeSources`, 100);
  return documents.map((document) => ({
    id: documentId(document),
    title: fieldString(document, 'title'),
    sourceType: fieldString(document, 'sourceType') as KnowledgeSourceSummary['sourceType'],
    url: fieldString(document, 'url'),
    characters: fieldInteger(document, 'characters'),
    chunkCount: fieldInteger(document, 'chunkCount'),
    updatedAt: fieldTimestamp(document, 'updatedAt'),
  })).filter((source) => validId(source.id) && source.title).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function deleteKnowledgeSource(projectId: string, accessToken: string, workspaceId: string, agentId: string, sourceId: string) {
  if (!validId(agentId) || !validId(sourceId)) throw new Error('INVALID_KNOWLEDGE_SOURCE');
  const path = `workspaces/${workspaceId}/agents/${agentId}/knowledgeSources/${sourceId}`;
  const existing = await getDocument(projectId, accessToken, path);
  const chunkCount = fieldInteger(existing, 'chunkCount');
  const writes: unknown[] = [];
  for (let index = 0; index < chunkCount; index += 1) writes.push({ delete: documentName(projectId, `${path}/chunks/${String(index).padStart(4, '0')}`) });
  writes.push({ delete: documentName(projectId, path) });
  await commitWrites(projectId, accessToken, writes);
}

function queryTerms(query: string) {
  const matches: string[] = query.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_'-]{1,63}/gu) || [];
  return [...new Set(matches.filter((term) => term.length > 1))].slice(0, 20);
}

export async function loadQorxKnowledgeDocuments(projectId: string, accessToken: string, workspaceId: string, agentId: string, query: string) {
  const metadata = await listDocuments(projectId, accessToken, `workspaces/${workspaceId}/agents/${agentId}/knowledgeSources`, 100);
  const terms = queryTerms(query);
  const rankedSources = metadata.map((document) => {
    const haystack = `${fieldString(document, 'title')} ${fieldString(document, 'searchTerms')}`.toLowerCase();
    return { document, score: terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0), updatedAt: fieldTimestamp(document, 'updatedAt') };
  }).sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt));
  const matching = rankedSources.filter((source) => source.score > 0);
  const selected = (matching.length ? matching : rankedSources).slice(0, 6);
  const chunkGroups = await Promise.all(selected.map(async ({ document }) => {
    const sourceId = documentId(document);
    const title = fieldString(document, 'title');
    const chunks = await listDocuments(projectId, accessToken, `workspaces/${workspaceId}/agents/${agentId}/knowledgeSources/${sourceId}/chunks`, 100);
    return chunks.map((chunk) => ({
      id: `${sourceId}-${documentId(chunk)}`,
      title,
      content: fieldString(chunk, 'content'),
      status: 'active' as const,
      score: terms.reduce((sum, term) => sum + (fieldString(chunk, 'content').toLowerCase().includes(term) ? 1 : 0), 0),
    }));
  }));
  return chunkGroups.flat().filter((chunk) => chunk.content).sort((a, b) => b.score - a.score).slice(0, 10).map(({ score: _score, ...document }) => document satisfies StoredKnowledgeDocument);
}
