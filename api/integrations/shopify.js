// server/server-data.ts
var encoder = new TextEncoder();
var firebaseApiKey = process.env.FIREBASE_WEB_API_KEY || process.env.VITE_FIREBASE_API_KEY || "AIzaSyCQenus-MpVsnfsiGMIKVr66Ag7TikasEk";
var googleTokenCache = /* @__PURE__ */ new Map();
var pendingGoogleTokens = /* @__PURE__ */ new Map();
var transientStatuses = /* @__PURE__ */ new Set([429, 500, 502, 503, 504]);
async function fetchWithTransientRetry(input, init = {}, timeoutMs = 1e4, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (!transientStatuses.has(response.status) || attempt === attempts - 1) return response;
      await response.body?.cancel().catch(() => void 0);
    } catch (cause) {
      lastError = cause;
      if (attempt === attempts - 1) throw cause;
    }
    await new Promise((resolve) => setTimeout(resolve, 80 * 2 ** attempt + Math.floor(Math.random() * 40)));
  }
  throw lastError || new Error("UPSTREAM_UNAVAILABLE");
}
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
async function verifyFirebaseAccount(req) {
  const authorization = headerValue(req, "authorization");
  if (!authorization.startsWith("Bearer ")) throw new Error("UNAUTHENTICATED");
  const token = authorization.slice("Bearer ".length).trim();
  if (!token) throw new Error("UNAUTHENTICATED");
  let response;
  try {
    response = await fetchWithTransientRetry(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(firebaseApiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: token })
    }, 6e3);
  } catch {
    throw new Error("AUTH_SERVICE_UNAVAILABLE");
  }
  if (!response.ok) throw new Error("UNAUTHENTICATED");
  const account = (await response.json()).users?.[0];
  if (!account?.localId || account.disabled) throw new Error("UNAUTHENTICATED");
  return account;
}
async function verifyFirebaseUid(req) {
  return (await verifyFirebaseAccount(req)).localId;
}
async function googleAccessToken(scope = "https://www.googleapis.com/auth/datastore") {
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL || "";
  const rawPrivateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID || "orin-ai-502503";
  if (!clientEmail || !rawPrivateKey || !projectId) throw new Error("SERVER_STORAGE_NOT_CONFIGURED");
  const cacheKey = `${projectId}${clientEmail}${scope}`;
  const cached = googleTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 5 * 6e4) return { projectId, accessToken: cached.accessToken };
  const pending = pendingGoogleTokens.get(cacheKey);
  if (pending) {
    const token = await pending;
    return { projectId: token.projectId, accessToken: token.accessToken };
  }
  const request = (async () => {
    const privateKeyBody = rawPrivateKey.replace("-----BEGIN PRIVATE KEY-----", "").replace("-----END PRIVATE KEY-----", "").replace(/\s/g, "");
    const signingKey = await crypto.subtle.importKey("pkcs8", base64ToBytes(privateKeyBody), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
    const now = Math.floor(Date.now() / 1e3);
    const header = { alg: "RS256", typ: "JWT" };
    if (process.env.FIREBASE_PRIVATE_KEY_ID) header.kid = process.env.FIREBASE_PRIVATE_KEY_ID;
    const claims = { iss: clientEmail, sub: clientEmail, aud: "https://oauth2.googleapis.com/token", scope, iat: now, exp: now + 3300 };
    const unsigned = `${bytesToBase64Url(encoder.encode(JSON.stringify(header)))}.${bytesToBase64Url(encoder.encode(JSON.stringify(claims)))}`;
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signingKey, encoder.encode(unsigned));
    const assertion = `${unsigned}.${bytesToBase64Url(new Uint8Array(signature))}`;
    const response = await fetchWithTransientRetry("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.access_token) throw new Error("SERVER_STORAGE_AUTH_FAILED");
    const token = { projectId, accessToken: payload.access_token, expiresAt: Date.now() + Math.max(300, Number(payload.expires_in) || 3300) * 1e3 };
    googleTokenCache.set(cacheKey, token);
    return token;
  })();
  pendingGoogleTokens.set(cacheKey, request);
  try {
    const token = await request;
    return { projectId: token.projectId, accessToken: token.accessToken };
  } finally {
    pendingGoogleTokens.delete(cacheKey);
  }
}
function encodedPath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}
function documentName(projectId, path) {
  return `projects/${projectId}/databases/(default)/documents/${path}`;
}
async function getDocument(projectId, accessToken, path) {
  const response = await fetchWithTransientRetry(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/${encodedPath(path)}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  }, 8e3);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("SERVER_STORAGE_READ_FAILED");
  return response.json();
}
async function requireWorkspaceRole(projectId, accessToken, workspaceId, uid, allowedRoles = ["owner", "admin", "editor"]) {
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(workspaceId) || !/^[A-Za-z0-9_-]{8,200}$/.test(uid)) throw new Error("FORBIDDEN");
  const [workspace, membership] = await Promise.all([
    getDocument(projectId, accessToken, `workspaces/${workspaceId}`),
    getDocument(projectId, accessToken, `workspaces/${workspaceId}/members/${uid}`)
  ]);
  const role = fieldString(membership, "role");
  if (!workspace || !membership || !allowedRoles.includes(role)) throw new Error("FORBIDDEN");
  return { workspace, membership, role };
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
async function encryptJson(payload, base64Key) {
  const keyBytes = base64ToBytes(base64Key.trim());
  if (keyBytes.byteLength !== 32) throw new Error("INVALID_ENCRYPTION_KEY");
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(JSON.stringify(payload)));
  return { ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)), iv: bytesToBase64Url(iv) };
}
async function decryptJson(ciphertext, iv, base64Key) {
  const keyBytes = base64ToBytes(base64Key.trim());
  if (keyBytes.byteLength !== 32) throw new Error("INVALID_ENCRYPTION_KEY");
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(iv) }, key, base64ToBytes(ciphertext));
  return JSON.parse(new TextDecoder().decode(plaintext));
}
var stringValue = (value) => ({ stringValue: value });
var integerValue = (value) => ({ integerValue: String(Math.trunc(value)) });
var doubleValue = (value) => ({ doubleValue: value });
var timestampValue = (value) => ({ timestampValue: value });
var booleanValue = (value) => ({ booleanValue: value });
var stringArrayValue = (values) => ({ arrayValue: { values: values.map(stringValue) } });
function fieldString(document, name) {
  return document?.fields?.[name]?.stringValue || "";
}
function fieldBoolean(document, name) {
  return document?.fields?.[name]?.booleanValue === true;
}
function fieldInteger(document, name) {
  const value = Number(document?.fields?.[name]?.integerValue || 0);
  return Number.isFinite(value) ? Math.trunc(value) : 0;
}
function fieldTimestamp(document, name) {
  return document?.fields?.[name]?.timestampValue || "";
}

// server/shopify.ts
function normalizeShopDomain(value) {
  const trimmed = value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(trimmed) || trimmed.length > 120) throw new Error("INVALID_SHOP");
  return trimmed;
}

// server/shopify-callback.ts
var encoder2 = new TextEncoder();
var decoder = new TextDecoder();
function queryValue(value) {
  return Array.isArray(value) ? value[0] || "" : value || "";
}
function parseCookie(req, name) {
  const raw = req.headers?.cookie;
  const cookieHeader = Array.isArray(raw) ? raw.join(";") : raw || "";
  const match = cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : "";
}
function bytesToHex(value) {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function hmacHex(message, secret) {
  const key = await crypto.subtle.importKey("raw", encoder2.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder2.encode(message))));
}
async function verifyShopifyQuery(query, secret) {
  const supplied = queryValue(query?.hmac).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(supplied)) return false;
  const pairs = Object.entries(query || {}).filter(([key]) => !["hmac", "signature"].includes(key)).map(([key, value]) => [key, queryValue(value)]).sort(([left], [right]) => left.localeCompare(right));
  const decodedMessage = pairs.map(([key, value]) => `${key}=${value}`).join("&");
  if (constantTimeEqual(await hmacHex(decodedMessage, secret), supplied)) return true;
  const encodedMessage = pairs.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
  return constantTimeEqual(await hmacHex(encodedMessage, secret), supplied);
}
async function verifyState(value, secret) {
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra) throw new Error("INVALID_STATE");
  const key = await crypto.subtle.importKey("raw", encoder2.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("HMAC", key, base64ToBytes(signature), encoder2.encode(payload));
  if (!valid) throw new Error("INVALID_STATE");
  const parsed = JSON.parse(decoder.decode(base64ToBytes(payload)));
  if (parsed.provider !== "shopify" || !parsed.uid || !/^[A-Za-z0-9_-]{8,200}$/.test(parsed.workspaceId) || normalizeShopDomain(parsed.shop) !== parsed.shop || !parsed.nonce || !Number.isFinite(parsed.issuedAt) || !Number.isFinite(parsed.expiresAt) || parsed.issuedAt > Date.now() + 6e4 || parsed.expiresAt < Date.now() || parsed.expiresAt - parsed.issuedAt > 10 * 60 * 1e3) throw new Error("INVALID_STATE");
  return parsed;
}
function redirect(res, status) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Set-Cookie", "orin_shopify_oauth=; Max-Age=0; Path=/api/integrations/shopify; HttpOnly; Secure; SameSite=Lax");
  res.setHeader("Location", `https://www.orin.work/app/integrations?provider=shopify&status=${encodeURIComponent(status)}`);
  return res.status(302).end();
}
async function exchangeToken(shop, code, clientId, clientSecret) {
  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    signal: AbortSignal.timeout(1e4)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) throw new Error("SHOPIFY_TOKEN_EXCHANGE_FAILED");
  return payload;
}
async function shopIdentity(shop, accessToken, apiVersion) {
  const response = await fetch(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "X-Shopify-Access-Token": accessToken },
    body: JSON.stringify({ query: "query OrinShopIdentity { shop { id name myshopifyDomain primaryDomain { url } } }" }),
    signal: AbortSignal.timeout(1e4)
  });
  const payload = await response.json().catch(() => ({}));
  const identity = payload.data?.shop;
  if (!response.ok || payload.errors?.length || !identity?.id || !identity.name || normalizeShopDomain(identity.myshopifyDomain || "") !== shop) {
    throw new Error("SHOPIFY_IDENTITY_FAILED");
  }
  return identity;
}
async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).end("Method not allowed");
  }
  const clientId = process.env.SHOPIFY_CLIENT_ID || "";
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET || "";
  const stateSecret = process.env.OAUTH_STATE_SECRET || "";
  const encryptionKey = process.env.CONNECTOR_ENCRYPTION_KEY || "";
  if (!clientId || !clientSecret || stateSecret.length < 32 || !encryptionKey) return redirect(res, "not_configured");
  try {
    if (!await verifyShopifyQuery(req.query, clientSecret)) return redirect(res, "invalid_signature");
    const code = queryValue(req.query?.code);
    const stateValue = queryValue(req.query?.state);
    const shop = normalizeShopDomain(queryValue(req.query?.shop));
    if (!code || !stateValue) return redirect(res, "invalid_callback");
    const state = await verifyState(stateValue, stateSecret);
    if (state.shop !== shop || parseCookie(req, "orin_shopify_oauth") !== state.nonce) return redirect(res, "invalid_state");
    const token = await exchangeToken(shop, code, clientId, clientSecret);
    const apiVersion = process.env.SHOPIFY_API_VERSION || "2026-07";
    const identity = await shopIdentity(shop, token.access_token, apiVersion);
    const encrypted = await encryptJson({
      provider: "shopify",
      shop,
      accessToken: token.access_token,
      scope: token.scope || "",
      apiVersion,
      refreshToken: token.refresh_token || null,
      expiresAt: token.expires_in ? new Date(Date.now() + token.expires_in * 1e3).toISOString() : null,
      refreshTokenExpiresAt: token.refresh_token_expires_in ? new Date(Date.now() + token.refresh_token_expires_in * 1e3).toISOString() : null
    }, encryptionKey);
    const { projectId, accessToken } = await googleAccessToken();
    await requireWorkspaceRole(projectId, accessToken, state.workspaceId, state.uid);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const routeId = `shopify_${await stableId("shopify-route", shop)}`;
    await commitWrites(projectId, accessToken, [
      {
        update: { name: documentName(projectId, `workspaces/${state.workspaceId}/connectorVault/shopify`), fields: {
          provider: stringValue("shopify"),
          ownerId: stringValue(state.uid),
          ciphertext: stringValue(encrypted.ciphertext),
          iv: stringValue(encrypted.iv),
          encryptionVersion: integerValue(1),
          createdAt: timestampValue(now),
          updatedAt: timestampValue(now)
        } }
      },
      {
        update: { name: documentName(projectId, `workspaces/${state.workspaceId}/connections/shopify`), fields: {
          provider: stringValue("shopify"),
          displayName: stringValue(identity.name),
          shopDomain: stringValue(shop),
          shopId: stringValue(identity.id),
          primaryDomain: stringValue(identity.primaryDomain?.url || ""),
          routeId: stringValue(routeId),
          apiVersion: stringValue(apiVersion),
          status: stringValue("configuration_required"),
          authorizationStatus: stringValue("authorized"),
          credentialState: stringValue("stored_server_side"),
          health: stringValue("webhook_pending"),
          desiredChannels: stringArrayValue(["Orders", "Customers", "Store events"]),
          authorizedBy: stringValue(state.uid),
          createdAt: timestampValue(now),
          updatedAt: timestampValue(now)
        } }
      },
      {
        update: { name: documentName(projectId, `connectorRoutes/${routeId}`), fields: {
          provider: stringValue("shopify"),
          accountType: stringValue("shop"),
          providerAccountId: stringValue(shop),
          shopDomain: stringValue(shop),
          workspaceId: stringValue(state.workspaceId),
          ownerId: stringValue(state.uid),
          active: booleanValue(true),
          createdAt: timestampValue(now),
          updatedAt: timestampValue(now)
        } }
      }
    ]);
    return redirect(res, "authorized");
  } catch (cause) {
    console.error("Shopify authorization callback failed", cause);
    return redirect(res, "error");
  }
}

