-- OMP Shipment Tracker — Postgres schema
-- Applied by `npm run initdb` (db/init.js). Safe to re-run (idempotent).

-- Source shipment rows. Typed columns are for query/reporting; the app reads
-- shipments through the `raw` JSONB column so the row shape round-trips
-- byte-for-byte identical to data/shipments.json. `docs` is broken out for
-- convenience but the authoritative copy also lives inside `raw`.
CREATE TABLE IF NOT EXISTS shipments (
  shipment_id    TEXT PRIMARY KEY,
  order_id       TEXT,
  vertical       TEXT,
  material       TEXT,
  seller         TEXT,
  sr_poc         TEXT,
  buyer          TEXT,
  br_poc         TEXT,
  control_poc    TEXT,
  funnel         TEXT,
  stage_raw      TEXT,
  dispatch_date  TEXT,
  due_date       TEXT,
  docs           JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw            JSONB NOT NULL
);

-- Append-only event log. Mirrors the event objects produced by createEvent()
-- in server.js. created_at is timestamptz; the store returns it as an ISO
-- string so downstream string comparisons keep working.
CREATE TABLE IF NOT EXISTS updates (
  id           UUID PRIMARY KEY,
  shipment_id  TEXT NOT NULL,
  type         TEXT NOT NULL,
  key          TEXT DEFAULT '',
  value        TEXT DEFAULT '',
  note         TEXT DEFAULT '',
  actor        TEXT DEFAULT '',
  actor_email  TEXT DEFAULT '',
  due_date     TEXT,
  status       TEXT DEFAULT 'open',
  reason       TEXT DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- For an already-created table (older deploys), add the column if missing.
ALTER TABLE updates ADD COLUMN IF NOT EXISTS reason TEXT DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_updates_shipment_id ON updates (shipment_id);
CREATE INDEX IF NOT EXISTS idx_updates_created_at ON updates (created_at);

-- Second auth factor. After Google SSO the user must also enter a PIN, so a
-- compromised Google account alone does not open the CRM. Only the PIN's scrypt
-- hash is stored — the PIN itself is never written anywhere. `email` is the real
-- Google address, lowercased. PINs are set and reset by admins only; a row's
-- absence means "no PIN issued yet", and that account cannot get in.
CREATE TABLE IF NOT EXISTS pins (
  email       TEXT PRIMARY KEY,
  salt        TEXT NOT NULL,
  hash        TEXT NOT NULL,
  set_by      TEXT DEFAULT '',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
