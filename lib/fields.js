/**
 * Field schema for the OMP tracker sheet + the formulas behind its auto columns.
 *
 * FIELD_SECTIONS (field-sections.json) is sent to the browser in /api/bootstrap,
 * so the Shipments page and the Sheet render every column from one source and
 * the screen never drifts from the sheet. A "field" update event writes one of
 * these keys; validateField() is its allowlist.
 *
 * Auto columns (GST, totals, DN, net payable, TDS, balance, due date, shortages)
 * are computed here. Each resolves to one value, in this order:
 *   1. a manual value typed in the CRM ("crm"),
 *   2. else a value imported from the source sheet that disagrees with the
 *      formula ("sheet") — only while none of its inputs were changed in the CRM,
 *      so an old sheet balance never hides a payment logged afterwards,
 *   3. else the formula ("auto").
 */
const FIELD_SECTIONS = require("./field-sections.json");

const FIELDS = new Map();
for (const sec of FIELD_SECTIONS) for (const f of sec.fields) FIELDS.set(f.key, f);

// Days a shipment may sit at a stage before it is flagged "stage delayed".
const STAGE_SLA = { mm: 3, predispatch: 1, intransit: 5, reached: 2, qc: 3 };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Returns { value } or { error }. "" always clears the field.
function validateField(key, raw) {
  const f = FIELDS.get(String(key || ""));
  if (!f) return { error: "invalid field" };
  const value = raw === null || raw === undefined ? "" : String(raw).trim();
  if (value === "") return { value: "" };
  if (f.kind === "date") return ISO_DATE.test(value) ? { value } : { error: `invalid date for ${f.label}` };
  if (f.kind === "number" || f.kind === "money") {
    const n = Number(value.replace(/[,\s]/g, ""));
    return Number.isFinite(n) ? { value: String(n) } : { error: `invalid number for ${f.label}` };
  }
  if (f.opts) return f.opts.some((o) => o[0] === value) ? { value } : { error: `invalid choice for ${f.label}` };
  return { value: value.slice(0, f.kind === "long" ? 2000 : 300) };
}

const num = (v) => {
  if (v === null || v === undefined || String(v).trim() === "" || String(v).trim().toLowerCase() === "na") return null;
  const n = Number(String(v).replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const round2 = (n) => (n === null ? null : Math.round(n * 100) / 100);

function toIso(v) {
  const s = String(v || "").trim();
  if (!s || s.toLowerCase() === "na") return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function addDays(iso, days) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Inputs of each auto column; a CRM change to any of them retires the sheet value.
const DEPS = {
  gst: ["materialValue", "gstRate"],
  total: ["materialValue", "gstRate", "gst"],
  dnGst: ["debitNote"],
  totalDn: ["debitNote", "dnGst"],
  netPayable: ["materialValue", "gstRate", "gst", "total", "debitNote", "dnGst", "totalDn"],
  itTds: ["materialValue", "tdsApplicable"],
  gstTds: ["materialValue", "tdsApplicable"],
  balance: ["materialValue", "gstRate", "gst", "total", "debitNote", "dnGst", "totalDn", "netPayable", "itTds", "gstTds", "tdsApplicable", "paidAmount"],
  dueDate: ["deliveredActualDate", "paymentTerms"],
  actualShortage: ["invoiceQty", "pickedQty"],
  mipShortage: ["invoiceQty", "receivedQty"],
};
const AUTO_KEYS = Object.keys(DEPS);

/**
 * row       merged shipment (source row + every event applied)
 * sheet     the untouched source row (what the sheet import said)
 * crm       { key: value } manual overrides typed in the CRM
 * touched   Set of keys changed in the CRM since import
 * Returns { values: { key: effective }, calc: { key: { auto, overridden, from } } }.
 */
function computeAuto(row, sheet, crm, touched) {
  const values = {};
  const calc = {};
  const isDate = (k) => k === "dueDate";
  const same = (k, a, b) => (isDate(k) ? a === b : Math.abs(a - b) <= 1);
  const read = (k) => (isDate(k) ? toIso : (v) => round2(num(v)));
  const eff = (k) => (k in values ? values[k] : num(row[k]));

  function resolve(key, auto) {
    auto = isDate(key) ? auto : round2(auto);
    const parse = read(key);
    let value = auto;
    let from = "auto";
    if (key in crm && parse(crm[key]) !== null) {
      // Typing the formula's own value back in ("Use auto" on a sheet value) is not an override.
      const typed = parse(crm[key]);
      if (auto === null || !same(key, typed, auto)) { value = typed; from = "crm"; }
    } else if (!DEPS[key].some((d) => touched.has(d))) {
      const s = parse(sheet[key]);
      // A blank-ish 0 from the import is "not filled", not a real figure.
      const zeroBlank = s === 0 && auto !== null && auto > 0 && (key !== "balance" || !(num(row.paidAmount) > 0));
      if (s !== null && !zeroBlank && (auto === null || !same(key, s, auto))) {
        value = s;
        from = "sheet";
      }
    }
    values[key] = value;
    calc[key] = { auto, overridden: from !== "auto", from };
  }

  const mv = num(row.materialValue);
  const rate = num(row.gstRate) ?? 18;
  resolve("gst", mv === null ? null : (mv * rate) / 100);
  resolve("total", mv === null ? null : mv + (eff("gst") || 0));
  const dn = num(row.debitNote);
  resolve("dnGst", dn === null ? null : dn * 0.18);
  resolve("totalDn", dn === null ? null : dn + (eff("dnGst") || 0));
  const total = eff("total");
  resolve("netPayable", total === null ? null : total - (eff("totalDn") || 0));
  const tds = String(row.tdsApplicable || "");
  resolve("itTds", !tds || mv === null ? null : ["both", "it"].includes(tds) ? mv * 0.001 : 0);
  resolve("gstTds", !tds || mv === null ? null : ["both", "gst"].includes(tds) ? mv * 0.02 : 0);
  const net = eff("netPayable");
  resolve("balance", net === null ? null
    : row.funnel === "rejected" ? 0
    : net - (eff("itTds") || 0) - (eff("gstTds") || 0) - (num(row.paidAmount) || 0));
  const delivered = toIso(row.deliveredActualDate);
  const terms = String(row.paymentTerms || "").match(/D\s*\+\s*(\d+)/i);
  resolve("dueDate", delivered && terms ? addDays(delivered, Number(terms[1])) : null);
  const invQty = num(row.invoiceQty) ?? num(row.qtyKg);
  const picked = num(row.pickedQty), received = num(row.receivedQty);
  resolve("actualShortage", invQty === null || picked === null ? null : invQty - picked);
  resolve("mipShortage", invQty === null || received === null ? null : invQty - received);
  return { values, calc };
}

module.exports = { FIELD_SECTIONS, FIELDS, STAGE_SLA, AUTO_KEYS, validateField, computeAuto };