// server/shopify-connect.ts
function requestBody(req) {
  try {
    return typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
  } catch {
    throw new Error("INVALID_REQUEST");
  }
}
async function handler2(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "DELETE") {
    res.setHeader("Allow", "DELETE");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }
  try {
    const body = requestBody(req);
    const uid = await verifyFirebaseUid(req);
    const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
    const { projectId, accessToken } = await googleAccessToken();
    await requireWorkspaceRole(projectId, accessToken, workspaceId, uid, ["owner", "admin"]);
    const connection = await getDocument(projectId, accessToken, `workspaces/${workspaceId}/connections/shopify`);
    const routeId = fieldString(connection, "routeId");
    const writes = [
      { delete: documentName(projectId, `workspaces/${workspaceId}/connections/shopify`) },
      { delete: documentName(projectId, `workspaces/${workspaceId}/connectorVault/shopify`) }
    ];
    if (/^shopify_[A-Za-z0-9_-]{40}$/.test(routeId)) writes.push({ delete: documentName(projectId, `connectorRoutes/${routeId}`) });
    await commitWrites(projectId, accessToken, writes);
    return res.status(200).json({ ok: true, status: "disconnected" });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "";
    if (message === "UNAUTHENTICATED") {
      res.setHeader("WWW-Authenticate", "Bearer");
      return res.status(401).json({ ok: false, error: "A valid ORIN AI session is required" });
    }
    if (message === "AUTH_SERVICE_UNAVAILABLE") return res.status(503).json({ ok: false, error: "Session verification is temporarily unavailable" });
    if (message === "FORBIDDEN") return res.status(403).json({ ok: false, error: "Only a workspace owner or admin can disconnect Shopify" });
    if (message === "INVALID_REQUEST") return res.status(400).json({ ok: false, error: "Invalid request" });
    console.error("Shopify disconnect failed", cause);
    return res.status(502).json({ ok: false, error: "The Shopify connection could not be removed." });
  }
}

// server/shopify-start.ts
var encoder3 = new TextEncoder();
function queryValue2(value) {
  return Array.isArray(value) ? value[0] || "" : value || "";
}
async function signState(payload, secret) {
  const key = await crypto.subtle.importKey("raw", encoder3.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder3.encode(payload))));
}
async function handler3(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }
  const clientId = process.env.SHOPIFY_CLIENT_ID || "";
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET || "";
  const stateSecret = process.env.OAUTH_STATE_SECRET || "";
  if (!clientId || !clientSecret || stateSecret.length < 32 || !process.env.CONNECTOR_ENCRYPTION_KEY || !process.env.FIREBASE_CLIENT_EMAIL || !process.env.FIREBASE_PRIVATE_KEY) {
    return res.status(503).json({ ok: false, error: "Shopify authorization is not configured for this deployment yet" });
  }
  try {
    const uid = await verifyFirebaseUid(req);
    const workspaceId = queryValue2(req.query?.workspaceId);
    const { projectId, accessToken } = await googleAccessToken();
    await requireWorkspaceRole(projectId, accessToken, workspaceId, uid);
    const shop = normalizeShopDomain(queryValue2(req.query?.shop));
    const nonce = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(24)));
    const payload = bytesToBase64Url(encoder3.encode(JSON.stringify({
      provider: "shopify",
      uid,
      workspaceId,
      shop,
      nonce,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 10 * 60 * 1e3
    })));
    const state = `${payload}.${await signState(payload, stateSecret)}`;
    const redirectUri = process.env.SHOPIFY_REDIRECT_URI || "https://www.orin.work/api/integrations/shopify/callback";
    const authorizationUrl = new URL(`https://${shop}/admin/oauth/authorize`);
    authorizationUrl.search = new URLSearchParams({
      client_id: clientId,
      scope: process.env.SHOPIFY_SCOPES || "read_orders,read_customers,read_products",
      redirect_uri: redirectUri,
      state
    }).toString();
    res.setHeader("Set-Cookie", `orin_shopify_oauth=${encodeURIComponent(nonce)}; Max-Age=600; Path=/api/integrations/shopify; HttpOnly; Secure; SameSite=Lax`);
    return res.status(200).json({ ok: true, authorizationUrl: authorizationUrl.toString() });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "";
    if (message === "UNAUTHENTICATED") {
      res.setHeader("WWW-Authenticate", "Bearer");
      return res.status(401).json({ ok: false, error: "A valid ORIN AI session is required" });
    }
    if (message === "AUTH_SERVICE_UNAVAILABLE") return res.status(503).json({ ok: false, error: "Session verification is temporarily unavailable" });
    if (message === "FORBIDDEN") return res.status(403).json({ ok: false, error: "You do not have permission to connect Shopify in this workspace" });
    if (message === "INVALID_SHOP") return res.status(400).json({ ok: false, error: "Enter the permanent store domain, such as your-store.myshopify.com." });
    console.error("Shopify authorization start failed", cause);
    return res.status(500).json({ ok: false, error: "Shopify authorization could not be started" });
  }
}

// server/lazada.ts
var encoder4 = new TextEncoder();
function bytesToHex2(value) {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function hmacSha256(message, secret) {
  const key = await crypto.subtle.importKey("raw", encoder4.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const input = typeof message === "string" ? encoder4.encode(message) : message;
  const data = new Uint8Array(input.byteLength);
  data.set(input);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, data.buffer));
}
async function signLazadaRequest(path, parameters, secret) {
  if (!path.startsWith("/") || !secret) throw new Error("INVALID_LAZADA_SIGNING_INPUT");
  const canonical = Object.entries(parameters).filter(([key]) => key !== "sign").map(([key, value]) => [key, String(value)]).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, value]) => `${key}${value}`).join("");
  return bytesToHex2(await hmacSha256(`${path}${canonical}`, secret)).toUpperCase();
}
function cleanText(value, maximum) {
  return typeof value === "string" ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, maximum) : "";
}
function positiveNumber(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}
function identifier(value) {
  const normalized = typeof value === "number" && Number.isFinite(value) ? String(value) : cleanText(value, 180);
  return /^[A-Za-z0-9._:-]{1,180}$/.test(normalized) ? normalized : "";
}
function normalizedCountry(value) {
  const country = cleanText(value, 8).toLowerCase();
  return ["sg", "my", "ph", "th", "id", "vn"].includes(country) ? country : "";
}
function parseLazadaToken(value) {
  if (!value || typeof value !== "object") return null;
  const candidate = value;
  const accessToken = cleanText(candidate.access_token, 4096);
  const refreshToken = cleanText(candidate.refresh_token, 4096);
  const expiresIn = positiveNumber(candidate.expires_in);
  const refreshExpiresIn = positiveNumber(candidate.refresh_expires_in);
  const accountPlatform = cleanText(candidate.account_platform, 100);
  const country = normalizedCountry(candidate.country);
  if (accessToken.length < 20 || refreshToken.length < 20 || !expiresIn || !refreshExpiresIn) return null;
  const seen = /* @__PURE__ */ new Set();
  const shops = (Array.isArray(candidate.country_user_info) ? candidate.country_user_info : []).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry;
    const sellerId = identifier(item.seller_id);
    const userId = identifier(item.user_id);
    const shopCountry = normalizedCountry(item.country);
    const shortCode = cleanText(item.short_code, 80);
    if (!sellerId || !userId || !shopCountry || seen.has(`${shopCountry}:${sellerId}`)) return [];
    seen.add(`${shopCountry}:${sellerId}`);
    return [{ country: shopCountry, sellerId, userId, shortCode }];
  });
  if (!shops.length) return null;
  return { accessToken, refreshToken, expiresIn, refreshExpiresIn, accountPlatform, country, shops };
}

// server/lazada-callback.ts
var encoder5 = new TextEncoder();
var decoder2 = new TextDecoder();
function queryValue3(value) {
  return Array.isArray(value) ? value[0] || "" : value || "";
}
function parseCookie2(req, name) {
  const raw = req.headers?.cookie;
  const cookieHeader = Array.isArray(raw) ? raw.join(";") : raw || "";
  const match = cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : "";
}
async function verifyState2(value, secret) {
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra) throw new Error("INVALID_STATE");
  const key = await crypto.subtle.importKey("raw", encoder5.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("HMAC", key, base64ToBytes(signature), encoder5.encode(payload));
  if (!valid) throw new Error("INVALID_STATE");
  const parsed = JSON.parse(decoder2.decode(base64ToBytes(payload)));
  if (parsed.provider !== "lazada" || !parsed.uid || !/^[A-Za-z0-9_-]{8,200}$/.test(parsed.workspaceId) || !/^[A-Za-z0-9_-]{8,128}$/.test(parsed.agentId) || !parsed.nonce || !Number.isFinite(parsed.issuedAt) || !Number.isFinite(parsed.expiresAt) || parsed.issuedAt > Date.now() + 6e4 || parsed.expiresAt < Date.now() || parsed.expiresAt - parsed.issuedAt > 10 * 60 * 1e3) throw new Error("INVALID_STATE");
  return parsed;
}
function redirect2(res, status) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Set-Cookie", "orin_lazada_oauth=; Max-Age=0; Path=/api/integrations/lazada; HttpOnly; Secure; SameSite=Lax");
  res.setHeader("Location", `https://www.orin.work/app/integrations?provider=lazada&status=${encodeURIComponent(status)}`);
  return res.status(302).end();
}
function readyAgent(agent) {
  const readiness = Number(agent?.fields?.readiness?.integerValue || 0);
  const channels = agent?.fields?.config?.mapValue?.fields?.channels?.arrayValue?.values || [];
  return readiness >= 6 && channels.some((channel) => channel.stringValue === "Lazada");
}
function fieldStringArray(document, name) {
  return (document?.fields?.[name]?.arrayValue?.values || []).flatMap((value) => value.stringValue ? [value.stringValue] : []);
}
async function exchangeToken2(code, appKey, appSecret) {
  const path = "/auth/token/create";
  const parameters = {
    app_key: appKey,
    code,
    sign_method: "sha256",
    timestamp: String(Date.now())
  };
  parameters.sign = await signLazadaRequest(path, parameters, appSecret);
  const response = await fetch(`https://auth.lazada.com/rest${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(parameters),
    signal: AbortSignal.timeout(1e4)
  });
  const payload = await response.json().catch(() => ({}));
  const token = parseLazadaToken(payload) || parseLazadaToken(payload.data);
  if (!response.ok || !token) throw new Error("LAZADA_TOKEN_EXCHANGE_FAILED");
  return token;
}
async function handler4(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).end("Method not allowed");
  }
  const appKey = process.env.LAZADA_APP_KEY || "";
  const appSecret = process.env.LAZADA_APP_SECRET || "";
  const stateSecret = process.env.OAUTH_STATE_SECRET || "";
  const encryptionKey = process.env.CONNECTOR_ENCRYPTION_KEY || "";
  if (!appKey || !appSecret || stateSecret.length < 32 || !encryptionKey) return redirect2(res, "not_configured");
  if (queryValue3(req.query?.error)) return redirect2(res, "cancelled");
  try {
    const code = queryValue3(req.query?.code);
    const stateValue = queryValue3(req.query?.state);
    if (!code || !stateValue || code.length > 4096) return redirect2(res, "invalid_callback");
    const state = await verifyState2(stateValue, stateSecret);
    if (parseCookie2(req, "orin_lazada_oauth") !== state.nonce) return redirect2(res, "invalid_state");
    const token = await exchangeToken2(code, appKey, appSecret);
    const { projectId, accessToken } = await googleAccessToken();
    await requireWorkspaceRole(projectId, accessToken, state.workspaceId, state.uid);
    const agent = await getDocument(projectId, accessToken, `workspaces/${state.workspaceId}/agents/${state.agentId}`);
    if (!readyAgent(agent)) return redirect2(res, "agent_not_ready");
    const existing = await getDocument(projectId, accessToken, `workspaces/${state.workspaceId}/connections/lazada`);
    const newRoutes = await Promise.all(token.shops.map(async (shop) => ({
      ...shop,
      sellerHash: await stableId("lazada-seller", shop.sellerId),
      routeId: `lazada_seller_${await stableId("lazada-seller", shop.sellerId)}`
    })));
    const routeIds = newRoutes.map((route) => route.routeId);
    const staleRouteIds = fieldStringArray(existing, "routeIds").filter((routeId) => /^lazada_seller_[A-Za-z0-9_-]{40}$/.test(routeId) && !routeIds.includes(routeId));
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const expiresAt = new Date(Date.now() + token.expiresIn * 1e3).toISOString();
    const refreshExpiresAt = new Date(Date.now() + token.refreshExpiresIn * 1e3).toISOString();
    const encrypted = await encryptJson({
      provider: "lazada",
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt,
      refreshExpiresAt,
      accountPlatform: token.accountPlatform,
      country: token.country,
      shops: token.shops
    }, encryptionKey);
    const webhookConfigured = process.env.LAZADA_WEBHOOKS_CONFIGURED === "true";
    const countries = [...new Set(token.shops.map((shop) => shop.country.toUpperCase()))];
    const displayName = token.shops.length === 1 ? `Lazada shop \xB7 ${countries[0]}` : `${token.shops.length} Lazada shops`;
    const writes = [
      {
        update: { name: documentName(projectId, `workspaces/${state.workspaceId}/connectorVault/lazada`), fields: {
          provider: stringValue("lazada"),
          ownerId: stringValue(state.uid),
          ciphertext: stringValue(encrypted.ciphertext),
          iv: stringValue(encrypted.iv),
          encryptionVersion: integerValue(1),
          createdAt: timestampValue(now),
          updatedAt: timestampValue(now)
        } }
      },
      {
        update: { name: documentName(projectId, `workspaces/${state.workspaceId}/connections/lazada`), fields: {
          provider: stringValue("lazada"),
          displayName: stringValue(displayName),
          status: stringValue(webhookConfigured ? "connected" : "configuration_required"),
          authorizationStatus: stringValue("authorized"),
          credentialState: stringValue("stored_server_side"),
          health: stringValue(webhookConfigured ? "awaiting_first_event" : "webhook_not_configured"),
          desiredChannels: stringArrayValue(["Customer messages"]),
          countries: stringArrayValue(countries),
          sellerIdHashes: stringArrayValue(newRoutes.map((route) => route.sellerHash)),
          routeIds: stringArrayValue(routeIds),
          shopCount: integerValue(token.shops.length),
          agentId: stringValue(state.agentId),
          autoReplyEnabled: booleanValue(true),
          autoReplyChannels: stringArrayValue(["Lazada"]),
          authorizedBy: stringValue(state.uid),
          tokenExpiresAt: timestampValue(expiresAt),
          createdAt: timestampValue(now),
          updatedAt: timestampValue(now)
        } }
      },
      {
        update: { name: documentName(projectId, `workspaces/${state.workspaceId}/agents/${state.agentId}`), fields: { status: stringValue("active") } },
        updateMask: { fieldPaths: ["status"] },
        updateTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }],
        currentDocument: { exists: true }
      },
      ...newRoutes.map((route) => ({
        update: { name: documentName(projectId, `connectorRoutes/${route.routeId}`), fields: {
          provider: stringValue("lazada"),
          accountType: stringValue("seller"),
          providerAccountId: stringValue(route.sellerId),
          providerUserId: stringValue(route.userId),
          country: stringValue(route.country),
          workspaceId: stringValue(state.workspaceId),
          ownerId: stringValue(state.uid),
          active: booleanValue(true),
          createdAt: timestampValue(now),
          updatedAt: timestampValue(now)
        } }
      })),
      ...staleRouteIds.map((routeId) => ({ delete: documentName(projectId, `connectorRoutes/${routeId}`) }))
    ];
    await commitWrites(projectId, accessToken, writes);
    return redirect2(res, "authorized");
  } catch (cause) {
    console.error("Lazada authorization callback failed", cause);
    return redirect2(res, "error");
  }
}

// server/lazada-connect.ts
function requestBody2(req) {
  try {
    return typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
  } catch {
    throw new Error("INVALID_REQUEST");
  }
}
function fieldStringArray2(document, name) {
  return (document?.fields?.[name]?.arrayValue?.values || []).flatMap((value) => value.stringValue ? [value.stringValue] : []);
}
async function conversationRouteNames(projectId, accessToken, workspaceId) {
  const response = await fetch(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents:runQuery`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: "conversationRoutes" }],
      where: { compositeFilter: { op: "AND", filters: [
        { fieldFilter: { field: { fieldPath: "workspaceId" }, op: "EQUAL", value: { stringValue: workspaceId } } },
        { fieldFilter: { field: { fieldPath: "provider" }, op: "EQUAL", value: { stringValue: "lazada" } } }
      ] } },
      limit: 250
    } }),
    signal: AbortSignal.timeout(1e4)
  });
  if (!response.ok) return [];
  const rows = await response.json();
  return rows.flatMap((row) => row.document?.name ? [row.document.name] : []);
}
async function handler5(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "DELETE") {
    res.setHeader("Allow", "DELETE");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }
  try {
    const body = requestBody2(req);
    const uid = await verifyFirebaseUid(req);
    const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
    const { projectId, accessToken } = await googleAccessToken();
    await requireWorkspaceRole(projectId, accessToken, workspaceId, uid, ["owner", "admin"]);
    const connection = await getDocument(projectId, accessToken, `workspaces/${workspaceId}/connections/lazada`);
    const routeIds = fieldStringArray2(connection, "routeIds").filter((routeId) => /^lazada_seller_[A-Za-z0-9_-]{40}$/.test(routeId));
    const privateConversationRoutes = await conversationRouteNames(projectId, accessToken, workspaceId);
    await commitWrites(projectId, accessToken, [
      { delete: documentName(projectId, `workspaces/${workspaceId}/connections/lazada`) },
      { delete: documentName(projectId, `workspaces/${workspaceId}/connectorVault/lazada`) },
      ...routeIds.map((routeId) => ({ delete: documentName(projectId, `connectorRoutes/${routeId}`) })),
      ...privateConversationRoutes.map((name) => ({ delete: name }))
    ]);
    return res.status(200).json({ ok: true, status: "disconnected" });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "";
    if (message === "UNAUTHENTICATED") {
      res.setHeader("WWW-Authenticate", "Bearer");
      return res.status(401).json({ ok: false, error: "A valid ORIN AI session is required" });
    }
    if (message === "AUTH_SERVICE_UNAVAILABLE") return res.status(503).json({ ok: false, error: "Session verification is temporarily unavailable" });
    if (message === "FORBIDDEN") return res.status(403).json({ ok: false, error: "Only a workspace owner or admin can disconnect Lazada" });
    if (message === "INVALID_REQUEST") return res.status(400).json({ ok: false, error: "Invalid request" });
    console.error("Lazada disconnect failed", cause);
    return res.status(502).json({ ok: false, error: "The Lazada connection could not be removed." });
  }
}

