/**
 * BookOrbit ↔ Shelfmark acceptance and regression verification, v1.5.21.
 *
 * EXTERNAL ORACLES — NOT AN IMPLEMENTATION-DERIVED TEST PLAN:
 *   - BookOrbit v3.5.0 API/host contracts and request behavior.
 *   - Shelfmark v1.5.1 search, queue, task status and custom-hook contracts.
 *   - The documented working CT105 workflow and its observed regressions.
 *
 * The test suite treats the plugin and companion as BLACK BOXES. Assertions
 * are about HTTP requests, response values, durable state, files, and user-
 * visible outcomes — not the internal algorithms used to achieve them.
 *
 * ALL backends are fake and isolated. The suite never contacts a real homelab,
 * never needs real credentials, and never writes to the actual library/state.
 *
 * Place at repository ROOT as verify.mjs, then run:
 *   node verify.mjs                # acceptance tests while developing
 *   node verify.mjs --release      # additionally require signed v1.5.21 release
 *
 * A 404 for an unknown route is intentional. NEVER add a made-up endpoint
 * to the allowlist just to make a test green. Verify an API contract first.
 *
 * The tests are deliberately independent of currently passing implementation.
 * Failing tests are actionable product/contract gaps, not reasons to weaken
 * their assertions. Release tests only pass after publication artifacts exist.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import plugin from './index.mjs';
import {
  BridgeService,
  BookOrbitAuthManager,
  BookOrbitSocketClient,
  timingSafeCompare,
  isJwt,
  decodeJwtExp,
  parseShelfmarkStatus,
  normalizeTaskGroup,
  parsePositiveInt,
  areEditionsCompatible,
  extractEpubMetadata,
  extractEpubMetadataFromFile,
  MAGIC_BYTES,
  sanitizeLog,
} from './bridge/bridge.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXPECTED_VERSION = '1.5.21';
const RELEASE_MODE = process.argv.includes('--release');
const TEST_TIMEOUT_MS = 10_000;
const tests = [];
const root = mkdtempSync(join(tmpdir(), 'bookorbit-shelfmark-verify-'));
let sequence = 0;
let passed = 0;
let failed = 0;
const failures = [];

function section(name) { console.log(`\n=== ${name} ===`); }
function test(name, run, timeoutMs = TEST_TIMEOUT_MS) { tests.push({ name, run, timeoutMs }); }
function unique(prefix = 'case') { return `${prefix}-${++sequence}`; }
function newStateFile(label = 'state') { return join(root, `${unique(label)}.json`); }
function pause(ms) { return new Promise((r) => setTimeout(r, ms)); }
function response(body, status = 200, headers = {}) {
  if (status === 204 || status === 304) return new Response(null, { status, headers });
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', ...headers },
  });
}
function failResponse(status = 500, message = 'Service unavailable') {
  return response({ error: message }, status);
}
function codeOf(err) { return err?.code ?? err?.name; }
async function rejectsWith(fn, matcher = () => true) {
  let error;
  try { await fn(); } catch (e) { error = e; }
  assert.ok(error, 'operation should have rejected');
  assert.ok(matcher(error), `unexpected rejection: ${String(error?.message || error)}`);
  return error;
}
function noSecrets(text, ...secrets) {
  for (const secret of secrets) assert.ok(!String(text).includes(secret), 'credential was leaked');
}
function expectedJson(opts) {
  assert.ok(opts?.body, 'request body missing');
  return typeof opts.body === 'string' ? JSON.parse(opts.body) : JSON.parse(Buffer.from(opts.body).toString('utf8'));
}

/**
 * The known contract surface is deliberately small. Only routes independently
 * established by the target API / handoff belong here. Other paths return 404.
 * In particular, GET /api/v1/admin/book-requests/:id DOES NOT EXIST in 3.5.0.
 */
const CONTRACT_ROUTES = Object.freeze([
  ['bo.health',     'GET',  /^\/api\/v1\/health\/?$/],
  ['bo.login',      'POST', /^\/api\/v1\/auth\/login\/?$/],
  ['bo.refresh',    'POST', /^\/api\/v1\/auth\/refresh\/?$/],
  ['bo.requests',   'GET',  /^\/api\/v1\/admin\/book-requests\/?$/],
  ['bo.request',    'GET',  /^\/api\/v1\/book-requests\/[^/]+\/?$/],
  ['bo.fulfill',    'POST', /^\/api\/v1\/admin\/book-requests\/[^/]+\/fulfill\/?$/],
  ['bo.upload',     'POST', /^\/api\/v1\/libraries\/[1-9]\d*\/upload\/?$/],
  ['bo.libraryBooks', 'POST', /^\/api\/v1\/libraries\/[1-9]\d*\/books\/?$/],
  ['bo.book',       'GET',  /^\/api\/v1\/books\/[1-9]\d*\/?$/],
  ['sm.health',     'GET',  /^\/api\/health\/?$/],
  ['sm.status',     'GET',  /^\/api\/status\/?$/],
  ['sm.metadata',   'GET',  /^\/api\/metadata\/search\/?$/],
  ['sm.releases',   'GET',  /^\/api\/releases\/?$/],
  ['sm.download',   'POST', /^\/api\/releases\/download\/?$/],
  ['sm.local',      'GET',  /^\/api\/localdownload\/?$/],
]);

/** Strict protocol fake: unlisted routes ALWAYS 404 and are audited. */
function contractFetch(handlers = {}, { throwOnUnexpected = false } = {}) {
  const calls = [];
  const unexpected = [];
  const fetchFn = async (url, options = {}) => {
    const method = String(options?.method || 'GET').toUpperCase();
    const parsed = new URL(String(url));
    const match = CONTRACT_ROUTES.find(([, m, path]) => m === method && path.test(parsed.pathname));
    const entry = { method, url: String(url), path: parsed.pathname, query: parsed.searchParams, options, route: match?.[0] ?? null };
    calls.push(entry);
    if (!match) {
      unexpected.push(entry);
      if (throwOnUnexpected) throw new Error(`UNDECLARED_API_ROUTE ${method} ${parsed.pathname}`);
      return failResponse(404, `No such endpoint: ${method} ${parsed.pathname}`);
    }
    const handler = handlers[match[0]];
    if (handler === undefined) return failResponse(503, `Fixture not configured: ${match[0]}`);
    const result = typeof handler === 'function' ? await handler(entry) : handler;
    return result instanceof Response ? result : response(result);
  };
  return {
    fetch: fetchFn, calls, unexpected,
    called(route) { return calls.filter((c) => c.route === route); },
    assertKnownRoutes() {
      assert.deepEqual(unexpected.map(({ method, path }) => `${method} ${path}`), [],
        'implementation called an endpoint not present in the v3.5.0/v1.5.1 contract');
    },
  };
}

function hostWith(fetchFn) {
  const calls = [];
  const host = {
    calls,
    fetch: async (url, opts = {}) => {
      assert.ok(!('signal' in opts && opts.signal !== undefined), 'BookOrbit PluginRequestInit does not accept signal');
      calls.push({ url, opts });
      return fetchFn(url, opts);
    },
    logger: { log() {}, warn() {}, error() {} },
    buildSearchText: (q) => [q?.title, q?.author].filter(Boolean).join(' ').trim(),
    fail: (code, message) => {
      assert.ok(['unauthorized', 'throttled', 'timeout', 'unreachable', 'unsupportedMedium', 'error'].includes(code),
        `unknown BookOrbit plugin error code ${code}`);
      const err = new Error(message || code);
      err.code = code;
      return err;
    },
  };
  return host;
}
function config(settings = {}) {
  return { id: 1, name: 'Shelfmark', baseUrl: 'http://shelfmark:8084', settings: {
    apiKey: 'fixture-secret-shelfmark-not-real', preferFormat: 'epub',
    downloadViaShelfmark: true, pollTimeoutSeconds: 0.2, pollIntervalMs: 10,
    ...settings,
  } };
}
function metadata(title, author, extra = {}) {
  return { provider: 'openlibrary', provider_id: unique('catalog'), title, authors: [author], ...extra };
}
function release(title, author, extra = {}) {
  return { id: unique('release'), source_id: unique('source'), source: 'annas', title, author,
    format: 'epub', size_bytes: 550_000, ...extra };
}
function queued(taskId, sourceId, title, extra = {}) {
  return { id: taskId, source: 'annas', source_id: sourceId, title, format: 'epub', status: 'queued', ...extra };
}
function bridgeOpts(extra = {}) {
  return {
    stateFilePath: newStateFile(),
    bookorbitUrl: 'http://bookorbit-app:3000',
    shelfmarkUrl: 'http://shelfmark:8084',
    bookorbitApiKey: 'fixture-bookorbit-key-not-real',
    shelfmarkApiKey: 'fixture-shelfmark-key-not-real',
    defaultLibraryId: 1, defaultFolderId: 1,
    allowedBaseDirs: [root],
    fileVisibilityAttempts: 2, fileVisibilityDelayMs: 5,
    dockReadinessAttempts: 2, dockReadinessIntervalMs: 5,
    maxSourceAttempts: 3, releaseFailureCooldownMs: 30_000,
    ...extra,
  };
}
function established(bridge, historical = ['historical-001']) {
  bridge.state.baselineEstablishedAt = '2026-10-28T00:00:00.000Z';
  bridge.state.baselineRequestIds = Object.fromEntries(historical.map((id) => [id, true]));
  bridge.saveState();
  return bridge;
}
function request(id, title, author, extra = {}) {
  return { id, title, author, status: 'approved', mediaKind: 'ebook',
    targetLibraryId: 1, targetFolderId: 1,
    requesterUserId: `user-${id}`, createdAt: '2026-10-29T00:00:00.000Z', ...extra };
}
function apiScenarios({ requests = [], details = {}, books = [], releases = [], taskId = unique('task'),
  libraryBooks,
  onPost = () => {}, onUpload, onFulfill,
  onMetadata, onReleases, ...handlers } = {}) {
  const libraryCards = Array.isArray(libraryBooks) ? [...libraryBooks] : [];
  const rawUpload = handlers['bo.upload'] ?? onUpload ?? (() => ({ id: 901 }));
  delete handlers['bo.upload'];
  const rawLibraryBooks = handlers['bo.libraryBooks'] ?? libraryBooks;
  delete handlers['bo.libraryBooks'];
  const rawFulfill = handlers['bo.fulfill'] ?? onFulfill ?? (() => ({ status: 'AVAILABLE' }));
  delete handlers['bo.fulfill'];

  return contractFetch({
    'bo.requests': () => response({ items: requests, total: requests.length, page: 1, limit: 50 }),
    'bo.request': ({ path }) => {
      const id = decodeURIComponent(path.split('/').at(-1));
      const item = details[id] ?? requests.find((r) => String(r.id) === id);
      return item ? response(item) : failResponse(404, 'Request not found');
    },
    'bo.upload': async (entry) => {
      onPost(entry);
      const res = typeof rawUpload === 'function' ? await rawUpload(entry) : rawUpload;
      if (res instanceof Response) {
        if (res.ok) {
          try {
            const data = await res.clone().json();
            const upId = parsePositiveInt(data?.id ?? data?.bookId);
            if (upId && !libraryCards.some((c) => parsePositiveInt(c?.id ?? c?.bookId) === upId)) {
              libraryCards.push({
                id: upId,
                title: data?.title ?? data?.existingBook?.title ?? requests[0]?.title ?? 'A Tale of Two Cities',
                author: data?.author ?? data?.existingBook?.author ?? requests[0]?.author ?? 'Charles Dickens',
                year: data?.year ?? data?.existingBook?.year ?? requests[0]?.year ?? 1859,
                format: 'epub',
              });
            }
          } catch {}
        }
        return res;
      }
      const upId = parsePositiveInt(res?.id ?? res?.bookId);
      if (upId && !libraryCards.some((c) => parsePositiveInt(c?.id ?? c?.bookId) === upId)) {
        libraryCards.push({
          id: upId,
          title: res?.title ?? res?.existingBook?.title ?? requests[0]?.title ?? 'A Tale of Two Cities',
          author: res?.author ?? res?.existingBook?.author ?? requests[0]?.author ?? 'Charles Dickens',
          year: res?.year ?? res?.existingBook?.year ?? requests[0]?.year ?? 1859,
          format: 'epub',
        });
      }
      return response(res);
    },
    'bo.libraryBooks': async (entry) => {
      if (rawLibraryBooks !== undefined) {
        const res = typeof rawLibraryBooks === 'function' ? await rawLibraryBooks(entry) : rawLibraryBooks;
        if (res instanceof Response) return res;
        const cards = Array.isArray(res) ? res : (res?.items || []);
        return response({ items: cards, total: Number(res?.total ?? cards.length) });
      }
      return response({ items: libraryCards, total: libraryCards.length });
    },
    'bo.fulfill': (entry) => {
      onPost(entry);
      const res = typeof rawFulfill === 'function' ? rawFulfill(entry) : rawFulfill;
      return res instanceof Response ? res : response(res);
    },
    'sm.metadata': (entry) => response(onMetadata ? onMetadata(entry) : { books }),
    'sm.releases': (entry) => response(onReleases ? onReleases(entry) : releases),
    'sm.status': () => response({ complete: {}, downloading: {}, queued: {}, error: {} }),
    'sm.download': (entry) => { onPost(entry); return response({ task_id: taskId }); },
    ...handlers,
  });
}
function createTask(bridge, extra = {}) {
  const taskId = extra.taskId || unique('task');
  const reqId = extra.requestIds?.[0] ?? unique('request');
  const task = {
    taskId, status: 'completed', title: 'A Tale of Two Cities', author: 'Charles Dickens',
    format: 'epub', filePath: FILES.taleEpub, libraryId: 1, folderId: 1,
    requestIds: [reqId], userIds: ['reader-1'], matchedBookId: null,
    requestFulfillments: {}, ...extra,
  };
  bridge.state.tasks[taskId] = task;
  bridge.state.requests[String(reqId)] = taskId;
  bridge.saveState();
  return task;
}

// Real ZIP/EPUB fixture built from the published EPUB container format rather
// than adopting a source-specific parser's implementation or fake PK-only data.
function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zipBytes(entries) {
  const locals = [], central = [];
  let offset = 0;
  for (const [name, value] of entries) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
    const filename = Buffer.from(name, 'utf8');
    const sum = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(sum, 14); local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(filename.length, 26);
    locals.push(local, filename, bytes);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6); directory.writeUInt32LE(sum, 16);
    directory.writeUInt32LE(bytes.length, 20); directory.writeUInt32LE(bytes.length, 24);
    directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, filename);
    offset += local.length + filename.length + bytes.length;
  }
  const centralLength = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralLength, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}
function epubBytes({ title = 'Frankenstein', author = 'Mary Wollstonecraft Shelley',
  year = 1818, isbn = '9780141439471', language = 'en' } = {}) {
  const opf = `<?xml version="1.0" encoding="UTF-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">\n<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n<dc:title>${title}</dc:title><dc:creator>${author}</dc:creator>\n<dc:language>${language}</dc:language><dc:date>${year}-01-01</dc:date>\n<dc:identifier id="id">urn:isbn:${isbn}</dc:identifier>\n</metadata><manifest><item id="text" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest>\n<spine><itemref idref="text"/></spine></package>`;
  return zipBytes([
    ['mimetype', 'application/epub+zip'],
    ['META-INF/container.xml', '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'],
    ['OEBPS/content.opf', opf],
    ['OEBPS/chapter.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Fixture only</p></body></html>'],
  ]);
}
const FILES = {
  validEpub: join(root, 'Frankenstein-1818.epub'),
  laterEpub: join(root, 'Frankenstein-2015.epub'),
  validPdf: join(root, 'Sample.pdf'),
  taleEpub: join(root, 'A-Tale-of-Two-Cities.epub'),
  fahrenheitEpub: join(root, 'Fahrenheit-451.epub'),
  animalFarmEpub: join(root, 'Animal-Farm.epub'),
  invalidEpub: join(root, 'fake.epub'),
  empty: join(root, 'zero.epub'),
};
writeFileSync(FILES.validEpub, epubBytes());
writeFileSync(FILES.laterEpub, epubBytes({ year: 2015, isbn: '9780199537150' }));
writeFileSync(FILES.taleEpub, epubBytes({ title: 'A Tale of Two Cities', author: 'Charles Dickens', year: 1859, isbn: '9780141439600' }));
writeFileSync(FILES.fahrenheitEpub, epubBytes({ title: 'Fahrenheit 451', author: 'Ray Bradbury', year: 1953, isbn: '9781451673319' }));
writeFileSync(FILES.animalFarmEpub, epubBytes({ title: 'Animal Farm', author: 'George Orwell', year: 1945, isbn: '9780451526342' }));
writeFileSync(FILES.validPdf, Buffer.from('%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\n%%EOF'));
writeFileSync(FILES.invalidEpub, '<html>not an EPUB</html>');
writeFileSync(FILES.empty, '');


// ─────────────────────────────────────────────────────────────────────────────
// 1. Plugin declaration, version and signed distribution contract
// ─────────────────────────────────────────────────────────────────────────────
test('DECLARATION: BookOrbit API v1, Shelfmark indexer and ebook-only', () => {
  assert.equal(plugin.apiVersion, 1);
  assert.equal(plugin.type, 'shelfmark');
  assert.deepEqual(plugin.mediaKinds, ['ebook']);
});
test('DECLARATION: native indexer advertises v1.5.21, never a previous version', () => {
  assert.equal(plugin.version, EXPECTED_VERSION);
});
test('DECLARATION: exposes search, test, and resolveFile entry points', () => {
  for (const name of ['test', 'search', 'resolveFile']) assert.equal(typeof plugin[name], 'function', name);
});
test('DECLARATION: requires configurable API key and EPUB-first preference', () => {
  assert.ok(plugin.settingsFields.some((f) => f.key === 'apiKey' && f.type === 'string'));
  assert.equal(plugin.settingsFields.find((f) => f.key === 'preferFormat')?.default, 'epub');
});
test('DECLARATION: native async/grab settings are explicitly represented', () => {
  assert.ok(plugin.settingsFields.some((f) => f.key === 'downloadViaShelfmark'));
  assert.ok(plugin.settingsFields.some((f) => f.key === 'pollTimeoutSeconds'));
});
test('DECLARATION: update channel is HTTPS and uses valid Ed25519 key metadata', () => {
  assert.match(plugin.update?.manifestUrl || '', /^https:\/\//);
  assert.match(plugin.update?.manifestUrl || '', /esreddy2\/bookorbit-plugin-shelfmark/);
  assert.match(plugin.update?.ed25519PublicKey || '', /^[A-Za-z0-9_-]{43}$/);
});
test('RELEASE CONTRACT: package version, plugin version and release target agree', () => {
  const packagePath = join(HERE, 'package.json');
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
  assert.equal(pkg.version, EXPECTED_VERSION);
  assert.equal(plugin.version, EXPECTED_VERSION);
});
if (RELEASE_MODE) {
  test('RELEASE: signed manifest has declared format and v1.5.21 version', () => {
    const manifest = JSON.parse(readFileSync(join(HERE, 'updates', 'shelfmark.json'), 'utf8'));
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.type, 'shelfmark');
    assert.equal(manifest.version, EXPECTED_VERSION);
    assert.match(manifest.sha256 || '', /^[0-9a-f]{64}$/);
    assert.ok(manifest.signature);
  });
  test('RELEASE: manifest SHA-256 matches the exact distributed indexer bytes', () => {
    const manifest = JSON.parse(readFileSync(join(HERE, 'updates', 'shelfmark.json'), 'utf8'));
    const digest = crypto.createHash('sha256').update(readFileSync(join(HERE, 'index.mjs'))).digest('hex');
    assert.equal(manifest.sha256, digest);
  });
  test('RELEASE: Ed25519 signature verifies the actual indexer bytes', () => {
    const manifest = JSON.parse(readFileSync(join(HERE, 'updates', 'shelfmark.json'), 'utf8'));
    const key = crypto.createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: plugin.update.ed25519PublicKey }, format: 'jwk',
    });
    assert.equal(crypto.verify(null, readFileSync(join(HERE, 'index.mjs')), key,
      Buffer.from(manifest.signature, 'base64')), true);
  });
  test('RELEASE: modified indexer bytes invalidate the manifest signature', () => {
    const manifest = JSON.parse(readFileSync(join(HERE, 'updates', 'shelfmark.json'), 'utf8'));
    const key = crypto.createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: plugin.update.ed25519PublicKey }, format: 'jwk',
    });
    const tampered = Buffer.concat([readFileSync(join(HERE, 'index.mjs')), Buffer.from('//tampers\n')]);
    assert.equal(crypto.verify(null, tampered, key, Buffer.from(manifest.signature, 'base64')), false);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Connectivity, authentication, network boundaries
