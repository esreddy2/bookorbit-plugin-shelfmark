#!/usr/bin/env node
// Executable companion-driven E2E lifecycle test (isolated stack only).
// Targets ONLY 127.0.0.1:13031 (BookOrbit), 127.0.0.1:18085 (Shelfmark), 127.0.0.1:8090 (companion).
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  normalizeString,
  normalizeLanguageCode,
  extractCoreTitle,
  titleMatchDecision,
  authorMatchDecision,
  sameIsbn,
} from '../shared/identity.mjs';
import { extractEpubMetadata } from '../bridge/bridge.mjs';

const BO = 'http://127.0.0.1:13031';
const SM = 'http://127.0.0.1:18085';
const CP = 'http://127.0.0.1:8090';
const SECRET = 'bookorbit-shelfmark-secret';

function assertIsolated() {
  for (const u of [BO, SM, CP]) {
    if (!u.startsWith('http://127.0.0.1:')) throw new Error('Refusing non-isolated endpoint: ' + u);
    if (u.includes('13030') || u.includes('18084')) throw new Error('Refusing production tunnel endpoint');
  }
}
assertIsolated();

async function j(url, opts = {}) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { ok: r.ok, status: r.status, body };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function login() {
  const r = await j(`${BO}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'E2ePass123' }) });
  if (!r.ok) throw new Error('login failed: ' + JSON.stringify(r.body));
  return r.body.accessToken;
}

async function fetchAllRequests(token) {
  const out = [];
  let page = 1;
  while (true) {
    const r = await j(`${BO}/api/v1/book-requests?page=${page}&limit=100`, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!r.ok) throw new Error('list requests failed: ' + JSON.stringify(r.body));
    const items = Array.isArray(r.body.items) ? r.body.items : [];
    out.push(...items);
    if (items.length < 100 || out.length >= (r.body.total ?? out.length)) break;
    page += 1;
    if (page > 100) break;
  }
  return out;
}

async function downloadFile(token, fileId) {
  const r = await fetch(`${BO}/api/v1/books/files/${fileId}/download`, { headers: { 'Authorization': `Bearer ${token}` } });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`download failed ${r.status}: ${text.slice(0, 200)}`);
  }
  const ab = await r.arrayBuffer();
  return Buffer.from(ab);
}

async function main() {
  mkdirSync('e2e/results', { recursive: true });
  const evidence = { startedAt: new Date().toISOString(), isolated: true, endpoints: { bookorbit: BO, shelfmark: SM, companion: CP }, steps: [] };
  const record = (step, data) => { evidence.steps.push({ step, at: new Date().toISOString(), ...data }); console.log(`[${step}]`, JSON.stringify(data)); };

  // 1. health
  const h1 = await j(`${BO}/api/v1/health`);
  const h2 = await j(`${SM}/api/health`);
  const h3 = await j(`${CP}/api/status`, { headers: { 'X-Bridge-Secret': SECRET } });
  record('health', { bookorbit: h1.status, shelfmark: h2.status, companion: h3.status });
  if (!h1.ok || !h2.ok || !h3.ok) throw new Error('health check failed');

  const token = await login();
  const H = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
  const authH = { 'Authorization': `Bearer ${token}` };

  // 2. baseline capture (prevent reused requests)
  const baselineRequests = await fetchAllRequests(token);
  const baselineIds = new Set(baselineRequests.map((r) => r.id));
  const companionBefore = await j(`${CP}/api/status`, { headers: { 'X-Bridge-Secret': SECRET } });
  record('baseline', { requestCount: baselineRequests.length, ids: [...baselineIds], companion: companionBefore.body });
  evidence.baseline = { requestCount: baselineRequests.length, ids: [...baselineIds], companionBefore: companionBefore.body };

  // 3. create a unique request
  const baseTitle = process.env.E2E_TITLE || 'Fahrenheit 451';
  const baseAuthor = process.env.E2E_AUTHOR || 'Ray Bradbury';
  const baseLanguage = process.env.E2E_LANGUAGE || null;
  const baseYear = process.env.E2E_YEAR ? Number(process.env.E2E_YEAR) : null;
  const baseIsbn = process.env.E2E_ISBN || null;
  // Keep the canonical title so Shelfmark search works; uniqueness is enforced by the
  // baseline request-id check below (a brand-new request id is never in the baseline).
  const runTag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const uniqueTitle = baseTitle;
  const create = await j(`${BO}/api/v1/book-requests`, { method: 'POST', headers: H, body: JSON.stringify({ title: uniqueTitle, authors: [baseAuthor], mediaKind: 'ebook', preferredFormats: ['epub'], targetLibraryId: 1, language: baseLanguage, publishedYear: baseYear, isbn13: baseIsbn }) });
  if (!create.ok) throw new Error('create request failed: ' + JSON.stringify(create.body));
  const reqId = create.body.request.id;
  const reusedRequestDetected = baselineIds.has(reqId);
  record('create_request', { reqId, status: create.body.request.status, uniqueTitle, reusedRequestDetected });
  if (reusedRequestDetected) throw new Error('created request reuses a baseline request id: ' + reqId);

  // validate request identity (use create response to avoid an extra throttled GET)
  const createdReq = create.body.request || {};
  const requestTitleCore = normalizeString(extractCoreTitle(createdReq.title));
  const baseTitleCore = normalizeString(extractCoreTitle(baseTitle));
  const requestAuthors = Array.isArray(createdReq.authors) ? createdReq.authors : [];
  const requestAuthorOk = baseAuthor ? requestAuthors.some((a) => authorMatchDecision(a, baseAuthor).outcome === 'match') : true;
  const requestIdentityOk = requestTitleCore === baseTitleCore && requestAuthorOk;
  record('request_identity', { reqId, requestTitle: createdReq.title, requestAuthors, baseTitle, baseAuthor, requestTitleCore, baseTitleCore, requestAuthorOk, ok: requestIdentityOk });
  if (!requestIdentityOk) throw new Error('request identity mismatch');

  evidence.request = { baseTitle, baseAuthor, baseLanguage, baseYear, baseIsbn, runTag, uniqueTitle, reqId, requestIdentityOk };

  // 4. wait for automatic completion (no manual reconcile) for up to AUTO_WAIT_MS
  const AUTO_WAIT_MS = Number(process.env.E2E_AUTO_WAIT_MS || 120000);
  const POLL_MS = Number(process.env.E2E_POLL_MS || 3000);
  let status = create.body.request.status;
  let matchedBookId = create.body.request.matchedBookId;
  const tryFetch = async () => {
    const r = await j(`${BO}/api/v1/book-requests/${reqId}`, authH);
    if (r.ok && r.body && r.body.status) return r.body;
    return null;
  };
  const autoStart = Date.now();
  let completedDuringAutoWait = false;
  while (Date.now() - autoStart < AUTO_WAIT_MS) {
    await sleep(POLL_MS);
    const diag = await j(`${CP}/api/diagnostics/${reqId}`, { headers: { 'X-Bridge-Secret': SECRET } });
    const task = diag.ok ? diag.body?.task : null;
    if (task?.fulfilled === true) {
      completedDuringAutoWait = true;
      if (task.matchedBookId) matchedBookId = task.matchedBookId;
      const body = await tryFetch();
      if (body) { status = body.status; matchedBookId = body.matchedBookId || matchedBookId; }
      else { status = 'available'; }
      break;
    }
    const body = await tryFetch();
    if (body) { status = body.status; matchedBookId = body.matchedBookId; if (status === 'available' && matchedBookId) { completedDuringAutoWait = true; break; } }
  }
  record('auto_wait', { autoCompleted: completedDuringAutoWait, status, matchedBookId, waitedMs: Date.now() - autoStart });

  // 5. if not available, try one reconciliation cycle (fallback) and poll
  let reconcileCalled = false;
  let reconcileResult = null;
  let completedAfterFallback = false;
  if (!(status === 'available' && matchedBookId)) {
    reconcileCalled = true;
    reconcileResult = await j(`${CP}/api/reconcile`, { method: 'POST', headers: { 'X-Bridge-Secret': SECRET } });
    record('manual_reconcile_called', { status: reconcileResult.status, body: reconcileResult.body });
    const fbStart = Date.now();
    while (Date.now() - fbStart < AUTO_WAIT_MS) {
      await sleep(POLL_MS);
      const diag = await j(`${CP}/api/diagnostics/${reqId}`, { headers: { 'X-Bridge-Secret': SECRET } });
      const task = diag.ok ? diag.body?.task : null;
      if (task?.fulfilled === true) {
        completedAfterFallback = true;
        if (task.matchedBookId) matchedBookId = task.matchedBookId;
        const body = await tryFetch();
        if (body) { status = body.status; matchedBookId = body.matchedBookId || matchedBookId; }
        else { status = 'available'; }
        break;
      }
      const body = await tryFetch();
      if (body) { status = body.status; matchedBookId = body.matchedBookId; if (status === 'available' && matchedBookId) { completedAfterFallback = true; break; } }
    }
    record('fallback_reconcile', { completedAfterFallback, status, matchedBookId, waitedMs: Date.now() - fbStart });
  }

  for (let attempt = 0; attempt < 15; attempt++) {
    const body = await tryFetch();
    if (body) { status = body.status; matchedBookId = body.matchedBookId; break; }
    await sleep(10000);
  }
  const completed = (status === 'available' || completedDuringAutoWait || completedAfterFallback) && !!matchedBookId;
  const completionSource = completedDuringAutoWait ? 'auto' : (completedAfterFallback ? 'fallback' : 'none');

  evidence.completion = {
    autoWaitMs: AUTO_WAIT_MS,
    pollMs: POLL_MS,
    completedDuringAutoWait,
    reconcileCalled,
    reconcileResult: reconcileResult ? { status: reconcileResult.status, body: reconcileResult.body } : null,
    completedAfterFallback,
    completionSource,
    finalStatus: status,
    matchedBookId,
  };

  // 6. validation of selected release + imported book + EPUB metadata
  const validations = { failures: [] };
  const check = (cond, label) => { if (!cond) validations.failures.push(label); };

  let companionDiagnostics = null;
  let book = null;
  let epubValidation = { status: 'not_attempted' };

  if (completed) {
    companionDiagnostics = await j(`${CP}/api/diagnostics/${reqId}`, { headers: { 'X-Bridge-Secret': SECRET } });
    record('companion_diagnostics', { status: companionDiagnostics.status, body: companionDiagnostics.body });
    const task = companionDiagnostics.body?.task || null;
    const releaseTitleOk = !!task && titleMatchDecision(task.title || '', baseTitle).outcome === 'match';
    const releaseAuthorOk = !!task && (baseAuthor ? authorMatchDecision(task.author || (task.authors || []), baseAuthor).outcome === 'match' : true);
    const releaseFormatOk = !!task && (task.format || '').toLowerCase() === 'epub';
    check(releaseTitleOk, 'selected_release_title_mismatch');
    check(releaseAuthorOk, 'selected_release_author_mismatch');
    check(releaseFormatOk, 'selected_release_format_not_epub');
    evidence.selectedReleaseValidation = {
      ok: releaseTitleOk && releaseAuthorOk && releaseFormatOk,
      task,
      releaseTitleOk,
      releaseAuthorOk,
      releaseFormatOk,
      verificationEvidence: companionDiagnostics.body?.verificationEvidence || null,
      verificationConflicts: companionDiagnostics.body?.verificationConflicts || null,
    };

    const bookRes = await j(`${CP}/api/book/${matchedBookId}`, { headers: { 'X-Bridge-Secret': SECRET } });
    book = bookRes.ok ? bookRes.body : null;
    record('imported_book', { status: bookRes.status, id: matchedBookId, title: book?.title, authors: book?.authors, language: book?.language, publishedYear: book?.publishedYear, isbn13: book?.isbn13, files: book?.files });
    if (!bookRes.ok) {
      validations.failures.push('imported_book_fetch_failed');
    } else {
      const bookAuthors = (book.authors || []).map((a) => (typeof a === 'string' ? a : a.name));
      const bookTitleOk = titleMatchDecision(book.title || '', baseTitle).outcome === 'match';
      const bookAuthorOk = baseAuthor ? bookAuthors.some((a) => authorMatchDecision(a, baseAuthor).outcome === 'match') : true;
      const primaryFile = (book.files || []).find((f) => f.role === 'primary') || (book.files || [])[0] || null;
      const bookFormatOk = !!primaryFile && (primaryFile.format || '').toLowerCase() === 'epub';
      check(bookTitleOk, 'imported_book_title_mismatch');
      check(bookAuthorOk, 'imported_book_author_mismatch');
      check(bookFormatOk, 'imported_book_format_not_epub');

      const expectedLangCode = normalizeLanguageCode(baseLanguage) || 'en';
      const bookLangCode = normalizeLanguageCode(book.language);
      let languageStatus = 'not_provided';
      if (bookLangCode) {
        languageStatus = bookLangCode === expectedLangCode ? 'match' : 'mismatch';
        check(languageStatus === 'match', 'imported_book_language_mismatch');
      } else {
        languageStatus = `observed:${book.language ?? 'unknown'}`;
      }

      let yearStatus = 'not_provided';
      if (baseYear) {
        yearStatus = book.publishedYear === baseYear ? 'match' : 'mismatch';
        check(yearStatus === 'match', 'imported_book_year_mismatch');
      } else {
        yearStatus = `observed:${book.publishedYear ?? 'unknown'}`;
      }

      let isbnStatus = 'not_provided';
      if (baseIsbn) {
        isbnStatus = sameIsbn(book.isbn13, baseIsbn) ? 'match' : 'mismatch';
        check(isbnStatus === 'match', 'imported_book_isbn_mismatch');
      } else {
        isbnStatus = `observed:${book.isbn13 ?? 'unknown'}`;
      }

      evidence.importedBookValidation = {
        ok: bookTitleOk && bookAuthorOk && bookFormatOk,
        bookId: book.id,
        title: book.title,
        authors: bookAuthors,
        language: book.language,
        publishedYear: book.publishedYear,
        isbn13: book.isbn13,
        primaryFile,
        bookTitleOk,
        bookAuthorOk,
        bookFormatOk,
        languageStatus,
        yearStatus,
        isbnStatus,
      };

      // EPUB metadata validation
      if (primaryFile?.id) {
        try {
          const epubRes = await j(`${CP}/api/epub-metadata/${primaryFile.id}`, { headers: { 'X-Bridge-Secret': SECRET } });
          const epubMeta = epubRes.ok ? epubRes.body?.metadata : null;
          if (!epubRes.ok) throw new Error(JSON.stringify(epubRes.body));
          epubValidation = { status: 'extracted', metadata: epubMeta };
          const epubTitleOk = !!epubMeta && titleMatchDecision(epubMeta.title || '', baseTitle).outcome === 'match';
          const epubAuthorOk = !!epubMeta && (baseAuthor ? authorMatchDecision(epubMeta.author || '', baseAuthor).outcome === 'match' : true);
          const epubFormatOk = true;
          let epubLanguageStatus = 'not_provided';
          if (epubMeta?.language) {
            const epubLangCode = normalizeLanguageCode(epubMeta.language);
            epubLanguageStatus = epubLangCode === expectedLangCode ? 'match' : 'mismatch';
            check(epubLanguageStatus === 'match', 'epub_language_mismatch');
          }
          let epubYearStatus = 'not_provided';
          if (baseYear && epubMeta?.year) {
            epubYearStatus = epubMeta.year === baseYear ? 'match' : 'mismatch';
            check(epubYearStatus === 'match', 'epub_year_mismatch');
          } else if (epubMeta?.year) {
            epubYearStatus = `observed:${epubMeta.year}`;
          }
          let epubIsbnStatus = 'not_provided';
          if (epubMeta?.isbn && book.isbn13) {
            epubIsbnStatus = sameIsbn(epubMeta.isbn, book.isbn13) ? 'match' : 'mismatch';
            check(epubIsbnStatus === 'match', 'epub_isbn_mismatch_with_book');
          } else if (epubMeta?.isbn) {
            epubIsbnStatus = `observed:${epubMeta.isbn}`;
          }
          check(epubTitleOk, 'epub_title_mismatch');
          check(epubAuthorOk, 'epub_author_mismatch');
          epubValidation = {
            status: 'extracted',
            metadata: epubMeta,
            epubTitleOk,
            epubAuthorOk,
            epubLanguageStatus,
            epubYearStatus,
            epubIsbnStatus,
          };
        } catch (e) {
          epubValidation = { status: 'failed', reason: String(e.message || e) };
          validations.failures.push('epub_download_or_parse_failed');
        }
      } else {
        epubValidation = { status: 'skipped', reason: 'no_primary_file' };
        validations.failures.push('epub_no_primary_file');
      }
    }
  }

  evidence.validation = {
    requestIdentityOk,
    reusedRequestDetected,
    failures: validations.failures,
    allPassed: validations.failures.length === 0,
  };
  evidence.companionDiagnostics = companionDiagnostics ? companionDiagnostics.body : null;
  evidence.importedBook = book;
  evidence.epubValidation = epubValidation;

  evidence.finishedAt = new Date().toISOString();
  evidence.finalStatus = status;
  evidence.matchedBookId = matchedBookId;
  evidence.autoCompleted = completedDuringAutoWait;
  evidence.completed = completed;
  evidence.completionSource = completionSource;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = join('e2e/results', `lifecycle-test-${stamp}.json`);
  writeFileSync(out, JSON.stringify(evidence, null, 2));
  console.log('RESULT:', status, 'matchedBookId=', matchedBookId, 'completed=', completed, 'completionSource=', completionSource, 'validationFailures=', validations.failures, '->', out);

  if (!(completed && validations.failures.length === 0)) process.exit(1);
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
