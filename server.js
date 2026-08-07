const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { getStore } = require("./db/store");
const auth = require("./auth/google");
const pin = require("./auth/pin");

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const DATA = path.join(ROOT, "data");
const SHIPMENTS_FILE = path.join(DATA, "shipments.json");
const UPDATES_FILE = path.join(DATA, "updates.json");
const PORT = Number(process.env.PORT || 4332);

// Defined up here (above handleApi) so request-time code can reference it safely
// for identity/host decisions. HOST (below, by listen) reuses the same value.
const IS_DEPLOYED = Boolean(process.env.HOST || auth.isEnabled() || process.env.DATABASE_URL || process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === "production");

const store = getStore();

// --- In-memory rate limiting (per client IP) --------------------------------
// Global sliding window: max RATE_MAX requests per RATE_WINDOW_MS. Plus a much
// stricter counter for FAILED Basic-Auth attempts so the shared password can't
// be brute-forced. Both maps are bounded so they can't leak memory themselves.
const RATE_WINDOW_MS = 10_000;
const RATE_MAX = 100;
const AUTHFAIL_WINDOW_MS = 60_000;
const AUTHFAIL_MAX = 10;
const RATE_MAP_MAX_KEYS = 20_000;
const rateMap = new Map();      // ip -> number[] (request timestamps)
const authFailMap = new Map();  // ip -> number[] (failed-auth timestamps)

function clientIp(req) {
  // Honor the first hop of x-forwarded-for (Railway's proxy), else the socket.
  const xff = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xff || (req.socket && req.socket.remoteAddress) || "unknown";
}

function slidingHit(map, ip, windowMs, max) {
  const now = Date.now();
  if (!map.has(ip) && map.size >= RATE_MAP_MAX_KEYS) {
    // Evict entries with no recent activity; if still full, drop the oldest key.
    for (const [k, v] of map) {
      if (!v.length || v[v.length - 1] <= now - windowMs) map.delete(k);
    }
    if (map.size >= RATE_MAP_MAX_KEYS) {
      const first = map.keys().next().value;
      if (first !== undefined) map.delete(first);
    }
  }
  let arr = map.get(ip);
  if (!arr) { arr = []; map.set(ip, arr); }
  while (arr.length && arr[0] <= now - windowMs) arr.shift();
  if (arr.length >= max) return true;   // blocked (do not record another hit)
  arr.push(now);
  return false;
}

function rateLimited(ip) { return slidingHit(rateMap, ip, RATE_WINDOW_MS, RATE_MAX); }
function authFailBlocked(ip) {
  const now = Date.now();
  const arr = authFailMap.get(ip);
  if (!arr) return false;
  while (arr.length && arr[0] <= now - AUTHFAIL_WINDOW_MS) arr.shift();
  return arr.length >= AUTHFAIL_MAX;
}
function recordAuthFail(ip) { slidingHit(authFailMap, ip, AUTHFAIL_WINDOW_MS, AUTHFAIL_MAX + 1); }

function tooManyRequests(res, retryAfterSec) {
  res.writeHead(429, {
    "Content-Type": "application/json; charset=utf-8",
    "Retry-After": String(retryAfterSec),
    ...securityHeaders(),
  });
  res.end(JSON.stringify({ error: "Too many requests" }));
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
};

const STAGE_ORDER = ["mm", "predispatch", "intransit", "reached", "qc", "completed", "rejected"];
const STAGE_LABELS = {
  mm: "Match Making",
  predispatch: "Pre-Dispatch",
  intransit: "In-Transit",
  reached: "Vehicle Reached",
  qc: "Quality Check",
  completed: "Completed",
  rejected: "Rejected",
};
const DOC_LABELS = {
  buyerPO: "Buyer PO",
  vehImages: "Vehicle Images",
  lrCopy: "LR Copy",
  weighslip: "Weighslip",
  invoice: "Seller Invoice",
  ewaybill: "E-way Bill",
  tracking: "Tracking",
  pod: "POD",
  podDoc: "POD Doc",
  qcReport: "QC Report",
  dn: "Debit Note",
  paymentAdvice: "Payment Advice",
  utr: "UTR",
};