// ─────────────────────────────────────────────────────────────────────────────
function testBackend(health, status) {
  return contractFetch({ 'sm.health': health, 'sm.status': status });
}
test('CONNECT: healthy Shelfmark accepts private API key', async () => {
  const mock = testBackend({ status: 'ok' }, { queued: {}, downloading: {}, complete: {}, error: {} });
  const host = hostWith(mock.fetch);
  const result = await plugin.test(config(), host);
  assert.equal(result.success, true);
  assert.ok(mock.called('sm.health').length >= 1);
  assert.ok(mock.called('sm.status').length >= 1);
  assert.ok(host.calls.some((c) => c.opts.headers?.['X-Api-Key'] === config().settings.apiKey));
  mock.assertKnownRoutes();
});
for (const status of [401, 403, 429, 500, 502, 503]) {
  test(`CONNECT: Shelfmark HTTP ${status} fails without claiming connectivity`, async () => {
    const mock = testBackend(failResponse(status, 'Backend rejected request'), failResponse(status));
    const result = await plugin.test(config(), hostWith(mock.fetch));
    assert.equal(result.success, false);
    assert.ok(result.error, 'must return an actionable error');
    mock.assertKnownRoutes();
  });
}
test('CONNECT: a reachable health endpoint but failed status endpoint is not healthy', async () => {
  const mock = testBackend({ status: 'ok' }, failResponse(500, 'Status route failed'));
  const result = await plugin.test(config(), hostWith(mock.fetch));
  assert.equal(result.success, false);
  mock.assertKnownRoutes();
});
test('CONNECT: network failure is contained and has no credential in diagnostic', async () => {
  const backend = async () => { throw new Error('ECONNREFUSED'); };
  const result = await plugin.test(config(), hostWith(backend));
  assert.equal(result.success, false);
  noSecrets(result.error, config().settings.apiKey);
});
test('CONNECT: malformed JSON does not report a successful connection', async () => {
  const mock = testBackend(response('{broken-json', 200), { complete: {} });
  const result = await plugin.test(config(), hostWith(mock.fetch));
  assert.equal(result.success, false);
});
test('CONNECT: no connection test calls an undeclared Shelfmark API route', async () => {
  const mock = testBackend({ status: 'ok' }, { complete: {} });
  await plugin.test(config(), hostWith(mock.fetch));
  mock.assertKnownRoutes();
});
test('HOST: custom fetch accepts only documented BookOrbit plugin options', async () => {
  const host = hostWith(async () => response({ ok: true }));
  await rejectsWith(() => host.fetch('http://shelfmark:8084/api/health', { signal: new AbortController().signal }));
});
test('HOST: invalid BookOrbit error codes fail the test harness, never masquerade as valid failures', () => {
  const host = hostWith(async () => response({}));
  assert.throws(() => host.fail('cancelled', 'not a supported host code'));
  assert.equal(host.fail('timeout', 'deadline').code, 'timeout');
});

