# OMP CRM — Project Log

Full record of what was built, decided, deployed, and what's next. Recykal Open Marketplace (recyclables B2B: Plastic + Metal scrap) — a CRM to drive every shipment through a 7-stage funnel to closure ("clear it").

---

## 1. What it is
A CRM-style ops dashboard. Ops associates follow each shipment/transaction and push it to closure — updating stage, documents, reasons, payment, and follow-ups directly on the dashboard (replacing the manual `OMP-TRACKER.xlsx`).

**Funnel (7 stages):** Match Making → Pre-Dispatch → In-Transit → Vehicle Reached → Quality Check → Completed (+ Rejected).

---

## 2. Where everything lives
| Thing | Location |
|---|---|
| Working code (the real one) | `C:\Users\ashwinkumar.singh\omp-tracker-claude` — port **4340** local (dev, bound 127.0.0.1) |
| GitHub | `github.com/Ashwinsingh-RVM/OMP` (branch `main`) |
| Live app | **https://omp-tracker-production.up.railway.app** (HTTP Basic Auth — password `H6SgXAnWEU9liT`) |
| Railway project | `omp-tracker` on DRS-RVM workspace |
| Database | Railway **Postgres** (`Postgres-s9Uk`), auto-seeds 130 shipments on boot |
| ⚠️ Separate folder | `C:\Users\ashwinkumar.singh\omp-tracker` (port 4330) is a ChatGPT/other-tool copy — DO NOT edit both (they clobber) |

---

## 3. Architecture
```
public/
  index.html      — shell (header, tabs, per-page containers)
  core.js         — shared state, data layer, helpers, page registry, boot
  boot.js         — boot entry (split out for CSP)
  styles.css      — design system (Recykal green/gold, Poppins + JetBrains Mono)
  pages/          — one file per page: overview, work, crm, pipeline, insights, trends
server.js         — zero-dependency Node http server + rate limiting + auth gate
db/               — store.js (JSON ⇄ Postgres auto-switch), schema.sql, init.js
auth/google.js    — Google OAuth (dormant — not enabled yet)
data/             — shipments.json (130 seed), updates.json (event timeline)
```
**Data flow:** routes → store (JSON or Postgres) → derived state (funnel, docs, payment, cause) → pages render from `OMP.state`.

---

## 4. Pages / features built
- **Overview** — personal KPI console + emoji pastel funnel + today's work + priority queue (scoped to your own shipments)
- **My Work** — your queues + performance snapshot (own-scoped)
- **Shipment CRM** — filterable list + cockpit: stage stepper (pinpoints), Update Stage + **reason dropdown** (why stuck), **Payment box** (invoice/due date, days overdue, paid/balance), **Document Verification** (color dropdown per doc — status only, NO file upload), follow-up, timeline; read-only for shipments you don't own
- **Pipeline** — org-wide stage funnel + list
- **Why Pending** — cause-first breakdown (auto-derived cause per open shipment) + by-stage + by-owner; click → CRM filtered
- **Trends** — transactions over time; **Bar / Line / Pie** + **Daily / Weekly / Monthly** + range (last 30d default)
- **Paid vs Balance** shown everywhere (payMini)
- **Recykal logo** + brand identity

---

## 5. Permission model (read-all / edit-own)
- Associates **SEE every shipment** (read-only) but **EDIT only ones assigned to them** (name on Control/SR/BR POC).
- Server enforces `canEditShipment` on writes; cockpit renders read-only + banner + disabled controls for non-owned; list shows a lock.
- Admin (`local@recykal.test`) edits all. "My shipments" filter + default-select-own for associates.

---

## 6. Security (red-team → fix cycle)
Two-agent exercise: attacker probed, defender fixed.

**Held (attacker failed):** SQL injection, stored/reflected XSS, path traversal, IDOR/scoping, prototype pollution, input validation, secrets exposure.

**Fixed & deployed:** per-IP rate limiting (100/10s → 429) + auth-brute-force gate (10/60s), loadState 2s cache, generic error messages, deployed-mode ignores body `actorEmail`, CSP dropped script `unsafe-inline` (boot → `/boot.js`). Plus earlier: 127.0.0.1 dev bind, no unknown→admin fallback, payload allowlists, security headers, HTTP Basic Auth gate.

**⚠️ OPEN CRITICAL:** live runs `authMode: dev` → the shared `APP_PASSWORD` is the only layer and past it the default identity is admin. Real fix = enable **Google OAuth** (per-user), which needs the owner's Google Cloud OAuth client.

---

## 7. Pending / next (owner to define)
1. **Real data pipeline** — how backend/sheet shipments feed the dashboard (currently a frozen xlsx snapshot; new shipments don't auto-appear). Options: periodic re-import, in-app "New Shipment" form, or Sheets ⇄ app sync.
2. **Auto-assign logic** — how shipments get assigned to associates (by vertical / region / load).
3. **Google OAuth** — per-user login (redirect URI `.../auth/google/callback`; needs Client ID + Secret → set `GOOGLE_CLIENT_ID/SECRET/CALLBACK_URL/SESSION_SECRET` + `AUTH_USERS`).
4. **GitHub → Railway auto-deploy** — dashboard connect so every push deploys.

---

## 8. "OMP Brain" roadmap (autonomous ops agent — Jarvis for OMP)
Realistic phased plan. A true self-aware AGI isn't feasible; a capable autonomous ops-brain is.

**6 layers:** Perception (data in) → Memory (DB/feature store) → Brain (Rules + ML + optional LLM) → Action (autonomous with human-in-loop) → Interface (Ask-JARVIS chat) → Learning (feedback → retrain).

| Phase | What | Notes |
|---|---|---|
| **0. Foundation** | DB, dashboard, timeline | ~done; needs data pipeline |
| **1. Reflexes (rules)** | auto-assign, SLA flags, auto follow-up, alerts, daily brief | buildable now, no ML — first real "autonomous" step |
| **2. Instincts (ML)** | stuck/delay predictor, ETA, payment-risk, anomaly detection, smart-assign, remark NLP | Python + XGBoost/sklearn, retrain daily |
| **3. Voice (LLM)** | Ask-JARVIS chat, summaries, draft comms, reasoning | to avoid ChatGPT/Claude dependency → self-host Llama/Mistral (GPU) or API to start |
| **4. Agency** | confidence-based autonomous actions + approvals + audit + kill-switch | safety-gated |
| **5. Learning loop** | outcomes → retrain → improves | |

**Highest ROI:** Phase 1 + 2 (auto-act + predict) = ~80% of the "Jarvis feel". **Data quality = everything** (build the pipeline first).

**Stack:** Node (app) + Postgres (memory) + Python microservice (ML/brain) + Redis (queue/cache) + n8n/cron (automation) + self-hosted LLM (Phase 3).

---

*This log is the durable record of the project so far. Update it as the build progresses.*