// server/lazada-start.ts
var encoder6 = new TextEncoder();
function queryValue4(value) {
  return Array.isArray(value) ? value[0] || "" : value || "";
}
async function signState2(payload, secret) {
  const key = await crypto.subtle.importKey("raw", encoder6.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder6.encode(payload))));
}
function lazadaReadyAgent(agent) {
  const readiness = Number(agent?.fields?.readiness?.integerValue || 0);
  const channels = agent?.fields?.config?.mapValue?.fields?.channels?.arrayValue?.values || [];
  return readiness >= 6 && channels.some((channel) => channel.stringValue === "Lazada");
}
async function handler6(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }
  const appKey = process.env.LAZADA_APP_KEY || "";
  const appSecret = process.env.LAZADA_APP_SECRET || "";
  const stateSecret = process.env.OAUTH_STATE_SECRET || "";
  if (!appKey || !appSecret || stateSecret.length < 32 || !process.env.CONNECTOR_ENCRYPTION_KEY || !process.env.FIREBASE_CLIENT_EMAIL || !process.env.FIREBASE_PRIVATE_KEY) return res.status(503).json({ ok: false, error: "Lazada authorization is not configured for this deployment yet" });
  try {
    const uid = await verifyFirebaseUid(req);
    const workspaceId = queryValue4(req.query?.workspaceId);
    const agentId = queryValue4(req.query?.agentId);
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(agentId)) return res.status(400).json({ ok: false, error: "Choose a Lazada-ready ORIN AI first" });
    const { projectId, accessToken } = await googleAccessToken();
    await requireWorkspaceRole(projectId, accessToken, workspaceId, uid);
    const agent = await getDocument(projectId, accessToken, `workspaces/${workspaceId}/agents/${agentId}`);
    if (!lazadaReadyAgent(agent)) return res.status(409).json({ ok: false, error: "Complete all six AI decisions and include Lazada before connecting the seller account" });
    const nonce = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(24)));
    const issuedAt = Date.now();
    const payload = bytesToBase64Url(encoder6.encode(JSON.stringify({
      provider: "lazada",
      uid,
      workspaceId,
      agentId,
      nonce,
      issuedAt,
      expiresAt: issuedAt + 10 * 60 * 1e3
    })));
    const state = `${payload}.${await signState2(payload, stateSecret)}`;
    const redirectUri = process.env.LAZADA_REDIRECT_URI || "https://www.orin.work/api/integrations/lazada/callback";
    const authorizationUrl = new URL("https://auth.lazada.com/oauth/authorize");
    authorizationUrl.search = new URLSearchParams({
      response_type: "code",
      force_auth: "true",
      redirect_uri: redirectUri,
      client_id: appKey,
      state
    }).toString();
    res.setHeader("Set-Cookie", `orin_lazada_oauth=${encodeURIComponent(nonce)}; Max-Age=600; Path=/api/integrations/lazada; HttpOnly; Secure; SameSite=Lax`);
    return res.status(200).json({ ok: true, authorizationUrl: authorizationUrl.toString() });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "";
    if (message === "UNAUTHENTICATED") {
      res.setHeader("WWW-Authenticate", "Bearer");
      return res.status(401).json({ ok: false, error: "A valid ORIN AI session is required" });
    }
    if (message === "AUTH_SERVICE_UNAVAILABLE") return res.status(503).json({ ok: false, error: "Session verification is temporarily unavailable" });
    if (message === "FORBIDDEN") return res.status(403).json({ ok: false, error: "You do not have permission to connect Lazada in this workspace" });
    console.error("Lazada authorization start failed", cause);
    return res.status(500).json({ ok: false, error: "Lazada authorization could not be started" });
  }
}

// server/shopee.ts
var encoder7 = new TextEncoder();
function bytesToHex3(value) {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function hmacSha2562(message, secret) {
  const key = await crypto.subtle.importKey("raw", encoder7.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const input = typeof message === "string" ? encoder7.encode(message) : message;
  const data = new Uint8Array(input.byteLength);
  data.set(input);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, data.buffer));
}
async function signShopeePublic(path, timestamp, partnerId, partnerKey) {
  if (!path.startsWith("/") || !/^\d{1,20}$/.test(partnerId) || !Number.isInteger(timestamp) || !partnerKey) throw new Error("INVALID_SHOPEE_SIGNING_INPUT");
  return bytesToHex3(await hmacSha2562(`${partnerId}${path}${timestamp}`, partnerKey));
}
async function signShopeeShop(path, timestamp, accessToken, shopId, partnerId, partnerKey) {
  if (!path.startsWith("/") || !/^\d{1,20}$/.test(shopId) || accessToken.length < 8) throw new Error("INVALID_SHOPEE_SIGNING_INPUT");
  return bytesToHex3(await hmacSha2562(`${partnerId}${path}${timestamp}${accessToken}${shopId}`, partnerKey));
}

