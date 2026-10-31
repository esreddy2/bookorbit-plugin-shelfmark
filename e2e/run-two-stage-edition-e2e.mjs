#!/usr/bin/env node
/**
 * Real Unattended Isolated Docker E2E Suite for Two-Stage Edition Verification (v1.7.6)
 *
 * Tests realistic BookOrbit requests with populated `publishedYear` AND `isbn13`
 * against Shelfmark releases with unknown release years (`year: null`, `isbn: null`)
 * backed by controlled OCF EPUB 3 fixtures served through Shelfmark's real Libgen
 * download pipeline (`/api/metadata/search` -> `/api/releases` -> `/api/releases/download`
 * -> `LibgenHandler` -> `/books` -> `/scripts/shelfmark-hook.sh` -> Companion `/webhook/shelfmark`
 * -> Stage 2 OPF verification -> BookOrbit upload & fulfillment).
 *
 * ZERO manual fulfillment, ZERO synthetic webhook calls, ZERO reused tasks, ZERO omitted metadata.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
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

async function ensureWorkAbsentBeforeTest(token, exactTitle) {
  const existing = await listLibraryBooks(token, 1);
  assert.equal(
    existing.some((b) => String(b.title || '').trim().toLowerCase() === exactTitle.toLowerCase()),
    false,
    `Library 1 must have zero "${exactTitle}" books before scenario starts`
  );
}

async function verifyShelfmarkUnknownYearReleases(title, author) {
  const match = await waitUntil(`Shelfmark metadata search for "${title}"`, async () => {
    const metaRes = await j(
      `${SM}/api/metadata/search?content_type=ebook&limit=10&query=${encodeURIComponent(title)}`,
      { headers: { 'X-Api-Key': SM_API_KEY } }
    );
    if (!metaRes.ok) return false;
    const books = metaRes.body?.books || [];
    return books.find((b) => String(b.title || '').toLowerCase().includes(title.toLowerCase())) || false;
  }, 30000, 1500);
  assert.ok(match, `Shelfmark metadata search found no work for ${title}`);

  const relUrl = new URL(`${SM}/api/releases`);
  relUrl.searchParams.set('provider', match.provider || 'openlibrary');
  relUrl.searchParams.set('book_id', match.provider_id || '');
  relUrl.searchParams.set('title', title);
  relUrl.searchParams.set('author', author);
  relUrl.searchParams.set('content_type', 'ebook');
  relUrl.searchParams.set('source', 'libgen');

  const relRes = await j(relUrl.href, { headers: { 'X-Api-Key': SM_API_KEY } });
  assert.equal(relRes.ok, true, `Shelfmark release search failed for ${title}: ${JSON.stringify(relRes.body)}`);
  const releases = Array.isArray(relRes.body) ? relRes.body : relRes.body?.releases || [];
  assert.ok(releases.length >= 1, `Expected >=1 unknown-year release from Shelfmark for ${title}, got 0`);
  for (const r of releases) {
    const relYear = r.year ?? r.extra?.year ?? null;
    const relIsbn = r.isbn ?? r.extra?.isbn ?? r.extra?.isbn13 ?? null;
    assert.equal(relYear, null, `Expected Shelfmark release year to be null (unknown), got ${relYear}`);
    assert.equal(relIsbn, null, `Expected Shelfmark release ISBN to be null (unknown), got ${relIsbn}`);
  }
  return {
    metadataProvider: `${match.provider}:${match.provider_id}`,
    releaseCount: releases.length,
    releases: releases.map((r) => ({
      source: r.source,
      source_id: r.source_id,
      title: r.title,
      author: r.extra?.author ?? null,
      year: r.year ?? r.extra?.year ?? null,
      isbn: r.isbn ?? r.extra?.isbn ?? null,
      language: r.language ?? r.extra?.language ?? null,
      format: r.format,
      size: r.size,
    })),
  };
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
  assert.equal(reqObj.publishedYear, publishedYear, `BookOrbit request ${createdId} must persist publishedYear=${publishedYear}`);
  assert.equal(reqObj.isbn13, isbn13, `BookOrbit request ${createdId} must persist isbn13=${isbn13}`);
  assert.equal(reqObj.status, 'approved', `Admin-created BookOrbit request ${createdId} should start in 'approved' status`);
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
  console.log(`=== Isolated Two-Stage Edition E2E Suite (runHex=${runHex}) ===`);
  console.log(`Targets verified isolated: BO=${BO} | SM=${SM} | CP=${CP} | Mirror=${MIRROR_HOST_URL}`);

  // Backup Shelfmark mirror & download_sources configs inside e2e-shelfmark-1
  const origMirrors = docker(['exec', 'e2e-shelfmark-1', 'cat', '/config/plugins/mirrors.json']);
  const origDownloadSources = docker(['exec', 'e2e-shelfmark-1', 'cat', '/config/plugins/download_sources.json']);

  const evidence = {
    suite: 'two-stage-edition-verification-e2e',
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
    // 1. Start controlled Libgen fixture mirror on e2e_default
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
      'node', '/app/e2e/controlled-libgen-mirror.mjs',
    ]);

    await waitUntil('controlled mirror health', async () => {
      const h = await j(`${MIRROR_HOST_URL}/_health`).catch(() => ({ ok: false }));
      return h.ok ? h.body : false;
    }, 15000, 300);

    // 2. Point isolated e2e-shelfmark-1 exclusivamente at controlled Libgen mirror (restored in finally!)
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

    await waitUntil('isolated Shelfmark restart health', async () => {
      const h = await j(`${SM}/api/health`).catch(() => ({ ok: false }));
      return h.ok;
    }, 30000, 500);

    // Verify BookOrbit and Companion health
    const boHealth = await j(`${BO}/api/v1/health`);
    const cpHealth = await j(`${CP}/api/status`, { headers: { 'X-Bridge-Secret': CP_SECRET } });
    assert.equal(boHealth.ok, true, 'BookOrbit 13031 must be healthy');
    assert.equal(cpHealth.ok, true, 'Companion 8090 must be healthy');

    const token = await loginBookOrbit();

    // ─────────────────────────────────────────────────────────────────────────
    // SCENARIO 1: Correct Automatic Fulfillment from Unknown-Year Release
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[Scenario 1] Automatic fulfillment: populated publishedYear=2005 + isbn13=9780141441030 vs unknown-year release...');
    await ensureWorkAbsentBeforeTest(token, 'The War of the Worlds');
    const s1ReleaseCheck = await verifyShelfmarkUnknownYearReleases('The War of the Worlds', 'H. G. Wells');
    const s1Req = await createRealisticRequest(token, {
      title: 'The War of the Worlds',
      author: 'H. G. Wells',
      publishedYear: 2005,
      isbn13: '9780141441030',
      language: 'en',
    });
    console.log(`  Created request #${s1Req.id} (publishedYear=${s1Req.publishedYear}, isbn13=${s1Req.isbn13})`);

    const s1FulfilledReq = await waitUntil(`Request #${s1Req.id} unattended fulfillment`, async () => {
      const r = await j(`${BO}/api/v1/book-requests/${s1Req.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const obj = r.body?.request || r.body;
      return obj?.status === 'available' && obj?.matchedBookId ? obj : false;
    }, 90000, 1000);

    const s1BookRes = await j(`${BO}/api/v1/books/${s1FulfilledReq.matchedBookId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(s1BookRes.ok, true, `Matched book ${s1FulfilledReq.matchedBookId} must exist in BookOrbit`);
    const s1Book = s1BookRes.body;
    assert.equal(s1Book.title, 'The War of the Worlds');
    assert.equal(s1Book.publishedYear, 2005, 'Imported BookOrbit book must have verified OPF year 2005');
    assert.equal(s1Book.isbn13, '9780141441030', 'Imported BookOrbit book must have verified OPF ISBN 9780141441030');

    const s1Diag = await waitUntil(`Request #${s1Req.id} companion stage=fulfilled`, async () => {
      const d = await getDiagnostics(s1Req.id);
      return d.stage?.stage === 'fulfilled' ? d : false;
    }, 10000, 300);
    assert.equal(s1Diag.stage?.stage, 'fulfilled');
    const s1TaskId = String(s1Diag.task?.id || s1Diag.request?.taskId || '');
    assert.ok(s1TaskId.includes(runHex), `Task ID ${s1TaskId} must come from this fresh E2E run (${runHex})`);

    evidence.scenarios.scenario1_verified_fulfillment = {
      passed: true,
      requestCreated: {
        id: s1Req.id,
        title: s1Req.title,
        authors: s1Req.authors,
        publishedYear: s1Req.publishedYear,
        isbn13: s1Req.isbn13,
        language: s1Req.language,
      },
      shelfmarkCandidatesObserved: s1ReleaseCheck,
      fulfilledRequest: {
        id: s1FulfilledReq.id,
        status: s1FulfilledReq.status,
        matchedBookId: s1FulfilledReq.matchedBookId,
        decisionNote: s1FulfilledReq.decisionNote,
      },
      importedLibraryBook: {
        id: s1Book.id,
        title: s1Book.title,
        authors: s1Book.authors,
        publishedYear: s1Book.publishedYear,
        isbn13: s1Book.isbn13,
        language: s1Book.language,
      },
      companionDiagnostics: s1Diag,
    };
    console.log(`  PASS Scenario 1: Request #${s1Req.id} fulfilled automatically -> Book #${s1Book.id} (year=${s1Book.publishedYear}, isbn13=${s1Book.isbn13})`);

    // ─────────────────────────────────────────────────────────────────────────
    // SCENARIO 2: Wrong Edition Rejected Before Upload
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[Scenario 2] Wrong edition rejection: populated publishedYear=2003 + isbn13=9780141439846 vs 2011/9780199564095 EPUB...');
    await ensureWorkAbsentBeforeTest(token, 'Dracula');
    const s2ReleaseCheck = await verifyShelfmarkUnknownYearReleases('Dracula', 'Bram Stoker');
    const s2Req = await createRealisticRequest(token, {
      title: 'Dracula',
      author: 'Bram Stoker',
      publishedYear: 2003,
      isbn13: '9780141439846',
      language: 'en',
    });
    console.log(`  Created request #${s2Req.id} (publishedYear=${s2Req.publishedYear}, isbn13=${s2Req.isbn13})`);

    const s2DiagInitial = await waitUntil(`Request #${s2Req.id} Stage 2 wrong-edition rejection`, async () => {
      const d = await getDiagnostics(s2Req.id);
      if (d.stage?.stage === 'review_required' && Array.isArray(d.verificationConflicts) && d.verificationConflicts.length > 0) {
        return d;
      }
      return false;
    }, 90000, 1000);

    // Wait >11s across at least one periodic reconcile() cycle (RECONCILE_INTERVAL_MS=10000)
    // to prove reconcile() does NOT resurrect or import the rejected task.
    await sleep(11500);

    const s2ReqAfter = await j(`${BO}/api/v1/book-requests/${s2Req.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.body?.request || r.body);
    assert.equal(s2ReqAfter.status, 'approved', 'Wrong-edition request must NOT become available');
    assert.equal(s2ReqAfter.matchedBookId, null, 'Wrong-edition request must have matchedBookId === null');

    const s2BooksAfter = await listLibraryBooks(token, 1);
    assert.equal(
      s2BooksAfter.some((b) => String(b.title || '').toLowerCase().includes('dracula')),
      false,
      'Wrong-edition EPUB must be rejected BEFORE upload (zero Dracula books in Library 1)'
    );

    const s2DiagFinal = await getDiagnostics(s2Req.id);
    assert.equal(s2DiagFinal.stage?.stage, 'review_required');
    assert.ok(s2DiagFinal.verificationConflicts.includes('conflicting_isbn'), `Expected conflicting_isbn in ${JSON.stringify(s2DiagFinal.verificationConflicts)}`);
    assert.ok(s2DiagFinal.verificationConflicts.includes('incompatible_year'), `Expected incompatible_year in ${JSON.stringify(s2DiagFinal.verificationConflicts)}`);

    evidence.scenarios.scenario2_wrong_edition_rejected = {
      passed: true,
      requestCreated: {
        id: s2Req.id,
        title: s2Req.title,
        publishedYear: s2Req.publishedYear,
        isbn13: s2Req.isbn13,
      },
      shelfmarkCandidatesObserved: s2ReleaseCheck,
      requestStateAfterReconcile: {
        id: s2ReqAfter.id,
        status: s2ReqAfter.status,
        matchedBookId: s2ReqAfter.matchedBookId,
      },
      draculaBooksInLibraryCount: 0,
      companionDiagnosticsInitial: s2DiagInitial,
      companionDiagnosticsAfterReconcile: s2DiagFinal,
    };
    console.log(`  PASS Scenario 2: Request #${s2Req.id} rejected before upload (conflicts=${JSON.stringify(s2DiagFinal.verificationConflicts)}, libraryBooks=0)`);

    // ─────────────────────────────────────────────────────────────────────────
    // SCENARIO 3: Unverifiable Edition Rejected Before Upload (Missing Year & ISBN)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[Scenario 3] Unverifiable edition rejection: populated publishedYear=2011 + isbn13=9780199560356 vs OPF lacking dc:date & ISBN...');
    await ensureWorkAbsentBeforeTest(token, 'Treasure Island');
    const s3ReleaseCheck = await verifyShelfmarkUnknownYearReleases('Treasure Island', 'Robert Louis Stevenson');
    const s3Req = await createRealisticRequest(token, {
      title: 'Treasure Island',
      author: 'Robert Louis Stevenson',
      publishedYear: 2011,
      isbn13: '9780199560356',
      language: 'en',
    });
    console.log(`  Created request #${s3Req.id} (publishedYear=${s3Req.publishedYear}, isbn13=${s3Req.isbn13})`);

    const s3DiagInitial = await waitUntil(`Request #${s3Req.id} Stage 2 unverifiable-edition rejection`, async () => {
      const d = await getDiagnostics(s3Req.id);
      if (d.stage?.stage === 'review_required' && Array.isArray(d.verificationConflicts) && d.verificationConflicts.length > 0) {
        return d;
      }
      return false;
    }, 90000, 1000);

    // Wait >11s across a reconcile() cycle to prove missing evidence is never fabricated into a match
    await sleep(11500);

    const s3ReqAfter = await j(`${BO}/api/v1/book-requests/${s3Req.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.body?.request || r.body);
    assert.equal(s3ReqAfter.status, 'approved', 'Unverifiable-edition request must NOT become available');
    assert.equal(s3ReqAfter.matchedBookId, null, 'Unverifiable-edition request must have matchedBookId === null');

    const s3BooksAfter = await listLibraryBooks(token, 1);
    assert.equal(
      s3BooksAfter.some((b) => String(b.title || '').toLowerCase().includes('treasure island')),
      false,
      'Unverifiable EPUB must be rejected BEFORE upload (zero Treasure Island books in Library 1)'
    );

    const s3DiagFinal = await getDiagnostics(s3Req.id);
    assert.equal(s3DiagFinal.stage?.stage, 'review_required');
    assert.ok(s3DiagFinal.verificationConflicts.includes('unverified_isbn'), `Expected unverified_isbn in ${JSON.stringify(s3DiagFinal.verificationConflicts)}`);
    assert.ok(s3DiagFinal.verificationConflicts.includes('unverified_edition_year'), `Expected unverified_edition_year in ${JSON.stringify(s3DiagFinal.verificationConflicts)}`);

    evidence.scenarios.scenario3_unverifiable_edition_rejected = {
      passed: true,
      requestCreated: {
        id: s3Req.id,
        title: s3Req.title,
        publishedYear: s3Req.publishedYear,
        isbn13: s3Req.isbn13,
      },
      shelfmarkCandidatesObserved: s3ReleaseCheck,
      requestStateAfterReconcile: {
        id: s3ReqAfter.id,
        status: s3ReqAfter.status,
        matchedBookId: s3ReqAfter.matchedBookId,
      },
      treasureIslandBooksInLibraryCount: 0,
      companionDiagnosticsInitial: s3DiagInitial,
      companionDiagnosticsAfterReconcile: s3DiagFinal,
    };
    console.log(`  PASS Scenario 3: Request #${s3Req.id} rejected before upload (conflicts=${JSON.stringify(s3DiagFinal.verificationConflicts)}, libraryBooks=0)`);

    // ─────────────────────────────────────────────────────────────────────────
    // SCENARIO 4: Bounded Alternative Candidate Recovery Across Unknown-Year Releases
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[Scenario 4] Bounded alternative recovery: Candidate A (wrong 1998) cooled down -> Candidate B (verified 2005 bit-3 ZIP) fulfills...');
    await ensureWorkAbsentBeforeTest(token, 'The Invisible Man');
    const s4ReleaseCheck = await verifyShelfmarkUnknownYearReleases('The Invisible Man', 'H. G. Wells');
    assert.equal(s4ReleaseCheck.releaseCount, 2, 'Expected 2 unknown-year candidates for The Invisible Man');

    const s4Req = await createRealisticRequest(token, {
      title: 'The Invisible Man',
      author: 'H. G. Wells',
      publishedYear: 2005,
      isbn13: '9780141439983',
      language: 'en',
    });
    console.log(`  Created request #${s4Req.id} (publishedYear=${s4Req.publishedYear}, isbn13=${s4Req.isbn13})`);

    const s4FulfilledReq = await waitUntil(`Request #${s4Req.id} bounded alternative fulfillment`, async () => {
      const r = await j(`${BO}/api/v1/book-requests/${s4Req.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const obj = r.body?.request || r.body;
      return obj?.status === 'available' && obj?.matchedBookId ? obj : false;
    }, 120000, 1000);

    const s4BookRes = await j(`${BO}/api/v1/books/${s4FulfilledReq.matchedBookId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(s4BookRes.ok, true);
    const s4Book = s4BookRes.body;
    assert.equal(s4Book.title, 'The Invisible Man');
    assert.equal(s4Book.publishedYear, 2005, 'Only Candidate B (2005) may be imported into BookOrbit');
    assert.equal(s4Book.isbn13, '9780141439983', 'Only Candidate B (9780141439983) may be imported into BookOrbit');

    const s4BooksAll = await listLibraryBooks(token, 1);
    const invisibleManBooks = s4BooksAll.filter((b) => String(b.title || '').toLowerCase().includes('invisible man'));
    assert.equal(invisibleManBooks.length, 1, 'Candidate A must NOT have been uploaded alongside Candidate B');

    const s4Diag = await waitUntil(`Request #${s4Req.id} companion stage=fulfilled`, async () => {
      const d = await getDiagnostics(s4Req.id);
      return d.stage?.stage === 'fulfilled' ? d : false;
    }, 10000, 300);
    assert.equal(s4Diag.stage?.stage, 'fulfilled');
    assert.equal(s4Diag.retryState?.attempts, 1, 'Request must record 1 failed source attempt from Candidate A before Candidate B succeeded');
    assert.equal(Array.isArray(s4Diag.attempts) ? s4Diag.attempts.length : 0, 1);

    const mirrorStats = await j(`${MIRROR_HOST_URL}/_stats`).then((r) => r.body);
    const getDownloads = (mirrorStats.requests || []).filter((r) => r.path === '/get.php').map((r) => r.search);
    assert.ok(
      getDownloads.some((s) => s.includes(`${runHex}${'0'.repeat(24)}04`)),
      'Shelfmark must have downloaded Candidate A first'
    );
    assert.ok(
      getDownloads.some((s) => s.includes(`${runHex}${'0'.repeat(24)}05`)),
      'Shelfmark must have downloaded Candidate B second after Candidate A was rejected'
    );

    evidence.scenarios.scenario4_bounded_alternative_recovery = {
      passed: true,
      requestCreated: {
        id: s4Req.id,
        title: s4Req.title,
        publishedYear: s4Req.publishedYear,
        isbn13: s4Req.isbn13,
      },
      shelfmarkCandidatesObserved: s4ReleaseCheck,
      fulfilledRequest: {
        id: s4FulfilledReq.id,
        status: s4FulfilledReq.status,
        matchedBookId: s4FulfilledReq.matchedBookId,
        decisionNote: s4FulfilledReq.decisionNote,
      },
      importedLibraryBook: {
        id: s4Book.id,
        title: s4Book.title,
        publishedYear: s4Book.publishedYear,
        isbn13: s4Book.isbn13,
      },
      invisibleManBooksInLibraryCount: invisibleManBooks.length,
      companionDiagnostics: s4Diag,
    };
    evidence.controlledMirrorHttpAudit = mirrorStats;
    evidence.completedAt = new Date().toISOString();
    evidence.allPassed = true;
    console.log(`  PASS Scenario 4: Candidate A rejected & cooled down (attempts=${s4Diag.retryState?.attempts}) -> Candidate B verified & fulfilled -> Book #${s4Book.id}`);

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const outPath = resolve(REPO_ROOT, `e2e/results/two-stage-edition-e2e-${ts}.json`);
    writeFileSync(outPath, JSON.stringify(evidence, null, 2));
    console.log(`\nALL 4 REALISTIC TWO-STAGE EDITION E2E SCENARIOS PASSED!`);
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
