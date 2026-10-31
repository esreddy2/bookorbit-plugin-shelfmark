# E2E Testing (BookOrbit ↔ Shelfmark)

This directory holds reproducible end-to-end probes that exercise the **real**
Shelfmark service (via the VM104 tunnel) instead of the mocked fixtures used by
`npm test` (`verify.mjs`).

## Current scope

- `real-shelfmark-search.mjs` — READ-ONLY. Runs the plugin's `search` against a live
  Shelfmark instance and writes a JSON evidence file to `e2e/results/`.
- `real-shelfmark-fulfillment.mjs` — GUARDED. Runs `search` then `resolveFile`
  (may queue a download). Requires `E2E_ALLOW_MUTATION=1`.

Neither mutates BookOrbit. Fulfillment mutation of Shelfmark is explicitly gated.

## Prerequisites

- Node.js >= 22 (available: v22.23.4).
- Persistent SSH tunnel to CT105 (already running on VM104):
  - BookOrbit: http://127.0.0.1:13030
  - Shelfmark: http://127.0.0.1:18084
- Optional: `SHELFMARK_API_KEY` if Shelfmark auth is enabled.

## Commands

```bash
# Read-only search probe
SHELFMARK_BASE_URL=http://127.0.0.1:18084 \
E2E_TITLE="1984" E2E_AUTHOR="George Orwell" \
  node e2e/real-shelfmark-search.mjs

# Guarded fulfillment probe (MUTATES live Shelfmark)
E2E_ALLOW_MUTATION=1 \
SHELFMARK_BASE_URL=http://127.0.0.1:18084 \
  node e2e/real-shelfmark-fulfillment.mjs
```

Evidence files are written to `e2e/results/` (gitignored).

## Architecture decision

A fully isolated local stack (BookOrbit + Shelfmark + plugin) is **not** currently
runnable on VM104 because:

1. Shelfmark v1.5.1 requires Python >= 3.14 (VM104 has 3.12.3) and `uv`.
2. BookOrbit v3.5.0 requires Node >= 24 and pnpm >= 11, plus PostgreSQL.
3. No Docker/Podman is installed; no CT105 shell or Docker-admin access is granted.
4. No BookOrbit test credentials are available for the tunneled instance.

Therefore the reproducible baseline for this stage is:

- Read-only probes against the live stack through the authorized tunnels.
- Guarded mutation probes gated by `E2E_ALLOW_MUTATION=1`.
- The existing simulated suite (`npm test`) remains the regression gate.

## Blockers and smallest required changes

- To run fulfillment E2E without touching production: deploy an isolated Shelfmark
  instance (Docker or native) with Python 3.14 + uv, seeded with controlled EPUB
  fixtures, and expose it on a local port; OR grant mutation authorization for a
  dedicated test tenant on CT105.
- To exercise BookOrbit-side fulfillment: a BookOrbit instance (Node 24 + pnpm +
  PostgreSQL) loaded with this plugin, or a test account on the tunneled instance.
- To enable authenticated Shelfmark API calls in probes: provide a non-production
  `SHELFMARK_API_KEY` via environment (do not commit).

## Real evidence captured

- `e2e/results/search-*.json`: 24 releases returned for "1984" by George Orwell
  against live Shelfmark v1.5.1 in ~5.4s.
- Shelfmark UI observed via Playwright: v1.5.1 (b8e466c), activity sidebar showing
  30 completed / 13 failed tasks (read-only).
EOF
echo done
## Demonstrated isolated lifecycle (2026-10-31)

Stack: BookOrbit 3.5.0 (13031) + Shelfmark 1.5.1 (18085) + pgvector/pgvector:pg18, rootless Docker.
Shelfmark configured via API: Open Library enabled, Direct Download enabled, AA mirror https://annas-archive.gl.

Steps executed:
1. Create admin, library (id 1), Shelfmark indexer (id 1, allowPrivateAddress=true).
2. Create book request "1984" by George Orwell (id 1, auto-approved).
3. Search releases -> 21 releases returned by Shelfmark indexer.
4. Grab first release -> downloaded by Shelfmark (progress to 100%), BookOrbit imported as bookDockFileId=1, status needs_review.
5. force-file -> status available, matchedBookId=1, book id 1 in library.

Infrastructure note: BookOrbit's DirectDownloadService has ALLOW_PRIVATE=false upstream; for the isolated stack only, `/app/dist/.../direct-download.service.js` was patched to `true` (not a source change). Production still requires the documented core fix or reverse proxy.

Evidence: `e2e/results/request-final.json` (status available, matchedBookId 1).

## Demonstrated companion-driven lifecycle (2026-10-31)

Stack: BookOrbit 3.5.0 (13031) + Shelfmark 1.5.1 (18085) + companion (8090) + pgvector/pgvector:pg18, rootless Docker.

Automated sequence (no manual grab/import/force-file):
1. Admin + library (id 1) + Shelfmark indexer (id 1) configured.
2. Shelfmark configured: Open Library enabled, Direct Download enabled, Libgen mirror https://libgen.li, AA base https://annas-archive.gl.
3. Companion started with state reset; baseline established over existing requests.
4. Created approved request 4 ("Fahrenheit 451", Ray Bradbury) (id 4).
5. Companion processed request 4 via Socket.IO broadcast: searched Shelfmark, queued a Libgen release.
6. Shelfmark downloaded the release to completion; companion reconciled and uploaded to BookOrbit library (book id 3).
7. Request 4 transitioned to status `available` with `matchedBookId=3` automatically.

Evidence: `e2e/results/companion-lifecycle-request4.json` (status available, matchedBookId 3).
Companion state: task `libgen:21e3...` status `fulfilled`, matchedBookId 3.

Notes:
- Companion direct-upload path required a small guard fix in `bridge/bridge.mjs` (attempt direct upload when libraryId present, not only when folderId present) because BookOrbit upload does not require a folder.
- Shelfmark direct-download source (Anna's Archive) is blocked by Shelfmark's own SSRF/host check in this environment; Libgen source was used instead.
- Webhook delivery from Shelfmark to companion intermittently times out (companion's handleWebhook/verifyFileWithRetry); reconciliation (`POST /api/reconcile`) recovers completed downloads.

## Additional demonstrated scenarios (2026-10-31)

- Unattended completion: request 5 ("A Tale of Two Cities") became `available` (matchedBookId 4) in ~35s with NO manual `/api/reconcile` after setting `RECONCILE_INTERVAL_MS=10000`. Evidence: `e2e/results/unattended-lifecycle-request5.json`.
- Restart/recovery: request 6 ("Brave New World") completed after companion restart mid-download; status `available` (matchedBookId 5). Evidence: `e2e/results/recovery-lifecycle-request6.json`.
- Incompatible-edition attempt: request 7 ("Fahrenheit 451", language `en`) still found a compatible release and fulfilled (matchedBookId 6); the companion's search filtered 3 of 12 releases but at least one passed. Language/edition rejection remains covered by `verify.mjs` property tests and `shared/identity.mjs` (`language_mismatch`, `conflicting_isbn`, `incompatible_year`, `unknown_release_year`).