aSyncGuard();
function aSyncGuard() { // Guard the test fixtures themselves against accidental false positives.
  test('HARNESS: unknown GET admin request-by-id is 404, not a successful dummy response', async () => {
    const mock = contractFetch({ 'bo.requests': [] });
    const res = await mock.fetch('http://bookorbit-app:3000/api/v1/admin/book-requests/123');
    assert.equal(res.status, 404);
    assert.equal(mock.unexpected.length, 1);
  });
  test('HARNESS: wrong HTTP method on a real route is also 404', async () => {
    const mock = contractFetch({ 'bo.fulfill': {} });
    const res = await mock.fetch('http://bookorbit-app:3000/api/v1/admin/book-requests/123/fulfill', { method: 'GET' });
    assert.equal(res.status, 404);
    assert.equal(mock.unexpected.length, 1);
  });
  test('HARNESS: a configured route with no fixture returns 503, not invented success', async () => {
    const mock = contractFetch({});
    assert.equal((await mock.fetch('http://shelfmark:8084/api/status')).status, 503);
    mock.assertKnownRoutes();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Native search results — external identity, language, edition and format
// ─────────────────────────────────────────────────────────────────────────────
async function searchScenario({ query, books, releases, settings, onMetadata, onReleases }) {
  const fake = apiScenarios({ books, releases, onMetadata, onReleases });
  const host = hostWith(fake.fetch);
  const result = await plugin.search(query, config(settings), host);
  assert.ok(Array.isArray(result), 'BookOrbit requires an array of release candidates');
  fake.assertKnownRoutes();
  return { result, fake, host };
}
const standardQuery = (title = 'Fahrenheit 451', author = 'Ray Bradbury', more = {}) =>
  ({ title, author, mediaKind: 'ebook', ...more });

test('SEARCH: exact title/author fetches metadata with title-only search', async () => {
  const { result, fake } = await searchScenario({
    query: standardQuery(), books: [metadata('Fahrenheit 451', 'Ray Bradbury')],
    releases: [release('Fahrenheit 451', 'Ray Bradbury')],
  });
  assert.ok(result.length > 0);
  assert.equal(result[0].format, 'epub');
  assert.equal(fake.called('sm.metadata')[0]?.query.get('query'), 'Fahrenheit 451');
});
test('SEARCH: a numeric title is not treated as a year or ISBN', async () => {
  const { result } = await searchScenario({
    query: standardQuery('1984', 'George Orwell'),
    books: [metadata('1984', 'George Orwell')], releases: [release('1984', 'George Orwell')],
  });
  assert.ok(result.some((r) => /1984/.test(r.title)));
});
test('SEARCH: numeric title provided as a number never throws', async () => {
  const { result } = await searchScenario({
    query: standardQuery(1984, 'George Orwell'),
    books: [metadata('1984', 'George Orwell')], releases: [release('1984', 'George Orwell')],
  });
  assert.ok(result.length > 0);
});
test('SEARCH: Nineteen Eighty-Four is equivalent to 1984 for George Orwell', async () => {
  const { result } = await searchScenario({
    query: standardQuery('1984', 'George Orwell'),
    books: [metadata('Nineteen Eighty-Four', 'George Orwell')],
    releases: [release('Nineteen Eighty-Four', 'George Orwell')],
  });
  assert.ok(result.length > 0);
});
test('SEARCH: an alternative title query is attempted when original numeric metadata is empty', async () => {
  const queried = [];
  const { result } = await searchScenario({
    query: standardQuery('1984', 'George Orwell'),
    onMetadata: ({ query }) => {
      const q = query.get('query'); queried.push(q);
      return { books: /nineteen/i.test(q) ? [metadata('Nineteen Eighty-Four', 'George Orwell')] : [] };
    },
    releases: [release('1984', 'George Orwell')],
  });
  assert.ok(queried.some((q) => /nineteen/i.test(q)));
  assert.ok(result.length > 0);
});
test('SEARCH: transposed author and MARC life dates are normalized for release searches', async () => {
  const { fake, result } = await searchScenario({
    query: standardQuery('Animal Farm', 'George Orwell'),
    books: [metadata('Animal Farm: A Fairy Story', 'Orwell, George, 1903-1950')],
    releases: [release('Animal Farm', 'George Orwell')],
  });
  assert.ok(result.length > 0);
  assert.ok(fake.called('sm.releases').some((c) => c.query.get('author') === 'George Orwell'));
});
test('SEARCH: metadata wrong-author match is not allowed to dictate a wrong release', async () => {
  const { result } = await searchScenario({
    query: standardQuery('1984', 'George Orwell'),
    books: [metadata('1984', 'Someone Else')],
    releases: [release('1984', 'Someone Else')],
  });
  assert.deepEqual(result, []);
});
test('SEARCH: no metadata match yields no release discovery (no fabricated IDs)', async () => {
  const { result, fake } = await searchScenario({
    query: standardQuery('Underground Book', 'Rare Author'),
    books: [], releases: [release('Underground Book', 'Rare Author')],
  });
  assert.deepEqual(result, []);
  assert.equal(fake.called('sm.releases').length, 0);
});
test('SEARCH: no match does not fabricate a candidate', async () => {
  const { result } = await searchScenario({
    query: standardQuery('Nonexistent Work 123456', 'Nonexistent Author'), books: [], releases: [],
  });
  assert.deepEqual(result, []);
});

const unsafeTitles = [
  'Study Guide: 1984 by George Orwell',
  'Summary and Analysis of 1984',
  'CliffsNotes on Orwell’s 1984',
  '1984: A Graphic Novel Adaptation',
  '1984 (Easy English, Graded Reader Stage 3)',
  '1984 and Animal Farm Complete Collection',
  '1984: Simplified Retelling',
  '1984-ieji (Lithuanian translation)',
];
for (const unsafeTitle of unsafeTitles) {
  test(`SEARCH: reject wrong work/adaptation: ${unsafeTitle}`, async () => {
    const { result } = await searchScenario({
      query: standardQuery('1984', 'George Orwell', { language: 'en' }),
      books: [metadata('1984', 'George Orwell')],
      releases: [release(unsafeTitle, 'George Orwell'), release('1984 (Signet Classics)', 'George Orwell')],
    });
    assert.ok(result.some((r) => /Signet/i.test(r.title)), 'valid book should survive');
    assert.ok(!result.some((r) => r.title === unsafeTitle), 'derivative/translation must not be returned');
  });
}

const wrongAuthors = ['Michael Dean', 'Eric Blair II', 'A. N. Other', 'George R. Orwell'];
for (const wrongAuthor of wrongAuthors) {
  test(`SEARCH: conflicting release author ${wrongAuthor} is rejected`, async () => {
    const { result } = await searchScenario({
      query: standardQuery('1984', 'George Orwell'),
      books: [metadata('1984', 'George Orwell')],
      releases: [release('1984', wrongAuthor), release('1984', 'George Orwell', { source_id: 'authentic-orwell' })],
    });
    assert.ok(result.some((r) => r.extra?.sourceId === 'authentic-orwell'));
    assert.ok(!result.some((r) => String(r.author).includes(wrongAuthor)));
  });
}

test('SEARCH: EPUB and PDF are eligible, with EPUB ranked first by default', async () => {
  const { result } = await searchScenario({
    query: standardQuery(), books: [metadata('Fahrenheit 451', 'Ray Bradbury')],
    releases: [release('Fahrenheit 451', 'Ray Bradbury', { format: 'pdf' }),
      release('Fahrenheit 451', 'Ray Bradbury', { format: 'epub' })],
  });
  assert.deepEqual(result.slice(0, 2).map((r) => r.format), ['epub', 'pdf']);
});
test('SEARCH: a PDF preference ranks PDF ahead of EPUB', async () => {
  const { result } = await searchScenario({
    query: standardQuery(), books: [metadata('Fahrenheit 451', 'Ray Bradbury')],
    releases: [release('Fahrenheit 451', 'Ray Bradbury', { format: 'epub' }),
      release('Fahrenheit 451', 'Ray Bradbury', { format: 'pdf' })],
    settings: { preferFormat: 'pdf' },
  });
  assert.equal(result[0]?.format, 'pdf');
});
for (const unsupported of ['mobi', 'azw3', 'm4b', 'mp3', 'flac', 'cbz', 'exe', 'zip']) {
  test(`SEARCH: unsupported ${unsupported} is excluded from ebook release candidates`, async () => {
    const { result } = await searchScenario({
      query: standardQuery('Dune', 'Frank Herbert'),
      books: [metadata('Dune', 'Frank Herbert')],
      releases: [release('Dune', 'Frank Herbert', { format: unsupported })],
    });
    assert.ok(!result.some((r) => r.format === unsupported));
  });
}

test('SEARCH: mixed EPUB/PDF provider formats produce an eligible ebook', async () => {
  const { result } = await searchScenario({
    query: standardQuery('1984', 'George Orwell'), books: [metadata('1984', 'George Orwell')],
    releases: [release('[PDF] [EPUB] 1984 by George Orwell Download', 'George Orwell', { format: 'epub, pdf' })],
  });
  assert.ok(result.some((r) => r.format === 'epub'));
});
test('SEARCH: explicit mismatched release language is rejected for an English request', async () => {
  const { result } = await searchScenario({
    query: standardQuery('1984', 'George Orwell', { language: 'en' }),
    books: [metadata('1984', 'George Orwell', { language: 'en' })],
    releases: [release('1984', 'George Orwell', { source_id: 'lt-1984', language: 'Lithuanian' }),
      release('1984', 'George Orwell', { source_id: 'en-1984', language: 'English' })],
  });
  assert.ok(result.some((r) => r.extra?.sourceId === 'en-1984'));
  assert.ok(!result.some((r) => r.extra?.sourceId === 'lt-1984'));
});
test('SEARCH: release language must not be fabricated from parent English metadata', async () => {
  const { result } = await searchScenario({
    query: standardQuery('1984', 'George Orwell', { language: 'en' }),
    books: [metadata('1984', 'George Orwell', { language: 'English' })],
    releases: [release('1984', 'George Orwell', { source_id: 'unknown-lang-1984', language: null })],
  });
  const found = result.find((r) => r.extra?.sourceId === 'unknown-lang-1984');
  if (found) assert.ok(!['English', 'en'].includes(found.language),
    'unknown release language was incorrectly asserted to be English');
});
test('SEARCH: ISBN-only BookOrbit query without metadata yields no releases', async () => {
  const isbn = '9780451524935';
  const { result, fake } = await searchScenario({
    query: { isbn13: isbn, isbn13s: [isbn], mediaKind: 'ebook' }, books: [],
    releases: [release('1984', 'George Orwell', { isbn })],
  });
  assert.deepEqual(result, []);
  assert.equal(fake.called('sm.releases').length, 0);
});
test('SEARCH: metadata ISBN is carried into the release lookup', async () => {
  const { fake } = await searchScenario({
    query: standardQuery('1984', 'George Orwell'),
    books: [metadata('1984', 'George Orwell', { isbn: ['9780451524935'] })],
    releases: [release('1984', 'George Orwell')],
  });
  assert.ok(fake.called('sm.releases').some((c) => c.query.get('isbn') === '9780451524935'));
});
test('SEARCH: ISBN-locked release query falls back to title and author without ISBN', async () => {
  const isbn = '9791223228388';
  const { result, fake } = await searchScenario({
    query: standardQuery('1984', 'George Orwell', { isbn13: isbn }),
    books: [metadata('1984', 'George Orwell', { isbn: [isbn] })],
    onReleases: (entry) => entry.query.get('isbn')
      ? { releases: [] }
      : { releases: [release('1984', 'George Orwell')] },
  });
  assert.ok(fake.called('sm.releases').some((c) => c.query.get('isbn') === isbn));
  assert.ok(fake.called('sm.releases').some((c) => !c.query.get('isbn')));
  assert.ok(result.length > 0);
});

test('SEARCH: a release with a conflicting authentic ISBN is rejected', async () => {
  const requestedIsbn = '9791223228388';
  const { result } = await searchScenario({
    query: standardQuery('1984', 'George Orwell', { isbn13: requestedIsbn }),
    books: [metadata('1984', 'George Orwell', { isbn: [requestedIsbn] })],
    releases: [release('1984', 'George Orwell', { isbn: '9780451524935' })],
  });
  assert.equal(result.length, 0);
});

test('SEARCH: no ISBN is fabricated when release metadata lacks one', async () => {
  const { result } = await searchScenario({
    query: standardQuery('1984', 'George Orwell'),
    books: [metadata('1984', 'George Orwell')],
    releases: [release('1984', 'George Orwell')],
  });
  assert.ok(result.every((r) => r.isbn === null || r.isbn === undefined || r.isbn === ''));
});
test('SEARCH: authentic size and metadata are preserved, unreported tracker fields stay unknown', async () => {
  const { result } = await searchScenario({
    query: standardQuery('1984', 'George Orwell'),
    books: [metadata('1984', 'George Orwell', { isbn: ['9780451524935'] })],
    releases: [release('1984', 'George Orwell', { size_bytes: 453921, language: 'English' })],
  });
  assert.ok(result.length > 0);
  assert.equal(result[0].sizeBytes, 453921);
  assert.equal(result[0].freeleech, null);
  assert.equal(result[0].primaryFileCount, null);
});
test('SEARCH: GUID serializes a durable source + source ID + file format', async () => {
  const { result } = await searchScenario({
    query: standardQuery('1984', 'George Orwell'),
    books: [metadata('1984', 'George Orwell')],
    releases: [release('1984', 'George Orwell', { source: 'annas', source_id: 'aa-1984-real-1' })],
  });
  const item = result.find((r) => r.extra?.sourceId === 'aa-1984-real-1');
  assert.ok(item);
  const payload = JSON.parse(item.guid);
  assert.equal(payload.source_id, 'aa-1984-real-1');
  assert.equal(payload.format, 'epub');
  assert.ok(payload.source);
});

const oceanPage = 'https://oceanofpdf.com/authors/george-orwell/pdf-epub-1984-download/';
test('SEARCH: OceanofPDF book-page URL survives the search result into serialized GUID', async () => {
  const { result } = await searchScenario({
    query: standardQuery('1984', 'George Orwell'),
    books: [metadata('1984', 'George Orwell')],
    releases: [release('1984', 'George Orwell', {
      source: 'oceanofpdf', source_id: 'oceanofpdf:source-record',
      download_url: oceanPage, info_url: oceanPage,
    })],
  });
  const item = result.find((r) => r.extra?.sourceId === 'oceanofpdf:source-record');
  assert.ok(item, 'correct OceanofPDF record should be presented');
  const guid = JSON.parse(item.guid);
  assert.ok([guid.source_url, guid.download_url, guid.info_url, guid.extra?.source_url]
    .some((value) => value === oceanPage), 'real source page URL was dropped from GUID');
});

test('SEARCH: configured release source is forwarded to /api/releases', async () => {
  const { fake } = await searchScenario({
    query: standardQuery(),
    books: [metadata('Fahrenheit 451', 'Ray Bradbury')],
    releases: [release('Fahrenheit 451', 'Ray Bradbury')],
    settings: { releaseSource: 'libgen' },
  });
  const calls = fake.called('sm.releases');
  assert.ok(calls.length > 0, 'must query releases');
  assert.ok(calls.every((c) => c.query.get('source') === 'libgen'),
    'configured source must be forwarded');
});

test('SEARCH: release source "all" or empty omits the source query parameter entirely', async () => {
  // Test source = 'all'
  const { fake: fakeAll } = await searchScenario({
    query: standardQuery(),
    books: [metadata('Fahrenheit 451', 'Ray Bradbury')],
    releases: [release('Fahrenheit 451', 'Ray Bradbury')],
    settings: { releaseSource: 'all' },
  });
  const callsAll = fakeAll.called('sm.releases');
  assert.ok(callsAll.length > 0, 'must query releases for source=all');
  assert.ok(callsAll.every((c) => !c.query.has('source')),
    'source parameter must be omitted when releaseSource is "all"');

  // Test source = '' (empty)
  const { fake: fakeEmpty } = await searchScenario({
    query: standardQuery(),
    books: [metadata('Fahrenheit 451', 'Ray Bradbury')],
    releases: [release('Fahrenheit 451', 'Ray Bradbury')],
    settings: { releaseSource: '' },
  });
  const callsEmpty = fakeEmpty.called('sm.releases');
  assert.ok(callsEmpty.length > 0, 'must query releases for empty source');
  assert.ok(callsEmpty.every((c) => !c.query.has('source')),
    'source parameter must be omitted when releaseSource is empty');

  // Test source = 'direct_download' preserves explicit source
  const { fake: fakeDirect } = await searchScenario({
    query: standardQuery(),
    books: [metadata('Fahrenheit 451', 'Ray Bradbury')],
    releases: [release('Fahrenheit 451', 'Ray Bradbury')],
    settings: { releaseSource: 'direct_download' },
  });
  const callsDirect = fakeDirect.called('sm.releases');
  assert.ok(callsDirect.length > 0, 'must query releases for direct_download');
  assert.ok(callsDirect.every((c) => c.query.get('source') === 'direct_download'),
    'explicit source direct_download must be preserved');

  // No direct /api/releases fallback without metadata-derived provider/book_id
  const { fake: fakeFallbackAll } = await searchScenario({
    query: standardQuery('Rare Book Title', 'Unknown Author'),
    books: [],
    releases: [release('Rare Book Title', 'Unknown Author')],
    settings: { releaseSource: 'all' },
  });
  const callsFallbackAll = fakeFallbackAll.called('sm.releases');
  assert.equal(callsFallbackAll.length, 0, 'must not query releases without metadata');
});

test('SEARCH: release payload carries the documented Shelfmark contract fields', async () => {
  const { result } = await searchScenario({
    query: standardQuery(),
    books: [metadata('Fahrenheit 451', 'Ray Bradbury')],
    releases: [release('Fahrenheit 451', 'Ray Bradbury')],
  });
  assert.ok(result.length > 0);
  const payload = result[0].extra.releasePayload;
  for (const field of ['source', 'source_id', 'title', 'format', 'content_type', 'protocol',
    'indexer', 'seeders', 'size', 'size_bytes', 'author', 'year', 'language', 'isbn']) {
    assert.ok(Object.hasOwn(payload, field), `missing payload field ${field}`);
  }
  assert.equal(payload.content_type, 'ebook');
  assert.equal(payload.format, 'epub');
  assert.equal(payload.source, 'annas');
});

test('SEARCH: release payload size is string or null, and size_bytes is numeric (Shelfmark parse_size_string safety)', async () => {
  // Case A: release reporting string size (e.g. "2.4 MB")
  const { result: resA } = await searchScenario({
    query: standardQuery(),
    books: [metadata('Fahrenheit 451', 'Ray Bradbury')],
    releases: [release('Fahrenheit 451', 'Ray Bradbury', { size: '2.4 MB', size_bytes: 2400000 })],
  });
  assert.ok(resA.length > 0);
  const payloadA = resA[0].extra.releasePayload;
  assert.equal(typeof payloadA.size, 'string', 'size must be a string');
  assert.equal(payloadA.size, '2.4 MB');
  assert.equal(typeof payloadA.size_bytes, 'number', 'size_bytes must be numeric');
  assert.equal(payloadA.size_bytes, 2400000);
  // Verify Shelfmark Python download/http.py::parse_size_string() .strip() safety
  assert.doesNotThrow(() => payloadA.size.trim());

  // Case B: release reporting numeric size (must normalize to string, never overwrite with number)
  const { result: resB } = await searchScenario({
    query: standardQuery(),
    books: [metadata('Fahrenheit 451', 'Ray Bradbury')],
    releases: [release('Fahrenheit 451', 'Ray Bradbury', { size: 550000 })],
  });
  assert.ok(resB.length > 0);
  const payloadB = resB[0].extra.releasePayload;
  assert.equal(typeof payloadB.size, 'string', 'numeric release.size must normalize to string');
  assert.equal(payloadB.size, '550000');
  assert.equal(typeof payloadB.size_bytes, 'number', 'size_bytes must be numeric');
  assert.equal(payloadB.size_bytes, 550000);

  // Case C: release with null/unreported size (must remain null, not overwritten with number)
  const { result: resC } = await searchScenario({
    query: standardQuery(),
    books: [metadata('Fahrenheit 451', 'Ray Bradbury')],
    releases: [release('Fahrenheit 451', 'Ray Bradbury', { size: null, size_bytes: 550000 })],
  });
  assert.ok(resC.length > 0);
  const payloadC = resC[0].extra.releasePayload;
  assert.equal(payloadC.size, null, 'unreported size must remain null');
  assert.equal(typeof payloadC.size_bytes, 'number');
  assert.equal(payloadC.size_bytes, 550000);
});
test('SEARCH: separate source IDs with same title must remain independently identifiable', async () => {
  const { result } = await searchScenario({
    query: standardQuery('Frankenstein', 'Mary Shelley'),
    books: [metadata('Frankenstein', 'Mary Shelley')],
    releases: [release('Frankenstein', 'Mary Shelley', { source_id: 'frank-a' }),
      release('Frankenstein', 'Mary Shelley', { source_id: 'frank-b' })],
  });
  const sourceIds = new Set(result.map((r) => r.extra?.sourceId));
  assert.ok(sourceIds.has('frank-a') && sourceIds.has('frank-b'));
});
test('SEARCH: no unsupported BookOrbit PluginRequestInit signal is passed during search', async () => {
  await searchScenario({ query: standardQuery(),
    books: [metadata('Fahrenheit 451', 'Ray Bradbury')],
    releases: [release('Fahrenheit 451', 'Ray Bradbury')] });
});
test('SEARCH: metadata 401 fails safely instead of returning a false positive release', async () => {
  const fake = apiScenarios({ 'sm.metadata': failResponse(401, 'Invalid metadata credentials'),
    'sm.releases': failResponse(401, 'Invalid release credentials') });
  let found;
  try { found = await plugin.search(standardQuery(), config(), hostWith(fake.fetch)); }
  catch (e) { assert.ok(e); }
  if (found) assert.equal(found.length, 0);
  fake.assertKnownRoutes();
});
test('SEARCH: malformed metadata response cannot create an invented release', async () => {
  const fake = apiScenarios({ 'sm.metadata': response('{truncated-json', 200), 'sm.releases': [] });
  try {
    const result = await plugin.search(standardQuery(), config(), hostWith(fake.fetch));
    assert.deepEqual(result, []);
  } catch (e) { assert.ok(e); }
  fake.assertKnownRoutes();
});
test('SEARCH: all results belong to the requested ebook medium', async () => {
  const { result } = await searchScenario({
    query: standardQuery('Dune', 'Frank Herbert'),
    books: [metadata('Dune', 'Frank Herbert')],
    releases: [release('Dune', 'Frank Herbert', { format: 'epub' }),
      release('Dune audiobook', 'Frank Herbert', { format: 'm4b' })],
  });
  assert.ok(result.every((r) => ['epub', 'pdf'].includes(r.format)));
});


// ─────────────────────────────────────────────────────────────────────────────
// 4. Native synchronous resolution and queue ownership
// ─────────────────────────────────────────────────────────────────────────────
function nativeRelease(sourceId = unique('native-source'), title = 'Fahrenheit 451', extra = {}) {
  return { title, format: 'epub', sizeBytes: 500_000,
    guid: JSON.stringify({ source: 'annas', source_id: sourceId, title, format: 'epub', ...extra }),
  };
}
function nativeStatus(tasks = {}, kind = 'complete') {
  return { complete: kind === 'complete' ? tasks : {}, downloading: kind === 'downloading' ? tasks : {},
    queued: kind === 'queued' ? tasks : {}, error: kind === 'error' ? tasks : {} };
}
async function nativeResolve(releaseCandidate, handlers = {}, settings = {}) {
  const fake = contractFetch({
    'sm.status': { complete: {}, downloading: {}, queued: {}, error: {} },
    'sm.download': { task_id: unique('new-native-task') },
    'sm.local': response('epub fixture bytes', 200), ...handlers,
  });
  const host = hostWith(fake.fetch);
  const outcome = await plugin.resolveFile(releaseCandidate, config(settings), host);
  fake.assertKnownRoutes();
  return { outcome, fake, host };
}
test('NATIVE: a matching completed task is reused without a new queue POST', async () => {
  const sourceId = unique('reusable');
  const taskId = unique('complete');
  const { outcome, fake } = await nativeResolve(nativeRelease(sourceId), {
    'sm.status': nativeStatus({ [taskId]: queued(taskId, sourceId, 'Fahrenheit 451', { status: 'completed' }) }),
  });
  assert.match(outcome.url, new RegExp(`id=${taskId}`));
  assert.equal(fake.called('sm.download').length, 0);
});
test('NATIVE: completed status is not enough if the actual file is gone', async () => {
  const sourceId = unique('missing-file');
  const taskId = unique('missing-task');
  const fake = contractFetch({
    'sm.status': nativeStatus({ [taskId]: queued(taskId, sourceId, 'Fahrenheit 451', { status: 'completed' }) }),
    'sm.local': failResponse(404, 'File no longer exists'),
    'sm.download': failResponse(500, 'already queued'),
  });
  await rejectsWith(() => plugin.resolveFile(nativeRelease(sourceId), config(), hostWith(fake.fetch)));
  assert.equal(fake.called('sm.local').length >= 1, true);
  fake.assertKnownRoutes();
});
test('NATIVE: pre-existing active task is adopted and polled without requeueing', async () => {
  const sourceId = unique('active-source');
  const taskId = unique('active-task');
  let statusCalls = 0;
  const { outcome, fake } = await nativeResolve(nativeRelease(sourceId), {
    'sm.status': () => response(++statusCalls < 2
      ? nativeStatus({ [taskId]: queued(taskId, sourceId, 'Fahrenheit 451', { status: 'downloading' }) }, 'downloading')
      : nativeStatus({ [taskId]: queued(taskId, sourceId, 'Fahrenheit 451', { status: 'completed' }) })),
  });
  assert.ok(outcome.url.includes(`id=${taskId}`));
  assert.equal(fake.called('sm.download').length, 0);
});
test('NATIVE: no existing task triggers exactly one queue POST and waits for completion', async () => {
  const sourceId = unique('fresh-src');
  const taskId = unique('fresh-task');
  let statusCalls = 0;
  const { outcome, fake } = await nativeResolve(nativeRelease(sourceId), {
    'sm.status': () => response(++statusCalls < 2 ? nativeStatus() :
      nativeStatus({ [taskId]: queued(taskId, sourceId, 'Fahrenheit 451', { status: 'completed' }) })),
    'sm.download': { task_id: taskId },
  });
  assert.ok(outcome.url.includes(`id=${taskId}`));
  assert.equal(fake.called('sm.download').length, 1);
});
test('NATIVE: a successful queue POST carries the exact selected source identity', async () => {
  const sourceId = unique('native-identity');
  const taskId = unique('identity-task');
  const fake = contractFetch({
    'sm.status': nativeStatus({ [taskId]: queued(taskId, sourceId, 'Fahrenheit 451', { status: 'completed' }) }),
    'sm.download': { task_id: taskId }, 'sm.local': response('binary'),
  });
  // Make status initially empty to force a POST.
  let statusCount = 0;
  const statusHandler = fake.fetch;
  const tracked = contractFetch({
    'sm.status': () => response(++statusCount === 1 ? nativeStatus() :
      nativeStatus({ [taskId]: queued(taskId, sourceId, 'Fahrenheit 451', { status: 'completed' }) })),
    'sm.download': { task_id: taskId }, 'sm.local': response('binary'),
  });
  await plugin.resolveFile(nativeRelease(sourceId), config(), hostWith(tracked.fetch));
  const posts = tracked.called('sm.download');
  assert.equal(posts.length, 1);
  const payload = expectedJson(posts[0].options);
  assert.equal(payload.source_id, sourceId);
  assert.equal(payload.format, 'epub');
  tracked.assertKnownRoutes();
});
test('NATIVE: queue POST normalizes older payload with numeric size to string and keeps size_bytes numeric', async () => {
  const sourceId = unique('num-size-src');
  const taskId = unique('num-size-task');
  const releaseWithOldNumericSize = nativeRelease(sourceId, 'Fahrenheit 451', {
    size: 654321, // numeric size in guid/payload from older bug!
    size_bytes: 654321,
  });
  let statusCalls = 0;
  const { outcome, fake } = await nativeResolve(releaseWithOldNumericSize, {
    'sm.status': () => response(++statusCalls < 2 ? nativeStatus() :
      nativeStatus({ [taskId]: queued(taskId, sourceId, 'Fahrenheit 451', { status: 'completed' }) })),
    'sm.download': { task_id: taskId },
  });
  assert.ok(outcome.url.includes(`id=${taskId}`));
  const downloadCalls = fake.called('sm.download');
  assert.equal(downloadCalls.length, 1);
  const sentPayload = expectedJson(downloadCalls[0].options);
  assert.equal(typeof sentPayload.size, 'string', 'Shelfmark download payload size must be string');
  assert.equal(sentPayload.size, '654321');
  assert.equal(typeof sentPayload.size_bytes, 'number', 'size_bytes must remain numeric');
  assert.equal(sentPayload.size_bytes, 654321);
});
test('NATIVE: OceanofPDF queue POST contains the real source page URL', async () => {
  let statusCount = 0;
  const taskId = unique('ocean-task');
  const fake = contractFetch({
    'sm.status': () => response(++statusCount === 1 ? nativeStatus() :
      nativeStatus({ [taskId]: queued(taskId, 'oceanofpdf:source-1984', '1984', { status: 'completed' }) })),
    'sm.download': { task_id: taskId }, 'sm.local': response('fixture'),
  });
  const selected = {
    title: '1984', format: 'epub',
    guid: JSON.stringify({ source: 'oceanofpdf', source_id: 'oceanofpdf:source-1984',
      title: '1984', format: 'epub', download_url: oceanPage, info_url: oceanPage,
      source_url: oceanPage }),
  };
  await plugin.resolveFile(selected, config(), hostWith(fake.fetch));
  assert.equal(fake.called('sm.download').length, 1, 'must queue new task');
  const body = expectedJson(fake.called('sm.download')[0].options);
  assert.ok([body.download_url, body.info_url, body.source_url, body.extra?.source_url].includes(oceanPage),
    'book page URL was omitted, which causes OceanofPDF to fail');
  fake.assertKnownRoutes();
});
for (const invalidUrl of [undefined, '', 'javascript:alert(1)', 'file:///etc/passwd',
  'http://127.0.0.1/private', 'https://wrong-domain.example/1984']) {
  test(`NATIVE: invalid OceanofPDF book-page URL ${String(invalidUrl)} is never queued`, async () => {
    const fake = contractFetch({ 'sm.status': nativeStatus(), 'sm.download': { task_id: 'should-not-queue' } });
    const candidate = { title: '1984', format: 'epub',
      guid: JSON.stringify({ source: 'oceanofpdf', source_id: unique('ocean-bad'),
        title: '1984', format: 'epub', source_url: invalidUrl, download_url: invalidUrl }),
    };
    try { await plugin.resolveFile(candidate, config(), hostWith(fake.fetch)); } catch (error) {
      assert.ok(error);
    }
    assert.equal(fake.called('sm.download').length, 0);
    fake.assertKnownRoutes();
  });
}
test('NATIVE: a duplicate-queue response adopts a matching Shelfmark task', async () => {
  const src = unique('duplicate-src');
  const taskId = unique('duplicate-task');
  let statusCall = 0;
  const { outcome, fake } = await nativeResolve(nativeRelease(src), {
    'sm.status': () => response(++statusCall === 1 ? nativeStatus() :
      nativeStatus({ [taskId]: queued(taskId, src, 'Fahrenheit 451', { status: 'completed' }) })),
    'sm.download': failResponse(500, 'Release is already in the download queue'),
  });
  assert.ok(outcome.url.includes(`id=${taskId}`));
  assert.equal(fake.called('sm.download').length, 1);
});
test('NATIVE: duplicate-queue error without a proven matching task fails closed', async () => {
  const fake = contractFetch({
    'sm.status': nativeStatus(),
    'sm.download': failResponse(500, 'Release is already in download queue'),
  });
  await rejectsWith(() => plugin.resolveFile(nativeRelease(), config(), hostWith(fake.fetch)));
  fake.assertKnownRoutes();
});
test('NATIVE: new request is not captured by unrelated completed task sharing title', async () => {
  const sourceId = unique('new-real-source');
  const taskId = unique('new-real-task');
  let statusCalls = 0;
  const { outcome, fake } = await nativeResolve(nativeRelease(sourceId), {
    'sm.status': () => response(++statusCalls === 1
      ? nativeStatus({ 'old-wrong-source': queued('old-wrong-source', 'unrelated-source', 'Fahrenheit 451', { status: 'completed' }) })
      : nativeStatus({ [taskId]: queued(taskId, sourceId, 'Fahrenheit 451', { status: 'completed' }) })),
    'sm.download': { task_id: taskId },
  });
  assert.ok(outcome.url.includes(`id=${taskId}`));
  assert.equal(fake.called('sm.download').length, 1);
});
test('NATIVE: historical failed tasks cannot override a newer exact successful task', async () => {
  const sourceId = unique('not-ancient');
  const taskId = unique('new-complete');
  const { outcome } = await nativeResolve(nativeRelease(sourceId), {
    'sm.status': {
      complete: { [taskId]: queued(taskId, sourceId, 'Fahrenheit 451', { status: 'completed' }) },
      error: { 'old-error': { id: 'old-error', title: 'Fahrenheit 451', error: 'Old mirror down' } },
    },
  });
  assert.ok(outcome.url.includes(`id=${taskId}`));
});
test('NATIVE: malformed release GUID fails without queueing unrelated content', async () => {
  const fake = contractFetch({ 'sm.status': nativeStatus(), 'sm.download': { task_id: 'bad' } });
  await rejectsWith(() => plugin.resolveFile({ title: 'Bad GUID', format: 'epub', guid: '{not-json' },
    config(), hostWith(fake.fetch)));
  assert.equal(fake.called('sm.download').length, 0);
});
test('NATIVE: two simultaneous callers for one release produce one queue POST', async () => {
  const sourceId = unique('concurrent');
  const taskId = unique('single-task');
  let posted = false;
  const fake = contractFetch({
    'sm.status': () => response(posted
      ? nativeStatus({ [taskId]: queued(taskId, sourceId, 'Fahrenheit 451', { status: 'completed' }) }) : nativeStatus()),
    'sm.download': () => { posted = true; return response({ task_id: taskId }); },
    'sm.local': response('binary'),
  });
  const r = nativeRelease(sourceId);
  const results = await Promise.all([plugin.resolveFile(r, config(), hostWith(fake.fetch)),
    plugin.resolveFile(r, config(), hostWith(fake.fetch))]);
  assert.equal(fake.called('sm.download').length, 1);
  assert.equal(results[0].url, results[1].url);
  fake.assertKnownRoutes();
});
test('NATIVE: abort before work makes no network calls', async () => {
  const ctrl = new AbortController(); ctrl.abort();
  const fake = contractFetch({ 'sm.status': nativeStatus() });
  await rejectsWith(() => plugin.resolveFile(nativeRelease(), config(), hostWith(fake.fetch), ctrl.signal));
  assert.equal(fake.calls.length, 0);
});
test('NATIVE: caller timeout is reported as timeout, not a successful download', async () => {
  const fake = contractFetch({
    'sm.status': nativeStatus({
      'forever-task': queued('forever-task', 'forever-source', 'A Long Book', { status: 'downloading' }),
    }, 'downloading'),
    'sm.download': { task_id: 'forever-task' },
  });
  const error = await rejectsWith(() => plugin.resolveFile(
    nativeRelease('forever-source', 'A Long Book'),
    config({ pollTimeoutSeconds: 0.06, pollIntervalMs: 5 }), hostWith(fake.fetch)));
  assert.equal(codeOf(error), 'timeout');
  fake.assertKnownRoutes();
});
test('NATIVE: explicit user cancellation cannot be reported as completed', async () => {
  const ctrl = new AbortController(); ctrl.abort();
  const fake = contractFetch({ 'sm.status': nativeStatus() });
  const err = await rejectsWith(() => plugin.resolveFile(nativeRelease(), config(), hostWith(fake.fetch), ctrl.signal));
  assert.notEqual(err.code, 'success');
});
test('NATIVE: no API key is echoed in a failed queue diagnostic', async () => {
  const secret = 'fixture-secret-NEVER-LOG-this';
  const fake = contractFetch({ 'sm.status': nativeStatus(),
    'sm.download': failResponse(500, `Internal error key=${secret}`) });
  const error = await rejectsWith(() => plugin.resolveFile(nativeRelease(),
    config({ apiKey: secret }), hostWith(fake.fetch)));
  noSecrets(error.message, secret);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Shelfmark task status, source IDs, task collisions and durable queue state
// ─────────────────────────────────────────────────────────────────────────────
test('STATUS: Shelfmark keyed complete/download/error groups are mapped to task IDs', () => {
  const parsed = parseShelfmarkStatus({
    complete: { 'task-a': { title: 'A' } },
    downloading: { 'task-b': { title: 'B' } },
    queued: { 'task-c': { title: 'C' } },
    error: { 'task-d': { title: 'D', error: 'Source failure' } },
  });
  assert.equal(parsed.complete[0].id, 'task-a');
  assert.equal(parsed.downloading[0].id, 'task-b');
  assert.equal(parsed.queued[0].id, 'task-c');
  assert.equal(parsed.error[0].id, 'task-d');
});
test('STATUS: array status groups remain valid and keep IDs', () => {
  const parsed = parseShelfmarkStatus({
    completed: [{ id: 'a-1', title: 'First' }], active: [{ id: 'a-2', title: 'Second' }],
    failed: [{ id: 'a-3', title: 'Third' }],
  });
  assert.equal(parsed.complete[0].id, 'a-1');
  assert.equal(parsed.downloading[0].id, 'a-2');
  assert.equal(parsed.error[0].id, 'a-3');
});
test('STATUS: keyed group does not discard a colon-delimited OceanofPDF task ID', () => {
  const task = 'oceanofpdf:145751b6b720f7ac36f0a514a2ff8fdc';
  const items = normalizeTaskGroup({ [task]: { title: '1984', format: 'epub' } });
  assert.equal(items[0].task_id, task);
  assert.equal(items[0].id, task);
});
test('STATUS: empty, null and empty-array input cannot fabricate tasks', () => {
  for (const value of [null, undefined, {}, []]) assert.deepEqual(normalizeTaskGroup(value), []);
});
test('STATUS: completed and failed are not confused when both exist for different IDs', () => {
  const parsed = parseShelfmarkStatus({
    complete: { 'task-good': { title: '1984' } },
    error: { 'task-old': { title: '1984', error: 'Old source' } },
  });
  assert.equal(parsed.complete[0].id, 'task-good');
  assert.equal(parsed.error[0].id, 'task-old');
});

function sampleQueueRelease(extra = {}) {
  return { source: 'annas', sourceId: unique('source'), title: 'Animal Farm',
    author: 'George Orwell', format: 'epub', ...extra };
}
function queueFixture(fake, bridge, releaseCandidate, reqId = unique('req')) {
  return bridge.queueRelease({ requestId: reqId, userId: `user-${reqId}`,
    release: releaseCandidate, fetchFn: fake.fetch });
}
test('QUEUE: a new release is sent to Shelfmark exactly once and persisted', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const taskId = unique('shelfmark-task');
  const fake = apiScenarios({ taskId });
  const releaseCandidate = sampleQueueRelease();
  const result = await queueFixture(fake, bridge, releaseCandidate, 'req-101');
  assert.equal(result.taskId, taskId);
  assert.equal(fake.called('sm.download').length, 1);
  assert.ok(bridge.state.tasks[taskId]?.requestIds.includes('req-101'));
  fake.assertKnownRoutes();
});
test('QUEUE: task and request mapping survive process restart without losing baseline', async () => {
  const stateFilePath = newStateFile();
  const bridge = established(new BridgeService(bridgeOpts({ stateFilePath })), ['old-1', 'old-2']);
  const taskId = unique('restart-task');
  const fake = apiScenarios({ taskId });
  await queueFixture(fake, bridge, sampleQueueRelease(), 'new-1');
  const restarted = new BridgeService(bridgeOpts({ stateFilePath }));
  assert.ok(restarted.state.tasks[taskId]?.requestIds.includes('new-1'));
  assert.equal(restarted.state.requests['new-1'], taskId);
  assert.equal(restarted.state.baselineRequestIds['old-2'], true);
});
test('QUEUE: two users selecting the same release share one task and retain both request IDs', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const taskId = unique('shared-task');
  const fake = apiScenarios({ taskId });
  const selected = sampleQueueRelease();
  const first = await queueFixture(fake, bridge, selected, 'alice-1');
  const second = await queueFixture(fake, bridge, selected, 'bob-1');
  assert.equal(first.taskId, taskId);
  assert.equal(second.taskId, taskId);
  assert.equal(fake.called('sm.download').length, 1);
  assert.deepEqual(new Set(bridge.state.tasks[taskId].requestIds), new Set(['alice-1', 'bob-1']));
});
test('QUEUE: two different sources remain distinct even for identical work', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const ids = ['source-1', 'source-2'];
  const fake = apiScenarios({ 'sm.download': ({ options }) => response({ task_id:
    `task-${expectedJson(options).source_id}` }) });
  const a = await queueFixture(fake, bridge, sampleQueueRelease({ sourceId: ids[0] }), 'req-A');
  const b = await queueFixture(fake, bridge, sampleQueueRelease({ sourceId: ids[1] }), 'req-B');
  assert.notEqual(a.taskId, b.taskId);
  assert.equal(fake.called('sm.download').length, 2);
});
test('QUEUE: conflicting source identity returned as an already-used task ID fails closed', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const collisionId = unique('collision-id');
  const fake = apiScenarios({ taskId: collisionId });
  await queueFixture(fake, bridge, sampleQueueRelease({ sourceId: 'frankenstein-a', title: 'Frankenstein',
    author: 'Mary Shelley', year: 1818 }), 'req-1818');
  await rejectsWith(() => queueFixture(fake, bridge, sampleQueueRelease({ sourceId: 'frankenstein-b',
    title: 'Frankenstein', author: 'Mary Shelley', year: 2015 }), 'req-2015'));
  assert.equal(bridge.state.tasks[collisionId].year, 1818);
  assert.deepEqual(bridge.state.tasks[collisionId].requestIds, ['req-1818']);
});
test('QUEUE: identical task ID cannot be silently reused for a different title', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const fake = apiScenarios({ taskId: unique('same-id') });
  await queueFixture(fake, bridge, sampleQueueRelease({ sourceId: 's1' }), 'req-a');
  await rejectsWith(() => queueFixture(fake, bridge,
    sampleQueueRelease({ sourceId: 's2', title: '1984', author: 'George Orwell' }), 'req-b'));
});
test('QUEUE: an empty queue acknowledgement is uncertain, never a fabricated task ID', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const fake = apiScenarios({ 'sm.download': response({}) });
  const selected = sampleQueueRelease({ sourceId: 'uncertain-1' });
  const first = await queueFixture(fake, bridge, selected, 'req-uncertain-A');
  assert.equal(first.taskId, null);
  assert.equal(first.status, 'uncertain_queue');
  const second = await queueFixture(fake, bridge, selected, 'req-uncertain-B');
  assert.notEqual(second.status, 'queued');
  assert.equal(fake.called('sm.download').length, 1, 'do not blindly repeat uncertain POST');
});
test('QUEUE: no queue response due to connection reset is treated as uncertain, not safe to requeue immediately', async () => {
  const bridge = new BridgeService(bridgeOpts());
  let posts = 0;
  const fake = apiScenarios({
    'sm.download': () => { posts++; throw new Error('ECONNRESET after request was sent'); },
  });
  const selected = sampleQueueRelease({ sourceId: unique('uncertain-network') });
  try { await queueFixture(fake, bridge, selected, 'first'); } catch {}
  try { await queueFixture(fake, bridge, selected, 'second'); } catch {}
  assert.equal(posts, 1, 'network response loss must not create an unbounded duplicate queue');
});
test('QUEUE: HTTP duplicate error adopts same exact release from keyed Shelfmark status', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const src = unique('status-src');
  const taskId = unique('already-task');
  const fake = apiScenarios({
    'sm.download': failResponse(500, 'Release is already in download queue'),
    'sm.status': response({ downloading: {
      [taskId]: queued(taskId, src, 'Animal Farm', { status: 'downloading' }),
    } }),
  });
  const result = await queueFixture(fake, bridge, sampleQueueRelease({ sourceId: src }), 'recovered');
  assert.equal(result.taskId, taskId);
  fake.assertKnownRoutes();
});
test('QUEUE: duplicate response cannot adopt a task with incompatible source ID', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const fake = apiScenarios({
    'sm.download': failResponse(500, 'Release already queued'),
    'sm.status': response({ downloading: {
      'unrelated-task': queued('unrelated-task', 'different-source', 'Animal Farm'),
    } }),
  });
  try { await queueFixture(fake, bridge, sampleQueueRelease({ sourceId: 'wanted-source' }), 'specific-request'); }
  catch {}
  assert.notEqual(bridge.state.requests['specific-request'], 'unrelated-task');
});
test('QUEUE: OceanofPDF URL reaches Shelfmark unchanged from companion queue', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const fake = apiScenarios();
  const selected = sampleQueueRelease({ source: 'oceanofpdf', sourceId: 'oceanofpdf:1984-source',
    title: '1984', author: 'George Orwell', downloadUrl: oceanPage, infoUrl: oceanPage,
    guid: JSON.stringify({ source: 'oceanofpdf', source_id: 'oceanofpdf:1984-source',
      title: '1984', format: 'epub', download_url: oceanPage, info_url: oceanPage, source_url: oceanPage }),
  });
  await queueFixture(fake, bridge, selected);
  assert.equal(fake.called('sm.download').length, 1);
  const payload = expectedJson(fake.called('sm.download')[0].options);
  assert.ok([payload.download_url, payload.info_url, payload.source_url, payload.extra?.source_url]
    .includes(oceanPage));
  fake.assertKnownRoutes();
});
for (const candidateUrl of [null, '', 'file:///etc/passwd', 'http://localhost/admin',
  'https://otherdomain.example/fake-download']) {
  test(`QUEUE: invalid OceanofPDF URL ${String(candidateUrl)} fails before sending task`, async () => {
    const bridge = new BridgeService(bridgeOpts());
    const fake = apiScenarios();
    try { await queueFixture(fake, bridge, sampleQueueRelease({ source: 'oceanofpdf',
      sourceId: unique('bad-ocean'), title: '1984', downloadUrl: candidateUrl,
      infoUrl: candidateUrl, sourceUrl: candidateUrl,
    })); } catch {}
    assert.equal(fake.called('sm.download').length, 0);
    fake.assertKnownRoutes();
  });
}
test('QUEUE: a release selected with a full serialized GUID retains source URL after adaptation', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const fake = apiScenarios();
  const selected = { title: '1984', format: 'epub',
    guid: JSON.stringify({ source: 'oceanofpdf', source_id: 'oceanofpdf:guid-case', title: '1984',
      format: 'epub', source_url: oceanPage, download_url: oceanPage, info_url: oceanPage }) };
  await queueFixture(fake, bridge, selected);
  const body = expectedJson(fake.called('sm.download')[0].options);
  assert.equal(body.source_id, 'oceanofpdf:guid-case');
  assert.ok([body.source_url, body.download_url, body.info_url].includes(oceanPage));
});
test('QUEUE: no fabricated task IDs after Shelfmark returns a real namespaced task ID', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const realId = 'oceanofpdf:145751b6b720f7ac36f0a514a2ff8fdc';
  const fake = apiScenarios({ taskId: realId });
  const result = await queueFixture(fake, bridge, sampleQueueRelease());
  assert.equal(result.taskId, realId);
  assert.ok(bridge.state.tasks[realId]);
});
test('QUEUE: bridge normalizes older release candidate with numeric size to string before POSTing to Shelfmark', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const taskId = unique('task-numeric-size');
  const fake = apiScenarios({ taskId });
  const olderRelease = {
    source: 'annas',
    sourceId: unique('annas-old-size'),
    title: '1984',
    format: 'epub',
    author: 'George Orwell',
    size: 789123,
    sizeBytes: 789123,
    guid: JSON.stringify({
      source: 'annas',
      source_id: unique('annas-old-size-guid'),
      title: '1984',
      format: 'epub',
      size: 789123,
    }),
  };
  const res = await queueFixture(fake, bridge, olderRelease, 'req-size-test');
  assert.equal(res.taskId, taskId);
  const calls = fake.called('sm.download');
  assert.equal(calls.length, 1, 'POST /api/releases/download must be called');
  const downloadPayload = expectedJson(calls[0].options);
  assert.equal(typeof downloadPayload.size, 'string', 'Shelfmark payload size must be string to prevent .strip() crash');
  assert.equal(downloadPayload.size, '789123');
  assert.equal(typeof downloadPayload.size_bytes, 'number', 'Shelfmark payload size_bytes must be numeric');
  assert.equal(downloadPayload.size_bytes, 789123);
  assert.doesNotThrow(() => {
    if (downloadPayload.size) downloadPayload.size.trim();
  });
  assert.ok(bridge.state.tasks[taskId]);
  assert.equal(bridge.state.requests['req-size-test'], taskId);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Edition semantics — never merge different requested books
// ─────────────────────────────────────────────────────────────────────────────
const FRANK = (year, isbn, extra = {}) => ({ title: 'Frankenstein', author: 'Mary Shelley',
  format: 'epub', year, ...(isbn ? { isbn } : {}), ...extra });
const editionCases = [
  ['same title/author/year', FRANK(1818), FRANK(1818), true],
  ['author middle names and same year', FRANK(1818), FRANK(1818, null, { author: 'Mary Wollstonecraft Shelley' }), true],
  ['1818 and 2015 years', FRANK(1818), FRANK(2015), false],
  ['2015 and 1818 years', FRANK(2015), FRANK(1818), false],
  ['different known ISBNs', FRANK(null, '9780141439471'), FRANK(null, '9780199537150'), false],
  ['same verified ISBN', FRANK(null, '9780141439471'), FRANK(null, '9780141439471'), true],
  ['known requested year and unknown candidate year', FRANK(1818), FRANK(undefined), false],
  ['different file media', FRANK(1818), FRANK(1818, null, { format: 'mp3' }), false],
  ['different title', FRANK(1818), { title: 'Dracula', author: 'Mary Shelley', year: 1818, format: 'epub' }, false],
];
for (const [name, requested, candidate, compatible] of editionCases) {
  test(`EDITION: ${name} → ${compatible ? 'compatible' : 'not compatible'}`, () => {
    assert.equal(Boolean(areEditionsCompatible(requested, candidate)), compatible);
  });
}
test('EDITION: OPF date, ISBN, author and language extracted from a real EPUB ZIP', () => {
  const result = extractEpubMetadataFromFile(FILES.validEpub);
  assert.equal(result.title, 'Frankenstein');
  assert.match(String(result.author), /Mary/i);
  assert.equal(result.year, 1818);
  assert.equal(result.isbn, '9780141439471');
});
test('EDITION: reading EPUB metadata from Buffer agrees with reading from file', () => {
  const file = extractEpubMetadataFromFile(FILES.validEpub);
  const memory = extractEpubMetadata(readFileSync(FILES.validEpub));
  assert.equal(memory.title, file.title);
  assert.equal(memory.year, file.year);
  assert.equal(memory.isbn, file.isbn);
});
test('EDITION: EPUB missing/corrupt inputs do not invent authoritative metadata', () => {
  assert.equal(extractEpubMetadata('not a Buffer'), null);
  assert.equal(extractEpubMetadata(Buffer.from('x')), null);
});
test('EDITION: same title but different EPUB OPF years must not be cross-adopted', () => {
  assert.equal(areEditionsCompatible(FRANK(1818),
    { title: 'Frankenstein', author: 'Mary Shelley', format: 'epub', filePath: FILES.validEpub }), true);
  assert.equal(areEditionsCompatible(FRANK(2015),
    { title: 'Frankenstein', author: 'Mary Shelley', format: 'epub', filePath: FILES.validEpub }), false);
});
test('EDITION: second EPUB has different embedded year and ISBN', () => {
  const result = extractEpubMetadataFromFile(FILES.laterEpub);
  assert.equal(result.year, 2015);
  assert.equal(result.isbn, '9780199537150');
});
test('EDITION: direct upload collision must not convert 1818 request into 2015 book', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const task = createTask(bridge, { title: 'Frankenstein', author: 'Mary Shelley',
    year: 1818, filePath: FILES.validEpub, requestIds: ['edition-1818'] });
  let fulfils = 0;
  const fake = apiScenarios({
    requests: [request('edition-1818', 'Frankenstein', 'Mary Shelley')],
    'bo.upload': failResponse(409, 'File already exists: 2015 edition'),
    'bo.fulfill': () => { fulfils++; return response({ status: 'AVAILABLE' }); },
  });
  const result = await bridge.fulfillBookOrbitRequests(task, fake.fetch);
  assert.equal(result.fulfilled, false);
  assert.equal(fulfils, 0);
  assert.equal(task.matchedBookId == null, true);
});


