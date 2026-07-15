// server/server-data.ts
var encoder = new TextEncoder();
var firebaseApiKey = process.env.FIREBASE_WEB_API_KEY || process.env.VITE_FIREBASE_API_KEY || "AIzaSyCQenus-MpVsnfsiGMIKVr66Ag7TikasEk";
function bytesToBase64Url(value) {
  let binary = "";
  value.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function base64ToBytes(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
function headerValue(req, name) {
  const value = req.headers?.[name] || req.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] || "" : value || "";
}
function constantTimeEqual(left, right) {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  if (leftBytes.length !== rightBytes.length) return false;
  let mismatch = 0;
  for (let index = 0; index < leftBytes.length; index += 1) mismatch |= leftBytes[index] ^ rightBytes[index];
  return mismatch === 0;
}
async function stableId(...parts) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(parts.join("")));
  return bytesToBase64Url(new Uint8Array(digest)).slice(0, 40);
}
async function googleAccessToken() {
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL || "";
  const rawPrivateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID || "orin-ai-502503";
  if (!clientEmail || !rawPrivateKey || !projectId) throw new Error("SERVER_STORAGE_NOT_CONFIGURED");
  const privateKeyBody = rawPrivateKey.replace("-----BEGIN PRIVATE KEY-----", "").replace("-----END PRIVATE KEY-----", "").replace(/\s/g, "");
  const signingKey = await crypto.subtle.importKey("pkcs8", base64ToBytes(privateKeyBody), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1e3);
  const header = { alg: "RS256", typ: "JWT" };
  if (process.env.FIREBASE_PRIVATE_KEY_ID) header.kid = process.env.FIREBASE_PRIVATE_KEY_ID;
  const claims = { iss: clientEmail, sub: clientEmail, aud: "https://oauth2.googleapis.com/token", scope: "https://www.googleapis.com/auth/datastore", iat: now, exp: now + 3300 };
  const unsigned = `${bytesToBase64Url(encoder.encode(JSON.stringify(header)))}.${bytesToBase64Url(encoder.encode(JSON.stringify(claims)))}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signingKey, encoder.encode(unsigned));
  const assertion = `${unsigned}.${bytesToBase64Url(new Uint8Array(signature))}`;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    signal: AbortSignal.timeout(1e4)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) throw new Error("SERVER_STORAGE_AUTH_FAILED");
  return { projectId, accessToken: payload.access_token };
}
function encodedPath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}
function documentName(projectId, path) {
  return `projects/${projectId}/databases/(default)/documents/${path}`;
}
async function getDocument(projectId, accessToken, path) {
  const response = await fetch(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/${encodedPath(path)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(8e3)
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("SERVER_STORAGE_READ_FAILED");
  return response.json();
}
async function commitWrites(projectId, accessToken, writes, conflictIsFalse = false) {
  const response = await fetch(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents:commit`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ writes }),
    signal: AbortSignal.timeout(1e4)
  });
  if (conflictIsFalse && response.status === 409) return false;
  if (!response.ok) throw new Error("SERVER_STORAGE_WRITE_FAILED");
  return true;
}
var stringValue = (value) => ({ stringValue: value });
var integerValue = (value) => ({ integerValue: String(Math.trunc(value)) });
var timestampValue = (value) => ({ timestampValue: value });
function fieldString(document, name) {
  return document?.fields?.[name]?.stringValue || "";
}
function fieldBoolean(document, name) {
  return document?.fields?.[name]?.booleanValue === true;
}

// server/shopify.ts
function normalizeShopDomain(value) {
  const trimmed = value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(trimmed) || trimmed.length > 120) throw new Error("INVALID_SHOP");
  return trimmed;
}

// server/shopify-webhook.ts
var config = { api: { bodyParser: false } };
var encoder2 = new TextEncoder();
var decoder = new TextDecoder();
function cleanText(value, maximum) {
  return typeof value === "string" ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, maximum) : "";
}
function bytesToBase64(value) {
  let binary = "";
  value.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}
