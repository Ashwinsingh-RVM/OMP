# OMP Shipment Tracker

Internal ops CRM / transaction control tower for Recykal.Market's Open Marketplace.
A single Node `http` app (no framework) that serves a static dashboard and a small JSON API.

## Two runtime modes, one codebase

Everything is additive with a working local fallback — the app boots with **zero env vars**.

| Concern | No env vars (local dev) | Production (env vars set) |
|---|---|---|
| **Data store** | `data/shipments.json` + `data/updates.json` | Postgres (set `DATABASE_URL`) |
| **Auth** | `?user=<email>` dev switcher | Google OAuth 2.0 (set the 3 Google/session vars) |

The two are independent — you can run Postgres with dev auth, or JSON with OAuth, etc.

## Quick start (local, no setup)

```bash
npm install          # installs pg (only needed for the Postgres path)
npm start            # http://localhost:4332  (or set PORT)
```

Open `http://localhost:4332`. Switch the acting associate with the header dropdown
(or `?user=<email>` — see `/api/users` for the list). No database, no Google, nothing else needed.

## API (unchanged shapes — the frontend depends on these exactly)

- `GET /api/bootstrap?user=<email>` → `{ summary, shipments, stages, docs, user, users }`
- `GET /api/users` → `{ users }`
- `GET /api/shipments/:id?user=<email>` → `{ shipment, timeline }`
- `POST /api/updates` → `{ ok, event }`
- `GET /api/me` → `{ user, authMode, authenticated }` *(new, additive)*

## Architecture of the deploy work

- **`db/store.js`** — async store adapter: `getShipments()`, `getUpdates()`, `addUpdate(event)`.
  Picks Postgres when `DATABASE_URL` is set, else the JSON files. `server.js` reads/writes
  the raw source through this; all of `loadState()` / normalize / doc-gate / scope /
  `buildSummary` logic is unchanged.
- **`db/schema.sql`** — `shipments` (typed columns + `docs` + `raw` JSONB) and `updates`.
- **`db/init.js`** (`npm run initdb`) — creates tables and seeds shipments from JSON. Idempotent.
- **`auth/google.js`** — zero-dependency Google OAuth code flow + HMAC-signed session cookie,
  mounted on the existing `http` server (no Express, so the static serving and all four API
  routes keep identical paths/shapes).

**Why zero-dep OAuth instead of Express?** Moving to Express would mean re-mounting the static
server and every route, risking the API contract another agent depends on. The auth-code flow is
a direct server-to-server TLS exchange with Google, so decoding + claim-checking the `id_token`
(`aud`, `iss`, `exp`, `email_verified`) is sufficient. `pg` is the only added dependency.

## Environment variables

See `.env.example`. All optional.

| Var | Purpose |
|---|---|
| `PORT` | HTTP port (Railway injects it; local default 4332) |
| `DATABASE_URL` | Postgres connection string → enables the Postgres store |
| `GOOGLE_CLIENT_ID` | Google OAuth client id → (with the two below) enables OAuth |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `SESSION_SECRET` | random string that signs session cookies |
| `GOOGLE_CALLBACK_URL` | authorized redirect URI (else derived from request host) |
| `AUTH_USERS` | *(optional)* JSON mapping real Google emails → internal user email/scope |

OAuth turns on only when `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `SESSION_SECRET`
are **all** present.

---

## Deploy: Railway + Google Cloud

### a) Create the Railway project + Postgres

1. Push this repo to GitHub.
2. Railway → **New Project → Deploy from GitHub repo** → pick this repo. It builds via
   Nixpacks and runs `npm start` (see `railway.json`).
3. In the project, **New → Database → Add PostgreSQL**.
4. On the app service → **Variables**, add a reference var:
   `DATABASE_URL = ${{Postgres.DATABASE_URL}}`
   (Railway's external URL requires SSL; the store enables `ssl: { rejectUnauthorized: false }`
   automatically for non-localhost URLs.)

### b) Initialize + seed the database

Run once, pointed at the Railway Postgres. Either locally with the public connection string:

```bash
# copy the Postgres "Public Network" connection string from Railway
DATABASE_URL="postgresql://...railway.app:5432/railway" npm run initdb
```

or from a Railway shell (`railway run npm run initdb`). It creates the tables and seeds the
130 shipments. It is idempotent — re-running never duplicates or errors.

### c) Create a Google Cloud OAuth client

1. https://console.cloud.google.com → create/select a project.
2. **APIs & Services → OAuth consent screen** → Internal (or External) → add your domain,
   scopes `openid`, `email`, `profile`.
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID → Web application**.
4. **Authorized redirect URIs** → add exactly:
   `https://<your-app>.up.railway.app/auth/google/callback`
   (and `http://localhost:4332/auth/google/callback` for local OAuth testing).
5. Copy the **Client ID** and **Client secret**.

### d) Set the app env vars (Railway → Variables)

```
GOOGLE_CLIENT_ID=<from step c>
GOOGLE_CLIENT_SECRET=<from step c>
GOOGLE_CALLBACK_URL=https://<your-app>.up.railway.app/auth/google/callback
SESSION_SECRET=<node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
# optional:
AUTH_USERS={"someone@recykal.com":"aishwarya@local.associate"}
```

### e) Deploy

Railway redeploys on push (or click **Deploy**). Visit the app URL → you'll be redirected to
`/login.html` → **Continue with Google** → back to the dashboard, scoped to the matched POC.
`/auth/logout` clears the session.

### Notes / gotchas

- `pg.Pool` is created once at module load (not per request).
- Session cookie is `HttpOnly`, `SameSite=Lax` (Lax so it survives the redirect back from
  Google), `Secure` when the request is HTTPS.
- Unknown-but-valid Google logins become a flagged **guest** with no shipments; map them via
  `AUTH_USERS` to grant scope.
