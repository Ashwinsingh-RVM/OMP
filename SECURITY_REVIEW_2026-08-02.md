# Security Review: OMP Shipment Tracker on localhost:4340

Date: 2026-08-02
Scope: black-box checks against http://localhost:4340/ plus source review of C:\Users\ashwinkumar.singh\omp-tracker-claude.

## Summary

The app is easy to access and modify in the current dev-mode configuration if the machine is reachable from the network. The most serious issues are unauthenticated admin data exposure, user impersonation through query parameters, and unauthenticated update writes.

I did not POST test data to /api/updates because that would mutate data/updates.json.

## Findings

### Critical: Dev mode exposes all shipment data as Local Admin

Evidence:
- GET /api/me returns authMode=dev and authenticated=true.
- GET /api/bootstrap returns 130 shipments as Local Admin by default.
- server.js:383 defaults to local@recykal.test.
- server.js:384 falls back to users[0], which is Local Admin.

Impact:
Anyone who can reach the server can read all shipment, buyer, seller, payment, owner, document, and timeline metadata.

Fix:
Do not default to admin. In dev mode, require an explicit DEV_ALLOW_IMPERSONATION=true flag. Unknown users should become guest/no scope, not admin.

### Critical: Server listens on all interfaces

Evidence:
- netstat showed 0.0.0.0:4340 and [::]:4340 listening.
- server.js:511 calls server.listen(PORT) without host.

Impact:
The app is not laptop-only. Anyone on the same network may reach it unless blocked by firewall.

Fix:
Use server.listen(PORT, '127.0.0.1') for local dev. Only bind 0.0.0.0 intentionally behind auth/reverse proxy.

### Critical: /api/updates accepts unauthenticated writes and does not scope-check shipmentId

Evidence:
- server.js:467 handles POST /api/updates.
- server.js:468-471 reads body, creates event, only checks shipmentId exists as a string, then store.addUpdate(event).
- There is no verification that the caller is authenticated or allowed to update that shipment.

Impact:
An attacker can append fake timeline/doc/stage/follow-up events if they can reach the service. This can corrupt operational workflow and audit history.

Fix:
Require auth for POST. Resolve server-side actor from session, ignore client-provided actor/actorEmail, verify shipment belongs to scopedShipments, validate type/key/value/status/reason allowlists.

### High: User impersonation via ?user= leaks scoped data and can fall back to admin

Evidence:
- server.js:383 uses ?user=<email> in dev mode.
- /api/users lists valid local emails.
- GET /api/bootstrap?user=ashwin@local.associate returned scoped data.
- GET /api/bootstrap?user=not-real@example.com fell back to Local Admin with 130 shipments.

Impact:
Any user can enumerate users and switch identity. Unknown user gives admin, which is worse.

Fix:
Remove /api/users in unauthenticated/dev mode or hide it behind admin auth. Unknown requested users should return 403 or guest scope.

### Medium: Missing security headers

Evidence:
- Response headers only include Content-Type and Cache-Control; no CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy.

Impact:
Does not cause compromise alone, but worsens XSS/clickjacking/blended attacks if any render sink becomes unsafe.

Fix:
Add baseline headers: Content-Security-Policy, X-Content-Type-Options: nosniff, X-Frame-Options: DENY or frame-ancestors 'none', Referrer-Policy: no-referrer.

### Medium: Google OAuth id_token is decoded without JWKS signature verification

Evidence:
- auth/google.js:172 decodes id_token.
- auth/google.js:176 comment says full RS256 JWKS verification is not required.

Impact:
The auth-code token exchange reduces risk, but signature verification is still the robust standard for validating ID tokens.

Fix:
Verify id_token signature using Google JWKS, or use a maintained OAuth/OIDC library.

### Low/Informational: Static path traversal appears blocked

Evidence:
- GET /..%2f..%2fWindows%2fwin.ini returned 403.
- server.js:477-480 checks PUBLIC prefix.

Impact:
Good. Keep this guard.

### Low/Informational: XSS risk appears mostly controlled in active modular frontend

Evidence:
- User-facing fields in crm.js/core.js are largely escaped using H.esc.
- Timeline event note/actor/value rendering is escaped in core.js:155-158.

Caveat:
index.html boot catch uses document.body.innerHTML with raw error message. Practical exploitability is low unless an attacker can influence boot exception text.

Fix:
Use textContent for boot errors or wrap through OMP.helpers.esc where available.

## Recommended Fix Order

1. Bind local dev to 127.0.0.1.
2. Remove admin fallback for unknown/missing user.
3. Require auth/scope checks for POST /api/updates.
4. Hide /api/users unless authenticated admin.
5. Validate update payload allowlists and length limits.
6. Add security headers.
7. Verify Google ID token signatures with JWKS.

## Quick Hardening Patch Direction

- Change server.listen(PORT) to server.listen(PORT, process.env.HOST || '127.0.0.1').
- In resolveUser dev mode: if no requested user and no explicit ALLOW_LOCAL_ADMIN, return guest.
- For POST /api/updates: reject guest, find shipment in scopedShipments, reject if not found.
- createEvent should use server-side user.name/user.email, not payload actor fields.
- Add sendSecurityHeaders(res) before all responses.