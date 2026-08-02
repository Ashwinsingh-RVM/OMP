/**
 * Zero-dependency Google OAuth 2.0 (auth-code flow) + signed-cookie sessions,
 * mounted on the existing Node `http` server (no Express).
 *
 * Enabled only when GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + SESSION_SECRET
 * are all set. When any is missing, isEnabled() is false and server.js keeps
 * the current dev behavior (?user=<email>) completely untouched.
 *
 * Routes (handled by handleAuth):
 *   GET /auth/google           -> redirect to Google consent screen
 *   GET /auth/google/callback  -> exchange code, verify id_token, set session
 *   GET /auth/logout           -> clear session cookie
 *
 * Session identity is exposed via getIdentity(req) -> { email, name } | null.
 */
const crypto = require("crypto");

const SESSION_COOKIE = "omp_session";
const STATE_COOKIE = "omp_oauth_state";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const CALLBACK_URL = process.env.GOOGLE_CALLBACK_URL || "";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

function isEnabled() {
  return Boolean(CLIENT_ID && CLIENT_SECRET && SESSION_SECRET);
}

/* ----------------------------- cookie helpers ----------------------------- */
function b64urlEncode(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return Buffer.from(str, "base64");
}
function hmac(data) {
  return b64urlEncode(crypto.createHmac("sha256", SESSION_SECRET).update(data).digest());
}
function timingSafeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function signSession(payload) {
  const body = b64urlEncode(JSON.stringify(payload));
  return `${body}.${hmac(body)}`;
}
function verifySession(token) {
  if (!token || token.indexOf(".") === -1) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  if (!timingSafeEqual(sig, hmac(body))) return null;
  try {
    const payload = JSON.parse(b64urlDecode(body).toString("utf8"));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function isSecureRequest(req) {
  if ((req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https") return true;
  return false;
}

function setCookie(res, name, value, { maxAgeMs, req, httpOnly = true } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "SameSite=Lax"];
  if (httpOnly) parts.push("HttpOnly");
  if (typeof maxAgeMs === "number") parts.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
  if (req && isSecureRequest(req)) parts.push("Secure");
  appendSetCookie(res, parts.join("; "));
}
function clearCookie(res, name) {
  appendSetCookie(res, `${name}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly`);
}
function appendSetCookie(res, cookie) {
  const existing = res.getHeader("Set-Cookie");
  if (!existing) res.setHeader("Set-Cookie", [cookie]);
  else res.setHeader("Set-Cookie", Array.isArray(existing) ? existing.concat(cookie) : [existing, cookie]);
}

/* ----------------------------- identity ----------------------------- */
function getIdentity(req) {
  if (!isEnabled()) return null;
  const cookies = parseCookies(req);
  const session = verifySession(cookies[SESSION_COOKIE]);
  if (!session || !session.email) return null;
  return { email: session.email, name: session.name || session.email };
}

function callbackUrlFor(req) {
  if (CALLBACK_URL) return CALLBACK_URL;
  const proto = isSecureRequest(req) ? "https" : "http";
  return `${proto}://${req.headers.host}/auth/google/callback`;
}

/* ----------------------------- route handler ----------------------------- */
async function handleAuth(req, res, url) {
  if (url.pathname === "/auth/google") return startLogin(req, res);
  if (url.pathname === "/auth/google/callback") return handleCallback(req, res, url);
  if (url.pathname === "/auth/logout") return handleLogout(req, res);
  res.writeHead(404, { "Content-Type": "text/plain" });
  return res.end("Not found");
}

function startLogin(req, res) {
  const state = b64urlEncode(crypto.randomBytes(16));
  setCookie(res, STATE_COOKIE, state, { maxAgeMs: 10 * 60 * 1000, req });
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: callbackUrlFor(req),
    response_type: "code",
    scope: "openid email profile",
    state,
    access_type: "online",
    prompt: "select_account",
  });
  res.writeHead(302, { Location: `${AUTH_ENDPOINT}?${params.toString()}` });
  res.end();
}

async function handleCallback(req, res, url) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookies = parseCookies(req);
  if (!code || !state || state !== cookies[STATE_COOKIE]) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    return res.end("Invalid OAuth state");
  }
  clearCookie(res, STATE_COOKIE);

  try {
    const tokenRes = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: callbackUrlFor(req),
        grant_type: "authorization_code",
      }),
    });
    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      throw new Error(`token exchange failed: ${tokenRes.status} ${text}`);
    }
    const tokens = await tokenRes.json();
    const claims = decodeIdToken(tokens.id_token);
    if (!claims) throw new Error("missing id_token");

    // The token exchange is a direct server-to-server TLS call to Google, so
    // decode + claim checks are sufficient (full RS256 JWKS verification is not
    // required for the auth-code flow).
    const validIss = ["accounts.google.com", "https://accounts.google.com"];
    if (claims.aud !== CLIENT_ID) throw new Error("aud mismatch");
    if (!validIss.includes(claims.iss)) throw new Error("iss mismatch");
    if (claims.exp && Date.now() / 1000 > claims.exp) throw new Error("id_token expired");
    if (claims.email_verified === false) throw new Error("email not verified");

    const email = String(claims.email || "").toLowerCase();
    const name = claims.name || email;
    const token = signSession({ email, name, exp: Date.now() + SESSION_TTL_MS });
    setCookie(res, SESSION_COOKIE, token, { maxAgeMs: SESSION_TTL_MS, req });
    res.writeHead(302, { Location: "/" });
    res.end();
  } catch (error) {
    console.error("[auth] callback error:", error);
    res.writeHead(302, { Location: "/login.html?error=auth" });
    res.end();
  }
}

function handleLogout(req, res) {
  clearCookie(res, SESSION_COOKIE);
  res.writeHead(302, { Location: "/login.html" });
  res.end();
}

function decodeIdToken(idToken) {
  if (!idToken) return null;
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(b64urlDecode(parts[1]).toString("utf8"));
  } catch (e) {
    return null;
  }
}

module.exports = { isEnabled, handleAuth, getIdentity };