// server/shopee-callback.ts
var encoder8 = new TextEncoder();
var decoder3 = new TextDecoder();
function queryValue5(value) {
  return Array.isArray(value) ? value[0] || "" : value || "";
}
function cleanText2(value, maximum) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}
function numericId(value) {
  const normalized = typeof value === "number" && Number.isFinite(value) ? String(Math.trunc(value)) : cleanText2(value, 40);
  return /^\d{1,20}$/.test(normalized) ? normalized : "";
}
function positiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}
function parseCookie3(req, name) {
  const raw = req.headers?.cookie;
  const cookieHeader = Array.isArray(raw) ? raw.join(";") : raw || "";
  const match = cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : "";
}
async function verifyState3(value, secret) {
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra) throw new Error("INVALID_STATE");
  const key = await crypto.subtle.importKey("raw", encoder8.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  if (!await crypto.subtle.verify("HMAC", key, base64ToBytes(signature), encoder8.encode(payload))) throw new Error("INVALID_STATE");
  const parsed = JSON.parse(decoder3.decode(base64ToBytes(payload)));
  if (parsed.provider !== "shopee" || !parsed.uid || !/^[A-Za-z0-9_-]{8,200}$/.test(parsed.workspaceId) || !/^[A-Za-z0-9_-]{8,128}$/.test(parsed.agentId) || !parsed.nonce || !Number.isFinite(parsed.issuedAt) || !Number.isFinite(parsed.expiresAt) || parsed.issuedAt > Date.now() + 6e4 || parsed.expiresAt < Date.now() || parsed.expiresAt - parsed.issuedAt > 10 * 60 * 1e3) throw new Error("INVALID_STATE");
  return parsed;
}
function redirect3(res, status) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Set-Cookie", "orin_shopee_oauth=; Max-Age=0; Path=/api/integrations/shopee; HttpOnly; Secure; SameSite=Lax");
  res.setHeader("Location", `https://www.orin.work/app/integrations?provider=shopee&status=${encodeURIComponent(status)}`);
  return res.status(302).end();
}
function readyAgent2(agent) {
  const readiness = Number(agent?.fields?.readiness?.integerValue || 0);
  const channels = agent?.fields?.config?.mapValue?.fields?.channels?.arrayValue?.values || [];
  return readiness >= 6 && channels.some((channel) => channel.stringValue === "Shopee");
}
function fieldStringArray3(document, name) {
  return (document?.fields?.[name]?.arrayValue?.values || []).flatMap((value) => value.stringValue ? [value.stringValue] : []);
}
function shopeeHost() {
  return process.env.SHOPEE_API_HOST || "https://partner.shopeemobile.com";
}
async function publicPost(path, body, partnerId, partnerKey) {
  const timestamp = Math.floor(Date.now() / 1e3);
  const sign = await signShopeePublic(path, timestamp, partnerId, partnerKey);
  const url = new URL(`${shopeeHost()}${path}`);
  url.search = new URLSearchParams({ partner_id: partnerId, timestamp: String(timestamp), sign }).toString();
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12e3)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || cleanText2(payload.error, 120)) throw new Error(`SHOPEE_API_${cleanText2(payload.error, 80) || response.status}`);
  return payload;
}
function tokenFields(payload) {
  const accessToken = cleanText2(payload.access_token, 4096);
  const refreshToken = cleanText2(payload.refresh_token, 4096);
  const expiresIn = positiveInteger(payload.expire_in);
  if (accessToken.length < 8 || refreshToken.length < 8 || !expiresIn) throw new Error("SHOPEE_TOKEN_EXCHANGE_FAILED");
  return { accessToken, refreshToken, expiresIn };
}
async function shopInfo(shopId, accessToken, partnerId, partnerKey) {
  const path = "/api/v2/shop/get_shop_info";
  const timestamp = Math.floor(Date.now() / 1e3);
  const sign = await signShopeeShop(path, timestamp, accessToken, shopId, partnerId, partnerKey);
  const url = new URL(`${shopeeHost()}${path}`);
  url.search = new URLSearchParams({ partner_id: partnerId, timestamp: String(timestamp), access_token: accessToken, shop_id: shopId, sign }).toString();
  const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(1e4) });
  const payload = await response.json().catch(() => ({}));
  const inner = payload.response && typeof payload.response === "object" ? payload.response : {};
  return {
    shopName: cleanText2(inner.shop_name, 160) || `Shopee shop ${shopId.slice(-4)}`,
    region: cleanText2(inner.region, 8).toUpperCase()
  };
}
async function exchangeTokens(code, shopId, mainAccountId, partnerId, partnerKey) {
  const first = await publicPost("/api/v2/auth/token/get", {
    code,
    partner_id: Number(partnerId),
    ...shopId ? { shop_id: Number(shopId) } : { main_account_id: Number(mainAccountId) }
  }, partnerId, partnerKey);
  const initial = tokenFields(first);
  const shopIds = shopId ? [shopId] : (Array.isArray(first.shop_id_list) ? first.shop_id_list : []).map(numericId).filter(Boolean);
  if (!shopIds.length) throw new Error("SHOPEE_NO_AUTHORIZED_SHOPS");
  const tokens = [];
  for (const authorizedShopId of [...new Set(shopIds)].slice(0, 100)) {
    const token = shopId ? initial : tokenFields(await publicPost("/api/v2/auth/access_token/get", {
      partner_id: Number(partnerId),
      shop_id: Number(authorizedShopId),
      refresh_token: initial.refreshToken
    }, partnerId, partnerKey));
    const info = await shopInfo(authorizedShopId, token.accessToken, partnerId, partnerKey).catch(() => ({ shopName: `Shopee shop ${authorizedShopId.slice(-4)}`, region: "" }));
    tokens.push({
      shopId: authorizedShopId,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: new Date(Date.now() + token.expiresIn * 1e3).toISOString(),
      ...info
    });
  }
  return tokens;
}
async function handler7(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).end("Method not allowed");
  }
  const partnerId = process.env.SHOPEE_PARTNER_ID || "";
  const partnerKey = process.env.SHOPEE_PARTNER_KEY || "";
  const stateSecret = process.env.OAUTH_STATE_SECRET || "";
  const encryptionKey = process.env.CONNECTOR_ENCRYPTION_KEY || "";
  if (!/^\d{1,20}$/.test(partnerId) || partnerKey.length < 16 || stateSecret.length < 32 || !encryptionKey) return redirect3(res, "not_configured");
  if (queryValue5(req.query?.error)) return redirect3(res, "cancelled");
  try {
    const code = queryValue5(req.query?.code);
    const stateValue = queryValue5(req.query?.state);
    const shopId = numericId(queryValue5(req.query?.shop_id));
    const mainAccountId = numericId(queryValue5(req.query?.main_account_id));
    if (!code || code.length > 4096 || !stateValue || !shopId && !mainAccountId || shopId && mainAccountId) return redirect3(res, "invalid_callback");
    const state = await verifyState3(stateValue, stateSecret);
    if (parseCookie3(req, "orin_shopee_oauth") !== state.nonce) return redirect3(res, "invalid_state");
    const shops = await exchangeTokens(code, shopId, mainAccountId, partnerId, partnerKey);
    const { projectId, accessToken } = await googleAccessToken();
    await requireWorkspaceRole(projectId, accessToken, state.workspaceId, state.uid);
    const agent = await getDocument(projectId, accessToken, `workspaces/${state.workspaceId}/agents/${state.agentId}`);
    if (!readyAgent2(agent)) return redirect3(res, "agent_not_ready");
    const existing = await getDocument(projectId, accessToken, `workspaces/${state.workspaceId}/connections/shopee`);
    const routes = await Promise.all(shops.map(async (shop) => ({
      ...shop,
      shopHash: await stableId("shopee-shop", shop.shopId),
      routeId: `shopee_shop_${await stableId("shopee-shop", shop.shopId)}`
    })));
    const routeIds = routes.map((route) => route.routeId);
    const staleRouteIds = fieldStringArray3(existing, "routeIds").filter((routeId) => /^shopee_shop_[A-Za-z0-9_-]{40}$/.test(routeId) && !routeIds.includes(routeId));
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const encrypted = await encryptJson({ provider: "shopee", partnerId, shops }, encryptionKey);
    const webhookConfigured = process.env.SHOPEE_WEBHOOKS_CONFIGURED === "true";
    const regions = [...new Set(shops.map((shop) => shop.region).filter(Boolean))];
    const displayName = shops.length === 1 ? shops[0].shopName : `${shops.length} Shopee shops`;
    const earliestExpiry = shops.map((shop) => shop.expiresAt).sort()[0];
    const writes = [
      {
        update: { name: documentName(projectId, `workspaces/${state.workspaceId}/connectorVault/shopee`), fields: {
          provider: stringValue("shopee"),
          ownerId: stringValue(state.uid),
          ciphertext: stringValue(encrypted.ciphertext),
          iv: stringValue(encrypted.iv),
          encryptionVersion: integerValue(1),
          createdAt: timestampValue(now),
          updatedAt: timestampValue(now)
        } }
      },
      {
        update: { name: documentName(projectId, `workspaces/${state.workspaceId}/connections/shopee`), fields: {
          provider: stringValue("shopee"),
          displayName: stringValue(displayName),
          status: stringValue(webhookConfigured ? "connected" : "configuration_required"),
          authorizationStatus: stringValue("authorized"),
          credentialState: stringValue("stored_server_side"),
          health: stringValue(webhookConfigured ? "awaiting_first_event" : "webhook_not_configured"),
          desiredChannels: stringArrayValue(["Customer messages"]),
          regions: stringArrayValue(regions),
          shopIdHashes: stringArrayValue(routes.map((route) => route.shopHash)),
          routeIds: stringArrayValue(routeIds),
          shopCount: integerValue(shops.length),
          agentId: stringValue(state.agentId),
          autoReplyEnabled: booleanValue(true),
          autoReplyChannels: stringArrayValue(["Shopee"]),
          authorizedBy: stringValue(state.uid),
          tokenExpiresAt: timestampValue(earliestExpiry),
          partnerAccessStatus: stringValue("approved"),
          createdAt: timestampValue(now),
          updatedAt: timestampValue(now)
        } }
      },
      {
        update: { name: documentName(projectId, `workspaces/${state.workspaceId}/agents/${state.agentId}`), fields: { status: stringValue("active") } },
        updateMask: { fieldPaths: ["status"] },
        updateTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }],
        currentDocument: { exists: true }
      },
      ...routes.map((route) => ({
        update: { name: documentName(projectId, `connectorRoutes/${route.routeId}`), fields: {
          provider: stringValue("shopee"),
          accountType: stringValue("seller"),
          providerAccountId: stringValue(route.shopId),
          displayName: stringValue(route.shopName),
          country: stringValue(route.region),
          workspaceId: stringValue(state.workspaceId),
          ownerId: stringValue(state.uid),
          active: booleanValue(true),
          createdAt: timestampValue(now),
          updatedAt: timestampValue(now)
        } }
      })),
      ...staleRouteIds.map((routeId) => ({ delete: documentName(projectId, `connectorRoutes/${routeId}`) }))
    ];
    await commitWrites(projectId, accessToken, writes);
    return redirect3(res, "authorized");
  } catch (cause) {
    console.error("Shopee authorization callback failed", cause);
    return redirect3(res, "error");
  }
}