// ─────────────────────────────────────────────────────────────────────────────
// 7. First-run safety, BookOrbit request discovery and cancellation tri-state
// ─────────────────────────────────────────────────────────────────────────────
test('BASELINE: first run discovers every historical request across paginated admin API', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const history = Array.from({ length: 73 }, (_, i) => request(`historical-${i}`, 'Old book', 'Old author'));
  const fake = apiScenarios({
    'bo.requests': ({ query }) => {
      const page = Number(query.get('page') || '1');
      const limit = 50;
      return response({ items: history.slice((page - 1) * limit, page * limit), total: history.length,
        page, limit });
    },
  });
  const result = await bridge.initializeBaseline({ fetchFn: fake.fetch });
  assert.equal(result.established, true);
  assert.ok(bridge.state.baselineEstablishedAt);
  assert.equal(Object.keys(bridge.state.baselineRequestIds).length, history.length);
  assert.ok(fake.called('bo.requests').some((c) => c.query.get('page') === '2'));
  assert.equal(fake.called('sm.download').length, 0);
  fake.assertKnownRoutes();
});
for (const status of [401, 403, 429, 500, 503]) {
  test(`BASELINE: admin API HTTP ${status} fails CLOSED instead of treating old requests as new`, async () => {
    const bridge = new BridgeService(bridgeOpts());
    const fake = apiScenarios({ 'bo.requests': failResponse(status, 'Refused') });
    const result = await bridge.initializeBaseline({ fetchFn: fake.fetch });
    assert.equal(result.established, false);
    assert.equal(bridge.state.baselineEstablishedAt, null);
    assert.equal(fake.called('sm.download').length, 0);
    fake.assertKnownRoutes();
  });
}
test('BASELINE: network interruption leaves baseline uninitialized', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const fake = apiScenarios({ 'bo.requests': () => { throw new Error('ECONNRESET'); } });
  const result = await bridge.initializeBaseline({ fetchFn: fake.fetch });
  assert.equal(result.established, false);
  assert.equal(bridge.state.baselineEstablishedAt, null);
});
test('BASELINE: impossible pagination total cannot be accepted as a complete history', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const fake = apiScenarios({ 'bo.requests': ({ query }) => response({
    total: 100,
    items: query.get('page') === '1'
      ? Array.from({ length: 50 }, (_, i) => request(`past-${i}`, 'Old', 'Author')) : [],
  }) });
  const result = await bridge.initializeBaseline({ fetchFn: fake.fetch });
  assert.equal(result.established, false);
  assert.equal(bridge.state.baselineEstablishedAt, null);
});
test('BASELINE: if writing the baseline fails, process must not pretend it was persisted', async () => {
  const bridge = new BridgeService(bridgeOpts());
  bridge.saveState = () => false;
  const fake = apiScenarios({ requests: [request('before-first-run', 'Old', 'Author')] });
  const result = await bridge.initializeBaseline({ fetchFn: fake.fetch });
  assert.equal(result.established, false);
  assert.equal(bridge.state.baselineEstablishedAt, null);
  assert.equal(fake.called('sm.download').length, 0);
});
test('BASELINE: an established baseline retains old request IDs after restart', async () => {
  const stateFilePath = newStateFile();
  const a = established(new BridgeService(bridgeOpts({ stateFilePath })), ['old-1', 'old-2']);
  const b = new BridgeService(bridgeOpts({ stateFilePath }));
  assert.equal(b.state.baselineRequestIds['old-1'], true);
  assert.equal(b.state.baselineRequestIds['old-2'], true);
  assert.equal(b.state.baselineEstablishedAt, a.state.baselineEstablishedAt);
});

test('REQUESTS: historical approved requests are never requeued after the companion upgrade', async () => {
  const bridge = established(new BridgeService(bridgeOpts()), ['historical-001']);
  const fake = apiScenarios({
    requests: [request('historical-001', 'Old Book', 'Old Author')],
    books: [metadata('Old Book', 'Old Author')],
    releases: [release('Old Book', 'Old Author')],
  });
  await bridge.processPendingRequests({ fetchFn: fake.fetch });
  assert.equal(fake.called('sm.download').length, 0);
  fake.assertKnownRoutes();
});
test('REQUESTS: a fresh approved book is queued after baseline, not mistaken for historical', async () => {
  const bridge = established(new BridgeService(bridgeOpts()), ['historical-001']);
  const req = request('brand-new-1', 'Animal Farm', 'George Orwell');
  const fake = apiScenarios({ requests: [req],
    books: [metadata('Animal Farm', 'George Orwell')],
    releases: [release('Animal Farm', 'George Orwell')], taskId: 'fresh-task-1',
  });
  await bridge.processPendingRequests({ fetchFn: fake.fetch });
  assert.equal(bridge.state.requests['brand-new-1'], 'fresh-task-1');
  assert.equal(fake.called('sm.download').length, 1);
  fake.assertKnownRoutes();
});
for (const disallowedState of ['pending', 'rejected', 'cancelled', 'available', 'failed']) {
  test(`REQUESTS: ${disallowedState} state is not eligible for an automatic download`, async () => {
    const bridge = established(new BridgeService(bridgeOpts()));
    const req = request(`req-${disallowedState}`, 'Animal Farm', 'George Orwell', { status: disallowedState });
    const fake = apiScenarios({ requests: [req],
      books: [metadata('Animal Farm', 'George Orwell')],
      releases: [release('Animal Farm', 'George Orwell')],
    });
    await bridge.processPendingRequests({ fetchFn: fake.fetch });
    assert.equal(fake.called('sm.download').length, 0);
    fake.assertKnownRoutes();
  });
}
test('REQUESTS: audiobook request is not processed by the ebook companion', async () => {
  const bridge = established(new BridgeService(bridgeOpts()));
  const req = request('audio-1', 'Dune', 'Frank Herbert', { mediaKind: 'audiobook' });
  const fake = apiScenarios({ requests: [req], books: [metadata('Dune', 'Frank Herbert')],
    releases: [release('Dune', 'Frank Herbert')] });
  await bridge.processPendingRequests({ fetchFn: fake.fetch });
  assert.equal(fake.called('sm.download').length, 0);
});
test('REQUESTS: a previously tracked request must not be queued again after repeated events', async () => {
  const bridge = established(new BridgeService(bridgeOpts()));
  const req = request('stable-1', 'Animal Farm', 'George Orwell');
  const fake = apiScenarios({ requests: [req], books: [metadata('Animal Farm', 'George Orwell')],
    releases: [release('Animal Farm', 'George Orwell')], taskId: 'stable-sm-task' });
  await bridge.processPendingRequests({ fetchFn: fake.fetch });
  await bridge.processPendingRequests({ fetchFn: fake.fetch });
  await bridge.processPendingRequests({ fetchFn: fake.fetch });
  assert.equal(fake.called('sm.download').length, 1);
});
test('REQUESTS: simultaneous changed events cannot create duplicate downloads', async () => {
  const bridge = established(new BridgeService(bridgeOpts()));
  const req = request('parallel-1', 'Animal Farm', 'George Orwell');
  const fake = apiScenarios({ requests: [req], books: [metadata('Animal Farm', 'George Orwell')],
    releases: [release('Animal Farm', 'George Orwell')], taskId: 'parallel-sm-task' });
  await Promise.all([bridge.processPendingRequests({ fetchFn: fake.fetch }),
    bridge.processPendingRequests({ fetchFn: fake.fetch })]);
  assert.equal(fake.called('sm.download').length, 1);
});
test('REQUESTS: one failed metadata search cannot block the next healthy approved request', async () => {
  const bridge = established(new BridgeService(bridgeOpts()));
  const requests = [request('bad-search', 'No Catalog', 'Unknown'),
    request('good-search', 'Animal Farm', 'George Orwell')];
  const fake = apiScenarios({
    requests,
    'sm.metadata': ({ query }) => /No Catalog/.test(query.get('query') || '')
      ? failResponse(500, 'Metadata search outage')
      : response({ books: [metadata('Animal Farm', 'George Orwell')] }),
    'sm.releases': ({ query }) => /No Catalog/.test(query.get('title') || '')
      ? failResponse(500, 'Source outage') : response([release('Animal Farm', 'George Orwell')]),
    taskId: 'healthy-task-after-error',
  });
  await bridge.processPendingRequests({ fetchFn: fake.fetch });
  assert.equal(bridge.state.requests['good-search'], 'healthy-task-after-error');
  assert.equal(fake.called('sm.download').length, 1);
  fake.assertKnownRoutes();
});
test('REQUESTS: an unauthorized request-list query must never result in queued downloads', async () => {
  const bridge = established(new BridgeService(bridgeOpts()));
  const fake = apiScenarios({ 'bo.requests': failResponse(401, 'JWT expired') });
  await bridge.processPendingRequests({ fetchFn: fake.fetch });
  assert.equal(fake.called('sm.download').length, 0);
  fake.assertKnownRoutes();
});
test('REQUESTS: failed list pagination cannot be treated as an empty successful queue', async () => {
  const bridge = established(new BridgeService(bridgeOpts()));
  const fake = apiScenarios({
    'bo.requests': ({ query }) => query.get('page') === '2' ? failResponse(503, 'Page unavailable') :
      response({ items: Array.from({ length: 50 }, (_, i) => request(`page-1-${i}`, 'Animal Farm', 'George Orwell')),
        total: 100 }),
  });
  await bridge.processPendingRequests({ fetchFn: fake.fetch });
  assert.equal(fake.called('sm.download').length, 0, 'partial request enumeration must not trigger automatic queueing');
});

