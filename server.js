const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { getStore } = require("./db/store");
const auth = require("./auth/google");

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const DATA = path.join(ROOT, "data");
const SHIPMENTS_FILE = path.join(DATA, "shipments.json");
const UPDATES_FILE = path.join(DATA, "updates.json");
const PORT = Number(process.env.PORT || 4332);

const store = getStore();

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

async function loadState() {
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

function nameKey(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function makeEmail(name) {
  return nameKey(name).replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "") + "@local.associate";
}

function buildUsers(shipments) {
  const users = [{ name: "Local Admin", email: "local@recykal.test", role: "admin", scope: "all" }];
  const seen = new Set(users.map((u) => u.email));
  for (const s of shipments) {
    for (const name of [...splitNames(s.controlPoc), ...splitNames(s.srPoc), ...splitNames(s.brPoc)]) {
      const email = makeEmail(name);
      if (!name || seen.has(email)) continue;
      users.push({ name, email, role: "associate", scope: "own" });
      seen.add(email);
    }
  }
  return users.sort((a, b) => (a.role === "admin" ? -1 : b.role === "admin" ? 1 : a.name.localeCompare(b.name)));
}

function authUserMap() {
  // Optional mapping of real Google emails to an internal user email/POC scope.
  // e.g. AUTH_USERS='{"ashwin.singh@recykal.com":"aishwarya@local.associate"}'
  try {
    return JSON.parse(process.env.AUTH_USERS || "{}");
  } catch (e) {
    return {};
  }
}

function resolveUser(req, url, shipments) {
  const users = buildUsers(shipments);
  if (auth.isEnabled()) {
    // OAuth mode: identity comes from the signed session cookie; ?user= is ignored.
    const identity = auth.getIdentity(req);
    if (!identity) return { name: "Guest", email: "guest", role: "guest", scope: "none" };
    const email = String(identity.email || "").toLowerCase();
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
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
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
  const state = await loadState();
  const users = buildUsers(state.shipments);
  const user = resolveUser(req, url, state.shipments);
  // Read model: admin + associates can READ every shipment; each is tagged with
  // canEdit (true only for the ones assigned to them). Guests get nothing.
  const canSeeAll = user.role === "admin" || user.role === "associate";
  const readable = (canSeeAll ? state.shipments : []).map((s) => ({ ...s, canEdit: canEditShipment(s, user) }));
  if (req.method === "GET" && url.pathname === "/api/me") {
    return sendJson(res, {
      user,
      authMode: auth.isEnabled() ? "google" : "dev",
      authenticated: auth.isEnabled() ? Boolean(auth.getIdentity(req)) : true,
    });
  }
  if (req.method === "GET" && url.pathname === "/api/users") {
    if (auth.isEnabled() && user.role !== "admin") return sendJson(res, { error: "Forbidden" }, 403);
    return sendJson(res, { users });
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
    const payload = await readBody(req);
    const shipmentId = String(payload.shipmentId || "").trim();
    if (!shipmentId) return sendJson(res, { error: "shipmentId required" }, 400);
    // Attribute the write server-side: in dev to the picked (known) associate,
    // in OAuth to the signed-in user. Client-supplied actor is never trusted for identity.
    let actingUser = user;
    if (!auth.isEnabled()) {
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
  try {
    if (!checkBasicAuth(req, res)) return;
    if (url.pathname.startsWith("/auth/")) return await auth.handleAuth(req, res, url);
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    // In OAuth mode, gate the app shell behind login (dev mode is never gated).
    if (auth.isEnabled() && (url.pathname === "/" || url.pathname === "/index.html") && !auth.getIdentity(req)) {
      res.writeHead(302, { Location: "/login.html" });
      return res.end();
    }
    return serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    return sendJson(res, { error: error.message || "Server error" }, 500);
  }
});

// Bind to loopback for local dev so the app is laptop-only. Bind all interfaces
// only when actually deployed (Railway/prod, OAuth on, a DATABASE_URL, or HOST set).
const IS_DEPLOYED = Boolean(process.env.HOST || auth.isEnabled() || process.env.DATABASE_URL || process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === "production");
const HOST = process.env.HOST || (IS_DEPLOYED ? "0.0.0.0" : "127.0.0.1");
server.listen(PORT, HOST, () => {
  const shown = HOST === "0.0.0.0" ? "0.0.0.0 (all interfaces)" : HOST;
  console.log(`OMP Shipment Tracker running at http://localhost:${PORT} (bound ${shown})`);
});







