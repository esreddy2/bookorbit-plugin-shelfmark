#!/usr/bin/env node
/**
 * Real Unattended Isolated Docker E2E Suite for Work + Actual Reading-Language Policy (v1.7.7)
 *
 * Exercises the full isolated Docker stack:
 *   BookOrbit (127.0.0.1:13031) -> Companion (127.0.0.1:8090) -> Shelfmark (127.0.0.1:18085)
 *   -> LibgenHandler -> /books -> /scripts/shelfmark-hook.sh -> /webhook/shelfmark
 *   -> Actual reading-text language verification -> BookOrbit upload & fulfillment.
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

async function ensureWorkAbsentBeforeTest(token, exactTitle) {
  const existing = await listLibraryBooks(token, 1);
  assert.equal(
    existing.some((b) => String(b.title || '').trim().toLowerCase() === exactTitle.toLowerCase()),
    false,
    `Library 1 must have zero "${exactTitle}" books before scenario starts`
  );
}

async function verifyShelfmarkReleases(title, author) {
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
  assert.ok(releases.length >= 1, `Expected >=1 release from Shelfmark for ${title}, got 0`);
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
  assert.equal(reqObj.publishedYear, publishedYear);
  assert.equal(reqObj.isbn13, isbn13);
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
  console.log(`=== Isolated Work + Actual Reading-Language E2E Suite (runHex=${runHex}) ===`);
  console.log(`Targets verified isolated: BO=${BO} | SM=${SM} | CP=${CP} | Mirror=${MIRROR_HOST_URL}`);

  // Backup Shelfmark mirror & download_sources configs inside e2e-shelfmark-1
  const origMirrors = docker(['exec', 'e2e-shelfmark-1', 'cat', '/config/plugins/mirrors.json']);
  const origDownloadSources = docker(['exec', 'e2e-shelfmark-1', 'cat', '/config/plugins/download_sources.json']);

  const evidence = {
    suite: 'work-and-reading-language-policy-e2e',
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
      'node', '/app/e2e/controlled-work-language-mirror.mjs',
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
    // SCENARIO 1: Exact Request #116 Metadata (1984, ISBN 9791223228388, year 2026)
    // Fulfills from streaming-ZIP English EPUB lacking ISBN, year, and dc:language,
    // containing accented English prose & mixed-script epigraph, without fabricating metadata.
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[Scenario 1] Request #116 metadata (1984, ISBN 9791223228388, year 2026) -> English EPUB lacking ISBN/year/dc:language (with accented words & mixed scripts)...');
    await ensureWorkAbsentBeforeTest(token, '1984');
    const s1ReleaseCheck = await verifyShelfmarkReleases('1984', 'George Orwell');
    const s1Req = await createRealisticRequest(token, {
      title: '1984',
      author: 'George Orwell',
      publishedYear: 2026,
      isbn13: '9791223228388',
      language: 'en',
    });
    console.log(`  Created request #${s1Req.id} (title="${s1Req.title}", publishedYear=${s1Req.publishedYear}, isbn13=${s1Req.isbn13})`);

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
    assert.equal(s1BookRes.ok, true);
    const s1Book = s1BookRes.body;
    assert.equal(s1Book.title, '1984');
    assert.equal(s1Book.publishedYear ?? null, null, 'Must NEVER fabricate requested year 2026 onto imported book lacking year');
    assert.equal(s1Book.isbn13 ?? null, null, 'Must NEVER fabricate requested ISBN 9791223228388 onto imported book lacking ISBN');

    const s1Diag = await waitUntil(`Request #${s1Req.id} companion stage=fulfilled`, async () => {
      const d = await getDiagnostics(s1Req.id);
      return d.stage?.stage === 'fulfilled' ? d : false;
    }, 10000, 300);
    const s1LangEv = (s1Diag.verificationEvidence || []).find((e) => e.field === 'language');
    assert.equal(s1LangEv?.status, 'verified');
    assert.equal(s1LangEv?.observed, 'en');

    evidence.scenarios.scenario1_request116_no_isbn_no_year_accented_mixed = {
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
      },
      importedLibraryBook: {
        id: s1Book.id,
        title: s1Book.title,
        authors: s1Book.authors,
        publishedYear: s1Book.publishedYear ?? null,
        isbn13: s1Book.isbn13 ?? null,
      },
      companionDiagnostics: s1Diag,
    };
    console.log(`  PASS Scenario 1: Request #${s1Req.id} fulfilled -> Book #${s1Book.id} (year=${s1Book.publishedYear ?? null}, isbn13=${s1Book.isbn13 ?? null}, detectedLang=${s1LangEv?.observed})`);

    // ─────────────────────────────────────────────────────────────────────────
    // SCENARIO 2: Different ISBN + Different Year + Conflicting French Metadata Hint
    // (Jane Eyre by Charlotte Brontë: req 9780141441146 / 2006 vs EPUB 9780199535590 / 1998 / dc:language=fr)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[Scenario 2] Different ISBN + different year + conflicting French metadata hint (Jane Eyre by Charlotte Brontë)...');
    await ensureWorkAbsentBeforeTest(token, 'Jane Eyre');
    const s2ReleaseCheck = await verifyShelfmarkReleases('Jane Eyre', 'Charlotte Brontë');
    const s2Req = await createRealisticRequest(token, {
      title: 'Jane Eyre',
      author: 'Charlotte Brontë',
      publishedYear: 2006,
      isbn13: '9780141441146',
      language: 'en',
    });
    console.log(`  Created request #${s2Req.id} (publishedYear=${s2Req.publishedYear}, isbn13=${s2Req.isbn13})`);

    const s2FulfilledReq = await waitUntil(`Request #${s2Req.id} unattended fulfillment`, async () => {
      const r = await j(`${BO}/api/v1/book-requests/${s2Req.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const obj = r.body?.request || r.body;
      return obj?.status === 'available' && obj?.matchedBookId ? obj : false;
    }, 90000, 1000);

    const s2BookRes = await j(`${BO}/api/v1/books/${s2FulfilledReq.matchedBookId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(s2BookRes.ok, true);
    const s2Book = s2BookRes.body;
    assert.equal(s2Book.title, 'Jane Eyre');
    assert.equal(s2Book.publishedYear, 1998, 'Imported book preserves authentic EPUB year 1998 rather than request year 2006');
    assert.equal(s2Book.isbn13, '9780199535590', 'Imported book preserves authentic EPUB ISBN 9780199535590 rather than request ISBN 9780141441146');

    const s2Diag = await waitUntil(`Request #${s2Req.id} companion stage=fulfilled`, async () => {
      const d = await getDiagnostics(s2Req.id);
      return d.stage?.stage === 'fulfilled' ? d : false;
    }, 10000, 300);
    const s2LangEv = (s2Diag.verificationEvidence || []).find((e) => e.field === 'language');
    assert.equal(s2LangEv?.status, 'verified');
    assert.equal(s2LangEv?.observed, 'en');
    assert.equal(s2LangEv?.metadataHint, 'fr', 'Must record conflicting French metadata hint overridden by verified English body text');

    evidence.scenarios.scenario2_different_isbn_different_year_conflicting_hint = {
      passed: true,
      requestCreated: {
        id: s2Req.id,
        title: s2Req.title,
        publishedYear: s2Req.publishedYear,
        isbn13: s2Req.isbn13,
      },
      shelfmarkCandidatesObserved: s2ReleaseCheck,
      fulfilledRequest: {
        id: s2FulfilledReq.id,
        status: s2FulfilledReq.status,
        matchedBookId: s2FulfilledReq.matchedBookId,
      },
      importedLibraryBook: {
        id: s2Book.id,
        title: s2Book.title,
        authors: s2Book.authors,
        publishedYear: s2Book.publishedYear,
        isbn13: s2Book.isbn13,
      },
      companionDiagnostics: s2Diag,
    };
    console.log(`  PASS Scenario 2: Request #${s2Req.id} fulfilled -> Book #${s2Book.id} (authentic EPUB year=${s2Book.publishedYear}, isbn13=${s2Book.isbn13}, metadataHint=fr -> verified en)`);

    // ─────────────────────────────────────────────────────────────────────────
    // SCENARIO 3: Deceptive English Metadata + English Cover/TOC + Foreign Body Text Rejected Before Upload
    // (The Picture of Dorian Gray: Candidate A Spanish + Candidate B mixed-script Korean, both claiming dc:language=en)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[Scenario 3] Deceptive English metadata + English cover/TOC + Spanish & Korean body chapters rejected before upload...');
    await ensureWorkAbsentBeforeTest(token, 'The Picture of Dorian Gray');
    const s3ReleaseCheck = await verifyShelfmarkReleases('The Picture of Dorian Gray', 'Oscar Wilde');
    assert.equal(s3ReleaseCheck.releaseCount, 2, 'Expected 2 deceptive candidates for The Picture of Dorian Gray');

    const s3Req = await createRealisticRequest(token, {
      title: 'The Picture of Dorian Gray',
      author: 'Oscar Wilde',
      publishedYear: 2003,
      isbn13: '9780141439570',
      language: 'en',
    });
    console.log(`  Created request #${s3Req.id} (publishedYear=${s3Req.publishedYear}, isbn13=${s3Req.isbn13})`);

    const s3DiagInitial = await waitUntil(`Request #${s3Req.id} rejecting both deceptive Spanish & Korean EPUBs`, async () => {
      const d = await getDiagnostics(s3Req.id);
      if ((d.retryState?.attempts || 0) >= 2 && Array.isArray(d.verificationConflicts) && d.verificationConflicts.includes('language_mismatch')) {
        return d;
      }
      return false;
    }, 120000, 1000);

    // Wait >11s across a periodic reconcile() cycle to prove rejected foreign tasks are NEVER resurrected
    await sleep(11500);

    const s3ReqAfter = await j(`${BO}/api/v1/book-requests/${s3Req.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.body?.request || r.body);
    assert.equal(s3ReqAfter.status, 'approved', 'Wrong-language request must NOT become available');
    assert.equal(s3ReqAfter.matchedBookId, null, 'Wrong-language request must have matchedBookId === null');

    const s3BooksAfter = await listLibraryBooks(token, 1);
    assert.equal(
      s3BooksAfter.some((b) => String(b.title || '').toLowerCase().includes('dorian gray')),
      false,
      'Deceptive non-English EPUBs must be rejected BEFORE upload (zero Dorian Gray books in Library 1)'
    );

    const s3DiagFinal = await getDiagnostics(s3Req.id);
    assert.ok(s3DiagFinal.verificationConflicts.includes('language_mismatch'));

    evidence.scenarios.scenario3_deceptive_english_metadata_rejected = {
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
      dorianGrayBooksInLibraryCount: 0,
      companionDiagnosticsInitial: s3DiagInitial,
      companionDiagnosticsAfterReconcile: s3DiagFinal,
    };
    console.log(`  PASS Scenario 3: Both deceptive Spanish & Korean EPUBs rejected before upload (attempts=${s3DiagFinal.retryState?.attempts}, conflicts=${JSON.stringify(s3DiagFinal.verificationConflicts)}, libraryBooks=0)`);

    // ─────────────────────────────────────────────────────────────────────────
    // SCENARIO 4: Insufficient Readable Evidence Routed to review_required Before Upload
    // (Wuthering Heights: dc:language=en + English cover + 20 English TOC items + image-scan chapters)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[Scenario 4] Insufficient readable evidence (English cover + TOC + image-scan chapters) -> review_required...');
    await ensureWorkAbsentBeforeTest(token, 'Wuthering Heights');
    const s4ReleaseCheck = await verifyShelfmarkReleases('Wuthering Heights', 'Emily Brontë');
    const s4Req = await createRealisticRequest(token, {
      title: 'Wuthering Heights',
      author: 'Emily Brontë',
      publishedYear: 2003,
      isbn13: '9780141439556',
      language: 'en',
    });
    console.log(`  Created request #${s4Req.id} (publishedYear=${s4Req.publishedYear}, isbn13=${s4Req.isbn13})`);

    const s4DiagInitial = await waitUntil(`Request #${s4Req.id} insufficient_language_evidence -> review_required`, async () => {
      const d = await getDiagnostics(s4Req.id);
      if (d.stage?.stage === 'review_required' && Array.isArray(d.verificationConflicts) && d.verificationConflicts.includes('insufficient_language_evidence')) {
        return d;
      }
      return false;
    }, 90000, 1000);

    await sleep(11500);

    const s4ReqAfter = await j(`${BO}/api/v1/book-requests/${s4Req.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.body?.request || r.body);
    assert.equal(s4ReqAfter.status, 'approved');
    assert.equal(s4ReqAfter.matchedBookId, null);

    const s4BooksAfter = await listLibraryBooks(token, 1);
    assert.equal(
      s4BooksAfter.some((b) => String(b.title || '').toLowerCase().includes('wuthering heights')),
      false,
      'Insufficient-text scan EPUB must NOT be uploaded (zero Wuthering Heights books in Library 1)'
    );

    const s4DiagFinal = await getDiagnostics(s4Req.id);
    assert.equal(s4DiagFinal.stage?.stage, 'review_required');
    assert.ok(s4DiagFinal.verificationConflicts.includes('insufficient_language_evidence'));

    evidence.scenarios.scenario4_insufficient_text_review_required = {
      passed: true,
      requestCreated: {
        id: s4Req.id,
        title: s4Req.title,
        publishedYear: s4Req.publishedYear,
        isbn13: s4Req.isbn13,
      },
      shelfmarkCandidatesObserved: s4ReleaseCheck,
      requestStateAfterReconcile: {
        id: s4ReqAfter.id,
        status: s4ReqAfter.status,
        matchedBookId: s4ReqAfter.matchedBookId,
      },
      wutheringHeightsBooksInLibraryCount: 0,
      companionDiagnosticsInitial: s4DiagInitial,
      companionDiagnosticsAfterReconcile: s4DiagFinal,
    };
    console.log(`  PASS Scenario 4: Request #${s4Req.id} placed in review_required (conflicts=${JSON.stringify(s4DiagFinal.verificationConflicts)}, libraryBooks=0)`);

    // ─────────────────────────────────────────────────────────────────────────
    // SCENARIO 5: Bounded Alternative Recovery
    // Candidate A (exact ISBN + exact year + dc:language=en, BUT Portuguese chapters) rejected ->
    // Candidate B (NO ISBN, NO year, streaming ZIP, genuine English chapters) automatically fulfills!
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[Scenario 5] Bounded alternative recovery: exact-ISBN Portuguese Candidate A rejected -> no-ISBN English Candidate B fulfills...');
    await ensureWorkAbsentBeforeTest(token, 'Sense and Sensibility');
    const s5ReleaseCheck = await verifyShelfmarkReleases('Sense and Sensibility', 'Jane Austen');
    assert.equal(s5ReleaseCheck.releaseCount, 2, 'Expected 2 candidates for Sense and Sensibility');

    const s5Req = await createRealisticRequest(token, {
      title: 'Sense and Sensibility',
      author: 'Jane Austen',
      publishedYear: 2003,
      isbn13: '9780141439662',
      language: 'en',
    });
    console.log(`  Created request #${s5Req.id} (publishedYear=${s5Req.publishedYear}, isbn13=${s5Req.isbn13})`);

    const s5FulfilledReq = await waitUntil(`Request #${s5Req.id} bounded alternative fulfillment`, async () => {
      const r = await j(`${BO}/api/v1/book-requests/${s5Req.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const obj = r.body?.request || r.body;
      return obj?.status === 'available' && obj?.matchedBookId ? obj : false;
    }, 120000, 1000);

    const s5BookRes = await j(`${BO}/api/v1/books/${s5FulfilledReq.matchedBookId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(s5BookRes.ok, true);
    const s5Book = s5BookRes.body;
    assert.equal(s5Book.title, 'Sense and Sensibility');
    assert.equal(s5Book.publishedYear ?? null, null, 'Only Candidate B (no ISBN/year, genuine English) may be imported');
    assert.equal(s5Book.isbn13 ?? null, null, 'Only Candidate B (no ISBN/year, genuine English) may be imported');

    const s5BooksAll = await listLibraryBooks(token, 1);
    const senseBooks = s5BooksAll.filter((b) => String(b.title || '').toLowerCase().includes('sense and sensibility'));
    assert.equal(senseBooks.length, 1, 'Portuguese Candidate A must NOT have been uploaded');

    const s5Diag = await waitUntil(`Request #${s5Req.id} companion stage=fulfilled`, async () => {
      const d = await getDiagnostics(s5Req.id);
      return d.stage?.stage === 'fulfilled' ? d : false;
    }, 10000, 300);
    assert.equal(s5Diag.retryState?.attempts, 1, 'Must record 1 failed attempt from deceptive Portuguese Candidate A before Candidate B succeeded');

    const mirrorStats = await j(`${MIRROR_HOST_URL}/_stats`).then((r) => r.body);
    evidence.scenarios.scenario5_bounded_alternative_recovery = {
      passed: true,
      requestCreated: {
        id: s5Req.id,
        title: s5Req.title,
        publishedYear: s5Req.publishedYear,
        isbn13: s5Req.isbn13,
      },
      shelfmarkCandidatesObserved: s5ReleaseCheck,
      fulfilledRequest: {
        id: s5FulfilledReq.id,
        status: s5FulfilledReq.status,
        matchedBookId: s5FulfilledReq.matchedBookId,
      },
      importedLibraryBook: {
        id: s5Book.id,
        title: s5Book.title,
        publishedYear: s5Book.publishedYear ?? null,
        isbn13: s5Book.isbn13 ?? null,
      },
      senseAndSensibilityBooksInLibraryCount: senseBooks.length,
      companionDiagnostics: s5Diag,
    };
    evidence.controlledMirrorHttpAudit = mirrorStats;
    evidence.completedAt = new Date().toISOString();
    evidence.allPassed = true;
    console.log(`  PASS Scenario 5: Exact-ISBN Portuguese Candidate A rejected (attempts=${s5Diag.retryState?.attempts}) -> No-ISBN English Candidate B fulfilled -> Book #${s5Book.id}`);

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const outPath = resolve(REPO_ROOT, `e2e/results/work-language-policy-e2e-${ts}.json`);
    writeFileSync(outPath, JSON.stringify(evidence, null, 2));
    console.log(`\nALL 5 REALISTIC WORK + READING-LANGUAGE E2E SCENARIOS PASSED!`);
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