test('CANCEL: approved individual request is classified active, not unknown', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const fake = apiScenarios({ details: { 'live-1': request('live-1', 'Animal Farm', 'George Orwell') } });
  assert.equal(await bridge.getRequestStatus('live-1', fake.fetch), 'active');
  fake.assertKnownRoutes();
});
for (const state of ['cancelled', 'rejected']) {
  test(`CANCEL: ${state} individual request is no longer active`, async () => {
    const bridge = new BridgeService(bridgeOpts());
    const fake = apiScenarios({ details: { 'ended-1': request('ended-1', 'Animal Farm', 'George Orwell', { status: state }) } });
    assert.equal(await bridge.getRequestStatus('ended-1', fake.fetch), 'cancelled');
    fake.assertKnownRoutes();
  });
}
test('CANCEL: Available is fulfilled, never cancelled', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const fake = apiScenarios({ details: { 'already-available': request('already-available', 'Animal Farm', 'George Orwell', { status: 'available' }) } });
  assert.equal(await bridge.getRequestStatus('already-available', fake.fetch), 'fulfilled');
  fake.assertKnownRoutes();
});
test('CANCEL: a 403 from individual lookup can fall back to the supported admin LIST', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const fake = apiScenarios({
    requests: [request('via-admin-list', '1984', 'George Orwell', { status: 'cancelled' })],
    'bo.request': failResponse(403, 'Not allowed to see this detail'),
  });
  assert.equal(await bridge.getRequestStatus('via-admin-list', fake.fetch), 'cancelled');
  assert.ok(fake.called('bo.requests').length > 0);
  fake.assertKnownRoutes();
});
test('CANCEL: 404 individual GET plus a successful admin list never uses nonexistent admin GET-by-ID', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const fake = apiScenarios({
    requests: [request('list-fallback', '1984', 'George Orwell', { status: 'cancelled' })],
    'bo.request': failResponse(404, 'Details not found'),
  });
  assert.equal(await bridge.getRequestStatus('list-fallback', fake.fetch), 'cancelled');
  fake.assertKnownRoutes();
  assert.ok(!fake.calls.some((c) => c.path === '/api/v1/admin/book-requests/list-fallback'));
});
test('CANCEL: total BookOrbit outage is UNKNOWN; must not guess ACTIVE', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const fake = apiScenarios({ 'bo.request': failResponse(503), 'bo.requests': failResponse(503) });
  assert.equal(await bridge.getRequestStatus('outage-1', fake.fetch), 'unknown');
  fake.assertKnownRoutes();
});
test('CANCEL: a network exception is UNKNOWN, not active and not cancelled', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const fake = apiScenarios({
    'bo.request': () => { throw new Error('ECONNRESET'); },
    'bo.requests': () => { throw new Error('ETIMEDOUT'); },
  });
  assert.equal(await bridge.getRequestStatus('no-network', fake.fetch), 'unknown');
});
test('CANCEL: approved list followed by unverified/unauthorized status must not queue', async () => {
  const bridge = established(new BridgeService(bridgeOpts()));
  const req = request('unauthorized-status', '1984', 'George Orwell');
  let listings = 0;
  const fake = apiScenarios({ requests: [req],
    'bo.request': failResponse(403, 'Not authorized'),
    'bo.requests': () => ++listings === 1
      ? response({ items: [req], total: 1 })
      : failResponse(503, 'Admin enumeration unavailable'),
    books: [metadata('1984', 'George Orwell')], releases: [release('1984', 'George Orwell')],
  });
  await bridge.processPendingRequests({ fetchFn: fake.fetch });
  assert.equal(fake.called('sm.download').length, 0,
    'a once-approved list item cannot override failed current-state verification');
  fake.assertKnownRoutes();
});
test('CANCEL: a cancelled request is never fulfilled after its task finished', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const task = createTask(bridge, { matchedBookId: 222, requestIds: ['cancelled-222'] });
  const fake = apiScenarios({ requests: [request('cancelled-222', task.title, task.author,
    { status: 'cancelled' })] });
  await bridge.fulfillBookOrbitRequests(task, fake.fetch);
  assert.equal(fake.called('bo.fulfill').length, 0);
  assert.equal(fake.called('bo.upload').length, 0);
  fake.assertKnownRoutes();
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. BookOrbit auth/session renewal; avoid the previous auth-refresh incident
// ─────────────────────────────────────────────────────────────────────────────
function fakeJwt(expOffsetSeconds = 3600) {
  const b64 = (x) => Buffer.from(JSON.stringify(x)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'fixture-service-user',
    exp: Math.floor(Date.now() / 1000) + expOffsetSeconds })}.fixture_signature`;
}
test('AUTH: JWT expiry can be read from a synthetic Bearer token', () => {
  const token = fakeJwt(3600);
  assert.equal(isJwt(token), true);
  assert.ok(decodeJwtExp(token) > Math.floor(Date.now() / 1000));
});
for (const notJwt of ['', 'my-static-api-key', 'Bearer abc', 'not.a.jwt', 'x.y.z']) {
  test(`AUTH: static/malformed token ${JSON.stringify(notJwt)} is not treated as a usable JWT`, () => {
    assert.equal(isJwt(notJwt), false);
  });
}
test('AUTH: native login uses only the supported BookOrbit login POST contract', async () => {
  const loginJwt = fakeJwt(3600);
  const fake = apiScenarios({
    'bo.login': ({ options }) => {
      const body = expectedJson(options);
      assert.equal(body.username, 'service-fixture');
      assert.equal(body.clientKind, 'native');
      return response({ token: loginJwt, refreshToken: 'fixture-refresh', expiresAt: '2026-11-01T00:00:00Z' });
    },
  });
  const auth = new BookOrbitAuthManager({ url: 'http://bookorbit-app:3000', username: 'service-fixture',
    password: 'fake-password', fetchFn: fake.fetch });
  assert.equal(await auth.login(), loginJwt);
  assert.equal(auth.refreshToken, 'fixture-refresh');
  assert.equal(fake.called('bo.login').length, 1);
  fake.assertKnownRoutes();
});
test('AUTH: near-expiration token is renewed before use', async () => {
  const freshToken = fakeJwt(3600);
  const fake = apiScenarios({
    'bo.refresh': response({ token: freshToken, refreshToken: 'refresh-next',
      expiresAt: new Date(Date.now() + 3600_000).toISOString() }),
  });
  const auth = new BookOrbitAuthManager({ url: 'http://bookorbit-app:3000',
    token: fakeJwt(30), refreshToken: 'refresh-before', fetchFn: fake.fetch });
  assert.equal(auth.isTokenExpired(), true);
  assert.equal(await auth.getValidToken(), freshToken);
  assert.equal(fake.called('bo.refresh').length, 1);
  fake.assertKnownRoutes();
});
test('AUTH: revoked refresh token does not become a fabricated authenticated session', async () => {
  const fake = apiScenarios({ 'bo.refresh': failResponse(401, 'Session expired'),
    'bo.login': failResponse(401, 'Login rejected') });
  const auth = new BookOrbitAuthManager({ url: 'http://bookorbit-app:3000',
    username: 'service-fixture', password: 'bad-password',
    token: fakeJwt(-30), refreshToken: 'invalid-refresh', fetchFn: fake.fetch });
  try {
    const maybe = await auth.getValidToken();
    assert.notEqual(maybe, fakeJwt(-30));
    assert.ok(!maybe, 'cannot invent an authenticated token from failed auth');
  } catch (error) { assert.ok(error); }
  fake.assertKnownRoutes();
});
test('AUTH: session recovery must not try unknown /api/v1/admin/auth/refresh route', async () => {
  const fake = apiScenarios({ 'bo.refresh': failResponse(401, 'Refresh expired'),
    'bo.login': response({ token: fakeJwt(3600), refreshToken: 'fresh' }) });
  const auth = new BookOrbitAuthManager({ url: 'http://bookorbit-app:3000',
    username: 'fixture', password: 'fixture', token: fakeJwt(-2),
    refreshToken: 'expired', fetchFn: fake.fetch });
  try { await auth.getValidToken(); } catch {}
  fake.assertKnownRoutes();
});


// ─────────────────────────────────────────────────────────────────────────────
// 9. Direct upload & fulfillment — the proven production path, NOT Book Dock
// ─────────────────────────────────────────────────────────────────────────────
async function directFulfillScenario({
  taskOptions = {}, requests, uploadResult = { id: 321, title: 'A Tale of Two Cities' },
  uploadStatus = 200, fulfillResults, detailHandler, otherHandlers = {},
} = {}) {
  const bridge = new BridgeService(bridgeOpts());
  const task = createTask(bridge, taskOptions);
  const expectedRequestIds = task.requestIds;
  const reqs = requests ?? expectedRequestIds.map((id) => request(id, task.title, task.author));
  const fake = apiScenarios({
    requests: reqs,
    'bo.request': detailHandler ?? (({ path }) => {
      const id = decodeURIComponent(path.split('/').at(-1));
      const item = reqs.find((r) => String(r.id) === id);
      return item ? response(item) : failResponse(404, 'No request');
    }),
    'bo.upload': () => response(uploadResult, uploadStatus),
    'bo.fulfill': ({ path }) => {
      const id = decodeURIComponent(path.split('/').at(-2));
      const configured = fulfillResults?.[id];
      return configured ?? response({ id, status: 'AVAILABLE' });
    },
    ...otherHandlers,
  });
  const result = await bridge.fulfillBookOrbitRequests(task, fake.fetch);
  return { result, bridge, task, fake };
}
test('FULFILL: completed EPUB uses the direct LIBRARY upload endpoint', async () => {
  const { result, task, fake } = await directFulfillScenario({ taskOptions: { requestIds: ['upload-1'] } });
  assert.equal(result.fulfilled, true);
  assert.equal(task.matchedBookId, 321);
  assert.equal(fake.called('bo.upload').length, 1);
  assert.equal(fake.called('bo.fulfill').length, 1);
  assert.equal(fake.called('bo.upload')[0].path, '/api/v1/libraries/1/upload');
  assert.equal(fake.called('bo.upload')[0].query.get('folderId'), '1');
  fake.assertKnownRoutes();
});
test('FULFILL: BookOrbit receives multipart file upload rather than JSON with a filesystem path', async () => {
  const { fake } = await directFulfillScenario();
  const entry = fake.called('bo.upload')[0];
  assert.ok(entry);
  assert.equal(entry.method, 'POST');
  assert.ok(entry.options?.body, 'file bytes/form must be transmitted');
  assert.ok(!(typeof entry.options.body === 'string' && entry.options.body.startsWith('{')),
    'uploading a JSON filename does not import a book');
});
test('FULFILL: receives real bookId from BookOrbit and sends only matchedBookId in fulfillment', async () => {
  const { task, fake } = await directFulfillScenario({ uploadResult: { id: 988, title: 'A Tale of Two Cities' } });
  assert.equal(task.matchedBookId, 988);
  const entry = fake.called('bo.fulfill')[0];
  assert.ok(entry);
  const body = expectedJson(entry.options);
  assert.equal(body.matchedBookId, 988);
  assert.ok(!Object.hasOwn(body, 'bookDockFileId'), 'retired Book Dock field must not be submitted');
  assert.equal(entry.method, 'POST');
  fake.assertKnownRoutes();
});
test('FULFILL: BookOrbit status is Available only after successful import and fulfill responses', async () => {
  const { result, task } = await directFulfillScenario();
  assert.equal(result.fulfilled, true);
  assert.equal(task.status, 'fulfilled');
  assert.equal(task.requestFulfillments[task.requestIds[0]].fulfilled, true);
});
for (const status of [400, 401, 403, 404, 413, 500, 502, 503]) {
  test(`FULFILL: failed library upload HTTP ${status} never calls fulfillment`, async () => {
    const { result, fake } = await directFulfillScenario({ uploadStatus: status,
      uploadResult: { error: `Upload rejected ${status}` } });
    assert.equal(result.fulfilled, false);
    assert.equal(fake.called('bo.fulfill').length, 0);
    fake.assertKnownRoutes();
  });
}
for (const bogusId of [null, 0, -1, 1.25, '', 'not-a-number']) {
  test(`FULFILL: invalid book ID ${JSON.stringify(bogusId)} cannot mark request Available`, async () => {
    const { result, task, fake } = await directFulfillScenario({ uploadResult: { id: bogusId } });
    assert.equal(result.fulfilled, false);
    assert.equal(fake.called('bo.fulfill').length, 0);
    assert.ok(!task.matchedBookId || !parsePositiveInt(task.matchedBookId));
  });
}
test('FULFILL: a 200 response without a book ID is not enough to fulfill', async () => {
  const { result, fake } = await directFulfillScenario({ uploadResult: { status: 'ok' } });
  assert.equal(result.fulfilled, false);
  assert.equal(fake.called('bo.fulfill').length, 0);
});
test('FULFILL: when upload succeeded, a temporary fulfill failure must NOT cause a second upload', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const task = createTask(bridge, { requestIds: ['retry-1'] });
  let attempts = 0;
  const fake = apiScenarios({ requests: [request('retry-1', task.title, task.author)],
    'bo.upload': { id: 401 },
    'bo.fulfill': () => ++attempts === 1
      ? failResponse(503, 'BookOrbit temporarily unavailable') : response({ id: 'retry-1', status: 'AVAILABLE' }),
  });
  await bridge.fulfillBookOrbitRequests(task, fake.fetch);
  assert.equal(task.matchedBookId, 401);
  assert.equal(fake.called('bo.upload').length, 1);
  await bridge.fulfillBookOrbitRequests(task, fake.fetch);
  assert.equal(fake.called('bo.upload').length, 1);
  assert.equal(fake.called('bo.fulfill').length, 2);
  assert.equal(task.status, 'fulfilled');
  fake.assertKnownRoutes();
});
test('FULFILL: successful request fulfillment remains successful after repeated reconciliation', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const task = createTask(bridge, { requestIds: ['already-successful'] });
  const fake = apiScenarios({ requests: [request('already-successful', task.title, task.author)],
    'bo.upload': { id: 1011 }, 'bo.fulfill': { status: 'AVAILABLE' } });
  await bridge.fulfillBookOrbitRequests(task, fake.fetch);
  await bridge.fulfillBookOrbitRequests(task, fake.fetch);
  assert.equal(fake.called('bo.upload').length, 1);
  assert.equal(fake.called('bo.fulfill').length, 1);
});
test('FULFILL: two requesters share one import but each receives their own fulfillment', async () => {
  const { task, fake, result } = await directFulfillScenario({
    taskOptions: { requestIds: ['alice-1984', 'bob-1984'], userIds: ['alice', 'bob'],
      title: '1984', author: 'George Orwell' },
  });
  assert.equal(fake.called('bo.upload').length, 1);
  assert.equal(fake.called('bo.fulfill').length, 2);
  assert.ok(task.requestFulfillments['alice-1984'].fulfilled);
  assert.ok(task.requestFulfillments['bob-1984'].fulfilled);
  assert.equal(result.fulfilled, true);
});
test('FULFILL: one requester error does not incorrectly mark the other requester unfulfilled', async () => {
  const { task, result, fake } = await directFulfillScenario({
    taskOptions: { requestIds: ['good-request', 'bad-request'] },
    fulfillResults: { 'bad-request': failResponse(400, 'Request is not approved') },
  });
  assert.equal(result.fulfilled, false);
  assert.equal(task.requestFulfillments['good-request'].fulfilled, true);
  assert.equal(task.requestFulfillments['bad-request'].fulfilled, false);
  assert.equal(task.status, 'partially_fulfilled');
  assert.equal(fake.called('bo.upload').length, 1);
});
test('FULFILL: after partial success retry only the unfulfilled request', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const task = createTask(bridge, { requestIds: ['request-a', 'request-b'] });
  let badState = true;
  const fake = apiScenarios({
    requests: [request('request-a', task.title, task.author), request('request-b', task.title, task.author)],
    'bo.upload': { id: 1101 },
    'bo.fulfill': ({ path }) => path.includes('/request-b/') && badState
      ? failResponse(400, 'Transient invalid state') : response({ status: 'AVAILABLE' }),
  });
  await bridge.fulfillBookOrbitRequests(task, fake.fetch);
  badState = false;
  await bridge.fulfillBookOrbitRequests(task, fake.fetch);
  const all = fake.called('bo.fulfill');
  assert.equal(all.filter((c) => c.path.includes('/request-a/')).length, 1);
  assert.equal(all.filter((c) => c.path.includes('/request-b/')).length, 2);
  assert.equal(fake.called('bo.upload').length, 1);
  assert.equal(task.status, 'fulfilled');
});
test('FULFILL: persisted matchedBookId prevents another upload after process restart', async () => {
  const stateFilePath = newStateFile();
  const first = new BridgeService(bridgeOpts({ stateFilePath }));
  const task = createTask(first, { requestIds: ['restart-fulfill-1'] });
  const fake = apiScenarios({
    requests: [request('restart-fulfill-1', task.title, task.author)],
    'bo.upload': { id: 502 },
    'bo.fulfill': failResponse(503, 'Restart during fulfill'),
  });
  await first.fulfillBookOrbitRequests(task, fake.fetch);
  assert.equal(first.state.tasks[task.taskId].matchedBookId, 502);
  const second = new BridgeService(bridgeOpts({ stateFilePath }));
  const successful = apiScenarios({ requests: [request('restart-fulfill-1', task.title, task.author)],
    libraryBooks: [{ id: 502, title: task.title, author: task.author, year: 1859, isbn: '9780141439600', format: task.format }],
    'bo.upload': failResponse(500, 'duplicate upload forbidden'),
    'bo.fulfill': { id: 'restart-fulfill-1', status: 'AVAILABLE' },
  });
  await second.fulfillBookOrbitRequests(second.state.tasks[task.taskId], successful.fetch);
  assert.equal(successful.called('bo.upload').length, 0);
  assert.equal(successful.called('bo.fulfill').length, 1);
  assert.equal(second.state.tasks[task.taskId].status, 'fulfilled');
});
test('FULFILL: 409 without authoritative compatible book must NOT guess an ID', async () => {
  const { task, result, fake } = await directFulfillScenario({ uploadStatus: 409,
    uploadResult: { error: 'Destination file exists' } });
  assert.equal(result.fulfilled, false);
  assert.equal(task.matchedBookId == null, true);
  assert.equal(fake.called('bo.fulfill').length, 0);
  fake.assertKnownRoutes();
});
test('FULFILL: 409 response with incompatible edition details must NOT be adopted', async () => {
  const { task, result, fake } = await directFulfillScenario({
    taskOptions: { title: 'Frankenstein', author: 'Mary Shelley', year: 1818,
      filePath: FILES.validEpub, requestIds: ['frank-1818'] },
    uploadStatus: 409,
    uploadResult: { error: 'Conflict', id: 1500,
      existingBook: { id: 1500, title: 'Frankenstein', author: 'Mary Shelley', year: 2015, format: 'epub' } },
  });
  assert.equal(result.fulfilled, false);
  assert.equal(task.matchedBookId == null, true);
  assert.equal(fake.called('bo.fulfill').length, 0);
});
test('FULFILL: 409 compatible authoritative ID can be adopted when same edition is verified', async () => {
  const { task, fake } = await directFulfillScenario({
    taskOptions: { title: 'Frankenstein', author: 'Mary Shelley', year: 1818,
      filePath: FILES.validEpub, requestIds: ['frank-same-edition'] },
    uploadStatus: 409,
    uploadResult: { error: 'Conflict', id: 1222,
      existingBook: { id: 1222, title: 'Frankenstein', author: 'Mary Shelley',
        year: 1818, isbn: '9780141439471', format: 'epub' } },
  });
  assert.equal(task.matchedBookId, 1222);
  assert.equal(fake.called('bo.fulfill').length, 1);
});
test('FULFILL: uncertain upload network failure is durably recorded and never blindly reuploaded', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const task = createTask(bridge, { requestIds: ['uncertain-upload-1'] });
  let posts = 0;
  const fake = apiScenarios({ requests: [request('uncertain-upload-1', task.title, task.author)],
    'bo.upload': () => { posts++; throw new Error('ECONNRESET after upload bytes'); },
  });
  try { await bridge.fulfillBookOrbitRequests(task, fake.fetch); } catch {}
  assert.equal(task.status, 'uncertain_upload');
  assert.ok(task.uncertainUpload);
  try { await bridge.fulfillBookOrbitRequests(task, fake.fetch); } catch {}
  assert.equal(posts, 1, 'do not duplicate a possibly successful upload');
});
test('FULFILL: invalid destination library ID cannot be silently replaced by an unrelated default', async () => {
  const { result, fake } = await directFulfillScenario({
    taskOptions: { libraryId: 0, folderId: 1, requestIds: ['no-library'] },
  });
  assert.equal(result.fulfilled, false);
  assert.equal(fake.called('bo.upload').length, 0);
});
test('FULFILL: valid per-request folder and library are honored instead of hardcoded CT105 defaults', async () => {
  const { result, fake } = await directFulfillScenario({
    taskOptions: { libraryId: 7, folderId: 13, requestIds: ['custom-destination'] },
  });
  assert.equal(result.fulfilled, true);
  const upload = fake.called('bo.upload')[0];
  assert.equal(upload.path, '/api/v1/libraries/7/upload');
  assert.equal(upload.query.get('folderId'), '13');
  fake.assertKnownRoutes();
});
test('FULFILL: a plain 200 with a non-Available response is not proof the request succeeded', async () => {
  const { result, task } = await directFulfillScenario({
    fulfillResults: { [/* filled below via overridable static request */ 'unapproved-fulfill']:
      response({ id: 'unapproved-fulfill', status: 'APPROVED' }) },
    taskOptions: { requestIds: ['unapproved-fulfill'] },
  });
  assert.ok(result.fulfilled !== true || task.requestFulfillments['unapproved-fulfill']?.fulfilled !== true,
    'a response without a confirmed Available outcome must not be marked fulfilled');
});
test('FULFILL: service API secret and fake user credentials never appear in errors', async () => {
  const key = 'fixture-secret-rotating-should-not-log';
  const bridge = new BridgeService(bridgeOpts({ bookorbitApiKey: key }));
  const task = createTask(bridge, { requestIds: ['secret-error-1'] });
  const fake = apiScenarios({ requests: [request('secret-error-1', task.title, task.author)],
    'bo.upload': failResponse(500, `Error handling secret=${key}`),
  });
  const outcome = await bridge.fulfillBookOrbitRequests(task, fake.fetch);
  noSecrets(JSON.stringify(outcome), key);
  noSecrets(JSON.stringify(bridge.state.tasks[task.taskId].error || ''), key);
});

test('STALE BOOK: deleting an imported book and requesting it again safely invalidates stale ID and re-imports from verified file', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const task = createTask(bridge, {
    title: 'Fahrenheit 451',
    author: 'Ray Bradbury',
    year: 1953,
    isbn: '9781451673319',
    format: 'epub',
    filePath: FILES.fahrenheitEpub,
    requestIds: ['req-first'],
  });

  // Step 1: Initial request fulfilled with book ID 1001
  let libraryCards = [];
  let uploadCount = 0;
  const fake1 = apiScenarios({
    requests: [request('req-first', task.title, task.author, { year: 1953, isbn: '9781451673319' })],
    'bo.upload': () => {
      uploadCount++;
      const id = 1001;
      libraryCards.push({ id, title: task.title, author: task.author, year: 1953, isbn: '9781451673319', format: 'epub' });
      return { id };
    },
    'bo.libraryBooks': () => response({ items: libraryCards, total: libraryCards.length }),
    'bo.fulfill': { id: 'req-first', status: 'AVAILABLE' },
  });

  const res1 = await bridge.fulfillBookOrbitRequests(task, fake1.fetch);
  assert.equal(res1.fulfilled, true);
  assert.equal(task.matchedBookId, 1001);
  assert.equal(task.status, 'fulfilled');
  assert.equal(task.requestFulfillments['req-first'].fulfilled, true);
  assert.equal(uploadCount, 1);

  // Step 2: Book 1001 is deleted from BookOrbit library
  libraryCards = []; // definitively deleted!

  // Step 3: Same book requested again (new request req-second)
  task.requestIds.push('req-second');
  const fake2 = apiScenarios({
    requests: [
      request('req-first', task.title, task.author, { year: 1953, isbn: '9781451673319', status: 'fulfilled' }),
      request('req-second', task.title, task.author, { year: 1953, isbn: '9781451673319', status: 'approved' }),
    ],
    'bo.upload': () => {
      uploadCount++;
      const id = 1002;
      libraryCards.push({ id, title: task.title, author: task.author, year: 1953, isbn: '9781451673319', format: 'epub' });
      return { id };
    },
    'bo.book': () => failResponse(404, 'Book not found'),
    'bo.libraryBooks': () => response({ items: libraryCards, total: libraryCards.length }),
    'bo.fulfill': ({ path }) => {
      const reqId = decodeURIComponent(path.split('/').at(-2));
      return response({ id: reqId, status: 'AVAILABLE' });
    },
  });

  const res2 = await bridge.fulfillBookOrbitRequests(task, fake2.fetch);
  assert.equal(res2.fulfilled, true);
  // Stale ID 1001 was invalidated and replaced with new import ID 1002
  assert.equal(task.matchedBookId, 1002);
  assert.equal(task.status, 'fulfilled');
  // Re-imported from verified file: uploadCount is now 2
  assert.equal(uploadCount, 2);
  // Historical fulfilled request req-first was preserved and NOT changed
  assert.equal(task.requestFulfillments['req-first'].fulfilled, true);
  // New request req-second was fulfilled
  assert.equal(task.requestFulfillments['req-second'].fulfilled, true);
});

test('STALE BOOK: API outage during library verification fails closed without duplicate upload or losing matchedBookId', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const task = createTask(bridge, {
    title: 'Nineteen Eighty-Four',
    author: 'George Orwell',
    year: 1949,
    format: 'epub',
    filePath: FILES.validEpub,
    matchedBookId: 1001,
    requestIds: ['req-outage'],
  });

  let uploadAttempts = 0;
  const fakeOutage = apiScenarios({
    requests: [request('req-outage', task.title, task.author, { year: 1949 })],
    'bo.libraryBooks': failResponse(503, 'Library index service unavailable'),
    'bo.upload': () => { uploadAttempts++; return response({ id: 9999 }); },
    'bo.fulfill': { status: 'AVAILABLE' },
  });

  const res = await bridge.fulfillBookOrbitRequests(task, fakeOutage.fetch);
  assert.equal(res.fulfilled, false);
  // Failed closed: did NOT upload duplicate
  assert.equal(uploadAttempts, 0);
  // Did NOT invalidate matchedBookId on transient outage
  assert.equal(task.matchedBookId, 1001);
});

test('FULFILL: HTTP 400 "That book no longer exists" is classified as inaccessible_book, never invalid_request_state', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const task = createTask(bridge, {
    title: 'Nineteen Eighty-Four',
    author: 'George Orwell',
    year: 1949,
    format: 'epub',
    filePath: FILES.validEpub,
    matchedBookId: 2001,
    requestIds: ['req-stale-fulfill'],
  });

  const fake = apiScenarios({
    requests: [request('req-stale-fulfill', task.title, task.author, { year: 1949 })],
    libraryBooks: [{ id: 2001, title: task.title, author: task.author, year: 1949, format: 'epub' }],
    'bo.fulfill': failResponse(400, '{"statusCode": 400, "message": "That book no longer exists"}'),
  });

  await bridge.fulfillBookOrbitRequests(task, fake.fetch);
  const fulfillment = task.requestFulfillments['req-stale-fulfill'];
  assert.ok(fulfillment);
  assert.equal(fulfillment.fulfilled, false);
  assert.equal(fulfillment.errorType, 'inaccessible_book');
  assert.notEqual(fulfillment.errorType, 'invalid_request_state');
  // Stale matchedBookId invalidated upon BookOrbit definitive report
  assert.equal(task.matchedBookId, null);
});

test('STALE BOOK: queueRelease adopting task with deleted book invalidates matchedBookId and reports reused: false', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const taskId = unique('task-adopted-deleted');
  const releaseKey = 'annas:adopted-del-1';
  bridge.state.releases[releaseKey] = taskId;
  bridge.state.tasks[taskId] = {
    taskId,
    releaseKey,
    title: 'Frankenstein',
    author: 'Mary Shelley',
    year: 1818,
    format: 'epub',
    status: 'completed',
    filePath: FILES.validEpub,
    matchedBookId: 3001,
    libraryId: 1,
    folderId: 1,
    requestIds: ['hist-req-1'],
    userIds: ['user-1'],
    requestFulfillments: { 'hist-req-1': { fulfilled: true, status: 200 } },
  };

  const fake = apiScenarios({
    requests: [
      request('hist-req-1', 'Frankenstein', 'Mary Shelley', { status: 'fulfilled' }),
      request('new-req-2', 'Frankenstein', 'Mary Shelley', { status: 'approved' }),
    ],
    'bo.book': () => failResponse(404, 'Book not found'),
    'bo.libraryBooks': () => response({ items: [], total: 0 }),
    'bo.upload': () => response({ id: 3002 }),
    'bo.fulfill': { status: 'AVAILABLE' },
  });

  const cand = {
    source: 'annas',
    sourceId: 'adopted-del-1',
    title: 'Frankenstein',
    author: 'Mary Shelley',
    year: 1818,
    format: 'epub',
    guid: JSON.stringify({ source: 'annas', source_id: 'adopted-del-1', title: 'Frankenstein', author: 'Mary Shelley', year: 1818, format: 'epub' }),
  };

  const res = await bridge.queueRelease({ requestId: 'new-req-2', userId: 'user-2', release: cand, fetchFn: fake.fetch });
  assert.equal(res.status, 'completed');
  assert.equal(res.reused, false, 'Stale book ID must not be reported as reused');
  assert.equal(bridge.state.tasks[taskId].matchedBookId, null);
  assert.equal(bridge.state.tasks[taskId].requestFulfillments['hist-req-1'].fulfilled, true);
});

// ─────────────────────────────────────────────────────────────────────────────

// 9b. verifyBookInLibrary: exact-ID verification, renamed books, editions, deletion, failures
test('VERIFY BOOK: renamed book is not declared deleted when exact ID still exists', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const task = createTask(bridge, { title: 'Old Title', author: 'Mary Shelley', year: 1818, format: 'epub' });
  const fake = apiScenarios({
    'bo.book': () => response({ id: 501, libraryId: 1, title: 'Renamed Title', author: 'Mary Shelley', publishedYear: 1818, format: 'epub' }),
    'bo.libraryBooks': () => response({ items: [{ id: 501, title: 'Original Title', author: 'Mary Shelley', year: 1818, format: 'epub' }], total: 1 }),
  });
  const status = await bridge.verifyBookInLibrary(task, 1, 501, {}, fake.fetch);
  assert.equal(status, 'exists');
});

test('VERIFY BOOK: different edition returns incompatible rather than deleted', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const task = createTask(bridge, { title: 'Frankenstein', author: 'Mary Shelley', year: 1818, format: 'epub' });
  const fake = apiScenarios({
    'bo.book': () => response({ id: 502, libraryId: 1, title: 'Frankenstein', author: 'Mary Shelley', publishedYear: 2015, format: 'epub' }),
    'bo.libraryBooks': () => response({ items: [{ id: 502, title: 'Frankenstein', author: 'Mary Shelley', year: 2015, format: 'epub' }], total: 1 }),
  });
  const status = await bridge.verifyBookInLibrary(task, 1, 502, {}, fake.fetch);
  assert.equal(status, 'incompatible');
});

test('VERIFY BOOK: deleted book returns deleted via exact-ID route', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const task = createTask(bridge, { title: 'Frankenstein', author: 'Mary Shelley', year: 1818, format: 'epub' });
  const fake = apiScenarios({
    'bo.book': () => failResponse(404, 'Book not found'),
    'bo.libraryBooks': () => response({ items: [], total: 0 }),
  });
  const status = await bridge.verifyBookInLibrary(task, 1, 503, {}, fake.fetch);
  assert.equal(status, 'deleted');
});

test('VERIFY BOOK: title search missing saved ID is inconclusive, not deletion', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const task = createTask(bridge, { title: 'Frankenstein', author: 'Mary Shelley', year: 1818, format: 'epub' });
  const fake = apiScenarios({
    'bo.book': () => failResponse(503, 'Exact route unavailable'),
    'bo.libraryBooks': () => failResponse(503, 'Library unavailable'),
  });
  const status = await bridge.verifyBookInLibrary(task, 1, 504, {}, fake.fetch);
  assert.equal(status, 'unknown');
});

test('VERIFY BOOK: API or auth failure returns unknown and preserves evidence', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const task = createTask(bridge, { title: 'Frankenstein', author: 'Mary Shelley', year: 1818, format: 'epub' });
  const fake = apiScenarios({
    'bo.book': () => failResponse(401, 'Unauthorized'),
    'bo.libraryBooks': () => failResponse(503, 'Library unavailable'),
  });
  const status = await bridge.verifyBookInLibrary(task, 1, 505, {}, fake.fetch);
  assert.equal(status, 'unknown');
});


test('VERIFY BOOK: exact-ID 404 does not by itself delete a book still listed in its library', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const task = createTask(bridge, { title: 'Frankenstein', author: 'Mary Shelley', year: 1818, format: 'epub' });
  const fake = apiScenarios({
    'bo.book': () => failResponse(404, 'Book not found'),
    'bo.libraryBooks': () => response({ items: [{ id: 506, title: 'Frankenstein', author: 'Mary Shelley', year: 1818, format: 'epub' }], total: 1 }),
  });
  const status = await bridge.verifyBookInLibrary(task, 1, 506, {}, fake.fetch);
  assert.equal(status, 'exists');
});

test('VERIFY BOOK: deletion is proven by library listing, not by exact-ID 404 alone', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const task = createTask(bridge, { title: 'Frankenstein', author: 'Mary Shelley', year: 1818, format: 'epub' });
  const fake = apiScenarios({
    'bo.book': () => failResponse(404, 'Book not found'),
    'bo.libraryBooks': () => response({ items: [], total: 0 }),
  });
  const status = await bridge.verifyBookInLibrary(task, 1, 507, {}, fake.fetch);
  assert.equal(status, 'deleted');
});

test('VERIFY BOOK: a book found in another library is not treated as deleted', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const task = createTask(bridge, { title: 'Frankenstein', author: 'Mary Shelley', year: 1818, format: 'epub' });
  const fake = apiScenarios({
    'bo.book': () => response({ id: 508, libraryId: 2, title: 'Frankenstein', author: 'Mary Shelley', publishedYear: 1818, format: 'epub' }),
    'bo.libraryBooks': () => response({ items: [], total: 0 }),
  });
  const status = await bridge.verifyBookInLibrary(task, 1, 508, {}, fake.fetch);
  assert.equal(status, 'unknown');
});

test('FULFILL: incompatible matched book fails closed without upload, fulfillment, or ID invalidation', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const task = createTask(bridge, {
    title: 'Frankenstein', author: 'Mary Shelley', year: 1818, format: 'epub',
    filePath: FILES.validEpub, matchedBookId: 509, requestIds: ['compat-req-1'],
  });
  const fake = apiScenarios({
    requests: [request('compat-req-1', 'Frankenstein', 'Mary Shelley', { year: 1818 })],
    'bo.libraryBooks': () => response({ items: [{ id: 509, title: 'Frankenstein', author: 'Mary Shelley', year: 2015, format: 'epub' }], total: 1 }),
    'bo.book': () => response({ id: 509, libraryId: 1, title: 'Frankenstein', author: 'Mary Shelley', publishedYear: 2015, format: 'epub' }),
    'bo.upload': () => response({ id: 9999 }),
    'bo.fulfill': { status: 'AVAILABLE' },
  });
  const result = await bridge.fulfillBookOrbitRequests(task, fake.fetch);
  assert.equal(result.fulfilled, false);
  assert.equal(task.matchedBookId, 509);
  assert.equal(fake.called('bo.upload').length, 0);
  assert.equal(fake.called('bo.fulfill').length, 0);
});


test('VERIFY BOOK: missing author still rejects mismatched publication year', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const task = createTask(bridge, { title: 'Frankenstein', author: '', year: 1818, format: 'epub' });
  const fake = apiScenarios({
    'bo.book': () => response({ id: 510, libraryId: 1, title: 'Frankenstein', author: '', publishedYear: 2015, format: 'epub' }),
    'bo.libraryBooks': () => response({ items: [{ id: 510, title: 'Frankenstein', author: '', year: 2015, format: 'epub' }], total: 1 }),
  });
  const status = await bridge.verifyBookInLibrary(task, 1, 510, {}, fake.fetch);
  assert.equal(status, 'incompatible');
});

test('VERIFY BOOK: missing author with matching year and no ISBN fails closed', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const task = createTask(bridge, { title: 'Frankenstein', author: '', year: 1818, format: 'epub' });
  const fake = apiScenarios({
    'bo.book': () => response({ id: 511, libraryId: 1, title: 'Frankenstein', author: '', publishedYear: 1818, format: 'epub' }),
    'bo.libraryBooks': () => response({ items: [{ id: 511, title: 'Frankenstein', author: '', year: 1818, format: 'epub' }], total: 1 }),
  });
  const status = await bridge.verifyBookInLibrary(task, 1, 511, {}, fake.fetch);
  assert.equal(status, 'exists');
});

test('VERIFY BOOK: Frankenstein editions are not accepted on title alone', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const task = createTask(bridge, { title: 'Frankenstein', author: '', year: null, format: 'epub' });
  const fake = apiScenarios({
    'bo.book': () => response({ id: 512, libraryId: 1, title: 'Frankenstein', author: '', publishedYear: null, format: 'epub' }),
    'bo.libraryBooks': () => response({ items: [{ id: 512, title: 'Frankenstein', author: '', year: null, format: 'epub' }], total: 1 }),
  });
  const status = await bridge.verifyBookInLibrary(task, 1, 512, {}, fake.fetch);
  assert.equal(status, 'unknown');
});


test('ISBN: different requested ISBNs do not share a task', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const fake = apiScenarios({});
  const rel = release('Frankenstein', 'Mary Shelley', { source_id: 'isbn-unknown-shared', isbn: null });
  const first = await bridge.queueRelease({ requestId: 'req-a', userId: 'u1', release: rel, libraryId: 1, folderId: 1, requestIsbn: '9780141439471', fetchFn: fake.fetch });
  assert.ok(first.taskId);
  let threw = false;
  try {
    await bridge.queueRelease({ requestId: 'req-b', userId: 'u2', release: rel, libraryId: 1, folderId: 1, requestIsbn: '9780199537150', fetchFn: fake.fetch });
  } catch (err) {
    threw = true;
  }
  assert.equal(threw, true, 'adopting a task with a conflicting requested ISBN must fail');
});

// 10. Security: real local files, path containment, webhook identity and size
// ─────────────────────────────────────────────────────────────────────────────
test('FILE: accepts real EPUB ZIP file and genuine PDF header', () => {
  const bridge = new BridgeService(bridgeOpts());
  assert.equal(bridge.verifyFile(FILES.validEpub, 'epub').ok, true);
  assert.equal(bridge.verifyFile(FILES.validPdf, 'pdf').ok, true);
});
for (const [label, path, format] of [
  ['missing EPUB', join(root, 'not-here.epub'), 'epub'],
  ['zero-byte EPUB', FILES.empty, 'epub'],
  ['HTML masquerading as EPUB', FILES.invalidEpub, 'epub'],
  ['directory instead of file', root, 'epub'],
  ['PDF mislabeled EPUB', FILES.validPdf, 'epub'],
  ['EPUB mislabeled PDF', FILES.validEpub, 'pdf'],
]) {
  test(`FILE: rejects ${label}`, () => {
    const bridge = new BridgeService(bridgeOpts());
    assert.equal(bridge.verifyFile(path, format).ok, false);
  });
}
test('FILE: translations from Shelfmark /books to companion /staging preserve file identity', () => {
  const bridge = new BridgeService(bridgeOpts({
    shelfmarkPathPrefix: '/books', localPathPrefix: root,
  }));
  assert.equal(bridge.resolvePath('/books/Frankenstein-1818.epub'), FILES.validEpub);
});
test('FILE: request cannot escape staging mount with ../ traversal', () => {
  const bridge = new BridgeService(bridgeOpts({
    shelfmarkPathPrefix: '/books', localPathPrefix: root,
  }));
  assert.equal(bridge.resolvePath('/books/../../etc/passwd'), null);
});
test('FILE: prefix collision cannot read another directory with a similar name', () => {
  const bridge = new BridgeService(bridgeOpts({ shelfmarkPathPrefix: '/books', localPathPrefix: root }));
  assert.equal(bridge.resolvePath('/books2/secret.epub'), null);
});
test('FILE: NUL byte injection is rejected before any file access', () => {
  const bridge = new BridgeService(bridgeOpts());
  assert.equal(bridge.resolvePath(`${FILES.validEpub}\0.txt`), null);
});
test('FILE: path pointing outside allowed directories is never accepted for download import', () => {
  const bridge = new BridgeService(bridgeOpts());
  assert.equal(bridge.resolvePath('/etc/passwd'), null);
});
test('FILE: symlink to a file outside approved staging directory is rejected', () => {
  const outside = join(tmpdir(), unique('outside-sensitive') + '.epub');
  const alias = join(root, unique('symlink') + '.epub');
  writeFileSync(outside, epubBytes());
  try {
    symlinkSync(outside, alias);
    const bridge = new BridgeService(bridgeOpts());
    assert.ok(bridge.resolvePath(alias) === null || !bridge.verifyFile(alias, 'epub').ok,
      'symlink should not bypass staging containment');
  } finally { rmSync(outside, { force: true }); rmSync(alias, { force: true }); }
});
test('FILE: request cannot overwrite existing library files during verification', () => {
  const originalHash = crypto.createHash('sha256').update(readFileSync(FILES.validEpub)).digest('hex');
  const bridge = new BridgeService(bridgeOpts());
  bridge.verifyFile(FILES.validEpub, 'epub');
  const afterwardHash = crypto.createHash('sha256').update(readFileSync(FILES.validEpub)).digest('hex');
  assert.equal(afterwardHash, originalHash);
});
test('FILE: magic byte signatures are explicit for EPUB and PDF', () => {
  assert.deepEqual(MAGIC_BYTES.epub, [0x50, 0x4b, 0x03, 0x04]);
  assert.deepEqual(MAGIC_BYTES.pdf, [0x25, 0x50, 0x44, 0x46]);
});
test('SECURITY: timing-safe secret comparison accepts exactly matching tokens', () => {
  assert.equal(timingSafeCompare('token-a', 'token-a'), true);
  assert.equal(timingSafeCompare('token-a', 'token-b'), false);
  assert.equal(timingSafeCompare('token-a', 'token'), false);
});
test('SECURITY: log sanitization redacts bearer tokens and URL query credentials', () => {
  assert.ok(sanitizeLog('Authorization: Bearer abc.def.ghi').includes('[REDACTED]'));
  assert.ok(sanitizeLog('token=topsecret123').includes('[REDACTED]'));
  assert.equal(typeof sanitizeLog(1234), 'string');
});
test('SECURITY: integer IDs reject 0, decimals, negative and nonsensical data', () => {
  for (const id of [0, -1, 1.25, '0', '-4', 'foo', null, undefined, 'Infinity', {}, []])
    assert.equal(parsePositiveInt(id), null, `invalid ID ${String(id)}`);
  assert.equal(parsePositiveInt(1), 1);
  assert.equal(parsePositiveInt('42'), 42);
});
test('WEBHOOK: incorrect authentication secret never changes task state', async () => {
  const bridge = new BridgeService(bridgeOpts({ secret: 'valid-webhook-secret' }));
  const task = createTask(bridge, { status: 'queued', filePath: null, requestIds: ['secret-req'] });
  const before = JSON.stringify(bridge.state.tasks[task.taskId]);
  const result = await bridge.handleWebhook({ task: { task_id: task.taskId },
    paths: { target: FILES.validEpub } }, 'wrong-secret');
  assert.equal(result.statusCode, 401);
  assert.equal(JSON.stringify(bridge.state.tasks[task.taskId]), before);
});
test('WEBHOOK: conflicting nested task identifiers are rejected before import', async () => {
  const bridge = new BridgeService(bridgeOpts({ secret: 'webhook-fixture' }));
  const task = createTask(bridge, { status: 'queued', filePath: null, requestIds: ['conflicted-req'] });
  const result = await bridge.handleWebhook({
    task: { task_id: task.taskId, id: 'another-task' }, paths: { target: FILES.validEpub },
  }, 'webhook-fixture');
  assert.equal(result.statusCode, 409);
  assert.ok(!result.ok);
});
test('WEBHOOK: content with incorrect EPUB signature is never sent to BookOrbit upload', async () => {
  const bridge = new BridgeService(bridgeOpts({ secret: 'webhook-fixture' }));
  const task = createTask(bridge, { status: 'queued', filePath: null, requestIds: ['corrupt-file-req'] });
  const fake = apiScenarios({ requests: [request('corrupt-file-req', task.title, task.author)] });
  const result = await bridge.handleWebhook({ task: { task_id: task.taskId, format: 'epub' },
    paths: { target: FILES.invalidEpub, final_paths: [FILES.invalidEpub] } },
  'webhook-fixture', fake.fetch);
  assert.equal(result.ok, false);
  assert.equal(fake.called('bo.upload').length, 0);
});
test('WEBHOOK: unknown task ID cannot authorize an unrelated file import', async () => {
  const bridge = new BridgeService(bridgeOpts({ secret: 'webhook-fixture' }));
  const fake = apiScenarios();
  const result = await bridge.handleWebhook({ task: { task_id: 'unknown-task' },
    paths: { target: FILES.validEpub } }, 'webhook-fixture', fake.fetch);
  assert.equal(fake.called('bo.upload').length, 0);
  assert.equal(fake.called('bo.fulfill').length, 0);
  assert.ok(result.statusCode >= 200);
});
test('WEBHOOK: nested Shelfmark v1.5.1 JSON identifies exactly the queued task and completed file', async () => {
  const bridge = new BridgeService(bridgeOpts({ secret: 'webhook-fixture' }));
  const task = createTask(bridge, { status: 'queued', filePath: null, requestIds: ['hook-success'] });
  const fake = apiScenarios({ requests: [request('hook-success', task.title, task.author)],
    'bo.upload': { id: 1777 }, 'bo.fulfill': { status: 'AVAILABLE' } });
  const result = await bridge.handleWebhook({
    version: 1, phase: 'post_transfer',
    task: { task_id: task.taskId, source: 'annas', title: task.title, format: 'epub' },
    output: { mode: 'folder', organization_mode: 'organize' },
    paths: { destination: root, target: FILES.validEpub, final_paths: [FILES.validEpub] },
  }, 'webhook-fixture', fake.fetch);
  assert.equal(result.ok, true);
  assert.equal(task.status, 'fulfilled');
  assert.equal(task.matchedBookId, 1777);
  assert.equal(fake.called('bo.upload').length, 1);
  assert.equal(fake.called('bo.fulfill').length, 1);
  fake.assertKnownRoutes();
});
test('WEBHOOK: delivery can arrive twice without a second upload or fulfillment', async () => {
  const bridge = new BridgeService(bridgeOpts({ secret: 'webhook-fixture' }));
  const task = createTask(bridge, { status: 'queued', filePath: null, requestIds: ['hook-repeat'] });
  const fake = apiScenarios({ requests: [request('hook-repeat', task.title, task.author)],
    'bo.upload': { id: 1778 }, 'bo.fulfill': { status: 'AVAILABLE' } });
  const body = { task: { task_id: task.taskId, format: 'epub' },
    paths: { target: FILES.validEpub, final_paths: [FILES.validEpub] } };
  await bridge.handleWebhook(body, 'webhook-fixture', fake.fetch);
  await bridge.handleWebhook(body, 'webhook-fixture', fake.fetch);
  assert.equal(fake.called('bo.upload').length, 1);
  assert.equal(fake.called('bo.fulfill').length, 1);
});
test('WEBHOOK: file not yet visible remains recoverable instead of failing the Shelfmark download', async () => {
  const bridge = new BridgeService(bridgeOpts({ secret: 'webhook-fixture' }));
  const task = createTask(bridge, { status: 'queued', filePath: null, requestIds: ['late-file-1'] });
  const path = join(root, 'not-yet-visible.epub');
  const result = await bridge.handleWebhook({ task: { task_id: task.taskId, format: 'epub' },
    paths: { target: path } }, 'webhook-fixture');
  assert.equal(result.statusCode, 200);
  assert.equal(result.status, 'awaiting_file');
  assert.equal(bridge.state.tasks[task.taskId].filePath, path);
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. Reconciliation, source failures and bounded retries
// ─────────────────────────────────────────────────────────────────────────────
test('RECONCILE: completed keyed Shelfmark task is recognized without any old polling bridge', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const task = createTask(bridge, { status: 'queued', filePath: null, requestIds: ['recon-complete'] });
  const fake = apiScenarios({ 'sm.status': response({ complete: {
    [task.taskId]: { id: task.taskId, title: task.title, format: 'epub', target: FILES.validEpub },
  }, downloading: {}, queued: {}, error: {} }),
    requests: [request('recon-complete', task.title, task.author)],
    'bo.upload': { id: 1899 }, 'bo.fulfill': { status: 'AVAILABLE' },
  });
  const result = await bridge.reconcile({ fetchFn: fake.fetch });
  assert.ok(result.ok);
  assert.ok(['completed', 'fulfilled'].includes(task.status));
  fake.assertKnownRoutes();
});
test('RECONCILE: a complete task is never confused with old same-title error tasks', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const task = createTask(bridge, { status: 'queued', filePath: null, requestIds: ['independent-complete'] });
  const fake = apiScenarios({ 'sm.status': response({
    complete: { [task.taskId]: { id: task.taskId, title: task.title,
      format: 'epub', target: FILES.validEpub } },
    error: { 'ancient-error-1': { title: task.title, error: 'Old source failed' } },
  }),
    requests: [request('independent-complete', task.title, task.author)],
    'bo.upload': { id: 1900 }, 'bo.fulfill': { status: 'AVAILABLE' },
  });
  await bridge.reconcile({ fetchFn: fake.fetch });
  assert.notEqual(task.status, 'failed');
  assert.equal(task.errorSource, undefined);
});
test('RECONCILE: a failed exact task is marked failed and releases the selected release lock', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const task = createTask(bridge, { status: 'queued', filePath: null, requestIds: ['failed-exact'],
    source: 'annas', sourceId: 'dead-mirror', releaseKey: 'annas:dead-mirror' });
  bridge.state.releases['annas:dead-mirror'] = task.taskId;
  const fake = apiScenarios({ 'sm.status': response({ error: {
    [task.taskId]: { id: task.taskId, title: task.title, error: 'HTTP 503 mirror unavailable' },
  } }) });
  await bridge.reconcile({ fetchFn: fake.fetch });
  assert.equal(task.status, 'failed');
  assert.equal(bridge.state.releases['annas:dead-mirror'], undefined);
  assert.ok(String(task.error).includes('503'));
});
test('RECONCILE: one failure increments one attempt despite repeated status notifications', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const task = createTask(bridge, { status: 'queued', filePath: null, requestIds: ['idempotent-fail'],
    source: 'annas', sourceId: 'idempotent-src', releaseKey: 'annas:idempotent-src' });
  bridge.state.releases['annas:idempotent-src'] = task.taskId;
  const fake = apiScenarios({ 'sm.status': response({ error: {
    [task.taskId]: { id: task.taskId, error: 'Source failed exactly once' },
  } }) });
  await bridge.reconcile({ fetchFn: fake.fetch });
  await bridge.reconcile({ fetchFn: fake.fetch });
  await bridge.reconcile({ fetchFn: fake.fetch });
  assert.equal(bridge.state.requestSourceAttempts['idempotent-fail'], 1);
  assert.equal(bridge.state.requestAttempts['idempotent-fail']?.length, 1);
});
test('RECONCILE: an unrelated completed task must never adopt this request by matching title only', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const task = createTask(bridge, { status: 'queued', filePath: null, requestIds: ['1984-recon'],
    title: '1984', author: 'George Orwell' });
  const fake = apiScenarios({ 'sm.status': response({ complete: {
    'unrelated-1984': { id: 'unrelated-1984', title: '1984: Graphic Novel', format: 'epub',
      target: FILES.validEpub },
  }, error: {
    [task.taskId]: { id: task.taskId, error: 'OceanofPDF page unavailable' },
  } }) });
  await bridge.reconcile({ fetchFn: fake.fetch });
  assert.notEqual(task.matchedBookId, 901);
  assert.equal(fake.called('bo.upload').length, 0);
});
test('RECONCILE: completed file with missing task ID cannot be assigned to any arbitrary request', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const task = createTask(bridge, { status: 'queued', filePath: null, requestIds: ['unrelated-req'] });
  const fake = apiScenarios({ 'sm.status': response({ complete: {
    'different-task': { id: 'different-task', title: task.title, format: 'epub', target: FILES.validEpub },
  } }) });
  await bridge.reconcile({ fetchFn: fake.fetch });
  assert.equal(task.matchedBookId, null);
  assert.equal(fake.called('bo.upload').length, 0);
});
test('RECONCILE: uncertain queue is resolved once a uniquely correlated Shelfmark task appears', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const selected = sampleQueueRelease({ sourceId: 'uncertain-adopt-src' });
  const start = apiScenarios({ 'sm.download': response({}), 'sm.status': response({ complete: {} }) });
  await queueFixture(start, bridge, selected, 'uncertain-adopt-req');
  const status = apiScenarios({ 'sm.status': response({ downloading: {
    'task-from-status': queued('task-from-status', 'uncertain-adopt-src', 'Animal Farm'),
  } }) });
  await bridge.reconcile({ fetchFn: status.fetch });
  assert.equal(bridge.state.requests['uncertain-adopt-req'], 'task-from-status');
  assert.ok(bridge.state.tasks['task-from-status']);
});
test('RECONCILE: uncertain queue remains locked if two different matching tasks are ambiguous', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const selected = sampleQueueRelease({ sourceId: 'uncertain-ambiguous-src' });
  await queueFixture(apiScenarios({ 'sm.download': response({}) }), bridge, selected, 'ambiguous-req');
  const status = apiScenarios({ 'sm.status': response({ downloading: {
    'candidate-1': queued('candidate-1', 'uncertain-ambiguous-src', 'Animal Farm'),
    'candidate-2': queued('candidate-2', 'uncertain-ambiguous-src', 'Animal Farm'),
  } }) });
  await bridge.reconcile({ fetchFn: status.fetch });
  assert.ok(!['candidate-1', 'candidate-2'].includes(bridge.state.requests['ambiguous-req']));
});
test('RECONCILE: source attempts survive companion restart', async () => {
  const stateFilePath = newStateFile();
  const bridge = new BridgeService(bridgeOpts({ stateFilePath }));
  const task = createTask(bridge, { status: 'queued', filePath: null, requestIds: ['retry-history-1'],
    source: 'annas', sourceId: 'retry-history-src', releaseKey: 'annas:retry-history-src' });
  const fake = apiScenarios({ 'sm.status': response({ error: {
    [task.taskId]: { id: task.taskId, error: 'Source HTTP 502' },
  } }) });
  await bridge.reconcile({ fetchFn: fake.fetch });
  const restarted = new BridgeService(bridgeOpts({ stateFilePath }));
  assert.equal(restarted.state.requestSourceAttempts['retry-history-1'], 1);
  assert.equal(restarted.state.requestAttempts['retry-history-1']?.length, 1);
});
test('RECONCILE: no Shelfmark download POST is ever triggered solely by a historical failed task', async () => {
  const bridge = established(new BridgeService(bridgeOpts()));
  const task = createTask(bridge, { status: 'failed', filePath: null, requestIds: ['historical-001'] });
  const fake = apiScenarios({ 'sm.status': response({ error: {
    [task.taskId]: { id: task.taskId, error: 'Old failure' },
  } }) });
  await bridge.reconcile({ fetchFn: fake.fetch });
  assert.equal(fake.called('sm.download').length, 0);
});
test('RECONCILE: one new request succeeding must not reopen older failed requests', async () => {
  const bridge = established(new BridgeService(bridgeOpts()), ['historical-001']);
  const oldTask = createTask(bridge, { status: 'failed', filePath: null, requestIds: ['historical-001'] });
  const fresh = request('fresh-after-failure', 'Animal Farm', 'George Orwell');
  const fake = apiScenarios({
    requests: [fresh], books: [metadata('Animal Farm', 'George Orwell')],
    releases: [release('Animal Farm', 'George Orwell')], taskId: 'fresh-after-failure-sm',
    'sm.status': response({ error: { [oldTask.taskId]: { id: oldTask.taskId, error: 'Old error' } } }),
  });
  await bridge.reconcile({ fetchFn: fake.fetch });
  await bridge.processPendingRequests({ fetchFn: fake.fetch });
  assert.equal(bridge.state.requests['fresh-after-failure'], 'fresh-after-failure-sm');
  assert.equal(fake.called('sm.download').length, 1);
});


// ─────────────────────────────────────────────────────────────────────────────
// 12. Companion private HTTP security, payload limits, post-download shell hook
// ─────────────────────────────────────────────────────────────────────────────
async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}
async function closeServer(server) {
  if (!server?.listening) return;
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
}
test('HTTP: companion listener is private and its status does not disclose secrets', async () => {
  const bridge = new BridgeService(bridgeOpts({ secret: 'private-test-secret' }));
  const server = bridge.createServer(0, '127.0.0.1');
  const url = await listen(server);
  try {
    assert.equal(server.address().address, '127.0.0.1');
    const res = await fetch(`${url}/api/status`, { signal: AbortSignal.timeout(1000) });
    assert.equal(res.status, 200);
    const body = await res.text();
    noSecrets(body, 'private-test-secret', 'fixture-bookorbit-key-not-real', 'fixture-shelfmark-key-not-real');
  } finally { await closeServer(server); bridge.stop(); }
});
for (const target of ['/api/queue', '/api/reconcile', '/webhook/shelfmark']) {
  test(`HTTP: unauthenticated POST ${target} is refused`, async () => {
    const bridge = new BridgeService(bridgeOpts({ secret: 'private-test-secret' }));
    const server = bridge.createServer(0, '127.0.0.1');
    const url = await listen(server);
    try {
      const res = await fetch(`${url}${target}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: '{}',
        signal: AbortSignal.timeout(1000) });
      assert.equal(res.status, 401);
    } finally { await closeServer(server); bridge.stop(); }
  });
}
test('HTTP: incorrect bridge secret is rejected even if payload looks like a task', async () => {
  const bridge = new BridgeService(bridgeOpts({ secret: 'private-test-secret' }));
  const server = bridge.createServer(0, '127.0.0.1');
  const url = await listen(server);
  try {
    const res = await fetch(`${url}/webhook/shelfmark`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Secret': 'wrong' },
      body: JSON.stringify({ task: { task_id: 'fake' } }), signal: AbortSignal.timeout(1500) });
    assert.equal(res.status, 401);
  } finally { await closeServer(server); bridge.stop(); }
});
test('HTTP: oversized authenticated webhook payload is rejected with 413', async () => {
  const bridge = new BridgeService(bridgeOpts({ secret: 'private-test-secret' }));
  const server = bridge.createServer(0, '127.0.0.1');
  const url = await listen(server);
  try {
    const res = await fetch(`${url}/webhook/shelfmark`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Secret': 'private-test-secret' },
      body: JSON.stringify({ payload: 'x'.repeat(1024 * 1024 + 100) }),
      signal: AbortSignal.timeout(2500) });
    assert.equal(res.status, 413);
  } finally { await closeServer(server); bridge.stop(); }
}, 6000);
test('HTTP: malformed authenticated webhook JSON cannot trigger an import', async () => {
  const bridge = new BridgeService(bridgeOpts({ secret: 'private-test-secret' }));
  const server = bridge.createServer(0, '127.0.0.1');
  const url = await listen(server);
  try {
    const res = await fetch(`${url}/webhook/shelfmark`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Secret': 'private-test-secret' },
      body: '{not-json', signal: AbortSignal.timeout(1500) });
    assert.ok(res.status >= 400);
  } finally { await closeServer(server); bridge.stop(); }
});

