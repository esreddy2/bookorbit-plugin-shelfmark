# API Integration Audit — Confirmed Non-Fixed Findings (v1.5.7)

## Confirmed (still present)

### Hook (`scripts/shelfmark-hook.sh`)
1. Fallback payload lacks `task_id`.

### BookOrbit permissions / ownership
1. Library access separate from `LibraryUpload`.
2. Target library must be type `books`.
3. Book Dock finalize requires `LibraryUpload` + `BookDockAccess`.
4. Library-scoped lookup requires viewer access; global fallback can match incompatible editions.
5. `ManageBookRequests` effectively mandatory.
6. Folder ownership unchecked.
7. Partial-permission Book Dock state can strand uploads.

### Test coverage gaps (`verify.mjs`)
1. `parseShelfmarkStatus` aliases untested.
2. AuthManager native-login/refresh untested.
3. `verifyFile` directory targets untested.
4. `/api/releases` `source` forwarding untested.
5. Book Dock `filed`/`errorMessage` paths untested.
6. Multi-file webhook payloads untested.

### Eighth-round additional findings

#### `verify.mjs` coverage gaps
1. `extractEpubMetadata` buffer-based export untested.
2. `parseShelfmarkStatus` alias groups untested.
3. `verifyFile` directory targets untested.
4. `/api/releases` `source` forwarding untested.
5. Book Dock `filed`/`errorMessage` paths untested.
6. Multi-file webhook payloads untested.
7. Webhook task ID mismatch handling untested.
8. `BookOrbitAuthManager.login()` native login untested.
9. `BookOrbitSocketClient` auth/reconnect/event parsing untested.
10. `findAuthoritativeBookOrbitBook` endpoint fallback untested.
11. Search payload contract fields unasserted.
12. Companion HTTP server invalid JSON/404 handling untested.

### Tenth-round additional findings

#### Concurrency/races (`bridge/bridge.mjs`, `index.mjs`)
1. HTTP handlers run concurrently with no global lock; state snapshots can interleave.
2. Module-level `inFlightResolutions` uncoordinated across processes.

#### URL construction/encoding
1. `getRequestStatus` first probes non-admin endpoint.

### Eleventh-round additional findings

#### Regex/title matching (`index.mjs`)
1. `rel.author` is not part of Shelfmark `Release` API (dead branch).

#### Env/config handling
1. Undocumented/option-only env handling.

### Twelfth-round additional findings

#### `index.mjs`
1. `/api/status` task objects expose only `id`, so edition-safety guards checking `year`/`isbn`/`source_id`/`book_id`/`task_id` are inert.
2. `/api/releases/download` returns no task ID, so `task_id`/`taskId`/`id` parsing is dead.

## Conclusion
Remaining risks are confined to the confirmed list above. Items previously confirmed as fixed in the working tree have been purged.

" filePath">
/home/dev/projects/personal/bookorbit-plugin-shelfmark/API_INTEGRATION_AUDIT.md
## Thirteenth-round additional findings

### File system / path handling
1. Hook fallback path payload missing metadata/destination.

### Exports / API surface
1. `MAGIC_BYTES`/`sanitizeLog` untested.

### String literals / URL construction
1. Bridge status correlation relies on nonexistent `source_id` field in Shelfmark `/api/status`.


## Testing policy note
Tests must catch present errors and assert real behavior; they must not be written with predetermined expected values merely to pass. New test additions are not secondary implementations—they will be audited in the next audit and must be completed thoroughly. Do not weaken assertions to make tests pass.
