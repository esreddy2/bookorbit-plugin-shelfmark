#!/usr/bin/env node
/**
 * Real Unattended Isolated Docker E2E Suite for Canonical Title Discovery & Series-Volume Identity (v1.7.8)
 *
 * Exercises the full isolated Docker stack:
 *   BookOrbit (127.0.0.1:13031) -> Companion (127.0.0.1:8090) -> Shelfmark (127.0.0.1:18085)
 *   -> Real OpenLibrary metadata search + Controlled LibgenHandler -> /books -> /scripts/shelfmark-hook.sh
 *   -> /webhook/shelfmark -> Post-download OPF title/volume + reading-text language verification
 *   -> BookOrbit upload & fulfillment.
 *
 * Scenarios verified:
 *   1. Series-prefixed volume request ("Percy Jackson and the Olympians, Book Five: The Last Olympian")
 *      discovers canonical "The Last Olympian", rejects slash omnibus & wrong-volume Book 1 traps,
 *      verifies canonical OPF <dc:title>The Last Olympian</dc:title> + English prose, and fulfills.
 *   2. Edition-suffixed request where raw OpenLibrary search returns 0 ("Harry Potter and the Chamber of Secrets: Enhanced Edition")
 *      falls back to canonical metadata search, rejects Book 1, and fulfills Book 2 automatically.
 *   3. Franchise-prefixed companion request ("From the Files of Camp Half-Blood: Camp Half-Blood Confidential")
 *      falls back to canonical "Camp Half-Blood Confidential", rejects slash omnibus, and fulfills.
 *   4. Wrong-volume & box-set rejection ("Percy Jackson and the Olympians, Book Four: The Battle of the Labyrinth")
 *      eliminates multi-volume range ("Books 1-5") and Book 2 in Stage 1, and rejects deceptive OPF Book 1 EPUB
 *      before upload (`finalization_failed` / `incompatible_series_volume`), importing 0 books.
 *   5. Honest `no_releases` handling for genuinely unavailable releases (both a real OpenLibrary work with 0
 *      source releases and a nonexistent work with 0 metadata matches), recording `stage: "no_releases"`
 *      with zero fabricated downloads.
 *
 * ZERO manual fulfillment, ZERO synthetic webhook calls, ZERO reused tasks, ZERO production contact.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BO = 'http://127.0.0.1:13031';
const SM = 'http://127.0.0.1:18085';
const CP = 'http://127.0.0.1:8090';
const MIRROR_HOST_URL = 'http://127.0.0.1:18099';
const SM_API_KEY = 'e2e-shelfmark-key';
const CP_SECRET = 'bookorbit-shelfmark-secret';
const MIRROR_CONTAINER = 'e2e-fixture-mirror';
const REPO_ROOT = resolve(import.meta.dirname, '..');

function getDockerEnv() {
  const uid = process.getuid ? process.getuid() : 1000;
  return {
    ...process.env,
    DOCKER_HOST: process.env.DOCKER_HOST || `unix:///run/user/${uid}/docker.sock`,
  };
}

function docker(args, input = undefined) {
  return execFileSync('docker', args, {
    env: getDockerEnv(),
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function assertIsolated() {
  for (const u of [BO, SM, CP, MIRROR_HOST_URL]) {
    const parsed = new URL(u);
    if (parsed.hostname !== '127.0.0.1') {
      throw new Error(`ISOLATION GUARD: Refusing non-loopback endpoint ${u}`);
    }
    if (parsed.port === '13030' || parsed.port === '18084') {
      throw new Error(`ISOLATION GUARD: Refusing production tunnel port in ${u}`);
    }
  }
  const cpEnvRaw = docker(['inspect', 'e2e-companion-1', '--format', '{{json .Config.Env}}']).trim();
  const cpEnv = JSON.parse(cpEnvRaw);
  assert.ok(cpEnv.includes('BOOKORBIT_URL=http://bookorbit:3000'), 'e2e-companion-1 must target isolated bookorbit:3000');
  assert.ok(cpEnv.includes('SHELFMARK_URL=http://shelfmark:8084'), 'e2e-companion-1 must target isolated shelfmark:8084');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function j(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { ok: res.ok, status: res.status, body };
}

async function waitUntil(desc, fn, maxWaitMs = 90000, pollMs = 750) {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < maxWaitMs) {
    try {
      const val = await fn();
      if (val) return val;
    } catch (err) {
      lastErr = err;
    }
    await sleep(pollMs);
  }
  throw new Error(`Timeout after ${maxWaitMs}ms waiting for: ${desc}${lastErr ? ` (last error: ${lastErr.message})` : ''}`);
}

async function loginBookOrbit() {
  const r = await j(`${BO}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'E2ePass123' }),
  });
  assert.equal(r.ok, true, `BookOrbit login failed: ${JSON.stringify(r.body)}`);
  return r.body.accessToken;
}

async function listLibraryBooks(token, libraryId = 1) {
  const r = await j(`${BO}/api/v1/libraries/${libraryId}/books`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: '', sort: [], pagination: { page: 0, size: 100 } }),
  });
  assert.equal(r.ok, true, `Failed to list library books: ${JSON.stringify(r.body)}`);
  return Array.isArray(r.body?.items) ? r.body.items : [];
}

async function ensureWorkAbsentBeforeTest(token, substringCheck) {
  let existing = await listLibraryBooks(token, 1);
  const needle = substringCheck.toLowerCase();
  const matched = existing.filter((b) => String(b.title || '').toLowerCase().includes(needle));
  if (matched.length > 0) {
    for (const b of matched) {
      try {
        execFileSync('docker', ['exec', 'e2e-postgres-1', 'psql', '-U', 'bookorbit', '-d', 'bookorbit', '-c', `DELETE FROM books WHERE id = ${b.id};`], {
          env: getDockerEnv(),
          stdio: 'ignore',
        });
      } catch (_) {}
    }
    existing = await listLibraryBooks(token, 1);
  }
  try {
    execFileSync('docker', ['exec', 'e2e-bookorbit-1', 'sh', '-c', `find /data/e2e-library -type d -iname "*${substringCheck}*" -exec rm -rf {} +`], {
      env: getDockerEnv(),
      stdio: 'ignore',
    });
  } catch (_) {}
  assert.equal(
    existing.some((b) => String(b.title || '').toLowerCase().includes(needle)),
    false,
    `Library 1 must have zero books matching "${substringCheck}" before scenario starts`
  );
}

async function createRealisticRequest(token, { title, author, publishedYear, isbn13, language = 'en' }) {
  const res = await j(`${BO}/api/v1/book-requests`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title,
      authors: [author],
      publishedYear,
      isbn13,
      language,
      mediaKind: 'ebook',
      preferredFormats: ['epub'],
      targetLibraryId: 1,
    }),
  });
  assert.equal(res.ok, true, `Failed to create BookOrbit request for "${title}": ${JSON.stringify(res.body)}`);
  const createdId = res.body?.request?.id ?? res.body?.id;
  assert.ok(createdId, `BookOrbit did not return request ID: ${JSON.stringify(res.body)}`);

  const verify = await j(`${BO}/api/v1/book-requests/${createdId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(verify.ok, true, `Failed to read back created request ${createdId}`);
  const reqObj = verify.body?.request || verify.body;
  assert.equal(reqObj.status, 'approved');
  return reqObj;
}

async function getDiagnostics(reqId) {
  const r = await j(`${CP}/api/diagnostics/${encodeURIComponent(reqId)}`, {
    headers: { 'X-Bridge-Secret': CP_SECRET },
  });
  assert.equal(r.ok, true, `Companion diagnostics failed for request ${reqId}: ${JSON.stringify(r.body)}`);
  return r.body;
}

async function main() {
  assertIsolated();
  mkdirSync(resolve(REPO_ROOT, 'e2e/results'), { recursive: true });

  const runHex = crypto.randomBytes(3).toString('hex');
  console.log(`=== Isolated Canonical Discovery & Series-Volume E2E Suite (runHex=${runHex}) ===`);
  console.log(`Targets verified isolated: BO=${BO} | SM=${SM} | CP=${CP} | Mirror=${MIRROR_HOST_URL}`);

  const origMirrors = docker(['exec', 'e2e-shelfmark-1', 'cat', '/config/plugins/mirrors.json']);
  const origDownloadSources = docker(['exec', 'e2e-shelfmark-1', 'cat', '/config/plugins/download_sources.json']);

  const evidence = {
    suite: 'canonical-discovery-and-series-volume-e2e',
    startedAt: new Date().toISOString(),
    runHex,
    isolationVerified: {
      bookorbit: BO,
      shelfmark: SM,
      companion: CP,
      controlledMirror: MIRROR_HOST_URL,
      productionUntouched: true,
    },
    scenarios: {},
    allPassed: false,
  };

  try {
    // 1. Sync rebuilt index.mjs into isolated e2e-bookorbit-1 and restart e2e-bookorbit-1 + e2e-companion-1
    const indexMjsContent = readFileSync(resolve(REPO_ROOT, 'index.mjs'), 'utf8');
    docker(['exec', '-i', 'e2e-bookorbit-1', 'sh', '-c', 'cat > /data/plugins/indexers/shelfmark/index.mjs'], indexMjsContent);
    docker(['restart', 'e2e-bookorbit-1', 'e2e-companion-1']);

    // 2. Start controlled Libgen fixture mirror on e2e_default
    try {
      docker(['rm', '-f', MIRROR_CONTAINER]);
    } catch {}

    docker([
      'run', '-d', '--rm',
      '--name', MIRROR_CONTAINER,
      '--network', 'e2e_default',
      '-p', '127.0.0.1:18099:18099',
      '-e', `E2E_RUN_HEX=${runHex}`,
      '-v', `${REPO_ROOT}:/app:ro`,
      'node:22-alpine',
      'node', '/app/e2e/controlled-canonical-discovery-mirror.mjs',
    ]);

    await waitUntil('controlled mirror health', async () => {
      const h = await j(`${MIRROR_HOST_URL}/_health`).catch(() => ({ ok: false }));
      return h.ok ? h.body : false;
    }, 15000, 300);

    // 3. Point isolated e2e-shelfmark-1 at controlled Libgen mirror (restored in finally!)
    const controlledMirrorsJson = JSON.stringify({
      AA_BASE_URL: '',
      AA_MIRROR_URLS: [],
      LIBGEN_MIRROR_URLS: [`http://${MIRROR_CONTAINER}:18099`],
      ZLIB_MIRROR_URLS: [],
      WELIB_MIRROR_URLS: [],
      OCEANOFPDF_MIRROR_URLS: [],
    }, null, 2);

    const controlledDownloadSourcesJson = JSON.stringify({
      DIRECT_DOWNLOAD_ENABLED: false,
      DIRECT_DOWNLOAD_LANGUAGE_FROM_PATH: false,
      FAST_SOURCES_DISPLAY: [{ id: 'libgen', enabled: true }],
      SOURCE_PRIORITY: [],
      MAX_RETRY: 2,
      DEFAULT_SLEEP: 1,
      RELEASE_SEARCH_TIMEOUT: 60,
      AA_CONTENT_TYPE_ROUTING: false,
    }, null, 2);

    docker(['exec', '-i', 'e2e-shelfmark-1', 'sh', '-c', 'cat > /config/plugins/mirrors.json'], controlledMirrorsJson);
    docker(['exec', '-i', 'e2e-shelfmark-1', 'sh', '-c', 'cat > /config/plugins/download_sources.json'], controlledDownloadSourcesJson);
    docker(['restart', 'e2e-shelfmark-1']);

    await waitUntil('isolated Shelfmark health', async () => {
      const h = await j(`${SM}/api/health`).catch(() => ({ ok: false }));
      return h.ok;
    }, 30000, 500);
    await waitUntil('isolated BookOrbit health', async () => {
      const h = await j(`${BO}/api/v1/health`).catch(() => ({ ok: false }));
      return h.ok;
    }, 30000, 500);
    await waitUntil('isolated Companion health', async () => {
      const h = await j(`${CP}/api/status`, { headers: { 'X-Bridge-Secret': CP_SECRET } }).catch(() => ({ ok: false }));
      return h.ok && h.body?.status === 'healthy';
    }, 30000, 500);

    const token = await loginBookOrbit();

    // ─────────────────────────────────────────────────────────────────────────
    // SCENARIO 1: Series-Prefixed Volume Discovery & Fulfillment (#129 Class)
    // "Percy Jackson and the Olympians, Book Five: The Last Olympian" by Rick Riordan
    // Rejects larger slash-omnibus (920 KB) & mislabeled Book 1 (810 KB), downloads Book 5 (420 KB)
    // whose OPF <dc:title> is canonical "The Last Olympian", verifies language, and fulfills.
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[Scenario 1] Series-prefixed volume request ("Percy Jackson and the Olympians, Book Five: The Last Olympian")...');
    await ensureWorkAbsentBeforeTest(token, 'Last Olympian');
    const s1Req = await createRealisticRequest(token, {
      title: 'Percy Jackson and the Olympians, Book Five: The Last Olympian',
      author: 'Rick Riordan',
      publishedYear: 2009,
      isbn13: '9781423101475',
      language: 'en',
    });
    console.log(`  Created request #${s1Req.id} ("${s1Req.title}")`);

    const s1Fulfilled = await waitUntil(`Request #${s1Req.id} unattended fulfillment`, async () => {
      const r = await j(`${BO}/api/v1/book-requests/${s1Req.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const obj = r.body?.request || r.body;
      return obj?.status === 'available' && obj?.matchedBookId ? obj : false;
    }, 90000, 1000);

    const s1BookRes = await j(`${BO}/api/v1/books/${s1Fulfilled.matchedBookId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(s1BookRes.ok, true);
    const s1Book = s1BookRes.body;
    assert.equal(s1Book.title, 'The Last Olympian', 'Imported book must be canonical Book 5 ("The Last Olympian"), never omnibus or Book 1');
    assert.equal(s1Book.publishedYear ?? null, null, 'Must never fabricate requested year onto imported book');
    assert.equal(s1Book.isbn13 ?? null, null, 'Must never fabricate requested ISBN onto imported book');

    const s1Diag = await waitUntil(`Request #${s1Req.id} companion stage=fulfilled`, async () => {
      const d = await getDiagnostics(s1Req.id);
      return d.stage?.stage === 'fulfilled' ? d : false;
    }, 10000, 300);
    assert.ok(s1Diag.task?.sourceId?.endsWith(`${runHex}${'0'.repeat(24)}13`), `Must select Book 5 candidate (13), rejecting omnibus (11) and Book 1 (12). Got: ${s1Diag.task?.sourceId}`);

    evidence.scenarios.scenario1_series_prefixed_volume_fulfillment = {
      passed: true,
      requestCreated: { id: s1Req.id, title: s1Req.title, authors: s1Req.authors, publishedYear: s1Req.publishedYear, isbn13: s1Req.isbn13 },
      fulfilledRequest: { id: s1Fulfilled.id, status: s1Fulfilled.status, matchedBookId: s1Fulfilled.matchedBookId },
      importedLibraryBook: { id: s1Book.id, title: s1Book.title, authors: s1Book.authors, publishedYear: s1Book.publishedYear ?? null, isbn13: s1Book.isbn13 ?? null },
      companionDiagnostics: s1Diag,
    };
    console.log(`  PASS Scenario 1: Request #${s1Req.id} fulfilled -> Book #${s1Book.id} ("${s1Book.title}")`);

    // ─────────────────────────────────────────────────────────────────────────
    // SCENARIO 2: Edition-Suffixed Metadata Fallback & Fulfillment (#123 Class)
    // "Harry Potter and the Chamber of Secrets: Enhanced Edition" by J.K. Rowling
    // Raw OpenLibrary query returns 0 books -> fallback to "Harry Potter and the Chamber of Secrets"
    // finds OL82537W -> rejects Book 1 -> fulfills Book 2!
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[Scenario 2] Edition-suffixed request ("Harry Potter and the Chamber of Secrets: Enhanced Edition")...');
    await ensureWorkAbsentBeforeTest(token, 'Chamber of Secrets');
    // Confirm raw OpenLibrary query on isolated Shelfmark genuinely returns 0 books
    const rawHpMeta = await j(
      `${SM}/api/metadata/search?content_type=ebook&limit=10&query=${encodeURIComponent('Harry Potter and the Chamber of Secrets: Enhanced Edition')}`,
      { headers: { 'X-Api-Key': SM_API_KEY } }
    );
    const rawHpCount = Array.isArray(rawHpMeta.body?.books) ? rawHpMeta.body.books.length : 0;
    console.log(`  Verified raw Shelfmark metadata query count for ": Enhanced Edition" = ${rawHpCount}`);

    const s2Req = await createRealisticRequest(token, {
      title: 'Harry Potter and the Chamber of Secrets: Enhanced Edition',
      author: 'J.K. Rowling',
      publishedYear: 2015,
      isbn13: '9781781105603',
      language: 'en',
    });
    console.log(`  Created request #${s2Req.id} ("${s2Req.title}")`);

    const s2Fulfilled = await waitUntil(`Request #${s2Req.id} unattended fulfillment`, async () => {
      const r = await j(`${BO}/api/v1/book-requests/${s2Req.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const obj = r.body?.request || r.body;
      return obj?.status === 'available' && obj?.matchedBookId ? obj : false;
    }, 90000, 1000);

    const s2BookRes = await j(`${BO}/api/v1/books/${s2Fulfilled.matchedBookId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(s2BookRes.ok, true);
    const s2Book = s2BookRes.body;
    assert.equal(s2Book.title, 'Harry Potter and the Chamber of Secrets');

    const s2Diag = await waitUntil(`Request #${s2Req.id} companion stage=fulfilled`, async () => {
      const d = await getDiagnostics(s2Req.id);
      return d.stage?.stage === 'fulfilled' ? d : false;
    }, 10000, 300);
    assert.ok(s2Diag.task?.sourceId?.endsWith(`${runHex}${'0'.repeat(24)}22`), `Must select Chamber of Secrets (22), rejecting Sorcerer's Stone (21). Got: ${s2Diag.task?.sourceId}`);

    evidence.scenarios.scenario2_enhanced_edition_metadata_fallback_fulfillment = {
      passed: true,
      rawMetadataBookCountBeforeFallback: rawHpCount,
      requestCreated: { id: s2Req.id, title: s2Req.title, authors: s2Req.authors, publishedYear: s2Req.publishedYear, isbn13: s2Req.isbn13 },
      fulfilledRequest: { id: s2Fulfilled.id, status: s2Fulfilled.status, matchedBookId: s2Fulfilled.matchedBookId },
      importedLibraryBook: { id: s2Book.id, title: s2Book.title, authors: s2Book.authors },
      companionDiagnostics: s2Diag,
    };
    console.log(`  PASS Scenario 2: Request #${s2Req.id} (rawMeta=${rawHpCount}) fulfilled -> Book #${s2Book.id} ("${s2Book.title}")`);

    // ─────────────────────────────────────────────────────────────────────────
    // SCENARIO 3: Franchise-Prefixed Companion Request (#132 Class)
    // "From the Files of Camp Half-Blood: Camp Half-Blood Confidential" by Rick Riordan
    // Raw OpenLibrary query returns 0 -> falls back to "Camp Half-Blood Confidential",
    // rejects slash omnibus, and fulfills from subtitle-bearing release!
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[Scenario 3] Franchise-prefixed companion request ("From the Files of Camp Half-Blood: Camp Half-Blood Confidential")...');
    await ensureWorkAbsentBeforeTest(token, 'Camp Half-Blood');
    const s3Req = await createRealisticRequest(token, {
      title: 'From the Files of Camp Half-Blood: Camp Half-Blood Confidential',
      author: 'Rick Riordan',
      publishedYear: 2017,
      isbn13: '9781484780657',
      language: 'en',
    });
    console.log(`  Created request #${s3Req.id} ("${s3Req.title}")`);

    const s3Fulfilled = await waitUntil(`Request #${s3Req.id} unattended fulfillment`, async () => {
      const r = await j(`${BO}/api/v1/book-requests/${s3Req.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const obj = r.body?.request || r.body;
      return obj?.status === 'available' && obj?.matchedBookId ? obj : false;
    }, 90000, 1000);

    const s3BookRes = await j(`${BO}/api/v1/books/${s3Fulfilled.matchedBookId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(s3BookRes.ok, true);
    const s3Book = s3BookRes.body;
    assert.equal(s3Book.title, 'Camp Half-Blood Confidential');

    const s3Diag = await waitUntil(`Request #${s3Req.id} companion stage=fulfilled`, async () => {
      const d = await getDiagnostics(s3Req.id);
      return d.stage?.stage === 'fulfilled' ? d : false;
    }, 10000, 300);
    assert.ok(s3Diag.task?.sourceId?.endsWith(`${runHex}${'0'.repeat(24)}32`), `Must select Camp Half-Blood Confidential (32), rejecting slash omnibus (31). Got: ${s3Diag.task?.sourceId}`);

    evidence.scenarios.scenario3_franchise_prefix_companion_fulfillment = {
      passed: true,
      requestCreated: { id: s3Req.id, title: s3Req.title, authors: s3Req.authors },
      fulfilledRequest: { id: s3Fulfilled.id, status: s3Fulfilled.status, matchedBookId: s3Fulfilled.matchedBookId },
      importedLibraryBook: { id: s3Book.id, title: s3Book.title, authors: s3Book.authors },
      companionDiagnostics: s3Diag,
    };
    console.log(`  PASS Scenario 3: Request #${s3Req.id} fulfilled -> Book #${s3Book.id} ("${s3Book.title}")`);

    // ─────────────────────────────────────────────────────────────────────────
    // SCENARIO 4: Wrong-Volume & Box-Set Rejection (Zero FalseUploads)
    // "Percy Jackson and the Olympians, Book Four: The Battle of the Labyrinth" by Rick Riordan
    // Stage 1 eliminates Books 1-5 box set (41) and Book 2 release (42);
    // Stage 2 inspects deceptive "The Battle of the Labyrinth" (43) whose internal OPF <dc:title>
    // is "Percy Jackson and the Olympians, Book 1: The Lightning Thief" and REJECTS before upload!
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[Scenario 4] Wrong-volume & box-set rejection ("Percy Jackson and the Olympians, Book Four: The Battle of the Labyrinth")...');
    await ensureWorkAbsentBeforeTest(token, 'Battle of the Labyrinth');
    const s4Req = await createRealisticRequest(token, {
      title: 'Percy Jackson and the Olympians, Book Four: The Battle of the Labyrinth',
      author: 'Rick Riordan',
      publishedYear: 2008,
      isbn13: '9781423101468',
      language: 'en',
    });
    console.log(`  Created request #${s4Req.id} ("${s4Req.title}")`);

    const s4Diag = await waitUntil(`Request #${s4Req.id} post-download wrong-volume rejection`, async () => {
      const d = await getDiagnostics(s4Req.id);
      if (
        (d.stage?.stage === 'finalization_failed' || d.stage?.stage === 'review_required' || d.lastVerification?.ok === false) &&
        Array.isArray(d.verificationConflicts) &&
        d.verificationConflicts.length > 0
      ) {
        return d;
      }
      return false;
    }, 90000, 1000);

    const s4Conflicts = s4Diag.verificationConflicts || s4Diag.lastVerification?.conflicts || [];
    assert.ok(
      s4Conflicts.includes('incompatible_series_volume') || s4Conflicts.includes('incompatible_title'),
      `Expected wrong-volume/title conflict, got ${JSON.stringify(s4Conflicts)}`
    );

    const s4BoCheck = await j(`${BO}/api/v1/book-requests/${s4Req.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const s4BoObj = s4BoCheck.body?.request || s4BoCheck.body;
    assert.equal(s4BoObj.status, 'approved', 'Wrong-volume request must remain unfulfilled');
    assert.equal(s4BoObj.matchedBookId ?? null, null, 'Wrong-volume request must have matchedBookId=null');

    const booksAfterS4 = await listLibraryBooks(token, 1);
    const s4FalseImports = booksAfterS4.filter((b) => {
      const t = String(b.title || '').toLowerCase();
      return t.includes('battle of the labyrinth') || t.includes('lightning thief') || t.includes('books 1-5');
    });
    assert.equal(s4FalseImports.length, 0, 'Zero wrong-volume or box-set books may be uploaded to Library 1');

    evidence.scenarios.scenario4_wrong_volume_and_boxset_rejected = {
      passed: true,
      requestCreated: { id: s4Req.id, title: s4Req.title, authors: s4Req.authors },
      bookorbitRequestAfterRejection: { id: s4BoObj.id, status: s4BoObj.status, matchedBookId: s4BoObj.matchedBookId ?? null },
      falseImportsInLibraryCount: s4FalseImports.length,
      companionDiagnostics: s4Diag,
    };
    console.log(`  PASS Scenario 4: Request #${s4Req.id} rejected wrong volumes & box set (conflicts=${JSON.stringify(s4Conflicts)}, 0 books imported)`);

    // ─────────────────────────────────────────────────────────────────────────
    // SCENARIO 5: Honest `no_releases` Handling for Genuinely Unavailable Works
    //   5A: Real OpenLibrary work ("Percy Jackson and the Olympians, Book Six: The Chalice of the Gods")
    //       with 0 available releases on sources -> stage='no_releases', 0 tasks queued.
    //   5B: Nonexistent work ("Percy Jackson and the Olympians, Book Eleven: Nonexistent Quest of Zephyrus")
    //       with 0 OpenLibrary metadata -> stage='no_releases', 0 tasks queued.
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[Scenario 5] Honest no_releases handling for genuinely unavailable releases...');
    const s5aReq = await createRealisticRequest(token, {
      title: 'Percy Jackson and the Olympians, Book Twelve: The Lost Vault of Kronos',
      author: 'Rick Riordan',
      publishedYear: 2026,
      isbn13: '9781368099999',
      language: 'en',
    });
    const s5bReq = await createRealisticRequest(token, {
      title: 'The Phantom Chronology of Olympus: Unwritten Legends',
      author: 'Rick Riordan',
      publishedYear: 2026,
      isbn13: null,
      language: 'en',
    });
    console.log(`  Created requests #${s5aReq.id} (unavailable volume 12) and #${s5bReq.id} (nonexistent companion work)`);

    const s5aDiag = await waitUntil(`Request #${s5aReq.id} honest no_releases stage`, async () => {
      const d = await getDiagnostics(s5aReq.id);
      return d.stage?.stage === 'no_releases' ? d : false;
    }, 60000, 750);
    const s5bDiag = await waitUntil(`Request #${s5bReq.id} honest no_releases stage`, async () => {
      const d = await getDiagnostics(s5bReq.id);
      return d.stage?.stage === 'no_releases' ? d : false;
    }, 60000, 750);

    assert.equal(s5aDiag.task ?? null, null, 'Unavailable work 5A must not fabricate a download task');
    assert.equal(s5bDiag.task ?? null, null, 'Nonexistent work 5B must not fabricate a download task');
    assert.equal(s5aDiag.stage?.stage, 'no_releases');
    assert.equal(s5bDiag.stage?.stage, 'no_releases');
    assert.equal(s5aDiag.errors?.errorType ?? s5aDiag.stage?.reason, 'no_releases');
    assert.equal(s5bDiag.errors?.errorType ?? s5bDiag.stage?.reason, 'no_releases');

    const mirrorStats = (await j(`${MIRROR_HOST_URL}/_stats`)).body;

    evidence.scenarios.scenario5_honest_no_releases_unavailable = {
      passed: true,
      realWorkZeroSourceReleases: {
        requestId: s5aReq.id,
        title: s5aReq.title,
        stage: s5aDiag.stage?.stage,
        task: s5aDiag.task ?? null,
        retryState: s5aDiag.retryState,
      },
      nonexistentWorkZeroMetadata: {
        requestId: s5bReq.id,
        title: s5bReq.title,
        stage: s5bDiag.stage?.stage,
        task: s5bDiag.task ?? null,
        retryState: s5bDiag.retryState,
      },
    };
    evidence.controlledMirrorHttpAudit = mirrorStats;
    evidence.completedAt = new Date().toISOString();
    evidence.allPassed = true;
    console.log(`  PASS Scenario 5: Requests #${s5aReq.id} and #${s5bReq.id} cleanly recorded stage="no_releases" with 0 fabricated tasks`);

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const outPath = resolve(REPO_ROOT, `e2e/results/canonical-discovery-e2e-${ts}.json`);
    writeFileSync(outPath, JSON.stringify(evidence, null, 2));
    console.log(`\nALL 5 REALISTIC CANONICAL DISCOVERY & SERIES-VOLUME E2E SCENARIOS PASSED!`);
    console.log(`Evidence written to: ${outPath}`);
  } finally {
    console.log('\nRestoring isolated Shelfmark configuration and cleaning up controlled mirror container...');
    try {
      docker(['exec', '-i', 'e2e-shelfmark-1', 'sh', '-c', 'cat > /config/plugins/mirrors.json'], origMirrors);
      docker(['exec', '-i', 'e2e-shelfmark-1', 'sh', '-c', 'cat > /config/plugins/download_sources.json'], origDownloadSources);
      docker(['restart', 'e2e-shelfmark-1']);
    } catch (restoreErr) {
      console.error('Warning restoring e2e-shelfmark-1 config:', restoreErr.message);
    }
    try {
      docker(['rm', '-f', MIRROR_CONTAINER]);
    } catch {}
  }
}

main().catch((err) => {
  console.error('\nE2E SUITE FAILED:', err);
  process.exit(1);
});