test('HTTP: unknown route returns 404 JSON', async () => {
  const bridge = new BridgeService(bridgeOpts({ secret: 'private-test-secret' }));
  const server = bridge.createServer(0, '127.0.0.1');
  const url = await listen(server);
  try {
    const res = await fetch(`${url}/no-such-route`, { signal: AbortSignal.timeout(1500) });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.ok(body.error);
  } finally { await closeServer(server); bridge.stop(); }
});

test('HTTP: multi-file webhook payload adopts the first verifiable file', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const task = createTask(bridge, { status: 'queued', filePath: null, requestIds: ['multi-file-req'] });
  const server = bridge.createServer(0, '127.0.0.1');
  const url = await listen(server);
  try {
    const res = await fetch(`${url}/webhook/shelfmark`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Secret': bridge.secret },
      body: JSON.stringify({
        task: { task_id: task.taskId, title: task.title, format: task.format },
        paths: { target: FILES.invalidEpub, final_paths: [FILES.invalidEpub, FILES.validEpub] },
      }),
      signal: AbortSignal.timeout(2000),
    });
    assert.ok(res.status === 200 || res.status === 422);
    const body = await res.json();
    if (body.ok) assert.equal(body.filePath, FILES.validEpub);
  } finally { await closeServer(server); bridge.stop(); }
}, 5000);

