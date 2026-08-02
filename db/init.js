#!/usr/bin/env node
/**
 * Creates the Postgres schema and seeds `shipments` from data/shipments.json.
 *
 * Usage:  DATABASE_URL=postgres://... npm run initdb
 *
 * Idempotent: uses CREATE TABLE IF NOT EXISTS and ON CONFLICT DO NOTHING so
 * re-running never errors or duplicates rows.
 */
const fs = require("fs");
const path = require("path");

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(
      "DATABASE_URL is not set. initdb only applies to the Postgres store.\n" +
        "Local/dev uses the JSON files directly — no init needed."
    );
    process.exit(1);
  }

  const { Pool } = require("pg");
  const isLocal = /localhost|127\.0\.0\.1/.test(url);
  const pool = new Pool({
    connectionString: url,
    ssl: isLocal ? false : { rejectUnauthorized: false },
  });

  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  console.log("[initdb] applying schema.sql ...");
  await pool.query(schema);

  const shipmentsFile = path.join(__dirname, "..", "data", "shipments.json");
  const source = JSON.parse(fs.readFileSync(shipmentsFile, "utf8").replace(/^﻿/, ""));
  const rows = source.shipments || [];
  console.log(`[initdb] seeding ${rows.length} shipments ...`);

  let inserted = 0;
  for (const row of rows) {
    const res = await pool.query(
      `INSERT INTO shipments
         (shipment_id, order_id, vertical, material, seller, sr_poc, buyer,
          br_poc, control_poc, funnel, stage_raw, dispatch_date, due_date, docs, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (shipment_id) DO NOTHING`,
      [
        row.shipmentId,
        row.orderId || null,
        row.vertical || null,
        row.material || null,
        row.seller || null,
        row.srPoc || null,
        row.buyer || null,
        row.brPoc || null,
        row.controlPoc || null,
        row.funnel || null,
        row.stageRaw || null,
        row.dispatchDate || null,
        row.dueDate || null,
        JSON.stringify(row.docs || {}),
        JSON.stringify(row),
      ]
    );
    inserted += res.rowCount;
  }

  console.log(`[initdb] done. Inserted ${inserted} new shipments (existing left untouched).`);
  await pool.end();
}

main().catch((error) => {
  console.error("[initdb] failed:", error);
  process.exit(1);
});
