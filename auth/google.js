/**
 * Signed-cookie sessions, mounted on the plain Node `http` server (no Express,
 * no dependencies).
 *
 * Sessions are minted by the email + PIN login in server.js (handleDirectLogin)
 * and carried in one HttpOnly, SameSite=Lax cookie holding {email, name, pinAt,
 * exp}, signed with HMAC-SHA256. Nothing is stored server-side, so there is no
 * session table to keep — revocation works by comparing the session's pinAt
 * against when that person's PIN was last written (see pinSatisfied()).
 *
 * Enabled only when SESSION_SECRET is set. Without it the app runs in local dev
 * mode, where identity comes from ?user=<email> and the server binds to
 * 127.0.0.1. server.js refuses to boot in that state if it looks deployed.
 *
 * Routes (handleAuth):
 *   GET /auth/logout  -> clear the session cookie
 *
 * Identity is exposed via getIdentity(req) -> { email, name, pinAt } | null.
 */
const crypto = require("crypto");

const SESSION_COOKIE = "omp_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const SESSION_SECRET = process.env.SESSION_SECRET || "";

// Can we mint and read signed sessions? This is what "is authentication on"
// means for this app.
function isEnabled() {
  return Boolean(SESSION_SECRET);
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
  // pinAt records when the PIN behind this session was accepted. It is compared
  // against when that PIN was last written, so an admin reset invalidates live
  // sessions instead of leaving them good for the rest of the 7 days.
  return { email: session.email, name: session.name || session.email, pinAt: session.pinAt || 0 };
}

/**
 * Start a session after a correct email + PIN.
 */
function issueSession(req, res, { email, name, pinAt }) {
  if (!isEnabled()) return false;
  const payload = {
    email: String(email).toLowerCase(),
    name: name || email,
    pinAt: pinAt || Date.now(),
    exp: Date.now() + SESSION_TTL_MS,
  };
  setCookie(res, SESSION_COOKIE, signSession(payload), { maxAgeMs: SESSION_TTL_MS, req });
  return true;
}

/* ----------------------------- route handler ----------------------------- */
async function handleAuth(req, res, url) {
  if (url.pathname === "/auth/logout") return handleLogout(req, res);
  res.writeHead(404, { "Content-Type": "text/plain" });
  return res.end("Not found");
}

function handleLogout(req, res) {
  clearCookie(res, SESSION_COOKIE);
  res.writeHead(302, { Location: "/login.html" });
  res.end();
}

module.exports = { isEnabled, handleAuth, getIdentity, issueSession };