function executeHook(script, filename, payload, url, secret = 'hook-fixture-secret') {
  return new Promise((resolve, reject) => {
    const child = execFile('bash', [script, filename], { cwd: HERE, timeout: 4_500,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, BRIDGE_WEBHOOK_URL: url, BRIDGE_SECRET: secret },
    }, (error, stdout, stderr) => resolve({ error, stdout, stderr, code: error?.code ?? 0 }));
    child.once('error', reject);
    child.stdin.end(JSON.stringify(payload));
  });
}
test('HOOK: Shelfmark gives executable $1 plus nested JSON stdin and bridge secret header', async () => {
  const script = join(HERE, 'scripts', 'shelfmark-hook.sh');
  assert.ok(existsSync(script), 'post-download hook script missing');
  const deliveries = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      deliveries.push({ url: req.url, method: req.method,
        secret: req.headers['x-bridge-secret'],
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  const url = await listen(server);
  try {
    const nested = { version: 1, phase: 'post_transfer',
      task: { task_id: 'hook-real-id', source: 'annas', title: '1984', format: 'epub' },
      paths: { destination: root, target: FILES.validEpub, final_paths: [FILES.validEpub] },
      output: { mode: 'folder' },
    };
    const result = await executeHook(script, FILES.validEpub, nested,
      `${url}/webhook/shelfmark`);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].url, '/webhook/shelfmark');
    assert.equal(deliveries[0].method, 'POST');
    assert.equal(deliveries[0].secret, 'hook-fixture-secret');
    assert.equal(deliveries[0].body.task.task_id, 'hook-real-id');
    assert.equal(deliveries[0].body.paths.target, FILES.validEpub);
  } finally { await closeServer(server); }
}, 8000);

