const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { getStore } = require("./db/store");
const auth = require("./auth/session");
const pin = require("./auth/pin");

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const DATA = path.join(ROOT, "data");
const SHIPMENTS_FILE = path.join(DATA, "shipments.json");
const UPDATES_FILE = path.join(DATA, "updates.json");
const PORT = Number(process.env.PORT || 4332);

// Sign-in is work email + PIN. Authentication is on whenever SESSION_SECRET is
// set; without it the app runs in local dev mode, where ?user= picks any
// identity and the default is admin with no cookie at all. That is safe on a
// laptop bound to 127.0.0.1 and catastrophic anywhere else, so the boot guard
// near server.listen refuses to start a deployed instance without the secret.
function authGateOn() {
  return auth.isEnabled();
}

// Defined up here (above handleApi) so request-time code can reference it safely
// for identity/host decisions. HOST (below, by listen) reuses the same value.
const IS_DEPLOYED = Boolean(process.env.HOST || authGateOn() || process.env.DATABASE_URL || process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === "production");

const store = getStore();
// The Activity tab (logins + who-updated-what across every shipment) is
// restricted to this one person specifically — not just any admin.
const ACTIVITY_OWNER_EMAIL = "ashwin.singh@recykal.com";

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
  // Cross-shipment POC contact log — so a different shipment for the same buyer/seller POC
  // shows the last time anyone contacted them, regardless of which shipment logged it.
  const rowById = new Map((source.shipments || []).map((r) => [r.shipmentId, r]));
  const pocContactMap = { buyer: new Map(), seller: new Map() };
  for (const event of updates.updates || []) {
    if (event.type !== "poc_contact") continue;
    const row = rowById.get(event.shipmentId);
    if (!row) continue;
    const side = event.key === "seller" ? "seller" : "buyer";
    const pocName = side === "seller" ? row.srPoc : row.brPoc;
    if (!pocName) continue;
    const key = nameKey(pocName);
    const list = pocContactMap[side].get(key) || [];
    list.push({ note: event.note || event.value, actor: event.actor, createdAt: event.createdAt, shipmentId: event.shipmentId });
    pocContactMap[side].set(key, list);
  }
  const shipments = (source.shipments || []).map((row) => {
    const events = (updateMap.get(row.shipmentId) || []).sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
    const openFollowUps = events.filter((event) => event.type === "followup" && event.status !== "done" && event.dueDate);
    const latestFollowUp = openFollowUps.length ? openFollowUps[openFollowUps.length - 1] : null;
    let merged = { ...row, docs: { ...(row.docs || {}) } };
    for (const event of events) {
      if (event.type === "stage") {
        // Only reset the aging clock when the stage genuinely changes — logging a
        // remark/reason with the dropdown left on the current stage (very common:
        // "why stuck" reason and stage-change share one event type) must NOT make
        // Stage Aging think the shipment just re-entered its current stage.
        if (event.value !== merged.funnel) merged.stageEnteredAt = event.createdAt;
        merged.funnel = event.value;
        if (event.value === "completed" || event.value === "rejected") merged.blockReason = "";
        if (event.value === "rejected" && event.reason) merged.rejectionReason = event.reason;
        if (event.reason) merged.blockReason = event.reason;
      }
      if (event.type === "doc") merged.docs[event.key] = event.value;
      if (event.type === "note") merged.remarks = event.value;
      if (event.type === "owner") {
        // key "payment" tracks a second, separate owner (who chases payment
        // on this shipment) alongside the operational owner (controlPoc) —
        // same event type, same value shape, just a parallel field.
        if (event.key === "payment") merged.paymentOwner = event.value;
        else merged.controlPoc = event.value;
      }
      if (event.type === "qty" && event.key === "invoiceQty") merged.invoiceQty = event.value;
      if (event.type === "qty" && event.key === "receivedQty") merged.receivedQty = event.value;
      if (event.type === "payment_detail" && event.key === "tds") merged.tds = event.value;
      if (event.type === "issue") merged.issueType = event.value;
      if (event.type === "invoice_detail") merged[event.key] = event.value;
      if (event.type === "detail") merged[event.key] = event.value;
      if (event.type === "margin" && event.key === "applies") merged.marginApplies = event.value;
      if (event.type === "margin" && event.key === "pctOverride") merged.marginPctOverride = event.value;
      if (event.type === "margin" && event.key === "invoiceStatus") merged.marginInvoiceStatus = event.value;
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
    const stageAge = daysSince(merged.stageEnteredAt || merged.dispatchDate);
    const invoiceQty = toNumber(merged.invoiceQty || merged.qtyKg);
    const receivedQty = merged.receivedQty !== undefined ? toNumber(merged.receivedQty) : null;
    const shortageQty = receivedQty !== null ? Math.max(0, invoiceQty - receivedQty) : null;
    const shortageStatus =
      shortageQty === null ? "not_received"
      : shortageQty <= 0 ? "clear"
      : shortageQty / (invoiceQty || 1) > 0.02 ? "shortage"
      : "minor_variance";
    // Owner is controlPoc only — srPoc/brPoc are the buyer's/seller's own external contacts,
    // never our internal txn team, never a fallback "owner".
    const owner = String(merged.controlPoc || "Unassigned").trim();
    const paymentOwner = String(merged.paymentOwner || "").trim();
    // Supplier margin: shipment-level override > standard 0.5% default. "No" locks it to 0.
    const marginApplies = merged.marginApplies || "pending";
    // `|| 0.5` would wrongly replace a genuine 0% override with the default
    // (0 is falsy) — check presence explicitly instead.
    const marginPct = marginApplies === "no" ? 0
      : merged.marginPctOverride !== undefined && merged.marginPctOverride !== "" ? toNumber(merged.marginPctOverride)
      : 0.5;
    const marginAmount = toNumber(merged.materialValue) * marginPct / 100;
    const buyerLog = (row.brPoc && pocContactMap.buyer.get(nameKey(row.brPoc))) || [];
    const sellerLog = (row.srPoc && pocContactMap.seller.get(nameKey(row.srPoc))) || [];
    const lastBuyerPocContact = buyerLog.length ? buyerLog[buyerLog.length - 1] : null;
    const lastSellerPocContact = sellerLog.length ? sellerLog[sellerLog.length - 1] : null;
    const pr = paymentRisk(merged, paymentStatus);
    const todayStr = new Date().toISOString().slice(0, 10);
    const dueSoon = !!(latestFollowUp && latestFollowUp.dueDate && latestFollowUp.dueDate <= todayStr);
    const cause = deriveCause({ funnel: merged.funnel, blockReason: merged.blockReason, issueType: merged.issueType, controlPoc: merged.controlPoc, paidProofPending, paymentRisk: pr, missingDocs, dueSoon });
    return {
      ...merged,
      docs,
      owner,
      paymentOwner,
      stageLabel: STAGE_LABELS[merged.funnel] || merged.stageRaw || "Unknown",
      requiredDocs: required,
      missingDocs,
      docStats,
      paymentDerived: paymentStatus,
      paidProofPending,
      blockReason: merged.blockReason || "",
      rejectionReason: merged.rejectionReason || "",
      cause,
      paymentRisk: pr,
      dispatchAge,
      stageAge,
      invoiceQty,
      receivedQty,
      shortageQty,
      shortageStatus,
      tds: merged.tds !== undefined ? toNumber(merged.tds) : null,
      issueType: merged.issueType || "",
      timelineCount: events.length,
      followUp: latestFollowUp,
      marginApplies,
      marginPct,
      marginAmount,
      marginInvoiceStatus: merged.marginInvoiceStatus || "not_raised",
      lastBuyerPocContact,
      lastSellerPocContact,
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
  if (o.issueType) return "issue_" + o.issueType;
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

// New shipment IDs: SH + YYMMDD + a 2-digit daily sequence, guaranteed unique
// against whatever's already in the book (existing legacy IDs follow their own
// scheme from the source sheet — this only has to not collide with them).
function generateShipmentId(existingIds) {
  const now = new Date();
  const stamp = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  for (let seq = 1; seq <= 99; seq++) {
    const id = `SH${stamp}${String(seq).padStart(2, "0")}`;
    if (!existingIds.has(id)) return id;
  }
  return `SH${stamp}${Date.now() % 1000}`;
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

// The real, currently-active txn team — only these 5 people have a work email +
// PIN and can actually sign in (see auth/roster.json AUTH_USERS). Every other
// controlPoc spelling seen in the historical seed data (Kalyan, Naveen, Megharaj B,
// Rajeshwari Sunnapu, Arijit Dutta, ...) is a past/inactive name: it still shows
// correctly as the owner on old shipments, but is NOT a selectable identity and
// NOT an auto-assign candidate — only real people who can act on a shipment today
// should ever be offered as one.
const ACTIVE_TXN_TEAM = new Set([
  "Bharath Kumar", "Divya Boppuri", "Jithender Chitakodur", "Aishwarya Laxmi Karanam", "Aravind Jakkula",
]);

// Payment-tracking specialist: assigned as paymentOwner on every shipment
// (existing ones migrated in bulk, new ones auto-assigned at intake), while
// staying out of the operational (controlPoc) auto-assign rotation below.
// Anyone can still edit payment fields (canEditShipment isn't scoped by this)
// — this only decides who a shipment defaults to for payment follow-up.
const PAYMENT_OWNER = "Aishwarya Laxmi Karanam";

// The active team is a fixed roster, not something discovered from shipment
// data — so everyone in it (including a specialist like the payment owner,
// who may hold zero operationally-owned shipments) always appears as a
// selectable user, never disappears just because no shipment's controlPoc
// currently names them.
function buildUsers() {
  const users = [{ name: "Local Admin", email: "local@recykal.test", role: "admin", scope: "all" }];
  for (const name of ACTIVE_TXN_TEAM) {
    users.push({ name, email: makeEmail(name), role: "associate", scope: "own" });
  }
  return users.sort((a, b) => (a.role === "admin" ? -1 : b.role === "admin" ? 1 : a.name.localeCompare(b.name)));
}

// Balanced auto-assign for a new shipment with no owner typed in: whoever
// currently has the fewest OPEN shipments gets it. Not buyer-based — deliberately,
// so no single associate gets buried just because they handle one heavy buyer.
// Admins and the payment specialist are never operational-assignment targets —
// she gets every shipment as paymentOwner separately (see intake below), not
// through this rotation. Ties break alphabetically for determinism.
function pickLeastLoadedOwner(shipments, users) {
  const candidates = users.filter((u) => u.role !== "admin" && u.name !== PAYMENT_OWNER);
  if (!candidates.length) return "";
  const openCount = new Map(candidates.map((u) => [nameKey(u.name), 0]));
  for (const s of shipments) {
    if (s.funnel === "completed" || s.funnel === "rejected") continue;
    for (const raw of splitNames(s.controlPoc)) {
      const key = nameKey(raw);
      if (openCount.has(key)) openCount.set(key, openCount.get(key) + 1);
    }
  }
  let best = candidates[0];
  for (const u of candidates) {
    if (openCount.get(nameKey(u.name)) < openCount.get(nameKey(best.name))) best = u;
  }
  return best.name;
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

// Direct email + PIN login — the second way in, for people who would rather not
// use Google (or when no Google client is configured at all).
//
// This form is reachable by anyone on the internet, which the Google-then-PIN
// path was not, so it carries two extra defences beyond the shared per-email
// lockout: a per-IP failure counter (the per-email lockout alone would let a
// stranger lock a colleague out with five guesses), and a constant-ish response
// time so the form cannot be used to discover who is on the roster.
const LOGIN_FAIL_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_FAIL_MAX = 12;
const loginFailMap = new Map(); // ip -> number[]

function loginFailBlocked(ip) {
  const now = Date.now();
  const list = (loginFailMap.get(ip) || []).filter((t) => now - t < LOGIN_FAIL_WINDOW_MS);
  if (list.length) loginFailMap.set(ip, list);
  else loginFailMap.delete(ip);
  return list.length >= LOGIN_FAIL_MAX;
}
function recordLoginFail(ip) {
  const now = Date.now();
  const list = (loginFailMap.get(ip) || []).filter((t) => now - t < LOGIN_FAIL_WINDOW_MS);
  list.push(now);
  if (loginFailMap.size > RATE_MAP_MAX_KEYS) loginFailMap.clear();
  loginFailMap.set(ip, list);
}

async function handleDirectLogin(req, res, ip) {
  if (!authGateOn()) return sendJson(res, { error: "Not available" }, 404);
  if (loginFailBlocked(ip)) {
    return sendJson(res, { error: "Too many failed sign-ins. Try again later." }, 429);
  }
  let payload;
  try {
    payload = await readBody(req);
  } catch (e) {
    return sendJson(res, { error: "Invalid request" }, 400);
  }
  const email = String(payload.email || "").trim().toLowerCase();
  const supplied = String(payload.pin || "");
  // One message for every failure — wrong PIN, unknown address, locked out at
  // the email level. The caller learns nothing about who exists.
  const deny = () => {
    recordLoginFail(ip);
    return sendJson(res, { error: "Incorrect email or PIN" }, 401);
  };

  if (!email || !isAuthorizedIdentity({ email }) || pin.isLockedOut(email)) {
    await pin.dummyVerify(supplied);
    return deny();
  }
  const { record } = await pinRecordFor(email);
  if (!record) {
    await pin.dummyVerify(supplied);
    return deny();
  }
  if (!(await pin.verifyPin(supplied, record))) {
    pin.recordFailure(email);
    return deny();
  }
  pin.clearFailures(email);
  // The PIN *was* the credential here, so the session starts already past the
  // PIN gate — there is no second factor still to clear.
  auth.issueSession(req, res, { email, name: email, pinAt: Date.now() });
  store.addLoginEvent({ email, createdAt: new Date().toISOString() }).catch(() => {});
  return sendJson(res, { ok: true });
}

function resolveUser(req, url, shipments) {
  const users = buildUsers(shipments);
  if (authGateOn()) {
    // Authenticated mode: identity comes from the signed session cookie, no
    // matter which login minted it. ?user= is ignored.
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
  // Dev mode (no auth env at all): ?user=<email> selects a KNOWN user only.
  // Default is the local admin (dev convenience, and the server now binds to
  // 127.0.0.1 so this is not network-reachable). An unknown user must NOT
  // fall back to admin — it becomes a no-scope guest.
  const requested = url.searchParams.get("user") || "local@recykal.test";
  const found = users.find((u) => u.email === requested);
  if (found) return found;
  return { name: "Guest", email: "guest", role: "guest", scope: "none" };
}

// Ownership/edit-scope is controlPoc only — same reasoning as buildUsers() above.
function shipmentNames(shipment) {
  return splitNames(shipment.controlPoc).map(nameKey);
}

function scopeShipments(shipments, user) {
  if (!user || user.role === "admin") return shipments;
  const key = nameKey(user.name);
  return shipments.filter((s) => shipmentNames(s).includes(key));
}

// Read model: an associate can SEE all shipments; EDIT only the ones assigned to
// them (their name is a Control/SR/BR POC). Admin edits all; guest edits nothing.
function canEditShipment(shipment, user) {
  // Every signed-in associate can edit any shipment, not just ones assigned
  // to them — assignment is now a filter/workload view (see "My shipments"
  // in the CRM), not an edit boundary. Only a guest (unrecognized identity)
  // is locked out.
  if (!user || user.role === "guest") return false;
  return true;
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
const UPDATE_TYPES = new Set(["stage", "doc", "note", "owner", "followup", "qty", "payment_detail", "issue", "invoice_detail", "margin", "poc_contact", "detail"]);
const DOC_VALUES = new Set(["missing", "pending", "ok", "na"]);
const QTY_KEYS = new Set(["invoiceQty", "receivedQty"]);
const PAYMENT_DETAIL_KEYS = new Set(["tds"]);
const INVOICE_DETAIL_KEYS = new Set(["invoiceDate", "paymentTerms", "dueDate"]);
// Generic manual fields the source sheet tracks that don't fit an existing type —
// mirrors the invoice_detail pattern (key/value, same generic columns, no new schema).
const DETAIL_DATE_KEYS = new Set(["mmDate", "dispatchDate", "vehicleExpDate", "vehicleActualDate", "vehiclePortalDate", "deliveredActualDate", "deliveredPortalDate", "completionDate"]);
const DETAIL_TEXT_KEYS = new Set(["orderId", "invoiceNo", "distance", "dnStatus", "dnRemarks", "unloaded", "podReceived", "paymentDoneConfirmed"]);
const DETAIL_KEYS = new Set([...DETAIL_DATE_KEYS, ...DETAIL_TEXT_KEYS]);
const ISSUE_TYPES = new Set(["gst_pending", "payment_advice_pending", "po_pending", "tracking_issue", "buyer_detail_issue", "other"]);
const MARGIN_KEYS = new Set(["applies", "pctOverride", "invoiceStatus"]);
const MARGIN_APPLIES_VALUES = new Set(["pending", "yes", "no"]);
const MARGIN_INVOICE_STATUS_VALUES = new Set(["not_raised", "raised", "sent"]);
const POC_CONTACT_KEYS = new Set(["buyer", "seller"]);
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
    // key "" = operational owner (controlPoc, default); key "payment" = the
    // separate payment-tracking owner. See computeState()'s "owner" branch.
    out.key = p.key === "payment" ? "payment" : "";
    const normalized = splitNames(p.value).map(canonicalName).join("/");
    out.value = clampStr(normalized, 120);
  } else if (type === "note") {
    out.value = clampStr(p.value, 1000);
  } else if (type === "followup") {
    out.value = ["scheduled", "done"].includes(p.value) ? p.value : "scheduled";
    out.status = ["open", "done"].includes(p.status) ? p.status : "open";
    out.dueDate = /^\d{4}-\d{2}-\d{2}$/.test(String(p.dueDate || "")) ? p.dueDate : "";
    out.reason = clampStr(p.reason, 60);
  } else if (type === "qty") {
    if (!QTY_KEYS.has(p.key)) return { error: "invalid qty key" };
    const n = Number(String(p.value ?? "").replace(/[,\s]/g, ""));
    if (!Number.isFinite(n) || n < 0) return { error: "invalid qty value" };
    out.key = p.key; out.value = String(n);
  } else if (type === "payment_detail") {
    if (!PAYMENT_DETAIL_KEYS.has(p.key)) return { error: "invalid payment_detail key" };
    const n = Number(String(p.value ?? "").replace(/[,\s]/g, ""));
    if (!Number.isFinite(n) || n < 0) return { error: "invalid payment_detail value" };
    out.key = p.key; out.value = String(n);
  } else if (type === "issue") {
    if (!ISSUE_TYPES.has(p.value)) return { error: "invalid issue type" };
    out.value = p.value;
  } else if (type === "invoice_detail") {
    if (!INVOICE_DETAIL_KEYS.has(p.key)) return { error: "invalid invoice_detail key" };
    if (p.key === "paymentTerms") { out.key = p.key; out.value = clampStr(p.value, 30); }
    else {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(p.value || ""))) return { error: "invalid date" };
      out.key = p.key; out.value = p.value;
    }
  } else if (type === "margin") {
    if (!MARGIN_KEYS.has(p.key)) return { error: "invalid margin key" };
    if (p.key === "applies") {
      if (!MARGIN_APPLIES_VALUES.has(p.value)) return { error: "invalid margin applies value" };
      out.key = p.key; out.value = p.value;
    } else if (p.key === "invoiceStatus") {
      if (!MARGIN_INVOICE_STATUS_VALUES.has(p.value)) return { error: "invalid margin invoice status" };
      out.key = p.key; out.value = p.value;
    } else {
      const n = Number(String(p.value ?? "").replace(/[,\s]/g, ""));
      if (!Number.isFinite(n) || n < 0 || n > 100) return { error: "invalid margin pct" };
      out.key = p.key; out.value = String(n);
    }
  } else if (type === "poc_contact") {
    if (!POC_CONTACT_KEYS.has(p.key)) return { error: "invalid poc_contact key" };
    out.key = p.key; out.value = clampStr(p.value, 300);
  } else if (type === "detail") {
    if (!DETAIL_KEYS.has(p.key)) return { error: "invalid detail key" };
    if (DETAIL_DATE_KEYS.has(p.key)) {
      if (p.value && !/^\d{4}-\d{2}-\d{2}$/.test(String(p.value))) return { error: "invalid date" };
      out.key = p.key; out.value = p.value || "";
    } else {
      out.key = p.key; out.value = clampStr(p.value, 300);
    }
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
  if (authGateOn()) {
    const identity = auth.getIdentity(req);
    // No session, or a session for somebody not on the roster: refuse outright
    // rather than answering with an empty payload. /api/me is the one exception
    // — the login page reads it to know which sign-in methods to offer, and the
    // frontend reads it to learn why it is being blocked.
    if (url.pathname !== "/api/me" && (!identity || !isAuthorizedIdentity(identity))) {
      return sendJson(res, { error: "Not authenticated" }, 403);
    }
    // Signature-valid session whose PIN has since been reset or cleared.
    const gated = identity && isAuthorizedIdentity(identity) && !(await pinSatisfied(identity));
    if (gated && url.pathname !== "/api/me") {
      return sendJson(res, { error: "Session expired. Sign in again.", pinRequired: true }, 403);
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
    const identity = authGateOn() ? auth.getIdentity(req) : null;
    return sendJson(res, {
      user,
      authMode: authGateOn() ? "secure" : "dev",
      authenticated: authGateOn() ? Boolean(identity) : true,
      // Session no longer valid — the PIN behind it was reset or cleared.
      pinRequired: Boolean(identity && isAuthorizedIdentity(identity) && !(await pinSatisfied(identity))),
    });
  }
  if (req.method === "GET" && url.pathname === "/api/users") {
    if (authGateOn() && user.role !== "admin") return sendJson(res, { error: "Forbidden" }, 403);
    return sendJson(res, { users });
  }
  // Admin-only PIN administration. Users cannot set or change their own PIN;
  // issuing and resetting is an admin action, so this is the one place PINs
  // are created. Reaching here already required clearing the PIN gate above,
  // so the endpoint that manages PINs is not itself a way around them.
  if (url.pathname === "/api/admin/pins") {
    if (!authGateOn()) return sendJson(res, { error: "Not available in dev mode" }, 400);
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
      users: (authGateOn() && user.role !== "admin") ? [] : users,
      ownerOptions: [...new Set(users.map((u) => u.name).filter(Boolean))],
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
    if (!authGateOn() && !IS_DEPLOYED) {
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
  if (req.method === "POST" && url.pathname === "/api/shipments") {
    // New-shipment intake: only the shipment ID is generated — every other field
    // (buyer, seller, material, qty, POCs...) is entered manually against it from
    // here, same as every existing shipment in the book.
    if (user.role === "guest") return sendJson(res, { error: "Not authorized" }, 403);
    let payload;
    try {
      payload = await readBody(req);
    } catch (e) {
      return sendJson(res, { error: "Invalid request" }, 400);
    }
    const buyer = clampStr(payload.buyer, 200);
    if (!buyer) return sendJson(res, { error: "Buyer is required" }, 400);
    const existingIds = new Set(state.shipments.map((s) => s.shipmentId));
    const manualId = clampStr(payload.shipmentId, 30).trim();
    if (manualId && existingIds.has(manualId)) return sendJson(res, { error: "That Shipment ID already exists" }, 400);
    const shipmentId = manualId || generateShipmentId(existingIds);
    const controlPocIn = clampStr(payload.controlPoc, 100).trim();
    // Owner left blank → auto-assign to whoever has the lightest open load right
    // now (same balanced logic as the plan's auto-assign — not buyer-based).
    const controlPoc = controlPocIn || pickLeastLoadedOwner(state.shipments, users);
    const row = {
      shipmentId,
      orderId: "",
      vertical: clampStr(payload.vertical, 60),
      material: clampStr(payload.material, 200),
      seller: clampStr(payload.seller, 200),
      srPoc: clampStr(payload.srPoc, 100),
      buyer,
      brPoc: clampStr(payload.brPoc, 100),
      controlPoc,
      paymentOwner: PAYMENT_OWNER,
      month: new Date().toLocaleString("en-IN", { month: "long" }),
      invoiceNo: "", invoiceDate: "", dispatchDate: "", dueDate: "", paymentTerms: "", distance: "",
      stageRaw: "MM", funnel: "mm",
      qtyKg: clampStr(payload.qtyKg, 20),
      materialValue: clampStr(payload.materialValue, 20),
      gst: "0", total: "0", debitNote: "0", netPayable: "0", paidAmount: "0", balance: "0",
      paymentStatus: "", docs: {}, remarks: "",
    };
    const inserted = await store.addShipment(row);
    invalidateState();
    // Someone else's request won a same-ID race between our uniqueness check and
    // this insert (only possible on Postgres, where both are real network I/O) —
    // report it honestly instead of claiming success over a silently-discarded row.
    if (!inserted) return sendJson(res, { error: "That Shipment ID was just taken — try again" }, 409);
    return sendJson(res, { ok: true, shipmentId, controlPoc, autoAssigned: !controlPocIn });
  }
  if (req.method === "POST" && url.pathname === "/api/admin/bulk-import-shipments") {
    // Admin-only bulk backfill/migration tool — inserts whole shipment rows in
    // one call (e.g. catching production up from a one-time sheet import run
    // locally). Reuses store.addShipment()'s existing ON CONFLICT DO NOTHING,
    // so it is safe to re-run: only shipmentIds not already present are added,
    // nothing existing is ever overwritten.
    if (authGateOn() && user.role !== "admin") return sendJson(res, { error: "Forbidden" }, 403);
    let payload;
    try {
      payload = await readBody(req);
    } catch (e) {
      return sendJson(res, { error: "Invalid request" }, 400);
    }
    const rows = Array.isArray(payload.shipments) ? payload.shipments : [];
    let inserted = 0;
    let skipped = 0;
    for (const row of rows) {
      if (!row || !row.shipmentId) { skipped++; continue; }
      const ok = await store.addShipment(row);
      if (ok) inserted++; else skipped++;
    }
    invalidateState();
    return sendJson(res, { ok: true, inserted, skipped, totalSent: rows.length });
  }
  if (req.method === "POST" && url.pathname === "/api/admin/bulk-reassign-owners") {
    // Admin-only bulk owner reassignment — e.g. rebalancing the whole book across
    // the current active team in one pass. Each entry just appends a normal
    // "owner" event (same path a single manual reassignment takes), so the full
    // history stays intact in each shipment's timeline; nothing is overwritten in
    // place. Body: { assignments: [{ shipmentId, owner, key? }, ...] } — key
    // "payment" targets the payment owner instead of the operational one.
    if (authGateOn() && user.role !== "admin") return sendJson(res, { error: "Forbidden" }, 403);
    let payload;
    try {
      payload = await readBody(req);
    } catch (e) {
      return sendJson(res, { error: "Invalid request" }, 400);
    }
    const assignments = Array.isArray(payload.assignments) ? payload.assignments : [];
    const knownIds = new Set(state.shipments.map((s) => s.shipmentId));
    let applied = 0;
    let skipped = 0;
    for (const a of assignments) {
      const shipmentId = String((a && a.shipmentId) || "").trim();
      const checked = shipmentId && knownIds.has(shipmentId) ? validateUpdate({ type: "owner", value: (a && a.owner) || "", key: (a && a.key) || "" }) : { error: "unknown shipment" };
      if (checked.error || !checked.value || !checked.value.value) { skipped++; continue; }
      const event = createEvent({ ...checked.value, shipmentId, actor: user.name, actorEmail: user.email });
      await store.addUpdate(event);
      applied++;
    }
    invalidateState();
    return sendJson(res, { ok: true, applied, skipped, totalSent: assignments.length });
  }
  if (req.method === "GET" && url.pathname === "/api/admin/activity") {
    // Deliberately narrower than the other admin-* routes: gated to one named
    // person, not "any admin" — see ACTIVITY_OWNER_EMAIL.
    if (authGateOn() && String(user.email || "").toLowerCase() !== ACTIVITY_OWNER_EMAIL) {
      return sendJson(res, { error: "Forbidden" }, 403);
    }
    const [logins, updates] = await Promise.all([store.getLoginEvents(), store.getUpdates()]);
    const idToShipment = new Map(state.shipments.map((s) => [s.shipmentId, s]));
    const loginFeed = logins
      .map((e) => ({ kind: "login", email: e.email, at: e.createdAt }))
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .slice(0, 200);
    const updateFeed = updates
      .map((e) => ({
        kind: "update",
        type: e.type,
        key: e.key,
        value: typeof e.value === "string" ? e.value : "",
        actor: e.actor,
        actorEmail: e.actorEmail,
        shipmentId: e.shipmentId,
        buyer: (idToShipment.get(e.shipmentId) || {}).buyer || "",
        at: e.createdAt,
      }))
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .slice(0, 300);
    return sendJson(res, { ok: true, logins: loginFeed, updates: updateFeed });
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

// Everything a visitor is allowed to load before they have signed in. Deliberately
// tiny: login.html carries its own CSS inline, so the sign-in screen needs no
// other file. Anything outside this set is a redirect until they are through.
// login.js must be here too: the email+PIN form needs a submit handler, the CSP
// forbids inline script, so without it the sign-in page loads with a dead form.
const PRE_LOGIN_PATHS = new Set(["/login.html", "/login.js", "/favicon.ico"]);

/**
 * Decide where an unauthenticated or half-authenticated request should be sent
 * instead of being served. Returns null when the request may proceed.
 * Only consulted when auth is on, and only for non-/api, non-/auth paths.
 */
async function pageGateRedirect(req, url) {
  const identity = auth.getIdentity(req);

  if (!identity) {
    return PRE_LOGIN_PATHS.has(url.pathname) ? null : "/login.html";
  }
  if (!isAuthorizedIdentity(identity)) {
    // Signed in once, but no longer on the roster — never gets past this.
    return PRE_LOGIN_PATHS.has(url.pathname) ? null : "/login.html?error=denied";
  }
  if (!(await pinSatisfied(identity))) {
    // The PIN behind this session was reset or cleared, so it is spent. The
    // PRE_LOGIN_PATHS check is what stops /login.html redirecting to itself
    // forever: the cookie is still signature-valid, only pinAt is stale.
    if (PRE_LOGIN_PATHS.has(url.pathname)) return null;
    return "/login.html?error=expired";
  }
  // Fully in — no reason to sit on the sign-in screen.
  if (url.pathname === "/login.html") return "/";
  // PIN administration is admin-only at the page level too (the API behind it
  // enforces this independently).
  if (url.pathname === "/admin-pins.html" && !adminEmails().includes(String(identity.email).toLowerCase())) {
    return "/";
  }
  return null;
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
    if (req.method === "POST" && url.pathname === "/auth/login") return await handleDirectLogin(req, res, ip);
    if (url.pathname.startsWith("/auth/")) return await auth.handleAuth(req, res, url);
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    // In OAuth mode nothing is served before login except the login screen
    // itself: a visitor's first request lands on /login.html and there is
    // nothing else to reach from there. Gating only the HTML pages would still
    // have handed out core.js, styles.css, pages/*.js and the logo to anyone.
    // (Dev mode is never gated — it binds to 127.0.0.1 and is laptop-only.)
    if (authGateOn()) {
      const redirect = await pageGateRedirect(req, url);
      if (redirect) {
        res.writeHead(302, { Location: redirect, ...securityHeaders() });
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
// Fail closed. Authentication now hangs off a single variable, and a deployed
// instance without it would bind 0.0.0.0 with resolveUser in dev mode, where
// ?user=local@recykal.test is admin over every shipment and needs no cookie.
// One missing env var on Railway would publish the whole CRM, so refuse to run.
if (IS_DEPLOYED && !authGateOn()) {
  console.error(
    "[boot] Refusing to start: this looks like a deployed instance " +
      "(HOST/DATABASE_URL/RAILWAY_ENVIRONMENT/NODE_ENV set) but SESSION_SECRET is missing, " +
      "so authentication would be OFF and every visitor would be an admin.\n" +
      "[boot] Set SESSION_SECRET (and ADMIN_EMAILS / AUTH_USERS) and start again."
  );
  process.exit(1);
}

const HOST = process.env.HOST || (IS_DEPLOYED ? "0.0.0.0" : "127.0.0.1");
server.listen(PORT, HOST, () => {
  const shown = HOST === "0.0.0.0" ? "0.0.0.0 (all interfaces)" : HOST;
  console.log(`OMP Shipment Tracker running at http://localhost:${PORT} (bound ${shown})`);
});







