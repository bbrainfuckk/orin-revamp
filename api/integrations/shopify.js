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
async function verifyFirebaseUid(req) {
  const authorization = headerValue(req, "authorization");
  if (!authorization.startsWith("Bearer ")) throw new Error("UNAUTHENTICATED");
  const token = authorization.slice("Bearer ".length).trim();
  if (!token) throw new Error("UNAUTHENTICATED");
  let response;
  try {
    response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(firebaseApiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: token }),
      signal: AbortSignal.timeout(6e3)
    });
  } catch {
    throw new Error("AUTH_SERVICE_UNAVAILABLE");
  }
  if (!response.ok) throw new Error("UNAUTHENTICATED");
  const account = (await response.json()).users?.[0];
  if (!account?.localId || account.disabled) throw new Error("UNAUTHENTICATED");
  return account.localId;
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
async function encryptJson(payload, base64Key) {
  const keyBytes = base64ToBytes(base64Key.trim());
  if (keyBytes.byteLength !== 32) throw new Error("INVALID_ENCRYPTION_KEY");
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(JSON.stringify(payload)));
  return { ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)), iv: bytesToBase64Url(iv) };
}
var stringValue = (value) => ({ stringValue: value });
var integerValue = (value) => ({ integerValue: String(Math.trunc(value)) });
var timestampValue = (value) => ({ timestampValue: value });
var booleanValue = (value) => ({ booleanValue: value });
var stringArrayValue = (values) => ({ arrayValue: { values: values.map(stringValue) } });
function fieldString(document, name) {
  return document?.fields?.[name]?.stringValue || "";
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
  if (parsed.provider !== "shopify" || !parsed.uid || parsed.workspaceId !== `personal_${parsed.uid}` || normalizeShopDomain(parsed.shop) !== parsed.shop || !parsed.nonce || !Number.isFinite(parsed.issuedAt) || !Number.isFinite(parsed.expiresAt) || parsed.issuedAt > Date.now() + 6e4 || parsed.expiresAt < Date.now() || parsed.expiresAt - parsed.issuedAt > 10 * 60 * 1e3) throw new Error("INVALID_STATE");
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
    if (workspaceId !== `personal_${uid}`) return res.status(403).json({ ok: false, error: "You do not have access to this workspace" });
    const { projectId, accessToken } = await googleAccessToken();
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
    if (workspaceId !== `personal_${uid}`) return res.status(403).json({ ok: false, error: "You do not have access to this workspace" });
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
  if (parsed.provider !== "lazada" || !parsed.uid || parsed.workspaceId !== `personal_${parsed.uid}` || !/^[A-Za-z0-9_-]{8,128}$/.test(parsed.agentId) || !parsed.nonce || !Number.isFinite(parsed.issuedAt) || !Number.isFinite(parsed.expiresAt) || parsed.issuedAt > Date.now() + 6e4 || parsed.expiresAt < Date.now() || parsed.expiresAt - parsed.issuedAt > 10 * 60 * 1e3) throw new Error("INVALID_STATE");
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
    if (workspaceId !== `personal_${uid}`) return res.status(403).json({ ok: false, error: "You do not have access to this workspace" });
    const { projectId, accessToken } = await googleAccessToken();
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
    if (workspaceId !== `personal_${uid}`) return res.status(403).json({ ok: false, error: "You do not have access to this workspace" });
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(agentId)) return res.status(400).json({ ok: false, error: "Choose a Lazada-ready ORIN AI first" });
    const { projectId, accessToken } = await googleAccessToken();
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
  if (parsed.provider !== "shopee" || !parsed.uid || parsed.workspaceId !== `personal_${parsed.uid}` || !/^[A-Za-z0-9_-]{8,128}$/.test(parsed.agentId) || !parsed.nonce || !Number.isFinite(parsed.issuedAt) || !Number.isFinite(parsed.expiresAt) || parsed.issuedAt > Date.now() + 6e4 || parsed.expiresAt < Date.now() || parsed.expiresAt - parsed.issuedAt > 10 * 60 * 1e3) throw new Error("INVALID_STATE");
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
    if (workspaceId !== `personal_${uid}`) return res.status(403).json({ ok: false, error: "You do not have access to this workspace" });
    const { projectId, accessToken } = await googleAccessToken();
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
    if (workspaceId !== `personal_${uid}`) return res.status(403).json({ ok: false, error: "You do not have access to this workspace" });
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(agentId)) return res.status(400).json({ ok: false, error: "Choose a Shopee-ready ORIN AI first" });
    const { projectId, accessToken } = await googleAccessToken();
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
  const currencyValues = /* @__PURE__ */ new Map();
  attributedEvents.forEach((event) => {
    const currency = /^[A-Z]{3}$/.test(event.currency) ? event.currency : "PHP";
    currencyValues.set(currency, roundMoney((currencyValues.get(currency) || 0) + event.value));
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
      aiHandledRate: conversations.size ? Math.round(aiHandled.size / conversations.size * 100) : 0,
      escalationRate: conversations.size ? Math.round(escalated.size / conversations.size * 100) : 0,
      medianFirstResponseMs: median(firstResponses),
      p90FirstResponseMs: percentile(firstResponses, 0.9),
      automationFailures: events.filter((event) => event.type === "automation.failed").length,
      events: events.length
    },
    channels: [...channels.entries()].map(([name, count]) => ({ name, count })).sort((left, right) => right.count - left.count || left.name.localeCompare(right.name)),
    currencies: [...currencyValues.entries()].map(([code, value]) => ({ code, value })).sort((left, right) => right.value - left.value || left.code.localeCompare(right.code))
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
function fieldTimestamp(document, name) {
  const value = document.fields?.[name]?.timestampValue || "";
  return Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : "";
}
function eventId(document) {
  return document.name?.split("/").pop() || "";
}
function toAnalyticsEvent(document) {
  const occurredAt = fieldTimestamp(document, "occurredAt");
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

// server/shopify-dispatch.ts
function queryValue8(value) {
  return Array.isArray(value) ? value[0] || "" : value || "";
}
async function handler11(req, res) {
  const action = queryValue8(req.query?.action);
  const provider = queryValue8(req.query?.provider);
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