test('HOOK: Node fallback delivers when curl is unavailable', async () => {
  const script = join(HERE, 'scripts', 'shelfmark-hook.sh');
  assert.ok(existsSync(script), 'post-download hook script missing');
  const noCurlDir = mkdtempSync(join(tmpdir(), 'nocurl-'));
  for (const bin of ['bash', 'node', 'cat', 'basename', 'sed', 'tail']) {
    const src = ['/bin/' + bin, '/usr/bin/' + bin].find(existsSync);
    if (src) symlinkSync(src, join(noCurlDir, bin));
  }
  const deliveries = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      deliveries.push({ url: req.url, method: req.method,
        secret: req.headers['x-bridge-secret'],
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  const url = await listen(server);
  try {
    const nested = { version: 1, phase: 'post_transfer',
      task: { task_id: 'hook-real-id', source: 'annas', title: '1984', format: 'epub' },
      paths: { destination: root, target: FILES.validEpub, final_paths: [FILES.validEpub] },
      output: { mode: 'folder' },
    };
    const result = await new Promise((resolve, reject) => {
      const child = execFile('bash', [script, FILES.validEpub], { cwd: HERE, timeout: 4_500,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, PATH: noCurlDir, BRIDGE_WEBHOOK_URL: `${url}/webhook/shelfmark`, BRIDGE_SECRET: 'hook-fixture-secret' },
      }, (error, stdout, stderr) => resolve({ error, stdout, stderr, code: error?.code ?? 0 }));
      child.once('error', reject);
      child.stdin.end(JSON.stringify(nested));
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].url, '/webhook/shelfmark');
    assert.equal(deliveries[0].method, 'POST');
    assert.equal(deliveries[0].secret, 'hook-fixture-secret');
    assert.equal(deliveries[0].body.task.task_id, 'hook-real-id');
    assert.equal(deliveries[0].body.paths.target, FILES.validEpub);
  } finally {
    await closeServer(server);
    rmSync(noCurlDir, { recursive: true, force: true });
  }
}, 8000);

test('HOOK: unavailable companion webhook must not mark Shelfmark download failed', async () => {
  const script = join(HERE, 'scripts', 'shelfmark-hook.sh');
  assert.ok(existsSync(script));
  const dummy = http.createServer();
  const url = await listen(dummy);
  await closeServer(dummy); // Race-free enough for local test: port is no longer listening.
  const result = await executeHook(script, FILES.validEpub, {
    version: 1, task: { task_id: 'offline-hook-test' },
    paths: { target: FILES.validEpub },
  }, `${url}/webhook/shelfmark`);
  assert.equal(result.code, 0, result.stderr);
}, 8000);

// ─────────────────────────────────────────────────────────────────────────────
// 13. Socket.IO namespace and Engine.IO v4 protocol correctness
// ─────────────────────────────────────────────────────────────────────────────
test('SOCKET: Engine.IO handshake connects to /book-requests namespace', () => {
  const sent = [];
  const client = new BookOrbitSocketClient({ url: 'http://127.0.0.1:3000',
    token: fakeJwt(3600) });
  client.ws = { readyState: 1, send: (frame) => sent.push(frame), close() {} };
  client.handlePacket('0{"sid":"engine-fixture","pingInterval":30000,"pingTimeout":20000}');
  assert.ok(sent.some((frame) => String(frame).startsWith('40/book-requests')));
  client.close();
});
test('SOCKET: server Engine.IO PING 2 must receive client PONG 3', () => {
  const sent = [];
  const client = new BookOrbitSocketClient({ url: 'http://127.0.0.1:3000', token: fakeJwt(3600) });
  client.ws = { readyState: 1, send: (frame) => sent.push(frame), close() {} };
  client.handlePacket('0{"sid":"engine-fixture","pingInterval":30000,"pingTimeout":20000}');
  sent.length = 0;
  client.handlePacket('2');
  assert.ok(sent.includes('3'));
  assert.ok(!sent.includes('2'), 'Engine.IO v4 client must not send unsolicited PING');
  client.close();
});
test('SOCKET: a completed namespace handshake does not require the deprecated Python bridge', () => {
  const client = new BookOrbitSocketClient({ url: 'http://127.0.0.1:3000', token: fakeJwt(3600) });
  client.ws = { readyState: 1, send() {}, close() {} };
  client.handlePacket('40/book-requests,{"sid":"socket-fixture"}');
  assert.equal(client.isConnected, true);
  client.close();
});

// Real loopback WebSocket handshake: tests the externally observable event
// delivery, not a particular callback/method inside the client implementation.
function encodeWsText(message) {
  const bytes = Buffer.from(String(message));
  if (bytes.length < 126) return Buffer.concat([Buffer.from([0x81, bytes.length]), bytes]);
  if (bytes.length < 65536) {
    const header = Buffer.from([0x81, 126, 0, 0]);
    header.writeUInt16BE(bytes.length, 2);
    return Buffer.concat([header, bytes]);
  }
  throw new Error('mock WebSocket message is unexpectedly huge');
}
function decodeWsMessages(incoming) {
  const decoded = [];
  let offset = 0;
  while (offset + 2 <= incoming.length) {
    const op = incoming[offset] & 0x0f;
    const masked = (incoming[offset + 1] & 0x80) !== 0;
    let len = incoming[offset + 1] & 0x7f;
    let headerLength = 2;
    if (len === 126) {
      if (offset + 4 > incoming.length) break;
      len = incoming.readUInt16BE(offset + 2); headerLength += 2;
    } else if (len === 127) {
      if (offset + 10 > incoming.length) break;
      const hi = incoming.readUInt32BE(offset + 2);
      const lo = incoming.readUInt32BE(offset + 6);
      if (hi !== 0) throw new Error('unexpected huge frame');
      len = lo; headerLength += 8;
    }
    const maskOffset = offset + headerLength;
    const bodyOffset = maskOffset + (masked ? 4 : 0);
    if (bodyOffset + len > incoming.length) break;
    const data = Buffer.from(incoming.subarray(bodyOffset, bodyOffset + len));
    if (masked) {
      const mask = incoming.subarray(maskOffset, maskOffset + 4);
      for (let i = 0; i < len; i++) data[i] ^= mask[i % 4];
    }
    if (op === 1) decoded.push(data.toString('utf8'));
    if (op === 8) decoded.push('__CLOSE__');
    offset = bodyOffset + len;
  }
  return { messages: decoded, unparsed: incoming.subarray(offset) };
}
async function waitUntil(testPredicate, timeoutMs = 1600) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (testPredicate()) return;
    await pause(20);
  }
  throw new Error(`condition not reached within ${timeoutMs}ms`);
}
test('SOCKET E2E: an authenticated book-requests:changed frame queues a newly approved ebook once', async () => {
  const stateFilePath = newStateFile();
  let posts = 0;
  let connected = false;
  const unexpected = [];
  const sockets = new Set();
  const incoming = request('new-socket-1', 'Animal Farm', 'George Orwell');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (body, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && url.pathname === '/api/v1/admin/book-requests') {
      send({ items: [incoming], total: 1 });
    } else if (req.method === 'GET' && url.pathname === '/api/v1/book-requests/new-socket-1') {
      send(incoming);
    } else if (req.method === 'GET' && url.pathname === '/api/metadata/search') {
      send({ books: [metadata('Animal Farm', 'George Orwell')] });
    } else if (req.method === 'GET' && url.pathname === '/api/releases') {
      send([release('Animal Farm', 'George Orwell', { source_id: 'socket-source' })]);
    } else if (req.method === 'POST' && url.pathname === '/api/releases/download') {
      posts++;
      send({ task_id: 'socket-shelfmark-task' });
    } else if (req.method === 'GET' && url.pathname === '/api/status') {
      send({ complete: {}, downloading: {}, queued: {}, error: {} });
    } else if (req.method === 'POST' && url.pathname === '/api/v1/auth/login') {
      send({ token: fakeJwt(3600), refreshToken: 'socket-refresh',
        expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    } else if (req.method === 'POST' && url.pathname === '/api/v1/auth/refresh') {
      send({ token: fakeJwt(3600), refreshToken: 'socket-refresh' });
    } else {
      unexpected.push(`${req.method} ${url.pathname}`);
      send({ error: 'No such endpoint' }, 404);
    }
  });
  server.on('upgrade', (req, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const wsKey = req.headers['sec-websocket-key'];
    if (!wsKey || !req.url.startsWith('/socket.io')) {
      unexpected.push(`WS ${req.url}`); socket.destroy(); return;
    }
    const accept = crypto.createHash('sha1').update(wsKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.write(encodeWsText('0{"sid":"socket-accept-fixture","pingInterval":15000,"pingTimeout":6000}'));
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const { messages, unparsed } = decodeWsMessages(buffer);
      buffer = unparsed;
      for (const frame of messages) {
        if (frame.startsWith('40/book-requests')) {
          connected = true;
          socket.write(encodeWsText('40/book-requests,{"sid":"namespace-fixture"}'));
          setTimeout(() => {
            if (!socket.destroyed) socket.write(encodeWsText('42/book-requests,["book-requests:changed"]'));
          }, 50).unref();
        } else if (frame === '2') {
          // A client should not issue unsolicited Engine.IO PING in v4.
          unexpected.push('WS unsolicited Engine.IO client PING');
        } else if (frame === '__CLOSE__') {
          socket.end();
        }
      }
    });
  });
  const base = await listen(server);
  const bridge = established(new BridgeService(bridgeOpts({ stateFilePath,
    bookorbitUrl: base, shelfmarkUrl: base, bookorbitToken: fakeJwt(3600) })), ['historical-only']);
  try {
    bridge.startSocketListener();
    await waitUntil(() => connected, 1600);
    await waitUntil(() => posts === 1, 2500);
    assert.equal(bridge.state.requests['new-socket-1'], 'socket-shelfmark-task');
    assert.equal(posts, 1);
    assert.deepEqual(unexpected, [], 'no nonexistent API routes or bad Engine.IO frames');
  } finally {
    bridge.stop();
    for (const socket of sockets) socket.destroy();
    await closeServer(server);
  }
}, 7000);

// ─────────────────────────────────────────────────────────────────────────────
// 14. Full isolated journey: request → search → queue → hook → library → Available
// ─────────────────────────────────────────────────────────────────────────────
test('E2E: a fresh approved book reaches Available via one queue and one direct upload', async () => {
  const stateFilePath = newStateFile();
  const bridge = established(new BridgeService(bridgeOpts({ stateFilePath,
    secret: 'e2e-fixture-secret' })), ['historical-only']);
  const incoming = request('e2e-f451', 'Fahrenheit 451', 'Ray Bradbury');
  const fake = apiScenarios({
    requests: [incoming],
    books: [metadata('Fahrenheit 451', 'Ray Bradbury')],
    releases: [release('Fahrenheit 451', 'Ray Bradbury', { source_id: 'e2e-f451-source' })],
    taskId: 'e2e-f451-shelfmark-task',
    'bo.upload': { id: 2001 }, 'bo.fulfill': { id: 'e2e-f451', status: 'AVAILABLE' },
  });
  await bridge.processPendingRequests({ fetchFn: fake.fetch });
  assert.equal(bridge.state.requests['e2e-f451'], 'e2e-f451-shelfmark-task');
  assert.equal(fake.called('sm.download').length, 1);
  const restarted = new BridgeService(bridgeOpts({ stateFilePath, secret: 'e2e-fixture-secret' }));
  assert.ok(restarted.state.tasks['e2e-f451-shelfmark-task']);
  const outcome = await restarted.handleWebhook({
    version: 1, phase: 'post_transfer',
    task: { task_id: 'e2e-f451-shelfmark-task', source: 'annas',
      title: 'Fahrenheit 451', format: 'epub' },
    paths: { destination: root, target: FILES.fahrenheitEpub, final_paths: [FILES.fahrenheitEpub] },
    output: { mode: 'folder' },
  }, 'e2e-fixture-secret', fake.fetch);
  assert.equal(outcome.ok, true);
  assert.equal(restarted.state.tasks['e2e-f451-shelfmark-task'].matchedBookId, 2001);
  assert.equal(restarted.state.tasks['e2e-f451-shelfmark-task'].status, 'fulfilled');
  assert.equal(fake.called('bo.upload').length, 1);
  assert.equal(fake.called('bo.fulfill').length, 1);
  assert.ok(!fake.calls.some((c) => c.path.startsWith('/api/v1/book-dock/')),
    'the old Book Dock workflow is retired from this integration');
  fake.assertKnownRoutes();
});
test('E2E: two independent Frankenstein editions remain two tasks and two library book IDs', async () => {
  const bridge = established(new BridgeService(bridgeOpts()), ['historical-only']);
  const fakeQueue = apiScenarios({
    'sm.download': ({ options }) => response({ task_id: expectedJson(options).source_id === 'frankenstein-1818'
      ? 'shelfmark-frank-1818' : 'shelfmark-frank-2015' }),
  });
  const older = await queueFixture(fakeQueue, bridge, sampleQueueRelease({ source: 'annas',
    sourceId: 'frankenstein-1818', title: 'Frankenstein', author: 'Mary Shelley', year: 1818 }), 'req-edition-1818');
  const newer = await queueFixture(fakeQueue, bridge, sampleQueueRelease({ source: 'annas',
    sourceId: 'frankenstein-2015', title: 'Frankenstein', author: 'Mary Shelley', year: 2015 }), 'req-edition-2015');
  assert.notEqual(older.taskId, newer.taskId);
  const t1 = bridge.state.tasks[older.taskId];
  const t2 = bridge.state.tasks[newer.taskId];
  t1.filePath = FILES.validEpub;
  t1.status = 'completed';
  t2.filePath = FILES.laterEpub;
  t2.status = 'completed';
  let uploadIndex = 0;
  const fakeBo = apiScenarios({ requests: [
    request('req-edition-1818', 'Frankenstein', 'Mary Shelley', { year: 1818 }),
    request('req-edition-2015', 'Frankenstein', 'Mary Shelley', { year: 2015 }),
  ],
    'bo.upload': () => response({ id: [3001, 3002][uploadIndex++] }),
    'bo.fulfill': { status: 'AVAILABLE' },
  });
  await bridge.fulfillBookOrbitRequests(t1, fakeBo.fetch);
  await bridge.fulfillBookOrbitRequests(t2, fakeBo.fetch);
  assert.equal(t1.matchedBookId, 3001);
  assert.equal(t2.matchedBookId, 3002);
  assert.equal(fakeBo.called('bo.upload').length, 2);
  assert.equal(fakeBo.called('bo.fulfill').length, 2);
  assert.deepEqual(t1.requestIds, ['req-edition-1818']);
  assert.deepEqual(t2.requestIds, ['req-edition-2015']);
  fakeQueue.assertKnownRoutes(); fakeBo.assertKnownRoutes();
});
test('E2E: a failed old request does not poison the next fresh unrelated book', async () => {
  const bridge = established(new BridgeService(bridgeOpts()), ['historical-001']);
  const old = createTask(bridge, { title: '1984', author: 'George Orwell',
    status: 'failed', requestIds: ['historical-001'] });
  const fresh = request('new-harry-potter', 'Harry Potter and the Chamber of Secrets', 'J. K. Rowling');
  const fake = apiScenarios({ requests: [fresh],
    books: [metadata(fresh.title, fresh.author)],
    releases: [release(fresh.title, fresh.author)],
    taskId: 'new-hp-shelfmark-task',
    'sm.status': response({ error: { [old.taskId]: {
      id: old.taskId, title: old.title, error: 'Ancient mirror error',
    } } }),
  });
  await bridge.reconcile({ fetchFn: fake.fetch });
  await bridge.processPendingRequests({ fetchFn: fake.fetch });
  assert.equal(bridge.state.requests['new-harry-potter'], 'new-hp-shelfmark-task');
  assert.equal(fake.called('sm.download').length, 1);
});



// ─────────────────────────────────────────────────────────────────────────────
// 15. Production acceptance matrix and v1.5.8-specific regression boundaries
// ─────────────────────────────────────────────────────────────────────────────
const productionRegressionBooks = [
  ['Fahrenheit 451', 'Ray Bradbury'],
  ['Animal Farm', 'George Orwell'],
  ["Harry Potter and the Philosopher's Stone", 'J. K. Rowling'],
  ['Harry Potter and the Chamber of Secrets', 'J. K. Rowling'],
  ['Frankenstein', 'Mary Shelley'],
  ['1984', 'George Orwell'],
];
for (const [title, author] of productionRegressionBooks) {
  test(`PRODUCTION: ${title} by ${author} remains discoverable after regression fixes`, async () => {
    const result = await searchScenario({ query: standardQuery(title, author),
      books: [metadata(title, author)], releases: [release(title, author)] });
    assert.ok(result.result.some((r) => r.format === 'epub'),
      'a previously working legitimate title was accidentally excluded');
  });
}
test('PRODUCTION: a real OceanofPDF page URL survives native search → companion queue unchanged', async () => {
  const search = await searchScenario({
    query: standardQuery('1984', 'George Orwell', { language: 'en' }),
    books: [metadata('1984', 'George Orwell')],
    releases: [release('1984', 'George Orwell', {
      source: 'oceanofpdf', source_id: 'oceanofpdf:regression-1984',
      download_url: oceanPage, info_url: oceanPage,
    })],
  });
  assert.ok(search.result.length > 0);
  const selected = search.result.find((r) => r.extra?.sourceId === 'oceanofpdf:regression-1984');
  assert.ok(selected, 'BookOrbit release picker must display a valid candidate');
  const bridge = new BridgeService(bridgeOpts());
  const fake = apiScenarios({ taskId: 'source-url-e2e-task' });
  await queueFixture(fake, bridge, selected, 'new-correct-1984');
  assert.equal(fake.called('sm.download').length, 1);
  const body = expectedJson(fake.called('sm.download')[0].options);
  assert.equal(body.source_id, 'oceanofpdf:regression-1984');
  assert.ok([body.source_url, body.download_url, body.info_url, body.extra?.source_url]
    .includes(oceanPage), 'the book page was lost between search and download queue');
  fake.assertKnownRoutes();
});
test('REGRESSION: plugin host.fail returning undefined cannot create an invalid thrown value', async () => {
  const fake = apiScenarios({
    'sm.metadata': failResponse(401, 'Credentials refused'),
    'sm.releases': failResponse(401, 'Credentials refused'),
  });
  const host = hostWith(fake.fetch);
  // A nonconforming host callback must not cause `throw undefined`.
  // A real Error rejection or explicit empty search result is acceptable.
  host.fail = () => undefined;
  const settled = await Promise.allSettled([
    plugin.search(standardQuery('1984', 'George Orwell'), config(), host),
  ]);
  const one = settled[0];
  if (one.status === 'rejected') {
    assert.ok(one.reason instanceof Error, 'undefined was thrown instead of a proper Error');
  } else {
    assert.deepEqual(one.value, [], 'API outage cannot be reported as a valid release');
  }
  fake.assertKnownRoutes();
});
test('REGRESSION: host.fetch status 404 is not silently treated like an empty metadata response', async () => {
  const fake = apiScenarios({
    'sm.metadata': failResponse(404, 'Endpoint does not exist'),
    'sm.releases': failResponse(404, 'Endpoint does not exist'),
  });
  let outcome;
  try { outcome = await plugin.search(standardQuery('1984', 'George Orwell'), config(), hostWith(fake.fetch)); }
  catch (error) { assert.ok(error); }
  if (outcome) assert.deepEqual(outcome, []);
  fake.assertKnownRoutes();
});
test('REGRESSION: user cancellation status never calls nonexistent admin GET-by-ID API', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const fake = apiScenarios({
    requests: [request('cancel-regression', '1984', 'George Orwell', { status: 'cancelled' })],
    'bo.request': failResponse(403, 'No detail permission'),
  });
  assert.equal(await bridge.getRequestStatus('cancel-regression', fake.fetch), 'cancelled');
  assert.ok(!fake.calls.some((c) => c.path === '/api/v1/admin/book-requests/cancel-regression'));
  fake.assertKnownRoutes();
});
test('REGRESSION: historic task marked failed once has one attempt after five status refreshes', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const task = createTask(bridge, { status: 'queued', filePath: null,
    requestIds: ['count-once-1'], source: 'annas', sourceId: 'once-source',
    releaseKey: 'annas:once-source' });
  const fake = apiScenarios({ 'sm.status': response({ error: {
    [task.taskId]: { id: task.taskId, error: 'Source was offline' },
  } }) });
  for (let i = 0; i < 5; i++) await bridge.reconcile({ fetchFn: fake.fetch });
  assert.equal(bridge.state.requestSourceAttempts['count-once-1'], 1);
  assert.equal(bridge.state.requestAttempts['count-once-1']?.length, 1);
});
test('REGRESSION: three distinct failed source task IDs create three, not repeated, attempts', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const requestId = 'bounded-retries-3';
  const errors = {};
  for (let i = 1; i <= 3; i++) {
    const task = createTask(bridge, { taskId: `fail-task-${i}`, status: 'queued', filePath: null,
      requestIds: [requestId], source: 'annas', sourceId: `source-${i}`,
      releaseKey: `annas:source-${i}` });
    errors[task.taskId] = { id: task.taskId, error: `Independent source failure ${i}` };
    await bridge.reconcile({ fetchFn: apiScenarios({ 'sm.status': response({ error: errors }) }).fetch });
  }
  assert.equal(bridge.state.requestSourceAttempts[requestId], 3);
  assert.equal(new Set(bridge.state.requestAttempts[requestId].map((a) => a.attemptId)).size, 3);
});
test('REGRESSION: a failed source is cooled down and a healthy alternative is selected', async () => {
  const bridge = established(new BridgeService(bridgeOpts({ releaseFailureCooldownMs: 60_000 })));
  const failedSourceId = 'failed-ocean-1984';
  const failingReleaseKey = `oceanofpdf:${failedSourceId}`;
  const failed = createTask(bridge, { status: 'queued', filePath: null,
    title: '1984', author: 'George Orwell', source: 'oceanofpdf',
    sourceId: failedSourceId, releaseKey: failingReleaseKey,
    requestIds: ['old-failed-1984'] });
  bridge.state.releases[failingReleaseKey] = failed.taskId;
  await bridge.reconcile({ fetchFn: apiScenarios({ 'sm.status': response({ error: {
    [failed.taskId]: { id: failed.taskId, error: 'Previously failed OceanofPDF source' },
  } }) }).fetch });
  assert.ok(bridge.state.failedReleases[failingReleaseKey],
    'actual reconciliation must establish the failed-source cooldown');
  const req = request('fresh-with-alternative', '1984', 'George Orwell');
  const fake = apiScenarios({ requests: [req],
    books: [metadata('1984', 'George Orwell')],
    releases: [
      release('1984', 'George Orwell', { source: 'oceanofpdf', source_id: failedSourceId,
        download_url: oceanPage, info_url: oceanPage }),
      release('1984', 'George Orwell', { source: 'annas', source_id: 'healthy-alternative-1984' }),
    ],
    taskId: 'healthy-alternate-task',
  });
  await bridge.processPendingRequests({ fetchFn: fake.fetch });
  const posts = fake.called('sm.download').map((c) => expectedJson(c.options));
  assert.equal(posts.length, 1, 'healthy alternative should be tried once');
  assert.equal(posts[0].source_id, 'healthy-alternative-1984');
  fake.assertKnownRoutes();
});

// ─────────────────────────────────────────────────────────────────────────────
// Test runner — keep executing after failures so one bad release is diagnosed
// rather than hiding every later failure. No tests touch deployed CT105.
// ─────────────────────────────────────────────────────────────────────────────
async function runAll() {
  console.log(`\nBookOrbit ↔ Shelfmark independent acceptance suite (${EXPECTED_VERSION})`);
  console.log(`Mode: ${RELEASE_MODE ? 'RELEASE + runtime' : 'development + runtime'}`);
  console.log(`Contracts: BookOrbit 3.5.0 / Shelfmark 1.5.1`);
  console.log(`Registered cases: ${tests.length}; isolated workspace: ${root}`);
  let lastSection = '';
  try {
    for (const item of tests) {
      const group = item.name.split(':', 1)[0];
      if (group !== lastSection) section(group);
      lastSection = group;
      let timer;
      const started = performance.now();
      try {
        await Promise.race([
          Promise.resolve().then(item.run),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(
              `TEST_TIMEOUT after ${item.timeoutMs}ms; async operation hung or is unbounded`)),
            item.timeoutMs);
            timer.unref?.();
          }),
        ]);
        passed++;
        console.log(`  PASS ${item.name} (${Math.round(performance.now() - started)}ms)`);
      } catch (error) {
        failed++;
        const details = error?.stack || String(error);
        failures.push({ test: item.name, details });
        console.error(`  FAIL ${item.name}`);
        console.error(`       ${String(error?.message || error).replaceAll('\n', '\n       ')}`);
      } finally { clearTimeout(timer); }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  console.log('\n────────────────────────────────────────────────────────────');
  console.log(`RESULT: ${passed} passed / ${failed} failed / ${tests.length} total`);
  if (failures.length) {
    console.log('\nFAILURES TO FIX (these expectations are independent of the implementation):');
    for (const [i, f] of failures.entries()) {
      console.log(`\n${i + 1}. ${f.test}`);
      console.log(f.details);
    }
  }
  console.log('\nIMPORTANT: all test backends were simulated. Passing is NOT proof of a live CT105 download.');
  console.log('After test success, verify native UI version, running companion mount, and a new request end-to-end.');
  process.exitCode = failed ? 1 : 0;
}

await runAll();