async function readRawBody(req) {
  if (!req[Symbol.asyncIterator]) throw new Error("INVALID_BODY");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size > 1e6) throw new Error("PAYLOAD_TOO_LARGE");
    chunks.push(chunk);
  }
  const raw = new Uint8Array(size);
  let offset = 0;
  chunks.forEach((chunk) => {
    raw.set(chunk, offset);
    offset += chunk.byteLength;
  });
  return raw;
}
async function verifyShopifyWebhook(raw, supplied, secret) {
  if (!supplied || !secret) return false;
  const key = await crypto.subtle.importKey("raw", encoder2.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const body = new Uint8Array(raw.byteLength);
  body.set(raw);
  const digest = bytesToBase64(new Uint8Array(await crypto.subtle.sign("HMAC", key, body.buffer)));
  return constantTimeEqual(digest, supplied.trim());
}
function safeDate(...values) {
  for (const value of values) {
    if (typeof value !== "string" || !value) continue;
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return (/* @__PURE__ */ new Date()).toISOString();
}
function customerFromPayload(payload, topic) {
  if (topic.startsWith("customers/")) return payload;
  return payload.customer || null;
}
async function connectorRoute(projectId, accessToken, shop) {
  const routeId = `shopify_${await stableId("shopify-route", shop)}`;
  const route = await getDocument(projectId, accessToken, `connectorRoutes/${routeId}`);
  if (!route || fieldString(route, "provider") !== "shopify" || fieldString(route, "shopDomain") !== shop || !fieldBoolean(route, "active")) return null;
  const workspaceId = fieldString(route, "workspaceId");
  if (!/^personal_[A-Za-z0-9_-]{8,180}$/.test(workspaceId)) return null;
  return { routeId, route, workspaceId };
}
async function removeConnector(projectId, accessToken, workspaceId, routeId) {
  await commitWrites(projectId, accessToken, [
    { delete: documentName(projectId, `workspaces/${workspaceId}/connections/shopify`) },
    { delete: documentName(projectId, `workspaces/${workspaceId}/connectorVault/shopify`) },
    { delete: documentName(projectId, `connectorRoutes/${routeId}`) }
  ]);
}
async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }
  try {
    const secret = process.env.SHOPIFY_CLIENT_SECRET || "";
    if (!secret) throw new Error("NOT_CONFIGURED");
    const raw = await readRawBody(req);
    if (!await verifyShopifyWebhook(raw, headerValue(req, "x-shopify-hmac-sha256"), secret)) throw new Error("INVALID_SIGNATURE");
    const shop = normalizeShopDomain(headerValue(req, "x-shopify-shop-domain"));
    const topic = cleanText(headerValue(req, "x-shopify-topic"), 80).toLowerCase();
    const webhookId = cleanText(headerValue(req, "x-shopify-webhook-id"), 160);
    if (!topic || !webhookId) throw new Error("INVALID_HEADERS");
    const payload = JSON.parse(decoder.decode(raw));
    const { projectId, accessToken } = await googleAccessToken();
    const route = await connectorRoute(projectId, accessToken, shop);
    if (!route) return res.status(200).json({ ok: true, ignored: true });
    if (topic === "app/uninstalled" || topic === "shop/redact") {
      await removeConnector(projectId, accessToken, route.workspaceId, route.routeId);
      return res.status(200).json({ ok: true, disconnected: true });
    }
    const eventId = await stableId("shopify-event", shop, webhookId);
    const base = `workspaces/${route.workspaceId}`;
    const customer = customerFromPayload(payload, topic);
    const externalCustomerId = customer?.id || payload.customer_id;
    const contactId = externalCustomerId ? await stableId("contact", "shopify", shop, String(externalCustomerId)) : "";
    const occurredAt = safeDate(payload.updated_at, payload.created_at, customer?.updated_at, customer?.created_at, headerValue(req, "x-shopify-triggered-at"));
    if (topic === "customers/redact") {
      const complianceWrites = [{
        update: { name: documentName(projectId, `${base}/providerEvents/${eventId}`), fields: {
          provider: stringValue("shopify"),
          type: stringValue(topic),
          sourceEventHash: stringValue(eventId),
          receivedAt: timestampValue((/* @__PURE__ */ new Date()).toISOString())
        } },
        currentDocument: { exists: false }
      }];
      if (contactId) complianceWrites.push({ delete: documentName(projectId, `${base}/contacts/${contactId}`) });
      const accepted2 = await commitWrites(projectId, accessToken, complianceWrites, true);
      return res.status(200).json({ ok: true, duplicate: !accepted2 });
    }
    const normalizedType = topic.startsWith("orders/") ? topic.endsWith("/create") ? "order.created" : "order.updated" : topic.startsWith("customers/") ? topic.endsWith("/create") ? "customer.created" : "customer.updated" : "store.updated";
    const writes = [
      {
        update: { name: documentName(projectId, `${base}/providerEvents/${eventId}`), fields: {
          provider: stringValue("shopify"),
          type: stringValue(topic),
          sourceEventHash: stringValue(eventId),
          receivedAt: timestampValue((/* @__PURE__ */ new Date()).toISOString())
        } },
        currentDocument: { exists: false }
      },
      {
        update: { name: documentName(projectId, `${base}/events/shopify_${eventId}`), fields: {
          type: stringValue(normalizedType),
          provider: stringValue("shopify"),
          channel: stringValue("Shopify"),
          conversationId: stringValue(""),
          contactId: stringValue(contactId),
          occurredAt: timestampValue(occurredAt),
          value: integerValue(0),
          sourceEventHash: stringValue(eventId)
        } },
        currentDocument: { exists: false }
      },
      {
        update: { name: documentName(projectId, `${base}/connections/shopify`), fields: {
          status: stringValue("connected"),
          health: stringValue("healthy"),
          lastWebhookTopic: stringValue(topic)
        } },
        updateMask: { fieldPaths: ["status", "health", "lastWebhookTopic"] },
        updateTransforms: [
          { fieldPath: "lastWebhookAt", setToServerValue: "REQUEST_TIME" },
          { fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }
        ],
        currentDocument: { exists: true }
      }
    ];
    if (contactId && customer) {
      const name = [cleanText(customer.first_name, 100), cleanText(customer.last_name, 100)].filter(Boolean).join(" ") || "Shopify customer";
      writes.push({
        update: { name: documentName(projectId, `${base}/contacts/${contactId}`), fields: {
          name: stringValue(name),
          handle: stringValue(cleanText(customer.email || payload.email, 240)),
          sourceProvider: stringValue("shopify"),
          lastSeenAt: timestampValue(occurredAt)
        } },
        updateMask: { fieldPaths: ["name", "handle", "sourceProvider", "lastSeenAt"] },
        updateTransforms: [
          { fieldPath: "channels", appendMissingElements: { values: [stringValue("Shopify")] } },
          { fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }
        ]
      });
    }
    const accepted = await commitWrites(projectId, accessToken, writes, true);
    return res.status(200).json({ ok: true, duplicate: !accepted });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "";
    if (message === "INVALID_SIGNATURE") return res.status(401).json({ ok: false, error: "Invalid Shopify signature" });
    if (message === "PAYLOAD_TOO_LARGE") return res.status(413).json({ ok: false, error: "Payload too large" });
    if (["INVALID_BODY", "INVALID_HEADERS", "INVALID_SHOP"].includes(message) || cause instanceof SyntaxError) return res.status(400).json({ ok: false, error: "Invalid Shopify webhook" });
    if (message === "NOT_CONFIGURED" || message === "SERVER_STORAGE_NOT_CONFIGURED" || message === "SERVER_STORAGE_AUTH_FAILED") return res.status(503).json({ ok: false, error: "Shopify webhook handling is not configured" });
    console.error("Shopify webhook failed", cause);
    return res.status(500).json({ ok: false, error: "Shopify webhook could not be completed" });
  }
}
export {
  config,
  handler as default,
  verifyShopifyWebhook
};
