# Repository Guidelines: bookorbit-plugin-shelfmark

## 1. Safety & Production Isolation
- **Zero Production Mutation**: Never access, deploy to, or modify production servers, live databases, or native BookOrbit plugin mounts.
- **Disposable Test Requests**: Historical test requests are disposable; never implement or run recovery operations for them.
- **Mount-Only Deployments**: Production rollouts modify only the companion service container mount.

## 2. Companion Bridge Architectural Invariants
- **Idempotent Failure Transitions**:
  - Always track attempts with durable identifiers (`shelfmark:${taskId}` or `queue:${releaseKey}`).
  - Never increment attempt counters simply because an error-state task remains in Shelfmark history.
  - Strictly enforce `maxSourceAttempts` (default: 3) to prevent infinite retry loops.
- **Strict Edition Compatibility**:
  - Normalized title, author, publication year, format, and ISBN must be verified.
  - A known requested year with an unknown release year must NOT be treated as a match unless verified by matching ISBN or OPF metadata extracted directly from the EPUB container.
  - When a release candidate collides with an existing task representing a different edition, iterate to next eligible candidates; never blacklist candidates merely due to task edition collisions.
- **Idempotent Uploads & Fulfillment**:
  - Handle BookOrbit HTTP 409 destination conflicts by querying library book records authoritatively; never assume filename conflicts mean identical editions.
  - Network timeouts and lost upload responses must transition to `uncertain_upload` and reconcile authoritatively before re-attempting upload.
  - Preserve `matchedBookId` once obtained and retry only unfulfilled request IDs.
  - Maintain `requestFulfillments` across reconciliation runs; do not reset completed requests on partially fulfilled tasks.
- **Non-Destructive Task Merging**:
  - When reconciling uncertain queues or adopting tasks, merge non-destructively: preserve existing `requestIds`, `userIds`, `matchedBookId`, and fulfillment history.

## 3. Testing & Verification Standards
- Run tests via `npm test` (`node verify.mjs`).
- Never weaken assertions to make tests pass.
- Any bug fix or lifecycle change must be accompanied by realistic regression test cases in `verify.mjs`.

## 4. Release & Publishing Protocol
When asked to create, sign, or publish a release:
1. Verify all tests pass: `npm test`.
2. Update version in `package.json` and `verify.mjs`.
3. Sign release: `node scripts/sign-release.mjs <new-version>`. This updates `index.mjs`, validates the Ed25519 signature, and writes `updates/shelfmark.json`.
4. Re-run `npm test` to confirm manifest signature and digest verification tests pass.
5. Commit all changed files with descriptive notes and tag `v<new-version>`.
6. Push commits and tags: `git push origin main --tags`.
7. Create GitHub release with attached asset:
   ```bash
   GH_TOKEN=... gh release create v<new-version> index.mjs --repo esreddy2/bookorbit-plugin-shelfmark --title "..." --notes "..."
   ```

## 5. OceanofPDF, Language, Cancellation & Progress Invariants (v1.5.6–v1.5.7)
- Preserve and validate the real OceanofPDF page URL (`source_url`/`download_url`/`info_url`); never synthesize from hashed `source_id`.
- Do not treat parent book language as proof of edition language; unknown stays unknown; reject known mismatches.
- Do not confuse canonical title equivalents with translated editions.
- Never claim a release has the request's ISBN without independent evidence.
- Cancellation is terminal per request; preserve shared downloads for other active requests.
- Record progress stages and meaningful failure reasons in companion state (`requestProgress` and aliases).