// server/shopee-connect.ts
function requestBody3(req) {
  try {
    return typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
  } catch {
    throw new Error("INVALID_REQUEST");
  }
}
function fieldStringArray4(document, name) {
  return (document?.fields?.[name]?.arrayValue?.values || []).flatMap((value) => value.stringValue ? [value.stringValue] : []);
}
async function conversationRouteNames2(projectId, accessToken, workspaceId) {
  const response = await fetch(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents:runQuery`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: "conversationRoutes" }],
      where: { compositeFilter: { op: "AND", filters: [
        { fieldFilter: { field: { fieldPath: "workspaceId" }, op: "EQUAL", value: { stringValue: workspaceId } } },
        { fieldFilter: { field: { fieldPath: "provider" }, op: "EQUAL", value: { stringValue: "shopee" } } }
      ] } },
      limit: 250
    } }),
    signal: AbortSignal.timeout(1e4)
  });
  if (!response.ok) return [];
  const rows = await response.json();
  return rows.flatMap((row) => row.document?.name ? [row.document.name] : []);
}
async function handler8(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "DELETE") {
    res.setHeader("Allow", "DELETE");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }
  try {
    const body = requestBody3(req);
    const uid = await verifyFirebaseUid(req);
    const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
    const { projectId, accessToken } = await googleAccessToken();
    await requireWorkspaceRole(projectId, accessToken, workspaceId, uid, ["owner", "admin"]);
    const connection = await getDocument(projectId, accessToken, `workspaces/${workspaceId}/connections/shopee`);
    const routeIds = fieldStringArray4(connection, "routeIds").filter((routeId) => /^shopee_shop_[A-Za-z0-9_-]{40}$/.test(routeId));
    const privateConversationRoutes = await conversationRouteNames2(projectId, accessToken, workspaceId);
    await commitWrites(projectId, accessToken, [
      { delete: documentName(projectId, `workspaces/${workspaceId}/connections/shopee`) },
      { delete: documentName(projectId, `workspaces/${workspaceId}/connectorVault/shopee`) },
      ...routeIds.map((routeId) => ({ delete: documentName(projectId, `connectorRoutes/${routeId}`) })),
      ...privateConversationRoutes.map((name) => ({ delete: name }))
    ]);
    return res.status(200).json({ ok: true, status: "disconnected" });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "";
    if (message === "UNAUTHENTICATED") {
      res.setHeader("WWW-Authenticate", "Bearer");
      return res.status(401).json({ ok: false, error: "A valid ORIN AI session is required" });
    }
    if (message === "AUTH_SERVICE_UNAVAILABLE") return res.status(503).json({ ok: false, error: "Session verification is temporarily unavailable" });
    if (message === "FORBIDDEN") return res.status(403).json({ ok: false, error: "Only a workspace owner or admin can disconnect Shopee" });
    if (message === "INVALID_REQUEST") return res.status(400).json({ ok: false, error: "Invalid request" });
    console.error("Shopee disconnect failed", cause);
    return res.status(502).json({ ok: false, error: "The Shopee connection could not be removed." });
  }
}

// server/shopee-start.ts
var encoder9 = new TextEncoder();
function queryValue6(value) {
  return Array.isArray(value) ? value[0] || "" : value || "";
}
async function signState3(payload, secret) {
  const key = await crypto.subtle.importKey("raw", encoder9.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder9.encode(payload))));
}
function shopeeReadyAgent(agent) {
  const readiness = Number(agent?.fields?.readiness?.integerValue || 0);
  const channels = agent?.fields?.config?.mapValue?.fields?.channels?.arrayValue?.values || [];
  return readiness >= 6 && channels.some((channel) => channel.stringValue === "Shopee");
}
async function handler9(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }
  const partnerId = process.env.SHOPEE_PARTNER_ID || "";
  const partnerKey = process.env.SHOPEE_PARTNER_KEY || "";
  const stateSecret = process.env.OAUTH_STATE_SECRET || "";
  if (!/^\d{1,20}$/.test(partnerId) || partnerKey.length < 16 || stateSecret.length < 32 || !process.env.CONNECTOR_ENCRYPTION_KEY || !process.env.FIREBASE_CLIENT_EMAIL || !process.env.FIREBASE_PRIVATE_KEY) return res.status(503).json({ ok: false, error: "Shopee authorization is not configured for this deployment yet" });
  try {
    const uid = await verifyFirebaseUid(req);
    const workspaceId = queryValue6(req.query?.workspaceId);
    const agentId = queryValue6(req.query?.agentId);
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(agentId)) return res.status(400).json({ ok: false, error: "Choose a Shopee-ready ORIN AI first" });
    const { projectId, accessToken } = await googleAccessToken();
    await requireWorkspaceRole(projectId, accessToken, workspaceId, uid);
    const agent = await getDocument(projectId, accessToken, `workspaces/${workspaceId}/agents/${agentId}`);
    if (!shopeeReadyAgent(agent)) return res.status(409).json({ ok: false, error: "Complete all six AI decisions and include Shopee before connecting the seller account" });
    const nonce = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(24)));
    const issuedAt = Date.now();
    const payload = bytesToBase64Url(encoder9.encode(JSON.stringify({
      provider: "shopee",
      uid,
      workspaceId,
      agentId,
      nonce,
      issuedAt,
      expiresAt: issuedAt + 10 * 60 * 1e3
    })));
    const state = `${payload}.${await signState3(payload, stateSecret)}`;
    const redirectUri = process.env.SHOPEE_REDIRECT_URI || "https://www.orin.work/api/integrations/shopee/callback";
    const authorizationUrl = new URL(process.env.SHOPEE_AUTH_URL || "https://open.shopee.com/auth");
    authorizationUrl.search = new URLSearchParams({
      partner_id: partnerId,
      auth_type: "seller",
      redirect_uri: redirectUri,
      response_type: "code",
      state
    }).toString();
    res.setHeader("Set-Cookie", `orin_shopee_oauth=${encodeURIComponent(nonce)}; Max-Age=600; Path=/api/integrations/shopee; HttpOnly; Secure; SameSite=Lax`);
    return res.status(200).json({ ok: true, authorizationUrl: authorizationUrl.toString() });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "";
    if (message === "UNAUTHENTICATED") {
      res.setHeader("WWW-Authenticate", "Bearer");
      return res.status(401).json({ ok: false, error: "A valid ORIN AI session is required" });
    }
    if (message === "AUTH_SERVICE_UNAVAILABLE") return res.status(503).json({ ok: false, error: "Session verification is temporarily unavailable" });
    if (message === "FORBIDDEN") return res.status(403).json({ ok: false, error: "You do not have permission to connect Shopee in this workspace" });
    console.error("Shopee authorization start failed", cause);
    return res.status(500).json({ ok: false, error: "Shopee authorization could not be started" });
  }
}

// server/analytics.ts
var ANALYTICS_EVENT_LIMIT = 5e3;
var ANALYTICS_DAY_OPTIONS = [7, 30, 90];
var dayMs = 864e5;
function normalizeAnalyticsDays(value) {
  const parsed = typeof value === "number" ? value : Number(value);
  return ANALYTICS_DAY_OPTIONS.includes(parsed) ? parsed : 30;
}
function normalizeTimezoneOffset(value) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(-840, Math.min(840, Math.trunc(parsed)));
}
function buildAnalyticsRange(daysInput, timezoneOffsetInput, nowInput = /* @__PURE__ */ new Date()) {
  const days = normalizeAnalyticsDays(daysInput);
  const timezoneOffset = normalizeTimezoneOffset(timezoneOffsetInput);
  const now = Number.isFinite(nowInput.getTime()) ? nowInput : /* @__PURE__ */ new Date();
  const localNow = new Date(now.getTime() - timezoneOffset * 6e4);
  const localStart = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate()) - (days - 1) * dayMs;
  const currentStartMs = localStart + timezoneOffset * 6e4;
  const currentEndMs = now.getTime();
  const duration = Math.max(dayMs, currentEndMs - currentStartMs);
  const previousEndMs = currentStartMs;
  const previousStartMs = previousEndMs - duration;
  return {
    days,
    timezoneOffset,
    currentStart: new Date(currentStartMs).toISOString(),
    currentEnd: new Date(currentEndMs).toISOString(),
    previousStart: new Date(previousStartMs).toISOString(),
    previousEnd: new Date(previousEndMs).toISOString()
  };
}
function uniqueConversationIds(events, type) {
  return new Set(events.filter((event) => event.type === type).map((event) => event.conversationId || event.id));
}
function percentile(values, position) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(position * sorted.length) - 1);
  return sorted[index];
}
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
function summarizeAnalyticsPeriod(events) {
  const conversations = uniqueConversationIds(events, "conversation.started");
  const responded = uniqueConversationIds(events, "conversation.responded");
  const explicitlyResolved = uniqueConversationIds(events, "conversation.resolved");
  const escalated = uniqueConversationIds(events, "conversation.escalated");
  const aiHandled = new Set([...responded, ...explicitlyResolved].filter((conversationId) => conversations.has(conversationId) && !escalated.has(conversationId)));
  const firstResponses = events.filter((event) => event.type === "conversation.responded" && event.firstResponseMs !== null && event.firstResponseMs >= 0).map((event) => event.firstResponseMs);
  const attributedEvents = events.filter((event) => event.type === "value.attributed" && Number.isFinite(event.value));
  const attributedValue = roundMoney(attributedEvents.reduce((total, event) => total + event.value, 0));
  const commerceEvents = events.filter((event) => event.type === "commerce.order_paid" && Number.isFinite(event.value));
  const verifiedCommerceValue = roundMoney(commerceEvents.reduce((total, event) => total + event.value, 0));
  const currencyValues = /* @__PURE__ */ new Map();
  attributedEvents.forEach((event) => {
    const currency = /^[A-Z]{3}$/.test(event.currency) ? event.currency : "PHP";
    currencyValues.set(currency, roundMoney((currencyValues.get(currency) || 0) + event.value));
  });
  const commerceCurrencyValues = /* @__PURE__ */ new Map();
  commerceEvents.forEach((event) => {
    if (!/^[A-Z]{3}$/.test(event.currency)) return;
    commerceCurrencyValues.set(event.currency, roundMoney((commerceCurrencyValues.get(event.currency) || 0) + event.value));
  });
  const channels = /* @__PURE__ */ new Map();
  events.filter((event) => event.type === "conversation.started").forEach((event) => {
    const channel = event.channel || "Unspecified";
    channels.set(channel, (channels.get(channel) || 0) + 1);
  });
  return {
    metrics: {
      conversations: conversations.size,
      aiHandled: aiHandled.size,
      escalated: escalated.size,
      leads: events.filter((event) => event.type === "lead.captured").length,
      attributedValue,
      verifiedCommerceValue,
      aiHandledRate: conversations.size ? Math.round(aiHandled.size / conversations.size * 100) : 0,
      escalationRate: conversations.size ? Math.round(escalated.size / conversations.size * 100) : 0,
      medianFirstResponseMs: median(firstResponses),
      p90FirstResponseMs: percentile(firstResponses, 0.9),
      automationFailures: events.filter((event) => event.type === "automation.failed").length,
      events: events.length
    },
    channels: [...channels.entries()].map(([name, count]) => ({ name, count })).sort((left, right) => right.count - left.count || left.name.localeCompare(right.name)),
    currencies: [...currencyValues.entries()].map(([code, value]) => ({ code, value })).sort((left, right) => right.value - left.value || left.code.localeCompare(right.code)),
    commerceCurrencies: [...commerceCurrencyValues.entries()].map(([code, value]) => ({ code, value })).sort((left, right) => right.value - left.value || left.code.localeCompare(right.code))
  };
}
function localDateKey(occurredAt, timezoneOffset) {
  const time = Date.parse(occurredAt);
  if (!Number.isFinite(time)) return "";
  return new Date(time - timezoneOffset * 6e4).toISOString().slice(0, 10);
}
function buildAnalyticsTrend(events, range) {
  const start = Date.parse(range.currentStart) - range.timezoneOffset * 6e4;
  const buckets = Array.from({ length: range.days }, (_, index) => {
    const date = new Date(start + index * dayMs).toISOString().slice(0, 10);
    return [date, { date, conversations: 0, aiResponses: 0, escalations: 0 }];
  });
  const byDate = new Map(buckets);
  events.forEach((event) => {
    const bucket = byDate.get(localDateKey(event.occurredAt, range.timezoneOffset));
    if (!bucket) return;
    if (event.type === "conversation.started") bucket.conversations += 1;
    if (event.type === "conversation.responded") bucket.aiResponses += 1;
    if (event.type === "conversation.escalated") bucket.escalations += 1;
  });
  return [...byDate.values()];
}
function summarizeAnalytics(currentEvents, previousEvents, range, truncated = { current: false, previous: false }) {
  return {
    range,
    current: summarizeAnalyticsPeriod(currentEvents),
    previous: summarizeAnalyticsPeriod(previousEvents),
    trend: buildAnalyticsTrend(currentEvents, range),
    truncated
  };
}

// server/analytics-summary.ts
function queryValue7(value) {
  return Array.isArray(value) ? value[0] || "" : value || "";
}
function validWorkspaceId(value) {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
function fieldNumber(document, name) {
  const value = document.fields?.[name];
  const parsed = value?.doubleValue ?? (value?.integerValue === void 0 ? Number.NaN : Number(value.integerValue));
  return Number.isFinite(parsed) ? parsed : 0;
}
function fieldTimestamp2(document, name) {
  const value = document.fields?.[name]?.timestampValue || "";
  return Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : "";
}
function eventId(document) {
  return document.name?.split("/").pop() || "";
}
function toAnalyticsEvent(document) {
  const occurredAt = fieldTimestamp2(document, "occurredAt");
  if (!occurredAt) return null;
  const firstResponseValue = document.fields?.firstResponseMs;
  const firstResponseMs = firstResponseValue ? fieldNumber({ fields: { firstResponseMs: firstResponseValue } }, "firstResponseMs") : null;
  return {
    id: eventId(document),
    type: fieldString(document, "type") || "unknown",
    channel: fieldString(document, "channel") || "Unspecified",
    conversationId: fieldString(document, "conversationId"),
    contactId: fieldString(document, "contactId"),
    value: fieldNumber(document, "value"),
    currency: fieldString(document, "currency").toUpperCase(),
    firstResponseMs,
    occurredAt
  };
}
function timestampFilter(op, value) {
  return { fieldFilter: { field: { fieldPath: "occurredAt" }, op, value: { timestampValue: value } } };
}
async function queryEvents(projectId, accessToken, workspaceId, start, end) {
  const response = await fetch(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/workspaces/${encodeURIComponent(workspaceId)}:runQuery`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery: {
      select: { fields: ["type", "channel", "conversationId", "contactId", "value", "currency", "firstResponseMs", "occurredAt"].map((fieldPath) => ({ fieldPath })) },
      from: [{ collectionId: "events", allDescendants: false }],
      where: { compositeFilter: { op: "AND", filters: [timestampFilter("GREATER_THAN_OR_EQUAL", start), timestampFilter("LESS_THAN", end)] } },
      orderBy: [{ field: { fieldPath: "occurredAt" }, direction: "DESCENDING" }],
      limit: ANALYTICS_EVENT_LIMIT + 1
    } }),
    signal: AbortSignal.timeout(2e4)
  });
  if (!response.ok) throw new Error("ANALYTICS_QUERY_FAILED");
  const rows = await response.json();
  const documents = rows.flatMap((row) => row.document ? [row.document] : []);
  const truncated = documents.length > ANALYTICS_EVENT_LIMIT;
  return {
    events: documents.slice(0, ANALYTICS_EVENT_LIMIT).flatMap((document) => {
      const event = toAnalyticsEvent(document);
      return event ? [event] : [];
    }),
    truncated
  };
}
async function handler10(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Vary", "Authorization");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }
  try {
    const uid = await verifyFirebaseUid(req);
    const workspaceId = queryValue7(req.query?.workspaceId);
    if (!validWorkspaceId(workspaceId)) return res.status(400).json({ ok: false, error: "A valid workspace is required" });
    const range = buildAnalyticsRange(queryValue7(req.query?.days), queryValue7(req.query?.timezoneOffset));
    const { projectId, accessToken } = await googleAccessToken();
    const membership = await getDocument(projectId, accessToken, `workspaces/${workspaceId}/members/${uid}`);
    if (!membership) return res.status(403).json({ ok: false, error: "You do not have access to this workspace" });
    const [current, previous] = await Promise.all([
      queryEvents(projectId, accessToken, workspaceId, range.currentStart, range.currentEnd),
      queryEvents(projectId, accessToken, workspaceId, range.previousStart, range.previousEnd)
    ]);
    return res.status(200).json({
      ok: true,
      generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      summary: summarizeAnalytics(current.events, previous.events, range, { current: current.truncated, previous: previous.truncated })
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "";
    if (message === "UNAUTHENTICATED") {
      res.setHeader("WWW-Authenticate", "Bearer");
      return res.status(401).json({ ok: false, error: "A valid ORIN AI session is required" });
    }
    if (message === "AUTH_SERVICE_UNAVAILABLE") return res.status(503).json({ ok: false, error: "Session verification is temporarily unavailable" });
    if (message.startsWith("SERVER_STORAGE_")) return res.status(503).json({ ok: false, error: "Analytics storage is temporarily unavailable" });
    console.error("Analytics summary failed", cause);
    return res.status(500).json({ ok: false, error: "Analytics could not be loaded" });
  }
}

// server/social-core.ts
var socialProviders = [
  "facebook",
  "instagram",
  "tiktok",
  "youtube",
  "linkedin",
  "threads",
  "pinterest",
  "x",
  "google_business",
  "reddit",
  "bluesky",
  "mastodon",
  "telegram"
];
var socialRecurrences = ["none", "daily", "weekdays", "weekly", "monthly"];
var socialCapabilities = {
  facebook: { label: "Facebook", connection: "oauth", availability: "app_review" },
  instagram: { label: "Instagram", connection: "oauth", availability: "app_review" },
  tiktok: { label: "TikTok", connection: "oauth", availability: "app_review" },
  youtube: { label: "YouTube", connection: "oauth", availability: "app_review" },
  linkedin: { label: "LinkedIn", connection: "oauth", availability: "app_review" },
  threads: { label: "Threads", connection: "oauth", availability: "app_review" },
  pinterest: { label: "Pinterest", connection: "oauth", availability: "app_review" },
  x: { label: "X", connection: "oauth", availability: "app_review" },
  google_business: { label: "Google Business Profile", connection: "oauth", availability: "app_review" },
  reddit: { label: "Reddit", connection: "oauth", availability: "written_approval" },
  bluesky: { label: "Bluesky", connection: "token", availability: "ready" },
  mastodon: { label: "Mastodon", connection: "token", availability: "ready" },
  telegram: { label: "Telegram", connection: "token", availability: "ready" }
};
function cleanText3(value, maximum) {
  return typeof value === "string" ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, maximum) : "";
}
function validateSocialCredential(provider, input) {
  if (!socialProviders.includes(provider) || !input || typeof input !== "object" || Array.isArray(input)) throw new Error("INVALID_CONNECTION");
  const values = input;
  if (provider === "telegram") {
    const botToken = cleanText3(values.botToken, 200);
    const chatId = cleanText3(values.chatId, 100);
    if (!/^\d{6,12}:[A-Za-z0-9_-]{30,80}$/.test(botToken) || !/^-?[A-Za-z0-9_@-]{2,100}$/.test(chatId)) throw new Error("INVALID_CONNECTION");
    return { botToken, chatId };
  }
  if (provider === "mastodon") {
    const instanceUrl = cleanText3(values.instanceUrl, 300).replace(/\/$/, "");
    const accessToken = cleanText3(values.accessToken, 500);
    let url;
    try {
      url = new URL(instanceUrl);
    } catch {
      throw new Error("INVALID_CONNECTION");
    }
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || !accessToken) throw new Error("INVALID_CONNECTION");
    return { instanceUrl: url.origin, accessToken };
  }
  if (provider === "bluesky") {
    const handle = cleanText3(values.handle, 253).toLowerCase();
    const appPassword = cleanText3(values.appPassword, 100);
    if (!/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/.test(handle) || appPassword.length < 8) throw new Error("INVALID_CONNECTION");
    return { handle, appPassword };
  }
  throw new Error("MANAGED_OAUTH_REQUIRED");
}
function validateSocialPost(input, now = Date.now()) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("INVALID_POST");
  const body = input;
  const text = cleanText3(body.text, 1e4);
  const mediaUrl = cleanText3(body.mediaUrl, 2e3);
  const rawTargets = Array.isArray(body.targets) ? body.targets : [];
  if (!text && !mediaUrl || !rawTargets.length || rawTargets.length > socialProviders.length) throw new Error("INVALID_POST");
  if (mediaUrl) {
    let url;
    try {
      url = new URL(mediaUrl);
    } catch {
      throw new Error("INVALID_MEDIA_URL");
    }
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("INVALID_MEDIA_URL");
  }
  const seen = /* @__PURE__ */ new Set();
  const targets = rawTargets.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("INVALID_TARGET");
    const candidate = raw;
    const provider = cleanText3(candidate.provider, 40);
    if (!socialProviders.includes(provider) || seen.has(provider)) throw new Error("INVALID_TARGET");
    seen.add(provider);
    return { provider, accountId: cleanText3(candidate.accountId, 300), variant: cleanText3(candidate.variant, 1e4) };
  });
  const scheduledAtText = cleanText3(body.scheduledAt, 50);
  let scheduledAt = "";
  if (scheduledAtText) {
    const time = Date.parse(scheduledAtText);
    if (!Number.isFinite(time) || time < now + 6e4 || time > now + 366 * 24 * 60 * 6e4) throw new Error("INVALID_SCHEDULE");
    scheduledAt = new Date(time).toISOString();
  }
  const recurrence = cleanText3(body.recurrence, 20) || "none";
  if (!socialRecurrences.includes(recurrence)) throw new Error("INVALID_RECURRENCE");
  const suppliedRuns = typeof body.maxRuns === "number" ? body.maxRuns : Number(body.maxRuns || 1);
  const maxRuns = recurrence === "none" ? 1 : Math.trunc(suppliedRuns);
  if (recurrence !== "none" && !scheduledAt) throw new Error("AUTOPOST_REQUIRES_SCHEDULE");
  if (recurrence !== "none" && (!Number.isFinite(maxRuns) || maxRuns < 2 || maxRuns > 365)) throw new Error("INVALID_RUN_COUNT");
  return { text, mediaUrl, targets, scheduledAt, recurrence, maxRuns };
}
function nextSocialOccurrence(current, recurrence) {
  const next = new Date(current);
  if (!Number.isFinite(next.getTime())) throw new Error("INVALID_SCHEDULE");
  if (recurrence === "daily" || recurrence === "weekdays") {
    next.setUTCDate(next.getUTCDate() + 1);
    if (recurrence === "weekdays") {
      while (next.getUTCDay() === 0 || next.getUTCDay() === 6) next.setUTCDate(next.getUTCDate() + 1);
    }
  } else if (recurrence === "weekly") {
    next.setUTCDate(next.getUTCDate() + 7);
  } else {
    const day = next.getUTCDate();
    next.setUTCDate(1);
    next.setUTCMonth(next.getUTCMonth() + 1);
    const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
    next.setUTCDate(Math.min(day, lastDay));
  }
  return next.toISOString();
}