const STATE_COORDS = {
  "telangana": [55, 62],
  "andhra pradesh": [59, 69],
  "tamil nadu": [55, 81],
  "kerala": [47, 82],
  "karnataka": [47, 72],
  "maharashtra": [41, 57],
  "gujarat": [25, 48],
  "west bengal": [78, 47],
  "odisha": [70, 56],
  "rajasthan": [32, 36],
  "delhi": [42, 26],
  "uttar pradesh": [52, 34],
  "haryana": [40, 28],
  "punjab": [36, 22],
  "madhya pradesh": [48, 48],
  "chhattisgarh": [60, 52],
  "jharkhand": [69, 47],
  "bihar": [66, 39],
};

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(raw);
  } catch (error) {
    console.error(`Could not read ${file}:`, error);
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function toNumber(value) {
  if (value === null || value === undefined) return 0;
  const n = Number(String(value).replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function asDate(value) {
  if (!value || String(value).toLowerCase() === "na") return null;
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return new Date(s.slice(0, 10) + "T00:00:00Z");
  const m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m) return new Date(`${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}T00:00:00Z`);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function daysSince(value) {
  const d = asDate(value);
  if (!d) return null;
  const now = new Date();
  return Math.max(0, Math.floor((now - d) / 86400000));
}

function normalizeDoc(value) {
  const s = String(value || "").trim().toLowerCase();
  if (["yes", "ok", "uploaded", "verified", "done", "available"].includes(s)) return "ok";
  if (["na", "n/a", "not applicable"].includes(s)) return "na";
  if (["pending", "wip"].includes(s)) return "pending";
  if (!s || ["no", "missing", "not uploaded"].includes(s)) return "missing";
  return s;
}

function paymentDerived(row) {
  const balance = toNumber(row.balance);
  const netPayable = toNumber(row.netPayable || row.total);
  const paid = toNumber(row.paidAmount);
  if (balance <= 1 && paid > 0) return "paid";
  if (paid > 0 && balance > 1) return "partial";
  if (netPayable > 0 && paid <= 0) return "pending";
  return "unknown";
}

// Short in-memory cache so loadState() doesn't recompute every shipment on every
// /api/* hit (DoS amplification). Invalidated immediately after any write so a
// writer always observes its own change on the next read.
let _stateCache = null;
let _stateCacheAt = 0;
const STATE_TTL_MS = 2000;
function invalidateState() { _stateCache = null; _stateCacheAt = 0; }

async function loadState() {
  const now = Date.now();
  if (_stateCache && now - _stateCacheAt < STATE_TTL_MS) return _stateCache;
  const result = await computeState();
  _stateCache = result;
  _stateCacheAt = Date.now();
  return result;
}

async function computeState() {
  const source = { shipments: await store.getShipments() };
  const updates = { updates: await store.getUpdates() };
  const updateMap = new Map();
  for (const event of updates.updates || []) {
    const list = updateMap.get(event.shipmentId) || [];
    list.push(event);
    updateMap.set(event.shipmentId, list);
  }
  const shipments = (source.shipments || []).map((row) => {
    const events = (updateMap.get(row.shipmentId) || []).sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
    const openFollowUps = events.filter((event) => event.type === "followup" && event.status !== "done" && event.dueDate);
    const latestFollowUp = openFollowUps.length ? openFollowUps[openFollowUps.length - 1] : null;
    let merged = { ...row, docs: { ...(row.docs || {}) } };
    for (const event of events) {
      if (event.type === "stage") {
        merged.funnel = event.value;
        if (event.value === "completed" || event.value === "rejected") merged.blockReason = "";
      }
      if (event.type === "doc") merged.docs[event.key] = event.value;
      if (event.type === "note") merged.remarks = event.value;
      if (event.type === "owner") merged.controlPoc = event.value;
      if (event.reason) merged.blockReason = event.reason;
    }
    const docs = {
      buyerPO: normalizeDoc(merged.docs.buyerPO),
      vehImages: normalizeDoc(merged.docs.vehImages),
      lrCopy: normalizeDoc(merged.docs.lrCopy),
      weighslip: normalizeDoc(merged.docs.weighslip),
      invoice: normalizeDoc(merged.docs.invoice),
      ewaybill: normalizeDoc(merged.docs.ewaybill),
      tracking: normalizeDoc(merged.docs.tracking),
      pod: normalizeDoc(merged.docs.pod),
      podDoc: normalizeDoc(merged.docs.podDoc),
      qcReport: normalizeDoc(merged.docs.qcReport),
      dn: normalizeDoc(merged.docs.dn),
      paymentAdvice: normalizeDoc(merged.docs.paymentAdvice),
      utr: normalizeDoc(merged.docs.utr),
    };
    const paymentStatus = paymentDerived(merged);
    const paidProofPending = paymentStatus === "paid" && docs.utr !== "ok" && docs.paymentAdvice !== "ok";
    let required = requiredDocsForStage(merged.funnel);
    if ((merged.funnel === "completed" || paymentStatus === "paid") && merged.funnel !== "qc") required = [];
    const missingDocs = required.filter((key) => !["ok", "na"].includes(docs[key]));
    const docStats = (() => {
      const c = { ok: 0, pending: 0, missing: 0, na: 0 };
      for (const key of required) {
        const v = docs[key] || "missing";
        c[v] = (c[v] || 0) + 1;
      }
      const verified = c.ok + c.na;
      return {
        required: required.length,
        verified,
        ok: c.ok,
        pending: c.pending,
        missing: c.missing,
        na: c.na,
        pct: required.length ? Math.round((verified / required.length) * 100) : 100,
      };
    })();
    const dispatchAge = daysSince(merged.dispatchDate);
    const stageAge = dispatchAge;
    const owner = String(merged.controlPoc || merged.srPoc || merged.brPoc || "Unassigned").trim();
    const pr = paymentRisk(merged, paymentStatus);
    const todayStr = new Date().toISOString().slice(0, 10);
    const dueSoon = !!(latestFollowUp && latestFollowUp.dueDate && latestFollowUp.dueDate <= todayStr);
    const cause = deriveCause({ funnel: merged.funnel, blockReason: merged.blockReason, controlPoc: merged.controlPoc, paidProofPending, paymentRisk: pr, missingDocs, dueSoon });
    return {
      ...merged,
      docs,
      owner,
      stageLabel: STAGE_LABELS[merged.funnel] || merged.stageRaw || "Unknown",
      requiredDocs: required,
      missingDocs,
      docStats,
      paymentDerived: paymentStatus,
      paidProofPending,
      blockReason: merged.blockReason || "",
      cause,
      paymentRisk: pr,
      dispatchAge,
      stageAge,
      timelineCount: events.length,
      followUp: latestFollowUp,
      route: deriveRoute(merged),
    };
  });
  return { source, updates, shipments };
}

// Why is a shipment still pending? A logged reason wins; otherwise derive the
// primary cause from its state so the pipeline can be explained even with no note.
function deriveCause(o) {
  if (o.funnel === "completed" || o.funnel === "rejected") return null;
  if (o.blockReason) return o.blockReason;
  if (!o.controlPoc) return "owner_missing";
  if (o.paidProofPending) return "payment_done_upload_pending";
  if (o.paymentRisk === "overdue") return "payment_overdue";
  if (o.missingDocs && o.missingDocs.length) return "docs_pending";
  if (o.funnel === "qc") return "qc_dn_pending";
  if (["partial", "pending"].includes(o.paymentRisk)) return "payment_pending";
  if (o.dueSoon) return "followup_due";
  return "in_progress";
}

function requiredDocsForStage(stage) {
  const gates = {
    mm: ["buyerPO"],
    predispatch: ["buyerPO", "vehImages", "lrCopy", "weighslip", "invoice", "ewaybill"],
    intransit: ["buyerPO", "vehImages", "weighslip", "invoice", "ewaybill", "tracking"],
    reached: ["buyerPO", "invoice", "ewaybill", "pod", "podDoc"],
    qc: ["buyerPO", "invoice", "ewaybill", "pod", "qcReport", "dn"],
    completed: ["buyerPO", "invoice", "ewaybill", "pod", "qcReport", "paymentAdvice", "utr"],
    rejected: [],
  };
  return gates[stage] || gates.mm;
}

function paymentRisk(row, status) {
  if (status === "paid") return "clear";
  const balance = toNumber(row.balance);
  const due = daysSince(row.dueDate);
  if (balance <= 1) return "clear";
  if (due !== null && due > 7) return "overdue";
  if (status === "partial") return "partial";
  return "pending";
}

function deriveRoute(row) {
  const text = [
    row.seller,
    row.buyer,
    row.remarks,
    row.stageRaw,
    row.vertical,
    row.material,
  ].join(" ").toLowerCase();
  let from = null;
  let to = null;
  for (const state of Object.keys(STATE_COORDS)) {
    if (text.includes(state)) {
      if (!from) from = state;
      else if (!to && state !== from) to = state;
    }
  }
  if (!from) {
    if (row.vertical === "Plastic") from = "telangana";
    else from = "west bengal";
  }
  if (!to) {
    if (String(row.buyer || "").toLowerCase().includes("national fibres")) to = "gujarat";
    else if (row.vertical === "Plastic") to = "gujarat";
    else to = "telangana";
  }
  return {
    from,
    to,
    fromPoint: STATE_COORDS[from] || [50, 60],
    toPoint: STATE_COORDS[to] || [55, 62],
  };
}

function buildSummary(shipments) {
  const byStage = {};
  for (const key of STAGE_ORDER) byStage[key] = 0;
  let gmv = 0, pending = 0, paid = 0, disputes = 0, needsAction = 0, proofPending = 0;
  const routes = {};
  for (const s of shipments) {
    byStage[s.funnel] = (byStage[s.funnel] || 0) + 1;
    gmv += toNumber(s.total || s.materialValue);
    pending += Math.max(0, toNumber(s.balance));
    paid += Math.max(0, toNumber(s.paidAmount));
    if (toNumber(s.debitNote) > 1 || s.funnel === "qc") disputes += 1;
    if (s.missingDocs.length || ["overdue", "pending", "partial"].includes(s.paymentRisk) || !s.controlPoc) needsAction += 1;
    if (s.paidProofPending) proofPending += 1;
    const key = `${s.route.from}|${s.route.to}`;
    routes[key] = routes[key] || { ...s.route, count: 0, gmv: 0 };
    routes[key].count += 1;
    routes[key].gmv += toNumber(s.total || s.materialValue);
  }
  return {
    total: shipments.length,
    gmv,
    pending,
    paid,
    disputes,
    needsAction,
    proofPending,
    byStage,
    routes: Object.values(routes).sort((a, b) => b.count - a.count).slice(0, 18),
  };
}

function splitNames(value) {
  return String(value || "")
    .split(/[,&/]|\band\b/i)
    .map((x) => x.trim())
    .filter(Boolean);
}

// The source xlsx spells several POCs more than one way ("Jithu" / "Jithender
// Chitakodur"). Each spelling used to become a separate user with its own
// shipment scope, so a person mapped to one spelling could not see or edit the
// shipments filed under the other. Collapse variants onto one canonical name.
// Keys are lowercase raw spellings; values are the canonical display name.
const NAME_ALIASES = {
  "jithu": "Jithender Chitakodur",
  "jithender": "Jithender Chitakodur",
  "jithender chitakodur": "Jithender Chitakodur",
  "meghraj": "Megharaj B",
  "megharaj": "Megharaj B",
  "megharaj b": "Megharaj B",
  "bharat": "Bharath Kumar",
  "bharath": "Bharath Kumar",
  "bharath kumar": "Bharath Kumar",
  "aishwarya": "Aishwarya Laxmi Karanam",
  "aishwarya laxmi karanam": "Aishwarya Laxmi Karanam",
  "aravind": "Aravind Jakkula",
  "aravind jakkula": "Aravind Jakkula",
  "divya": "Divya Boppuri",
  "divya boppuri": "Divya Boppuri",
  "rajeshwari": "Rajeshwari Sunnapu",
  "rajeshwari sunnapu": "Rajeshwari Sunnapu",
  // Not in the login roster, but the same person split across spellings — merged
  // so admin views and ownership counts are honest.
  "arijit": "Arijit Dutta",
  "arjit": "Arijit Dutta",
  "arijit dutt": "Arijit Dutta",
  "arijit dutta": "Arijit Dutta",
  "atharv patil": "Atharva Sudhir Patil",
  "atharva patil": "Atharva Sudhir Patil",
  "atharva sudhir patil": "Atharva Sudhir Patil",
  "ashish": "Ashish Kumar Rai",
  "ashish kumar rai": "Ashish Kumar Rai",
  "adarsh": "Adarsh Krishnan",
  "adarsh krishnan": "Adarsh Krishnan",
  "arghyadeep": "Arghyadeep Samanta",
  "arghyadeep samanta": "Arghyadeep Samanta",
};

function canonicalName(value) {
  const raw = String(value || "").trim().replace(/\s+/g, " ");
  return NAME_ALIASES[raw.toLowerCase()] || raw;
}

// Identity key for a POC name. Aliasing lives here so every consumer —
// makeEmail (user identity), shipmentNames + scopeShipments + canEditShipment
// (ownership) — agrees on who a name belongs to.
function nameKey(value) {
  return canonicalName(value).toLowerCase();
}

function makeEmail(name) {
  return nameKey(name).replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "") + "@local.associate";
}

function buildUsers(shipments) {
  const users = [{ name: "Local Admin", email: "local@recykal.test", role: "admin", scope: "all" }];
  const seen = new Set(users.map((u) => u.email));
  for (const s of shipments) {
    for (const raw of [...splitNames(s.controlPoc), ...splitNames(s.srPoc), ...splitNames(s.brPoc)]) {
      if (!raw) continue;
      // Display the canonical name so a person appears once, under one spelling.
      const name = canonicalName(raw);
      const email = makeEmail(name);
      if (seen.has(email)) continue;
      users.push({ name, email, role: "associate", scope: "own" });
      seen.add(email);
    }
  }
  return users.sort((a, b) => (a.role === "admin" ? -1 : b.role === "admin" ? 1 : a.name.localeCompare(b.name)));
}

function authUserMap() {
  // Optional mapping of real Google emails to an internal user email/POC scope.
  // e.g. AUTH_USERS='{"ashwin.singh@recykal.com":"aishwarya@local.associate"}'
  // Keys are normalised to lowercase: Google emails arrive lowercased, but the
  // configured roster is hand-written and often is not (e.g. Invoicing20@...).
  // A case mismatch would silently drop that person to a no-scope guest.
  try {
    const raw = JSON.parse(process.env.AUTH_USERS || "{}");
    const out = {};
    for (const [k, v] of Object.entries(raw)) out[String(k).trim().toLowerCase()] = String(v).trim().toLowerCase();
    return out;
  } catch (e) {
    return {};
  }
}

// Real Google emails that get admin (see + edit everything). Comma-separated.
// Kept separate from AUTH_USERS so each admin keeps their own identity in the
// audit trail instead of every admin writing as "local@recykal.test".
function adminEmails() {
  return String(process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

// Is this signed-in Google account on the roster at all? Used to keep the app
// shell closed to strangers once the shared APP_PASSWORD gate is removed.
function isAuthorizedIdentity(identity) {
  const email = String((identity && identity.email) || "").toLowerCase();
  if (!email) return false;
  return adminEmails().includes(email) || Object.prototype.hasOwnProperty.call(authUserMap(), email);
}

/* ------------------------------- PIN factor ------------------------------- */
// Sessions live 7 days, so "did this session pass the PIN gate" cannot be a
// simple boolean: an admin who clears or resets somebody's PIN expects that
// person to be out NOW — that is the whole point of admin-controlled PINs, and
// it is the only instant off-switch for offboarding (removing them from
// AUTH_USERS otherwise needs a redeploy). So the session's pinAt is compared
// against when the PIN was last written: an older session no longer counts.
//
// A short cache keeps this off the database on every single API call. Writes
// invalidate it immediately, so a reset takes effect on the next request.
const PIN_META_TTL_MS = 5_000;
const pinMetaCache = new Map(); // email -> { updatedAt: number|null, at: number }

function invalidatePinMeta(email) {
  pinMetaCache.delete(String(email || "").toLowerCase());
}

async function pinUpdatedAt(email) {
  const key = String(email || "").toLowerCase();
  const hit = pinMetaCache.get(key);
  if (hit && Date.now() - hit.at < PIN_META_TTL_MS) return hit.updatedAt;
  const record = await store.getPin(key);
  const updatedAt = record && record.updatedAt ? Date.parse(record.updatedAt) : null;
  if (pinMetaCache.size > 1000) pinMetaCache.clear();
  pinMetaCache.set(key, { updatedAt: Number.isFinite(updatedAt) ? updatedAt : null, at: Date.now() });
  return pinMetaCache.get(key).updatedAt;
}

// Has this session cleared the PIN gate, and is that still valid?
async function pinSatisfied(identity) {
  if (!identity || !identity.pinAt) return false;
  const email = String(identity.email).toLowerCase();
  const updatedAt = await pinUpdatedAt(email);
  if (updatedAt === null) {
    // No PIN on record. Either an admin just cleared it — in which case this
    // session must die — or this is the bootstrap admin who never had a row.
    return Boolean(process.env.BOOTSTRAP_ADMIN_PIN) && adminEmails().includes(email);
  }
  // Issued or re-issued after this session passed the gate → ask again.
  return identity.pinAt >= updatedAt;
}

// Look up the stored PIN hash, falling back to BOOTSTRAP_ADMIN_PIN for an admin
// who has no PIN row yet. That bootstrap exists solely so the first admin can
// sign in and issue everyone else's PIN; remove the env var once that is done.
async function pinRecordFor(email) {
  const lower = String(email || "").toLowerCase();
  const stored = await store.getPin(lower);
  if (stored) return { record: stored, bootstrap: false };
  const boot = process.env.BOOTSTRAP_ADMIN_PIN;
  if (boot && adminEmails().includes(lower) && pin.isValidPinFormat(boot)) {
    return { record: await pin.hashPin(boot), bootstrap: true };
  }
  return { record: null, bootstrap: false };
}

// PIN submission. The Google session is already verified here, so the acting
// email comes from the cookie and is never taken from the body.
async function handlePinSubmit(req, res) {
  const identity = auth.getIdentity(req);
  if (!identity || !isAuthorizedIdentity(identity)) return sendJson(res, { error: "Not authorized" }, 403);
  const email = String(identity.email).toLowerCase();
  if (pin.isLockedOut(email)) {
    return sendJson(res, { error: "Too many incorrect PINs. Try again later." }, 429);
  }
  let payload;
  try {
    payload = await readBody(req);
  } catch (e) {
    return sendJson(res, { error: "Invalid request" }, 400);
  }
  const supplied = String(payload.pin || "");
  const { record } = await pinRecordFor(email);
  // Same generic message whether no PIN was ever issued or the PIN is wrong —
  // never reveal which accounts have a PIN set.
  const ok = record ? await pin.verifyPin(supplied, record) : false;
  if (!ok) {
    pin.recordFailure(email);
    return sendJson(res, { error: "Incorrect PIN", attemptsLeft: pin.attemptsLeft(email) }, 401);
  }
  pin.clearFailures(email);
  auth.updateSession(req, res, { pinAt: Date.now() });
  return sendJson(res, { ok: true });
}

function resolveUser(req, url, shipments) {
  const users = buildUsers(shipments);
  if (auth.isEnabled()) {
    // OAuth mode: identity comes from the signed session cookie; ?user= is ignored.
    const identity = auth.getIdentity(req);
    if (!identity) return { name: "Guest", email: "guest", role: "guest", scope: "none" };
    const email = String(identity.email || "").toLowerCase();
    // Admins keep their real identity (name + email) so audit rows name the
    // actual person, but get admin role/scope.
    if (adminEmails().includes(email)) {
      return { name: identity.name || email, email, role: "admin", scope: "all" };
    }
    const mapped = authUserMap()[email];
    let match = null;
    if (mapped) match = users.find((u) => u.email.toLowerCase() === String(mapped).toLowerCase());
    if (!match) match = users.find((u) => u.email.toLowerCase() === email);
    if (match) return match;
    // Known-good Google login but not a recognised POC → flagged guest, no shipments.
    return { name: identity.name || identity.email, email, role: "guest", scope: "none" };
  }
  // Dev mode (no OAuth env): ?user=<email> selects a KNOWN user only.
  // Default is the local admin (dev convenience, and the server now binds to
  // 127.0.0.1 so this is not network-reachable). An unknown user must NOT
  // fall back to admin — it becomes a no-scope guest.
  const requested = url.searchParams.get("user") || "local@recykal.test";
  const found = users.find((u) => u.email === requested);
  if (found) return found;
  return { name: "Guest", email: "guest", role: "guest", scope: "none" };
}

function shipmentNames(shipment) {
  return [...splitNames(shipment.controlPoc), ...splitNames(shipment.srPoc), ...splitNames(shipment.brPoc)].map(nameKey);
}

function scopeShipments(shipments, user) {
  if (!user || user.role === "admin") return shipments;
  const key = nameKey(user.name);
  return shipments.filter((s) => shipmentNames(s).includes(key));
}

// Read model: an associate can SEE all shipments; EDIT only the ones assigned to
// them (their name is a Control/SR/BR POC). Admin edits all; guest edits nothing.
function canEditShipment(shipment, user) {
  if (!user || user.role === "guest") return false;
  if (user.role === "admin") return true;
  return shipmentNames(shipment).includes(nameKey(user.name));
}
// Optional shared-password gate for deployed instances. When APP_PASSWORD is set
// (e.g. on Railway) every request needs HTTP Basic Auth. In local dev it is unset,
// so there is no gate and the server is bound to 127.0.0.1 anyway.
function checkBasicAuth(req, res) {
  const pass = process.env.APP_PASSWORD;
  if (!pass) return true;
  const hdr = String(req.headers.authorization || "");
  const m = hdr.match(/^Basic (.+)$/);
  if (m) {
    let supplied = "";
    try {
      const decoded = Buffer.from(m[1], "base64").toString("utf8");
      const idx = decoded.indexOf(":");
      supplied = idx >= 0 ? decoded.slice(idx + 1) : decoded;
    } catch (e) { supplied = ""; }
    const a = Buffer.from(supplied), b = Buffer.from(pass);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  res.writeHead(401, { "WWW-Authenticate": 'Basic realm="OMP Shipment Tracker", charset="UTF-8"', "Content-Type": "text/plain; charset=utf-8", ...securityHeaders() });
  res.end("Authentication required");
  return false;
}

function securityHeaders() {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  };
}

// Allowlists + length limits for update events (never trust client shape).
const UPDATE_TYPES = new Set(["stage", "doc", "note", "owner", "followup"]);
const DOC_VALUES = new Set(["missing", "pending", "ok", "na"]);
const clampStr = (v, n) => String(v === null || v === undefined ? "" : v).slice(0, n);
function validateUpdate(p) {
  const type = String(p.type || "note");
  if (!UPDATE_TYPES.has(type)) return { error: "invalid type" };
  const out = { type, value: "", key: "", note: clampStr(p.note, 1000), dueDate: "", status: "open", reason: "" };
  if (type === "stage") {
    if (!STAGE_ORDER.includes(p.value)) return { error: "invalid stage" };
    out.value = p.value; out.reason = clampStr(p.reason, 60);
  } else if (type === "doc") {
    if (!Object.prototype.hasOwnProperty.call(DOC_LABELS, p.key)) return { error: "invalid doc key" };
    if (!DOC_VALUES.has(p.value)) return { error: "invalid doc value" };
    out.key = p.key; out.value = p.value;
  } else if (type === "owner") {
    out.value = clampStr(p.value, 120);
  } else if (type === "note") {
    out.value = clampStr(p.value, 1000);
  } else if (type === "followup") {
    out.value = ["scheduled", "done"].includes(p.value) ? p.value : "scheduled";
    out.status = ["open", "done"].includes(p.status) ? p.status : "open";
    out.dueDate = /^\d{4}-\d{2}-\d{2}$/.test(String(p.dueDate || "")) ? p.dueDate : "";
    out.reason = clampStr(p.reason, 60);
  }
  return { value: out };
}

function sendJson(res, body, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache", ...securityHeaders() });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function createEvent(payload) {
  return {
    id: crypto.randomUUID(),
    shipmentId: String(payload.shipmentId || "").trim(),
    type: String(payload.type || "note"),
    key: payload.key || "",
    value: payload.value ?? "",
    note: payload.note || "",
    actor: payload.actor || "Local User",
    actorEmail: payload.actorEmail || "local@recykal.test",
    dueDate: payload.dueDate || "",
    status: payload.status || "open",
    reason: payload.reason || "",
    createdAt: new Date().toISOString(),
  };
}

async function handleApi(req, res, url) {
  // The PIN gate has to live here, not only on the HTML shell: a valid Google
  // session with no PIN could otherwise curl /api/bootstrap and pull all 130
  // shipments, which is exactly the compromised-account case the PIN exists to
  // stop. /api/me stays open so the frontend can tell WHY it is being blocked.
  if (auth.isEnabled()) {
    const identity = auth.getIdentity(req);
    const gated = identity && isAuthorizedIdentity(identity) && !(await pinSatisfied(identity));
    if (gated && url.pathname !== "/api/me") {
      return sendJson(res, { error: "PIN required", pinRequired: true }, 403);
    }
  }
  const state = await loadState();
  const users = buildUsers(state.shipments);
  const user = resolveUser(req, url, state.shipments);
  // Read model: admin + associates can READ every shipment; each is tagged with
  // canEdit (true only for the ones assigned to them). Guests get nothing.
  const canSeeAll = user.role === "admin" || user.role === "associate";
  const readable = (canSeeAll ? state.shipments : []).map((s) => ({ ...s, canEdit: canEditShipment(s, user) }));
  if (req.method === "GET" && url.pathname === "/api/me") {
    const identity = auth.isEnabled() ? auth.getIdentity(req) : null;
    return sendJson(res, {
      user,
      authMode: auth.isEnabled() ? "google" : "dev",
      authenticated: auth.isEnabled() ? Boolean(identity) : true,
      pinRequired: Boolean(identity && isAuthorizedIdentity(identity) && !(await pinSatisfied(identity))),
    });
  }
  if (req.method === "GET" && url.pathname === "/api/users") {
    if (auth.isEnabled() && user.role !== "admin") return sendJson(res, { error: "Forbidden" }, 403);
    return sendJson(res, { users });
  }
  // Admin-only PIN administration. Users cannot set or change their own PIN;
  // issuing and resetting is an admin action, so this is the one place PINs
  // are created. Reaching here already required clearing the PIN gate above,
  // so the endpoint that manages PINs is not itself a way around them.
  if (url.pathname === "/api/admin/pins") {
    if (!auth.isEnabled()) return sendJson(res, { error: "Not available in dev mode" }, 400);
    if (user.role !== "admin") return sendJson(res, { error: "Forbidden" }, 403);

    if (req.method === "GET") {
      // Who has a PIN issued — never any hash or PIN material.
      const issued = new Set(await store.listPinEmails());
      const roster = [
        ...adminEmails().map((email) => ({ email, role: "admin", internal: "" })),
        ...Object.entries(authUserMap()).map(([email, internal]) => ({ email, role: "associate", internal })),
      ];
      return sendJson(res, { roster: roster.map((r) => ({ ...r, hasPin: issued.has(r.email) })) });
    }

    if (req.method === "POST") {
      let payload;
      try {
        payload = await readBody(req);
      } catch (e) {
        return sendJson(res, { error: "Invalid request" }, 400);
      }
      const target = String(payload.email || "").trim().toLowerCase();
      // Only roster members get PINs — no issuing a PIN to an arbitrary address.
      if (!target || !isAuthorizedIdentity({ email: target })) {
        return sendJson(res, { error: "Not a roster member" }, 400);
      }
      if (payload.clear === true) {
        await store.clearPin(target);
        pin.clearFailures(target);
        // Their live session stops working on its next request, not in 7 days.
        invalidatePinMeta(target);
        return sendJson(res, { ok: true, cleared: true });
      }
      const value = String(payload.pin || "");
      if (!pin.isValidPinFormat(value)) {
        return sendJson(res, { error: `PIN must be ${pin.PIN_MIN}-${pin.PIN_MAX} digits` }, 400);
      }
      const record = await pin.hashPin(value);
      // updatedAt is the app clock so it is comparable with session pinAt; any
      // session that passed the gate before this moment must re-enter the PIN.
      await store.setPin(target, { ...record, setBy: user.email, updatedAt: new Date().toISOString() });
      pin.clearFailures(target); // a fresh PIN clears any standing lockout
      invalidatePinMeta(target);
      return sendJson(res, { ok: true });
    }
    return sendJson(res, { error: "Method not allowed" }, 405);
  }
  if (req.method === "GET" && url.pathname === "/api/bootstrap") {
    return sendJson(res, {
      summary: buildSummary(readable),
      shipments: readable,
      stages: STAGE_ORDER.map((key) => ({ key, label: STAGE_LABELS[key] })),
      docs: DOC_LABELS,
      user,
      users: (auth.isEnabled() && user.role !== "admin") ? [] : users,
    });
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/shipments/")) {
    const shipmentId = decodeURIComponent(url.pathname.split("/").pop());
    const shipment = readable.find((s) => s.shipmentId === shipmentId);
    const timeline = (state.updates.updates || []).filter((e) => e.shipmentId === shipmentId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (!shipment) return sendJson(res, { error: "Shipment not found or not visible" }, 404);
    return sendJson(res, { shipment, timeline });
  }
  if (req.method === "POST" && url.pathname === "/api/updates") {
    if (user.role === "guest") return sendJson(res, { error: "Not authorized" }, 403);
    let payload;
    try {
      payload = await readBody(req);
    } catch (e) {
      return sendJson(res, { error: "Invalid request" }, 400);
    }
    const shipmentId = String(payload.shipmentId || "").trim();
    if (!shipmentId) return sendJson(res, { error: "shipmentId required" }, 400);
    // Attribute the write server-side. Only trust the client-supplied actor to
    // pick the acting user in LOCAL dev (no OAuth, not deployed) — a pure
    // laptop convenience. When deployed or OAuth is on, ignore the body actor
    // and attribute the write to the server-resolved user.
    let actingUser = user;
    if (!auth.isEnabled() && !IS_DEPLOYED) {
      const byBody = users.find((u) => u.email === String(payload.actorEmail || "").toLowerCase());
      if (byBody) actingUser = byBody;
    }
    const target = state.shipments.find((s) => s.shipmentId === shipmentId);
    if (!target) return sendJson(res, { error: "Shipment not found" }, 404);
    if (!canEditShipment(target, actingUser)) return sendJson(res, { error: "You can only update shipments assigned to you" }, 403);
    const checked = validateUpdate(payload);
    if (checked.error) return sendJson(res, { error: checked.error }, 400);
    const event = createEvent({ ...checked.value, shipmentId, actor: actingUser.name, actorEmail: actingUser.email });
    await store.addUpdate(event);
    invalidateState(); // writer must observe its own change on the next read
    return sendJson(res, { ok: true, event });
  }
  return sendJson(res, { error: "Not found" }, 404);
}

function serveStatic(req, res, url) {
  let filePath = url.pathname === "/" ? path.join(PUBLIC, "index.html") : path.join(PUBLIC, decodeURIComponent(url.pathname));
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      return res.end("Not found");
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "no-cache", ...securityHeaders() });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const ip = clientIp(req);
  try {
    // Stricter brute-force gate on the shared Basic-Auth password: block early if
    // this IP has already piled up too many failed auths in the window.
    if (process.env.APP_PASSWORD && authFailBlocked(ip)) {
      return tooManyRequests(res, Math.ceil(AUTHFAIL_WINDOW_MS / 1000));
    }
    if (!checkBasicAuth(req, res)) {
      if (process.env.APP_PASSWORD) recordAuthFail(ip);
      return;
    }
    // Global per-IP sliding-window limiter (applied after auth) so an
    // authenticated (or dev) client can't flood the server.
    if (rateLimited(ip)) {
      return tooManyRequests(res, Math.ceil(RATE_WINDOW_MS / 1000));
    }
    if (req.method === "POST" && url.pathname === "/auth/pin") return await handlePinSubmit(req, res);
    if (url.pathname.startsWith("/auth/")) return await auth.handleAuth(req, res, url);
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    // In OAuth mode, gate the app shell behind login (dev mode is never gated).
    // A valid Google account that is not on the roster is turned away here too:
    // without this, once APP_PASSWORD is gone any Google user on the internet
    // could sign in and load the (empty) dashboard shell.
    const GATED_PAGES = ["/", "/index.html", "/admin-pins.html"];
    if (auth.isEnabled() && GATED_PAGES.includes(url.pathname)) {
      const identity = auth.getIdentity(req);
      if (!identity) {
        res.writeHead(302, { Location: "/login.html" });
        return res.end();
      }
      if (!isAuthorizedIdentity(identity)) {
        res.writeHead(302, { Location: "/login.html?error=denied" });
        return res.end();
      }
      // Signed in and on the roster, but the PIN is still outstanding — either
      // never entered on this session, or invalidated by an admin reset.
      if (!(await pinSatisfied(identity))) {
        res.writeHead(302, { Location: "/pin.html" });
        return res.end();
      }
      // PIN administration is admin-only at the page level too, so a non-admin
      // never even loads it (the API behind it enforces this independently).
      if (url.pathname === "/admin-pins.html" && !adminEmails().includes(String(identity.email).toLowerCase())) {
        res.writeHead(302, { Location: "/" });
        return res.end();
      }
    }
    return serveStatic(req, res, url);
  } catch (error) {
    // Log the real error server-side; never leak DB/column/parser internals.
    console.error(error);
    if (!res.headersSent) return sendJson(res, { error: "Server error" }, 500);
  }
});

// Bind to loopback for local dev so the app is laptop-only. Bind all interfaces
// only when actually deployed (Railway/prod, OAuth on, a DATABASE_URL, or HOST set).
// IS_DEPLOYED is defined near the top of the file.
const HOST = process.env.HOST || (IS_DEPLOYED ? "0.0.0.0" : "127.0.0.1");
server.listen(PORT, HOST, () => {
  const shown = HOST === "0.0.0.0" ? "0.0.0.0 (all interfaces)" : HOST;
  console.log(`OMP Shipment Tracker running at http://localhost:${PORT} (bound ${shown})`);
});







