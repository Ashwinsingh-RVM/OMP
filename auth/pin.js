/**
 * Second auth factor: a per-person PIN checked after Google SSO.
 *
 * Google alone proves "this mailbox is yours". The PIN proves "you are the
 * person we handed a PIN to" — so a hijacked Google account, or a shared
 * invoicing mailbox that several people can open, still does not open the CRM.
 *
 * Only a scrypt hash is stored (see db/schema.sql `pins`). The PIN itself is
 * never written to disk, the database, or a log line.
 *
 * PINs are issued and reset by admins only. No row for an email means "no PIN
 * issued" and that account cannot get past the gate — with one bootstrap
 * exception: an ADMIN_EMAILS account with no row may use BOOTSTRAP_ADMIN_PIN,
 * which exists purely so the first admin can get in and issue everyone else's.
 */
const crypto = require("crypto");

const PIN_MIN = 6;
const PIN_MAX = 12;

// Per-email lockout. Keyed on the identity email (the Google session is already
// verified by the time a PIN is submitted), NOT on IP — everyone at the office
// shares one NAT address, so an IP-keyed lockout lets one wrong-PIN user lock
// out the whole company.
const MAX_ATTEMPTS = 5;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map(); // email -> number[] (timestamps of failures)

const SCRYPT_KEYLEN = 32;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

function isValidPinFormat(pin) {
  return /^[0-9]{6,12}$/.test(String(pin || ""));
}

// scrypt is deliberately slow (~100ms). Use the async form: the sync form would
// block the single-threaded event loop, stalling every other request behind one
// PIN check.
function scrypt(pin, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(pin), salt, SCRYPT_KEYLEN, SCRYPT_PARAMS, (err, key) => {
      if (err) return reject(err);
      resolve(key.toString("hex"));
    });
  });
}

async function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = await scrypt(pin, salt);
  return { salt, hash };
}

async function verifyPin(pin, record) {
  if (!record || !record.salt || !record.hash) return false;
  const computed = await scrypt(pin, record.salt);
  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(String(record.hash), "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* ----------------------------- lockout ----------------------------- */
function recentFailures(email) {
  const key = String(email || "").toLowerCase();
  const cutoff = Date.now() - LOCKOUT_WINDOW_MS;
  const list = (attempts.get(key) || []).filter((t) => t > cutoff);
  if (list.length) attempts.set(key, list);
  else attempts.delete(key);
  return list;
}

function isLockedOut(email) {
  return recentFailures(email).length >= MAX_ATTEMPTS;
}

function attemptsLeft(email) {
  return Math.max(0, MAX_ATTEMPTS - recentFailures(email).length);
}

function recordFailure(email) {
  const key = String(email || "").toLowerCase();
  const list = recentFailures(key);
  list.push(Date.now());
  attempts.set(key, list);
}

function clearFailures(email) {
  attempts.delete(String(email || "").toLowerCase());
}

module.exports = {
  PIN_MIN,
  PIN_MAX,
  MAX_ATTEMPTS,
  LOCKOUT_WINDOW_MS,
  isValidPinFormat,
  hashPin,
  verifyPin,
  isLockedOut,
  attemptsLeft,
  recordFailure,
  clearFailures,
};