// server/scheduler-store.ts
var collections = {
  social: "socialScheduleJobs",
  followup: "followUpScheduleJobs"
};
function validId(value, maximum = 200) {
  return value.length >= 8 && value.length <= maximum && /^[A-Za-z0-9_-]+$/.test(value);
}
function denoSchedulerConfigured() {
  return process.env.ORIN_SCHEDULER_PROVIDER === "deno" && (process.env.ORIN_SCHEDULER_SECRET || "").length >= 32;
}
async function putScheduledJob(projectId, accessToken, kind, workspaceId, jobId, scheduledAt) {
  if (!denoSchedulerConfigured()) throw new Error(kind === "social" ? "SCHEDULER_NOT_CONFIGURED" : "FOLLOWUP_SCHEDULER_NOT_CONFIGURED");
  if (!validId(workspaceId) || !validId(jobId, 128) || !Number.isFinite(Date.parse(scheduledAt))) throw new Error("INVALID_SCHEDULED_JOB");
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await commitWrites(projectId, accessToken, [{
    update: {
      name: documentName(projectId, `${collections[kind]}/${jobId}`),
      fields: {
        workspaceId: stringValue(workspaceId),
        jobId: stringValue(jobId),
        scheduledAt: timestampValue(scheduledAt),
        updatedAt: timestampValue(now)
      }
    }
  }]);
}
async function removeScheduledJob(projectId, accessToken, kind, jobId) {
  if (!validId(jobId, 128)) return;
  await commitWrites(projectId, accessToken, [{ delete: documentName(projectId, `${collections[kind]}/${jobId}`) }]);
}
function documentId(document) {
  return document.name?.split("/").pop() || "";
}
async function listDueScheduledJobs(projectId, accessToken, kind, dueAt = (/* @__PURE__ */ new Date()).toISOString(), maximum = 50) {
  const response = await fetchWithTransientRetry(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents:runQuery`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: collections[kind] }],
        where: { fieldFilter: { field: { fieldPath: "scheduledAt" }, op: "LESS_THAN_OR_EQUAL", value: { timestampValue: dueAt } } },
        orderBy: [{ field: { fieldPath: "scheduledAt" }, direction: "ASCENDING" }],
        limit: Math.min(100, Math.max(1, maximum))
      }
    })
  });
  if (!response.ok) throw new Error("SCHEDULER_STORAGE_READ_FAILED");
  const payload = await response.json();
  return payload.flatMap(({ document }) => {
    if (!document) return [];
    const id = documentId(document);
    const workspaceId = fieldString(document, "workspaceId");
    const jobId = fieldString(document, "jobId") || id;
    const scheduledAt = fieldTimestamp(document, "scheduledAt");
    return validId(id, 128) && validId(workspaceId) && validId(jobId, 128) && scheduledAt ? [{ id, workspaceId, jobId, scheduledAt }] : [];
  });
}
async function recordSchedulerHeartbeat(projectId, accessToken) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await commitWrites(projectId, accessToken, [{
    update: {
      name: documentName(projectId, "schedulerState/deno"),
      fields: { provider: stringValue("deno"), status: stringValue("healthy"), lastSeenAt: timestampValue(now) }
    }
  }]);
  return now;
}
async function denoSchedulerReadiness(projectId, accessToken) {
  if (!denoSchedulerConfigured()) return { ready: false, reason: "not_configured", provider: "deno" };
  try {
    const state = await getDocument(projectId, accessToken, "schedulerState/deno");
    const lastSeenAt = fieldTimestamp(state, "lastSeenAt");
    const age = Date.now() - Date.parse(lastSeenAt);
    return Number.isFinite(age) && age >= 0 && age <= 4 * 6e4 ? { ready: true, reason: "", provider: "deno", lastSeenAt } : { ready: false, reason: "heartbeat_stale", provider: "deno", lastSeenAt };
  } catch {
    return { ready: false, reason: "scheduler_unavailable", provider: "deno" };
  }
}

// server/social-dispatch.ts
function bodyOf(req) {
  const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("INVALID_REQUEST");
  return body;
}
function clean(value, maximum = 200) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}
async function requireEditor(projectId, accessToken, workspaceId, uid) {
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(workspaceId)) throw new Error("INVALID_REQUEST");
  const [workspace, membership] = await Promise.all([
    getDocument(projectId, accessToken, `workspaces/${workspaceId}`),
    getDocument(projectId, accessToken, `workspaces/${workspaceId}/members/${uid}`)
  ]);
  const role = fieldString(membership, "role");
  if (!workspace || !["owner", "admin", "editor"].includes(role)) throw new Error("FORBIDDEN");
  return fieldString(workspace, "ownerId") || uid;
}
async function testCredential(provider, credential) {
  if (provider === "telegram") {
    const response = await fetch(`https://api.telegram.org/bot${credential.botToken}/getChat?chat_id=${encodeURIComponent(credential.chatId)}`, { signal: AbortSignal.timeout(8e3) });
    if (!response.ok || !(await response.json()).ok) throw new Error("PROVIDER_REJECTED_CREDENTIALS");
  } else if (provider === "mastodon") {
    const response = await fetch(`${credential.instanceUrl}/api/v1/accounts/verify_credentials`, { headers: { Authorization: `Bearer ${credential.accessToken}` }, signal: AbortSignal.timeout(8e3) });
    if (!response.ok) throw new Error("PROVIDER_REJECTED_CREDENTIALS");
  } else if (provider === "bluesky") {
    const response = await fetch("https://bsky.social/xrpc/com.atproto.server.createSession", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identifier: credential.handle, password: credential.appPassword }), signal: AbortSignal.timeout(8e3) });
    if (!response.ok) throw new Error("PROVIDER_REJECTED_CREDENTIALS");
  }
}
async function publish(provider, credential, text, mediaUrl, idempotencyKey) {
  if (provider === "facebook" || provider === "instagram") {
    const meta = credential;
    const page = meta.pages.find((item) => provider === "facebook" ? true : Boolean(item.instagramBusinessAccount?.id));
    if (!page?.id || !page.accessToken) throw new Error("PROVIDER_ACCOUNT_NOT_FOUND");
    const version = /^v\d+\.\d+$/.test(meta.graphVersion) ? meta.graphVersion : "v23.0";
    if (provider === "facebook") {
      const endpoint = mediaUrl ? `${page.id}/photos` : `${page.id}/feed`;
      const form = new URLSearchParams(mediaUrl ? { url: mediaUrl, caption: text } : { message: text });
      const response2 = await fetch(`https://graph.facebook.com/${version}/${endpoint}`, { method: "POST", headers: { Authorization: `Bearer ${page.accessToken}`, "Content-Type": "application/x-www-form-urlencoded" }, body: form, signal: AbortSignal.timeout(2e4) });
      const data2 = await response2.json().catch(() => ({}));
      if (!response2.ok || !data2.id && !data2.post_id) throw new Error(`PROVIDER_DELIVERY_FAILED:${response2.status}`);
      return data2.post_id || data2.id || "";
    }
    if (!mediaUrl) throw new Error("INSTAGRAM_MEDIA_REQUIRED");
    const instagramId = page.instagramBusinessAccount?.id || "";
    const container = await fetch(`https://graph.facebook.com/${version}/${instagramId}/media`, { method: "POST", headers: { Authorization: `Bearer ${page.accessToken}`, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ image_url: mediaUrl, caption: text }), signal: AbortSignal.timeout(2e4) });
    const containerData = await container.json().catch(() => ({}));
    if (!container.ok || !containerData.id) throw new Error(`PROVIDER_DELIVERY_FAILED:${container.status}`);
    const response = await fetch(`https://graph.facebook.com/${version}/${instagramId}/media_publish`, { method: "POST", headers: { Authorization: `Bearer ${page.accessToken}`, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ creation_id: containerData.id }), signal: AbortSignal.timeout(2e4) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.id) throw new Error(`PROVIDER_DELIVERY_FAILED:${response.status}`);
    return data.id;
  }
  if (mediaUrl && provider !== "telegram") throw new Error("MEDIA_UPLOAD_NOT_READY");
  if (provider === "telegram") {
    const endpoint = mediaUrl ? "sendPhoto" : "sendMessage";
    const payload = mediaUrl ? { chat_id: credential.chatId, photo: mediaUrl, caption: text } : { chat_id: credential.chatId, text };
    const response = await fetch(`https://api.telegram.org/bot${credential.botToken}/${endpoint}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15e3) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok || !data.result?.message_id) throw new Error(`PROVIDER_DELIVERY_FAILED:${data.description || response.status}`);
    return String(data.result.message_id);
  }
  if (provider === "mastodon") {
    const response = await fetch(`${credential.instanceUrl}/api/v1/statuses`, { method: "POST", headers: { Authorization: `Bearer ${credential.accessToken}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey }, body: JSON.stringify({ status: text }), signal: AbortSignal.timeout(15e3) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.id) throw new Error(`PROVIDER_DELIVERY_FAILED:${response.status}`);
    return data.id;
  }
  if (provider === "bluesky") {
    const sessionResponse = await fetch("https://bsky.social/xrpc/com.atproto.server.createSession", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identifier: credential.handle, password: credential.appPassword }), signal: AbortSignal.timeout(8e3) });
    const session = await sessionResponse.json().catch(() => ({}));
    if (!sessionResponse.ok || !session.accessJwt || !session.did) throw new Error("PROVIDER_REJECTED_CREDENTIALS");
    const response = await fetch("https://bsky.social/xrpc/com.atproto.repo.createRecord", { method: "POST", headers: { Authorization: `Bearer ${session.accessJwt}`, "Content-Type": "application/json" }, body: JSON.stringify({ repo: session.did, collection: "app.bsky.feed.post", record: { $type: "app.bsky.feed.post", text, createdAt: (/* @__PURE__ */ new Date()).toISOString() } }), signal: AbortSignal.timeout(15e3) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.uri) throw new Error(`PROVIDER_DELIVERY_FAILED:${response.status}`);
    return data.uri;
  }
  throw new Error("PROVIDER_NOT_CONNECTED");
}
async function credentialFor(projectId, accessToken, workspaceId, provider) {
  const vaultId = provider === "facebook" || provider === "instagram" ? "meta" : `social_${provider}`;
  const vault = await getDocument(projectId, accessToken, `workspaces/${workspaceId}/connectorVault/${vaultId}`);
  if (!vault) throw new Error("PROVIDER_NOT_CONNECTED");
  return decryptJson(fieldString(vault, "ciphertext"), fieldString(vault, "iv"), process.env.CONNECTOR_ENCRYPTION_KEY || "");
}
async function deliverStoredPost(projectId, accessToken, workspaceId, postId, post) {
  const text = fieldString(post, "text");
  const mediaUrl = fieldString(post, "mediaUrl");
  let targets;
  try {
    targets = JSON.parse(fieldString(post, "targetsJson"));
  } catch {
    throw new Error("INVALID_STORED_POST");
  }
  const deliveries = await Promise.all(targets.map(async (target) => {
    const deliveryId = await stableId("social-delivery", postId, target.provider);
    let deliveryStatus = "failed";
    let externalId = "";
    let error = "";
    try {
      externalId = await publish(target.provider, await credentialFor(projectId, accessToken, workspaceId, target.provider), target.variant || text, mediaUrl, deliveryId);
      deliveryStatus = "delivered";
    } catch (cause) {
      error = cause instanceof Error ? cause.message.slice(0, 300) : "DELIVERY_FAILED";
    }
    await commitWrites(projectId, accessToken, [{ update: { name: documentName(projectId, `workspaces/${workspaceId}/socialDeliveries/${deliveryId}`), fields: { postId: stringValue(postId), provider: stringValue(target.provider), status: stringValue(deliveryStatus), externalId: stringValue(externalId), error: stringValue(error), requestCount: integerValue(1), bytesSent: integerValue(new TextEncoder().encode(target.variant || text).byteLength), updatedAt: timestampValue((/* @__PURE__ */ new Date()).toISOString()) } } }]);
    return { provider: target.provider, status: deliveryStatus, externalId, error };
  }));
  const delivered = deliveries.filter((delivery) => delivery.status === "delivered").length;
  const status = delivered === targets.length ? "delivered" : delivered ? "partially_delivered" : "failed";
  await commitWrites(projectId, accessToken, [{ update: { name: documentName(projectId, `workspaces/${workspaceId}/socialPosts/${postId}`), fields: { status: stringValue(status), deliveredCount: integerValue(delivered), updatedAt: timestampValue((/* @__PURE__ */ new Date()).toISOString()), completed: booleanValue(true) } }, updateMask: { fieldPaths: ["status", "deliveredCount", "updatedAt", "completed"] } }]);
  return { status, deliveries };
}
async function enqueuePost(projectId, accessToken, workspaceId, postId, scheduledAt) {
  await putScheduledJob(projectId, accessToken, "social", workspaceId, postId, scheduledAt);
}
async function reserveScheduledPost(projectId, accessToken, workspaceId, postId, post) {
  if (!post.updateTime) return false;
  return commitWrites(projectId, accessToken, [{
    update: {
      name: documentName(projectId, `workspaces/${workspaceId}/socialPosts/${postId}`),
      fields: { status: stringValue("publishing"), updatedAt: timestampValue((/* @__PURE__ */ new Date()).toISOString()) }
    },
    updateMask: { fieldPaths: ["status", "updatedAt"] },
    currentDocument: { updateTime: post.updateTime }
  }], true);
}
async function scheduleNextAutopost(projectId, accessToken, workspaceId, postId, post) {
  const recurrence = fieldString(post, "recurrence");
  const runNumber = Math.max(1, fieldInteger(post, "runNumber"));
  const maxRuns = Math.max(1, fieldInteger(post, "maxRuns"));
  if (recurrence === "none" || !recurrence || runNumber >= maxRuns) return null;
  const nextAt = nextSocialOccurrence(fieldTimestamp(post, "scheduledAt"), recurrence);
  const seriesId = fieldString(post, "seriesId") || postId;
  const nextPostId = await stableId("social-post-run", seriesId, nextAt);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await commitWrites(projectId, accessToken, [{
    update: {
      name: documentName(projectId, `workspaces/${workspaceId}/socialPosts/${nextPostId}`),
      fields: {
        text: stringValue(fieldString(post, "text")),
        mediaUrl: stringValue(fieldString(post, "mediaUrl")),
        targetsJson: stringValue(fieldString(post, "targetsJson")),
        status: stringValue("scheduled"),
        scheduledAt: timestampValue(nextAt),
        recurrence: stringValue(recurrence),
        seriesId: stringValue(seriesId),
        runNumber: integerValue(runNumber + 1),
        maxRuns: integerValue(maxRuns),
        createdBy: stringValue(fieldString(post, "createdBy")),
        createdAt: timestampValue(now),
        updatedAt: timestampValue(now),
        completed: booleanValue(false)
      }
    },
    currentDocument: { exists: false }
  }], true);
  await enqueuePost(projectId, accessToken, workspaceId, nextPostId, nextAt);
  return { postId: nextPostId, scheduledAt: nextAt, runNumber: runNumber + 1, maxRuns };
}
async function runScheduledPost(projectId, accessToken, workspaceId, postId) {
  const post = await getDocument(projectId, accessToken, `workspaces/${workspaceId}/socialPosts/${postId}`);
  if (!post) return { ok: true, duplicate: true };
  const status = fieldString(post, "status");
  if (status === "publishing" && !fieldBoolean(post, "completed")) return { ok: true, busy: true };
  if (status !== "scheduled") {
    const next2 = fieldBoolean(post, "completed") ? await scheduleNextAutopost(projectId, accessToken, workspaceId, postId, post) : null;
    return { ok: true, duplicate: true, next: next2 };
  }
  if (!await reserveScheduledPost(projectId, accessToken, workspaceId, postId, post)) return { ok: true, busy: true };
  const outcome = await deliverStoredPost(projectId, accessToken, workspaceId, postId, post);
  const next = await scheduleNextAutopost(projectId, accessToken, workspaceId, postId, post);
  return { ok: true, postId, ...outcome, next };
}
async function sweepScheduledPosts(projectId, accessToken) {
  const jobs = await listDueScheduledJobs(projectId, accessToken, "social", (/* @__PURE__ */ new Date()).toISOString(), 100);
  const outcomes = [];
  const startedAt = Date.now();
  for (let index = 0; index < jobs.length && Date.now() - startedAt < 45e3; index += 10) {
    outcomes.push(...await Promise.all(jobs.slice(index, index + 10).map(async (job) => {
      try {
        const result = await runScheduledPost(projectId, accessToken, job.workspaceId, job.jobId);
        if (!result.busy) await removeScheduledJob(projectId, accessToken, "social", job.id);
        return { jobId: job.jobId, ok: true, busy: result.busy === true, duplicate: result.duplicate === true };
      } catch (cause) {
        return { jobId: job.jobId, ok: false, error: cause instanceof Error ? cause.message.slice(0, 120) : "SOCIAL_JOB_FAILED" };
      }
    })));
  }
  return { ok: outcomes.every((item) => item.ok), checked: outcomes.length, deferred: jobs.length - outcomes.length, outcomes };
}
async function handleSocial(req, action) {
  if (req.method !== "POST") throw new Error("METHOD_NOT_ALLOWED");
  const body = bodyOf(req);
  if (action === "run_scheduled") {
    const supplied = typeof req.headers?.["x-orin-scheduler"] === "string" ? req.headers["x-orin-scheduler"] : "";
    if (!process.env.ORIN_SCHEDULER_SECRET || !constantTimeEqual(supplied, process.env.ORIN_SCHEDULER_SECRET)) throw new Error("UNAUTHENTICATED");
    const workspaceId2 = clean(body.workspaceId);
    const postId = clean(body.postId, 80);
    if (!/^[A-Za-z0-9_-]{8,200}$/.test(workspaceId2) || !/^[A-Za-z0-9_-]{20,80}$/.test(postId)) throw new Error("INVALID_REQUEST");
    const { projectId: projectId2, accessToken: accessToken2 } = await googleAccessToken();
    const result = await runScheduledPost(projectId2, accessToken2, workspaceId2, postId);
    if (!result.busy) await removeScheduledJob(projectId2, accessToken2, "social", postId);
    return result;
  }
  if (action === "sweep") {
    const supplied = typeof req.headers?.["x-orin-scheduler"] === "string" ? req.headers["x-orin-scheduler"] : "";
    if (!process.env.ORIN_SCHEDULER_SECRET || !constantTimeEqual(supplied, process.env.ORIN_SCHEDULER_SECRET)) throw new Error("UNAUTHENTICATED");
    const { projectId: projectId2, accessToken: accessToken2 } = await googleAccessToken();
    const lastSeenAt = await recordSchedulerHeartbeat(projectId2, accessToken2);
    return { ...await sweepScheduledPosts(projectId2, accessToken2), provider: "deno", lastSeenAt };
  }
  const account = await verifyFirebaseAccount(req);
  const { projectId, accessToken } = await googleAccessToken();
  const workspaceId = clean(body.workspaceId);
  const ownerId = await requireEditor(projectId, accessToken, workspaceId, account.localId);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  if (action === "scheduler_status") return { ok: true, scheduler: await denoSchedulerReadiness(projectId, accessToken) };
  if (action === "disconnect") {
    const provider = clean(body.provider, 40);
    if (!socialCapabilities[provider] || socialCapabilities[provider].connection !== "token") throw new Error("INVALID_CONNECTION");
    await commitWrites(projectId, accessToken, [
      { delete: documentName(projectId, `workspaces/${workspaceId}/connectorVault/social_${provider}`) },
      { delete: documentName(projectId, `workspaces/${workspaceId}/connections/social_${provider}`) }
    ]);
    return { ok: true, provider, disconnected: true };
  }
  if (action === "cancel" || action === "retry") {
    const postId = clean(body.postId, 80);
    if (!/^[A-Za-z0-9_-]{20,80}$/.test(postId)) throw new Error("INVALID_REQUEST");
    const postPath = `workspaces/${workspaceId}/socialPosts/${postId}`;
    const post = await getDocument(projectId, accessToken, postPath);
    if (!post) throw new Error("POST_NOT_FOUND");
    const currentStatus = fieldString(post, "status");
    if (action === "cancel") {
      if (!["scheduled", "schedule_failed"].includes(currentStatus)) throw new Error("POST_NOT_CANCELLABLE");
      await commitWrites(projectId, accessToken, [{ update: { name: documentName(projectId, postPath), fields: { status: stringValue("cancelled"), completed: booleanValue(true), cancelledBy: stringValue(account.localId), updatedAt: timestampValue(now) } }, updateMask: { fieldPaths: ["status", "completed", "cancelledBy", "updatedAt"] }, ...post.updateTime ? { currentDocument: { updateTime: post.updateTime } } : {} }]);
      return { ok: true, postId, status: "cancelled" };
    }
    if (!["failed", "partially_delivered"].includes(currentStatus)) throw new Error("POST_NOT_RETRYABLE");
    const reserved = await commitWrites(projectId, accessToken, [{ update: { name: documentName(projectId, postPath), fields: { status: stringValue("publishing"), completed: booleanValue(false), updatedAt: timestampValue(now) } }, updateMask: { fieldPaths: ["status", "completed", "updatedAt"] }, ...post.updateTime ? { currentDocument: { updateTime: post.updateTime } } : {} }], true);
    if (!reserved) throw new Error("POST_CHANGED");
    return { ok: true, postId, ...await deliverStoredPost(projectId, accessToken, workspaceId, postId, post) };
  }
  if (action === "connect") {
    const provider = clean(body.provider, 40);
    const credential = validateSocialCredential(provider, body.credential);
    await testCredential(provider, credential);
    const encrypted = await encryptJson(credential, process.env.CONNECTOR_ENCRYPTION_KEY || "");
    await commitWrites(projectId, accessToken, [{ update: { name: documentName(projectId, `workspaces/${workspaceId}/connectorVault/social_${provider}`), fields: { provider: stringValue(provider), ownerId: stringValue(ownerId), ciphertext: stringValue(encrypted.ciphertext), iv: stringValue(encrypted.iv), encryptionVersion: integerValue(1), updatedAt: timestampValue(now) } } }, { update: { name: documentName(projectId, `workspaces/${workspaceId}/connections/social_${provider}`), fields: { provider: stringValue(provider), category: stringValue("social_publishing"), displayName: stringValue(socialCapabilities[provider].label), status: stringValue("connected"), health: stringValue("healthy"), credentialState: stringValue("stored_server_side"), connectionMode: stringValue("byok"), connectedBy: stringValue(account.localId), updatedAt: timestampValue(now) } } }]);
    return { ok: true, provider };
  }
  if (action === "create" || action === "publish") {
    const post = validateSocialPost(body);
    const requestId = clean(body.requestId, 128);
    if (!/^[A-Za-z0-9_-]{12,128}$/.test(requestId)) throw new Error("INVALID_REQUEST");
    const postId = await stableId("social-post", workspaceId, account.localId, requestId);
    const postPath = `workspaces/${workspaceId}/socialPosts/${postId}`;
    if (await getDocument(projectId, accessToken, postPath)) return { ok: true, postId, duplicate: true };
    const status = post.scheduledAt ? "scheduled" : "publishing";
    await commitWrites(projectId, accessToken, [{ update: { name: documentName(projectId, postPath), fields: { text: stringValue(post.text), mediaUrl: stringValue(post.mediaUrl), targetsJson: stringValue(JSON.stringify(post.targets)), status: stringValue(status), scheduledAt: post.scheduledAt ? timestampValue(post.scheduledAt) : timestampValue(now), recurrence: stringValue(post.recurrence), seriesId: stringValue(postId), runNumber: integerValue(1), maxRuns: integerValue(post.maxRuns), createdBy: stringValue(account.localId), createdAt: timestampValue(now), updatedAt: timestampValue(now), completed: booleanValue(false) } }, currentDocument: { exists: false } }]);
    if (post.scheduledAt) {
      try {
        await enqueuePost(projectId, accessToken, workspaceId, postId, post.scheduledAt);
      } catch (cause) {
        await commitWrites(projectId, accessToken, [{ update: { name: documentName(projectId, postPath), fields: { status: stringValue("schedule_failed"), updatedAt: timestampValue((/* @__PURE__ */ new Date()).toISOString()) } }, updateMask: { fieldPaths: ["status", "updatedAt"] } }]);
        throw cause;
      }
      return { ok: true, postId, status: "scheduled", recurrence: post.recurrence, maxRuns: post.maxRuns };
    }
    const stored = await getDocument(projectId, accessToken, postPath);
    return { ok: true, postId, ...await deliverStoredPost(projectId, accessToken, workspaceId, postId, stored) };
  }
  throw new Error("INVALID_REQUEST");
}

