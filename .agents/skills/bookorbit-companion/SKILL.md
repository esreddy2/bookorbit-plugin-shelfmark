---
name: bookorbit-companion
description: >-
  Actionable guide for developing, testing, and debugging the BookOrbit Shelfmark
  asynchronous companion bridge (bridge/bridge.mjs) and hook contracts. Use when
  modifying BookOrbit fulfillment, direct library uploads, Shelfmark hooks, or task lifecycles.
---

# BookOrbit Shelfmark Companion Architecture Guide

## Core Concepts & Invariants

### 1. Direct Library Upload & Idempotency
- **Endpoint**: `POST /api/v1/libraries/:id/upload?folderId=:folderId` (multipart form-data with file field `file`).
- **Persistence Timing**: Always persist the returned `bookId` to disk (`saveState()`) **before** invoking request fulfillment endpoints.
- **Fulfillment Retry**: If fulfillment fails or is retried later, check `task.matchedBookId`. If present, skip file upload completely.
- **Fallback**: Fall back to Book Dock staging (`/api/v1/book-dock/upload` -> readiness loop -> `/finalize`) only when direct upload returns 404.

### 2. Task ID Collisions & Safe Multi-Request Adoption
- Multiple BookOrbit requests may match the same release or Shelfmark task ID.
- In `queueRelease()`:
  - Check if `this.state.tasks[taskId]` already exists.
  - Verify edition compatibility with `areEditionsCompatible()`.
  - Atomically merge `requestId` and `userId` into existing arrays (`requestIds`, `userIds`).
  - Never overwrite `this.state.tasks[taskId] = taskRecord` unconditionally.

### 3. Independent Per-Request Fulfillment
- BookOrbit fulfills requests individually via `POST /api/v1/admin/book-requests/:id/fulfill`.
- Track each request status in `task.requestFulfillments[reqId]`.
- Classify HTTP 400 with invalid request status as `invalid_request_state` without failing the entire task.
- Set `task.status = 'fulfilled'` only if all associated `requestIds` succeed; otherwise set `task.status = 'partially_fulfilled'`.
- Reconciliation sweeps must retry only the unfulfilled request IDs.

### 4. Strict Edition Disambiguation
- Use `areEditionsCompatible(a, b)`:
  - Compares normalized title, author tokens, format, publication year, and ISBN.
  - Distinct publication years (e.g. 1818 vs 2015) or conflicting ISBNs must strictly reject compatibility.
  - Never adopt an incompatible edition during HTTP 409 Conflict inspection.

### 5. Engine.IO v4 Heartbeat Protocol
- The client connects to BookOrbit's `/book-requests` namespace with an authenticated JWT.
- Monitor server heartbeats (`pingInterval`).
- When server sends PING `2`, immediately reply with PONG `3`.
- Do not send unsolicited PING `2` packets from the client.

### 6. Shelfmark Hook Contract & Zero-Exit Safety
- `scripts/shelfmark-hook.sh` receives positional argument `$1` (target path) and rich nested JSON on `stdin`.
- Shelfmark treats non-zero exit codes as download failures. The hook must catch delivery/network errors and exit `0` so Shelfmark preserves completed files. Background reconciliation will recover the task.

## 7. OceanofPDF URL, Language, Cancellation & Progress (v1.5.6–v1.5.7)
- Shelfmark requires the real OceanofPDF page URL in `source_url`/`download_url`/`info_url`; validate before POSTing.
- Language must come from the release, never inherited from parent book metadata.
- Cancellation checks belong before queueing, importing, and fulfilling; terminal per request.
- Progress stages and failure reasons should be persisted in `requestProgress`/`requestStages`/`requestStatus` aliases.
