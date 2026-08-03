/**
 * Data store adapter.
 *
 * Exposes an async interface used by server.js:
 *   - getShipments()      -> Promise<Array<row>>   (raw source rows, same shape as data/shipments.json "shipments")
 *   - getUpdates()        -> Promise<Array<event>> (event objects, camelCase, createdAt as ISO string)
 *   - addUpdate(event)    -> Promise<void>         (append one event)
 *
 * Implementation is selected at boot:
 *   - process.env.DATABASE_URL set  -> Postgres (via `pg`)
 *   - otherwise                     -> JSON-file behavior (data/shipments.json read, data/updates.json append)
 *
 * The JSON path requires ZERO env config so local dev is unbroken.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, "data");
const SHIPMENTS_FILE = path.join(DATA, "shipments.json");
const UPDATES_FILE = path.join(DATA, "updates.json");

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
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

/* ----------------------------- JSON store ----------------------------- */
function createJsonStore() {
  return {
    kind: "json",
    async getShipments() {
      const source = readJson(SHIPMENTS_FILE, { shipments: [] });
      return source.shipments || [];
    },
    async getUpdates() {
      const updates = readJson(UPDATES_FILE, { updates: [] });
      return updates.updates || [];
    },
    async addUpdate(event) {
      const current = readJson(UPDATES_FILE, { updates: [] });
      current.updates = current.updates || [];
      current.updates.push(event);
      writeJson(UPDATES_FILE, current);
    },
  };
}

/* --------------------------- Postgres store --------------------------- */
function createPgStore() {
  // Lazy-require so the JSON path never needs `pg` installed.
  const { Pool } = require("pg");
  const url = process.env.DATABASE_URL;
  const isLocal = /localhost|127\.0\.0\.1/.test(url || "");
  // Managed Postgres (Railway/Render/etc.) terminates TLS; local usually does not.
  const pool = new Pool({
    connectionString: url,
    ssl: isLocal ? false : { rejectUnauthorized: false },
  });

  // Auto-migrate + seed once on first use, so a fresh Railway/Render Postgres
  // needs no separate `npm run initdb` step. Idempotent (IF NOT EXISTS / COUNT check).
  let readyPromise = null;
  function ensureReady() {
    if (readyPromise) return readyPromise;
    readyPromise = (async () => {
      const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
      await pool.query(schema);
      const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM shipments");
      if (rows[0].n === 0) {
        const source = readJson(SHIPMENTS_FILE, { shipments: [] });
        const list = source.shipments || [];
        for (const row of list) {
          await pool.query(
            `INSERT INTO shipments
               (shipment_id, order_id, vertical, material, seller, sr_poc, buyer,
                br_poc, control_poc, funnel, stage_raw, dispatch_date, due_date, docs, raw)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
             ON CONFLICT (shipment_id) DO NOTHING`,
            [row.shipmentId, row.orderId || null, row.vertical || null, row.material || null,
             row.seller || null, row.srPoc || null, row.buyer || null, row.brPoc || null,
             row.controlPoc || null, row.funnel || null, row.stageRaw || null,
             row.dispatchDate || null, row.dueDate || null, JSON.stringify(row.docs || {}), JSON.stringify(row)]
          );
        }
        console.log(`[store] seeded ${list.length} shipments into Postgres`);
      }
    })().catch((e) => { readyPromise = null; throw e; });
    return readyPromise;
  }

  return {
    kind: "postgres",
    pool,
    async getShipments() {
      await ensureReady();
      // shipments are read-only from the app's perspective — all mutations
      // are appended to `updates`. `raw` JSONB round-trips the seeded row
      // verbatim, keeping loadState()'s transform byte-for-byte identical.
      const { rows } = await pool.query("SELECT raw FROM shipments ORDER BY shipment_id");
      return rows.map((r) => r.raw);
    },
    async getUpdates() {
      await ensureReady();
      const { rows } = await pool.query(
        `SELECT id, shipment_id, type, key, value, note, actor, actor_email,
                due_date, status, reason, created_at
           FROM updates
          ORDER BY created_at ASC`
      );
      return rows.map((r) => ({
        id: r.id,
        shipmentId: r.shipment_id,
        type: r.type,
        key: r.key || "",
        value: r.value ?? "",
        note: r.note || "",
        actor: r.actor || "",
        actorEmail: r.actor_email || "",
        dueDate: r.due_date || "",
        status: r.status || "",
        reason: r.reason || "",
        // Downstream code calls String(createdAt).localeCompare(...) and
        // createdAt.localeCompare(...) — must be an ISO string, not a Date.
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at || ""),
      }));
    },
    async addUpdate(event) {
      await ensureReady();
      await pool.query(
        `INSERT INTO updates
           (id, shipment_id, type, key, value, note, actor, actor_email, due_date, status, reason, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          event.id,
          event.shipmentId,
          event.type,
          event.key || "",
          String(event.value ?? ""),
          event.note || "",
          event.actor || "",
          event.actorEmail || "",
          event.dueDate ? event.dueDate : null,
          event.status || "",
          event.reason || "",
          event.createdAt,
        ]
      );
    },
  };
}

let store = null;
function getStore() {
  if (store) return store;
  store = process.env.DATABASE_URL ? createPgStore() : createJsonStore();
  console.log(`[store] using ${store.kind} store`);
  return store;
}

module.exports = { getStore, SHIPMENTS_FILE, UPDATES_FILE };