// server/communications-dispatch.ts
var providers = /* @__PURE__ */ new Set(["twilio", "semaphore", "infobip", "elevenlabs"]);
var clean2 = (value, maximum = 500) => typeof value === "string" ? value.trim().slice(0, maximum) : "";
var e164 = (value) => {
  const result = clean2(value, 20);
  if (!/^\+[1-9]\d{7,14}$/.test(result)) throw new Error("INVALID_PHONE_NUMBER");
  return result;
};
function bodyOf2(req) {
  const value = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_REQUEST");
  return value;
}
async function requireEditor2(projectId, accessToken, workspaceId, uid) {
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(workspaceId)) throw new Error("INVALID_REQUEST");
  const [workspace, member] = await Promise.all([getDocument(projectId, accessToken, `workspaces/${workspaceId}`), getDocument(projectId, accessToken, `workspaces/${workspaceId}/members/${uid}`)]);
  if (!workspace || !["owner", "admin", "editor"].includes(fieldString(member, "role"))) throw new Error("FORBIDDEN");
  return fieldString(workspace, "ownerId") || uid;
}
function validateCommunicationsCredential(provider, raw) {
  if (!providers.has(provider) || !raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("INVALID_CONNECTION");
  const value = raw;
  if (provider === "twilio") {
    const accountSid = clean2(value.accountSid);
    const authToken = clean2(value.authToken);
    const fromNumber = e164(value.fromNumber);
    if (!/^AC[a-fA-F0-9]{32}$/.test(accountSid) || authToken.length < 20) throw new Error("INVALID_CONNECTION");
    return { accountSid, authToken, fromNumber };
  }
  if (provider === "semaphore") {
    const apiKey2 = clean2(value.apiKey);
    const senderName = clean2(value.senderName, 11);
    if (apiKey2.length < 10 || !senderName) throw new Error("INVALID_CONNECTION");
    return { apiKey: apiKey2, senderName };
  }
  if (provider === "infobip") {
    const baseUrl = clean2(value.baseUrl, 300).replace(/\/$/, "");
    const apiKey2 = clean2(value.apiKey);
    const sender = clean2(value.sender, 20);
    let url;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new Error("INVALID_CONNECTION");
    }
    if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || apiKey2.length < 10 || !sender) throw new Error("INVALID_CONNECTION");
    return { baseUrl: url.origin, apiKey: apiKey2, sender };
  }
  const apiKey = clean2(value.apiKey);
  const agentId = clean2(value.agentId, 100);
  const agentPhoneNumberId = clean2(value.agentPhoneNumberId, 100);
  if (apiKey.length < 20 || !agentId || !agentPhoneNumberId) throw new Error("INVALID_CONNECTION");
  return { apiKey, agentId, agentPhoneNumberId };
}
async function credentialFor2(projectId, accessToken, workspaceId, provider) {
  const vault = await getDocument(projectId, accessToken, `workspaces/${workspaceId}/connectorVault/comms_${provider}`);
  if (!vault) throw new Error("PROVIDER_NOT_CONNECTED");
  return decryptJson(fieldString(vault, "ciphertext"), fieldString(vault, "iv"), process.env.CONNECTOR_ENCRYPTION_KEY || "");
}
async function testCommunicationsCredential(provider, credential) {
  let responses = [];
  if (provider === "twilio") {
    responses = [await fetch(`https://api.twilio.com/2010-04-01/Accounts/${credential.accountSid}/Balance.json`, {
      headers: { Authorization: `Basic ${btoa(`${credential.accountSid}:${credential.authToken}`)}` },
      signal: AbortSignal.timeout(1e4)
    })];
  } else if (provider === "semaphore") {
    const query = new URLSearchParams({ apikey: credential.apiKey });
    responses = await Promise.all([
      fetch(`https://api.semaphore.co/api/v4/account?${query}`, { signal: AbortSignal.timeout(1e4) }),
      fetch(`https://api.semaphore.co/api/v4/account/sendernames?${query}`, { signal: AbortSignal.timeout(1e4) })
    ]);
  } else if (provider === "infobip") {
    responses = [await fetch(`${credential.baseUrl}/account/1/balance`, {
      headers: { Authorization: `App ${credential.apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(1e4)
    })];
  } else if (provider === "elevenlabs") {
    const headers = { "xi-api-key": credential.apiKey, Accept: "application/json" };
    responses = await Promise.all([
      fetch(`https://api.elevenlabs.io/v1/convai/agents/${encodeURIComponent(credential.agentId)}`, { headers, signal: AbortSignal.timeout(1e4) }),
      fetch(`https://api.elevenlabs.io/v1/convai/phone-numbers/${encodeURIComponent(credential.agentPhoneNumberId)}`, { headers, signal: AbortSignal.timeout(1e4) })
    ]);
  }
  if (!responses.length || responses.some((response) => !response.ok)) throw new Error("PROVIDER_REJECTED_CREDENTIALS");
  if (provider === "semaphore") {
    const senders = await responses[1].json().catch(() => []);
    const sender = senders.find((item) => item.name?.toLowerCase() === credential.senderName.toLowerCase());
    if (!sender || !["active", "approved"].includes(String(sender.status || "").toLowerCase())) throw new Error("PROVIDER_SENDER_NOT_APPROVED");
  }
  if (provider === "elevenlabs") {
    const phone = await responses[1].json().catch(() => ({}));
    if (phone.assigned_agent?.agent_id !== credential.agentId) throw new Error("PROVIDER_PHONE_AGENT_MISMATCH");
  }
}
async function sendSms(provider, credential, to, message) {
  let response;
  if (provider === "twilio") response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${credential.accountSid}/Messages.json`, { method: "POST", headers: { Authorization: `Basic ${btoa(`${credential.accountSid}:${credential.authToken}`)}`, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ To: to, From: credential.fromNumber, Body: message }), signal: AbortSignal.timeout(15e3) });
  else if (provider === "semaphore") response = await fetch("https://api.semaphore.co/api/v4/messages", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ apikey: credential.apiKey, number: to, message, sendername: credential.senderName }), signal: AbortSignal.timeout(15e3) });
  else if (provider === "infobip") response = await fetch(`${credential.baseUrl}/sms/2/text/advanced`, { method: "POST", headers: { Authorization: `App ${credential.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ messages: [{ destinations: [{ to }], from: credential.sender, text: message }] }), signal: AbortSignal.timeout(15e3) });
  else throw new Error("INVALID_SMS_PROVIDER");
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`PROVIDER_DELIVERY_FAILED:${response.status}`);
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const first = Array.isArray(payload) ? payload[0] : messages[0];
  return String(payload.sid || first?.messageId || first?.message_id || crypto.randomUUID());
}
async function startCall(credential, to) {
  const response = await fetch("https://api.elevenlabs.io/v1/convai/twilio/outbound-call", { method: "POST", headers: { "xi-api-key": credential.apiKey, "Content-Type": "application/json" }, body: JSON.stringify({ agent_id: credential.agentId, agent_phone_number_id: credential.agentPhoneNumberId, to_number: to }), signal: AbortSignal.timeout(2e4) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.conversation_id && !payload.callSid) throw new Error(`PROVIDER_DELIVERY_FAILED:${response.status}`);
  return payload.conversation_id || payload.callSid || "";
}
async function handleCommunications(req, action) {
  if (req.method !== "POST") throw new Error("METHOD_NOT_ALLOWED");
  const body = bodyOf2(req);
  const account = await verifyFirebaseAccount(req);
  const { projectId, accessToken } = await googleAccessToken();
  const workspaceId = clean2(body.workspaceId, 200);
  const ownerId = await requireEditor2(projectId, accessToken, workspaceId, account.localId);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  if (action === "disconnect") {
    const provider = clean2(body.provider, 30);
    if (!providers.has(provider)) throw new Error("INVALID_CONNECTION");
    await commitWrites(projectId, accessToken, [
      { delete: documentName(projectId, `workspaces/${workspaceId}/connectorVault/comms_${provider}`) },
      { delete: documentName(projectId, `workspaces/${workspaceId}/connections/comms_${provider}`) }
    ]);
    return { ok: true, provider, disconnected: true };
  }
  if (action === "connect") {
    const provider = clean2(body.provider, 30);
    const credential = validateCommunicationsCredential(provider, body.credential);
    await testCommunicationsCredential(provider, credential);
    const encrypted = await encryptJson(credential, process.env.CONNECTOR_ENCRYPTION_KEY || "");
    const unitCost = typeof body.estimatedUnitCostUsd === "number" && body.estimatedUnitCostUsd >= 0 && body.estimatedUnitCostUsd <= 100 ? body.estimatedUnitCostUsd : 0;
    await commitWrites(projectId, accessToken, [{ update: { name: documentName(projectId, `workspaces/${workspaceId}/connectorVault/comms_${provider}`), fields: { provider: stringValue(provider), ownerId: stringValue(ownerId), ciphertext: stringValue(encrypted.ciphertext), iv: stringValue(encrypted.iv), updatedAt: timestampValue(now) } } }, { update: { name: documentName(projectId, `workspaces/${workspaceId}/connections/comms_${provider}`), fields: { provider: stringValue(provider), category: stringValue(provider === "elevenlabs" ? "voice" : "sms"), displayName: stringValue(provider === "elevenlabs" ? "ElevenLabs Agents" : provider.charAt(0).toUpperCase() + provider.slice(1)), status: stringValue("connected"), health: stringValue("healthy"), credentialState: stringValue("stored_server_side"), connectionMode: stringValue("byok"), estimatedUnitCostUsd: doubleValue(unitCost), connectedBy: stringValue(account.localId), connectionTestedAt: timestampValue(now), updatedAt: timestampValue(now) } } }]);
    return { ok: true, provider };
  }
  if (action === "send_sms" || action === "start_call") {
    const provider = action === "start_call" ? "elevenlabs" : clean2(body.provider, 30);
    const to = e164(body.to);
    const message = action === "send_sms" ? clean2(body.message, 1600) : "";
    if (body.consentConfirmed !== true) throw new Error("CONSENT_REQUIRED");
    if (action === "send_sms" && (!["twilio", "semaphore", "infobip"].includes(provider) || !message)) throw new Error("INVALID_MESSAGE");
    const connection = await getDocument(projectId, accessToken, `workspaces/${workspaceId}/connections/comms_${provider}`);
    if (!connection) throw new Error("PROVIDER_NOT_CONNECTED");
    const externalId = action === "start_call" ? await startCall(await credentialFor2(projectId, accessToken, workspaceId, provider), to) : await sendSms(provider, await credentialFor2(projectId, accessToken, workspaceId, provider), to, message);
    const deliveryId = await stableId("communication-delivery", workspaceId, provider, externalId);
    const unitCost = Number(connection.fields?.estimatedUnitCostUsd?.doubleValue || 0);
    await commitWrites(projectId, accessToken, [{ update: { name: documentName(projectId, `workspaces/${workspaceId}/communicationDeliveries/${deliveryId}`), fields: { provider: stringValue(provider), type: stringValue(action === "start_call" ? "voice_call" : "sms"), destinationMasked: stringValue(`${to.slice(0, 4)}\u2022\u2022\u2022\u2022${to.slice(-3)}`), status: stringValue("accepted"), externalId: stringValue(externalId), units: integerValue(1), estimatedCostUsd: doubleValue(unitCost), providerBilledCostUsd: doubleValue(0), costState: stringValue("estimated"), consentConfirmed: stringValue("user_attested"), consentConfirmedAt: timestampValue(now), createdBy: stringValue(account.localId), createdAt: timestampValue(now), updatedAt: timestampValue(now) } } }]);
    return { ok: true, deliveryId, externalId };
  }
  throw new Error("INVALID_REQUEST");
}

// server/shopify-dispatch.ts
function queryValue8(value) {
  return Array.isArray(value) ? value[0] || "" : value || "";
}
async function handler11(req, res) {
  const action = queryValue8(req.query?.action);
  const provider = queryValue8(req.query?.provider);
  if (provider === "communications") {
    res.setHeader("Cache-Control", "no-store");
    try {
      return res.status(200).json(await handleCommunications(req, action));
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : "COMMUNICATIONS_REQUEST_FAILED";
      const status = error === "UNAUTHENTICATED" ? 401 : error === "FORBIDDEN" ? 403 : error === "METHOD_NOT_ALLOWED" ? 405 : error.includes("PROVIDER_") ? 422 : 400;
      return res.status(status).json({ ok: false, error });
    }
  }
  if (provider === "social") {
    res.setHeader("Cache-Control", "no-store");
    try {
      return res.status(200).json(await handleSocial(req, action));
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : "SOCIAL_REQUEST_FAILED";
      const status = error === "UNAUTHENTICATED" ? 401 : error === "FORBIDDEN" ? 403 : error === "METHOD_NOT_ALLOWED" ? 405 : error.includes("PROVIDER_") || error.includes("MEDIA_") ? 422 : 400;
      return res.status(status).json({ ok: false, error });
    }
  }
  if (provider === "analytics") {
    if (action === "summary") return handler10(req, res);
    res.setHeader("Cache-Control", "no-store");
    return res.status(404).json({ ok: false, error: "Analytics route not found" });
  }
  if (provider === "lazada") {
    if (action === "start") return handler6(req, res);
    if (action === "callback") return handler4(req, res);
    if (action === "connect") return handler5(req, res);
    res.setHeader("Cache-Control", "no-store");
    return res.status(404).json({ ok: false, error: "Lazada route not found" });
  }
  if (provider === "shopee") {
    if (action === "start") return handler9(req, res);
    if (action === "callback") return handler7(req, res);
    if (action === "connect") return handler8(req, res);
    res.setHeader("Cache-Control", "no-store");
    return res.status(404).json({ ok: false, error: "Shopee route not found" });
  }
  if (action === "start") return handler3(req, res);
  if (action === "callback") return handler(req, res);
  if (action === "connect") return handler2(req, res);
  res.setHeader("Cache-Control", "no-store");
  return res.status(404).json({ ok: false, error: "Shopify route not found" });
}
export {
  handler11 as default
};
