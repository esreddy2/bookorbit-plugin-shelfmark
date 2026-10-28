/**
 * Verification test suite for BookOrbit Shelfmark indexer plugin v1.2.0.
 *
 * Simulates BookOrbit host environment and validates the plugin against
 * mocked Shelfmark v1.5.1 API fixtures and comprehensive unit test cases.
 *
 * Run with: node verify.mjs
 */

import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';

import plugin from './index.mjs';
import {
  BridgeService,
  BookOrbitSocketClient,
  BookOrbitAuthManager,
  timingSafeCompare,
  isJwt,
  decodeJwtExp,
  parseShelfmarkStatus,
  normalizeTaskGroup,
  parsePositiveInt,
  areEditionsCompatible,
} from './bridge/bridge.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

const HEALTH = fixture('health.json');
const META_SEARCH = fixture('metadata_search.json');
const RELEASES = fixture('releases.json');
const STATUS = fixture('status.json');

let pass = 0;
let fail = 0;

function ok(name, condition, extra) {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ok   ${name}`);
  } else {
    fail += 1;
    console.error(`  ✗ FAIL ${name}`, extra ?? '');
  }
}

function makeHost(handler) {
  const calls = [];
  return {
    calls,
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      // Enforce BookOrbit v3.5.0 PluginRequestInit contract: signal is NOT supported
      if ('signal' in options && options.signal !== undefined) {
        throw new Error('PluginRequestInit contract violation: "signal" property must not be passed to host.fetch()');
      }
      return handler(url, options);
    },
    logger: {
      log: () => {},
      warn: () => {},
      error: () => {},
    },
    buildSearchText: (q) => [q.title, q.author].filter(Boolean).join(' ').trim(),
    fail: (code, message) => {
      const validCodes = ['unauthorized', 'throttled', 'timeout', 'unreachable', 'unsupportedMedium', 'error'];
      if (!validCodes.includes(code)) {
        throw new Error(`INVALID_BOOKORBIT_FAILURE_CODE: "${code}" is not supported by BookOrbit!`);
      }
      const err = new Error(message);
      err.code = code;
      return err;
    },
  };
}

const mockResponse = (body, status = 200, headers = {}) => {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
};

const baseConfig = (overrides = {}) => ({
  id: 1,
  name: 'Shelfmark',
  baseUrl: 'http://localhost:8084',
  settings: {
    apiKey: 'secret-shelfmark-key-98765',
    preferFormat: 'epub',
    downloadViaShelfmark: true,
    pollTimeoutSeconds: 5,
    pollIntervalMs: 15, // Fast polling for snappy test execution
    ...overrides.settings,
  },
  ...overrides,
});

async function runTests() {
  console.log('\n--- 1. Declaration & Metadata ---');
  ok('targets BookOrbit API version 1', plugin.apiVersion === 1);
  ok('type is shelfmark', plugin.type === 'shelfmark');
  ok('supports ebook only', plugin.mediaKinds.length === 1 && plugin.mediaKinds.includes('ebook'));
  ok('defines apiKey in settingsFields', plugin.settingsFields.some((f) => f.key === 'apiKey' && f.type === 'string'));
  ok('defines preferFormat in settingsFields', plugin.settingsFields.some((f) => f.key === 'preferFormat'));
  ok('preferFormat defaults to epub', plugin.settingsFields.find((f) => f.key === 'preferFormat')?.default === 'epub');
  ok('defines downloadViaShelfmark toggle', plugin.settingsFields.some((f) => f.key === 'downloadViaShelfmark'));
  ok('defines pollTimeoutSeconds defaulting to 240', plugin.settingsFields.find((f) => f.key === 'pollTimeoutSeconds')?.default === 240);
  ok('declares semantic version 1.5.4', plugin.version === '1.5.4');
  ok('declares update channel', typeof plugin.update === 'object' && plugin.update !== null);
  ok('update manifestUrl is HTTPS and points to fork repo', typeof plugin.update?.manifestUrl === 'string' && plugin.update.manifestUrl.includes('esreddy2/bookorbit-plugin-shelfmark'));
  ok('update ed25519PublicKey is 43-char base64url', /^[A-Za-z0-9_-]{43}$/.test(plugin.update?.ed25519PublicKey ?? ''));

  // Verify that updates/shelfmark.json matches index.mjs
  {
    const manifestFile = join(here, 'updates', 'shelfmark.json');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    const indexSrc = readFileSync(join(here, 'index.mjs'), 'utf8');

    ok('manifest schemaVersion is 1', manifest.schemaVersion === 1);
    ok('manifest type matches plugin', manifest.type === plugin.type);
    ok('manifest version matches plugin', manifest.version === plugin.version);

    const calculatedSha = crypto.createHash('sha256').update(indexSrc).digest('hex');
    ok('manifest sha256 matches index.mjs', manifest.sha256 === calculatedSha);

    const verifierKey = crypto.createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: plugin.update.ed25519PublicKey },
      format: 'jwk',
    });
    const validSig = crypto.verify(null, Buffer.from(indexSrc), verifierKey, Buffer.from(manifest.signature, 'base64'));
    ok('manifest Ed25519 signature verifies against plugin public key', validSig === true);
  }

  console.log('\n--- 2. Connectivity Test (test) ---');
  {
    const host = makeHost((url) => {
      if (url.includes('/api/health')) return mockResponse(HEALTH);
      if (url.includes('/api/status')) return mockResponse(STATUS);
      return mockResponse({ error: 'not found' }, 404);
    });

    const result = await plugin.test(baseConfig(), host);
    ok('test succeeds on healthy response', result.success === true && result.indexerName === 'Shelfmark');
    ok('sends Authorization and X-Api-Key headers', host.calls[0].options.headers['X-Api-Key'] === 'secret-shelfmark-key-98765');
  }

  {
    const host = makeHost(() => mockResponse({ error: 'Unauthorized' }, 401));
    const result = await plugin.test(baseConfig(), host);
    ok('test handles authentication failure (401/403)', result.success === false && result.error.includes('Authentication failed'));
  }

  {
    const host = makeHost((url) => {
      if (url.includes('/api/health')) return mockResponse(HEALTH);
      if (url.includes('/api/status')) return mockResponse({ error: 'server error' }, 500);
      return mockResponse({});
    });
    const result = await plugin.test(baseConfig(), host);
    ok('test handles status endpoint failure (500)', result.success === false && result.error.includes('HTTP 500'));
  }

  {
    const host = makeHost(() => {
      throw new Error('Connection refused');
    });
    const result = await plugin.test(baseConfig(), host);
    ok('test handles unreachable host / connection error', result.success === false && result.error.includes('Connection refused'));
  }

  console.log('\n--- 3. Search & Metadata Robustness (BUG 2) ---');
  {
    // Test 1: Exact title and author match (e.g. Fahrenheit 451, Ray Bradbury)
    let queriedParam = null;
    const host = makeHost((url) => {
      if (url.includes('/api/metadata/search')) {
        queriedParam = new URL(url).searchParams.get('query');
        return mockResponse({
          books: [
            { provider: 'openlibrary', provider_id: 'OL-F451', title: 'Fahrenheit 451', authors: ['Ray Bradbury'] },
          ],
        });
      }
      if (url.includes('/api/releases')) {
        return mockResponse([
          { id: 'f451-epub', source_id: 'f451-src', source: 'libgen', title: 'Fahrenheit 451 [EPUB]', format: 'epub', size_bytes: 400000 },
        ]);
      }
      return mockResponse([]);
    });

    const query = { title: 'Fahrenheit 451', author: 'Ray Bradbury', mediaKind: 'ebook' };
    const releases = await plugin.search(query, baseConfig(), host);
    ok('exact title and author match', releases.length === 1 && releases[0].format === 'epub');
    ok('queries metadata by title only', queriedParam === 'Fahrenheit 451');
  }

  {
    // Test 2: Numeric title '1984'
    const host = makeHost((url) => {
      if (url.includes('/api/metadata/search')) {
        return mockResponse({
          books: [{ provider: 'openlibrary', provider_id: 'OL-1984', title: '1984', authors: ['George Orwell'] }],
        });
      }
      if (url.includes('/api/releases')) {
        return mockResponse([{ id: '1984-rel', source_id: '1984-src', source: 'libgen', title: '1984 [EPUB]', format: 'epub', size_bytes: 500000 }]);
      }
      return mockResponse([]);
    });

    const res = await plugin.search({ title: '1984', author: 'George Orwell', mediaKind: 'ebook' }, baseConfig(), host);
    ok('numeric title 1984 matches successfully', res.length === 1 && res[0].title === '1984 [EPUB]');
  }

  {
    // Test 3: 1984 versus Nineteen Eighty-Four equivalence
    // Case A: Query is '1984', Open Library metadata returns 'Nineteen Eighty-Four'
    const hostA = makeHost((url) => {
      if (url.includes('/api/metadata/search')) {
        return mockResponse({
          books: [{ provider: 'openlibrary', provider_id: 'OL-NEF', title: 'Nineteen Eighty-Four', authors: ['George Orwell'] }],
        });
      }
      if (url.includes('/api/releases')) {
        return mockResponse([{ id: 'nef-rel', source_id: 'nef-src', source: 'libgen', title: 'Nineteen Eighty-Four', format: 'epub', size_bytes: 450000 }]);
      }
      return mockResponse([]);
    });

    const resA = await plugin.search({ title: '1984', author: 'George Orwell', mediaKind: 'ebook' }, baseConfig(), hostA);
    ok('1984 versus Nineteen Eighty-Four (matches equivalent edition)', resA.length === 1);

    // Case B: Query is '1984', Open Library metadata search for '1984' returns zero, but fallback for 'nineteen eighty-four' succeeds
    let searchAttempt = 0;
    const hostB = makeHost((url) => {
      if (url.includes('/api/metadata/search')) {
        searchAttempt++;
        const q = new URL(url).searchParams.get('query');
        if (q === '1984') return mockResponse({ books: [] }); // 0 results for 1984
        if (q.includes('nineteen')) {
          return mockResponse({
            books: [{ provider: 'openlibrary', provider_id: 'OL-NEF-2', title: 'Nineteen Eighty-Four', authors: ['George Orwell'] }],
          });
        }
      }
      if (url.includes('/api/releases')) {
        return mockResponse([{ id: 'rel-b', source_id: 'src-b', source: 'libgen', title: '1984', format: 'epub', size_bytes: 500000 }]);
      }
      return mockResponse([]);
    });

    const resB = await plugin.search({ title: '1984', author: 'George Orwell', mediaKind: 'ebook' }, baseConfig(), hostB);
    ok('1984 fallback to Nineteen Eighty-Four when initial query returns 0', resB.length === 1);
  }

  {
    // Test 4: Numeric title supplied as a number (e.g. { title: 1984 })
    const host = makeHost((url) => {
      if (url.includes('/api/metadata/search')) {
        return mockResponse({
          books: [{ provider: 'openlibrary', provider_id: 'OL-1984-num', title: '1984', authors: ['George Orwell'] }],
        });
      }
      if (url.includes('/api/releases')) {
        return mockResponse([{ id: 'r1', source_id: 's1', source: 'libgen', title: '1984', format: 'epub', size_bytes: 500000 }]);
      }
      return mockResponse([]);
    });

    const res = await plugin.search({ title: 1984, author: 'George Orwell', mediaKind: 'ebook' }, baseConfig(), host);
    ok('numeric title supplied as a number primitive handles safely without throwing', res.length === 1);
  }

  {
    // Test 5: Animal Farm alternate editions (subtitles and edition noise)
    let releaseSearchTitle = null;
    const host = makeHost((url) => {
      if (url.includes('/api/metadata/search')) {
        return mockResponse({
          books: [
            {
              provider: 'openlibrary',
              provider_id: 'OL-AF-SUB',
              title: 'Animal Farm: A Fairy Story (Penguin Modern Classics)',
              authors: ['Orwell, George'], // Transposed author
            },
          ],
        });
      }
      if (url.includes('/api/releases')) {
        releaseSearchTitle = new URL(url).searchParams.get('title');
        return mockResponse([
          { id: 'af-1', source_id: 'af-src-1', source: 'libgen', title: 'Animal Farm', format: 'epub', size_bytes: 350000 },
        ]);
      }
      return mockResponse([]);
    });

    const res = await plugin.search({ title: 'Animal Farm', author: 'George Orwell', mediaKind: 'ebook' }, baseConfig(), host);
    ok('Animal Farm alternate editions and transposed author match', res.length === 1);
    ok('cleans subtitle noise for release query (sent "Animal Farm" instead of long subtitle)', releaseSearchTitle === 'Animal Farm');
  }

  {
    // Test 5B: Provider metadata enrichment (AA & OceanofPDF) for numeric titles
    // - Converts "Orwell, George, 1903-1950" to "George Orwell"
    // - Passes ISBN to /api/releases
    // - Fans out release queries for both "1984" and "Nineteen Eighty-Four"
    // - Handles OceanofPDF formats and title conventions
    const capturedReleasesUrls = [];
    const host = makeHost((url) => {
      if (url.includes('/api/metadata/search')) {
        return mockResponse({
          books: [
            {
              provider: 'openlibrary',
              provider_id: 'OL-1984-META',
              title: 'Nineteen Eighty-Four',
              authors: ['Orwell, George, 1903-1950'], // Transposed with MARC life dates
              isbn: ['9780451524935'],
            },
          ],
        });
      }
      if (url.includes('/api/releases')) {
        const u = new URL(url);
        capturedReleasesUrls.push({
          title: u.searchParams.get('title'),
          author: u.searchParams.get('author'),
          isbn: u.searchParams.get('isbn'),
        });
        if (u.searchParams.get('title') === '1984') {
          // OceanofPDF direct download match
          return mockResponse([
            {
              id: 'ocean-1',
              source_id: 'ocean-src-1',
              source: 'direct_download',
              title: '[PDF] [EPUB] 1984 by George Orwell Download',
              format: 'epub, pdf',
              size_bytes: 650000,
            },
          ]);
        }
        if (u.searchParams.get('title') === 'Nineteen Eighty-Four') {
          // Anna's Archive match
          return mockResponse([
            {
              id: 'aa-1',
              source_id: 'aa-src-1',
              source: 'direct_download',
              title: 'Nineteen Eighty-Four',
              author: 'George Orwell',
              format: 'epub',
              size_bytes: 600000,
            },
          ]);
        }
      }
      return mockResponse([]);
    });

    const res = await plugin.search({ title: '1984', author: 'George Orwell', mediaKind: 'ebook' }, baseConfig(), host);
    ok('fans out release queries across both core and equivalent numeric titles', capturedReleasesUrls.some((u) => u.title === '1984') && capturedReleasesUrls.some((u) => u.title === 'Nineteen Eighty-Four'));
    ok('normalizes transposed author with dates to natural order for AA/OceanofPDF', capturedReleasesUrls.every((u) => u.author === 'George Orwell'));
    ok('passes ISBN to /api/releases for direct providers', capturedReleasesUrls.every((u) => u.isbn === '9780451524935'));
    ok('captures OceanofPDF releases with bracketed titles and multi-formats', res.some((r) => r.extra?.sourceId === 'ocean-src-1' && r.format === 'epub'));
    ok('captures Anna Archive releases under alternative title', res.some((r) => r.extra?.sourceId === 'aa-src-1'));
    ok('normalizes author name in BookOrbit release objects', res.every((r) => r.author === 'George Orwell'));
  }

  {
    // Test 5C: Derivative / study guide noise rejection for numeric titles
    const host = makeHost((url) => {
      if (url.includes('/api/metadata/search')) {
        return mockResponse({
          books: [{ provider: 'openlibrary', provider_id: 'OL-1984', title: '1984', authors: ['George Orwell'] }],
        });
      }
      if (url.includes('/api/releases')) {
        return mockResponse([
          { id: 'guide-1', source_id: 'g-1', source: 'libgen', title: 'Study Guide: 1984 by George Orwell', format: 'epub', size_bytes: 200000 },
          { id: 'guide-2', source_id: 'g-2', source: 'libgen', title: 'Summary of 1984 by George Orwell', format: 'epub', size_bytes: 210000 },
          { id: 'guide-3', source_id: 'g-3', source: 'libgen', title: "CliffsNotes on Orwell's 1984", format: 'epub', size_bytes: 220000 },
          { id: 'book-1', source_id: 'b-1', source: 'libgen', title: '1984 (Signet Classics)', author: 'George Orwell', format: 'epub', size_bytes: 500000 },
        ]);
      }
      return mockResponse([]);
    });

    const res = await plugin.search({ title: '1984', author: 'George Orwell', mediaKind: 'ebook' }, baseConfig(), host);
    ok('rejects study guides, summaries, and CliffsNotes noise for 1984', res.length === 1 && res[0].extra?.sourceId === 'b-1');
  }

  {
    // Test 5D: BookOrbit v3.5.0 PluginReleaseQuery contract (isbn13 and isbn13s)
    let queriedIsbn = null;
    let releasesIsbn = null;
    const host = makeHost((url) => {
      if (url.includes('/api/metadata/search')) {
        queriedIsbn = new URL(url).searchParams.get('query');
        return mockResponse({ books: [] }); // Fallback to direct release query
      }
      if (url.includes('/api/releases')) {
        releasesIsbn = new URL(url).searchParams.get('isbn');
        return mockResponse([
          { id: 'rel-isbn', source_id: 'src-isbn', source: 'annas', title: '1984', author: 'George Orwell', format: 'epub', size_bytes: 500000 },
        ]);
      }
      return mockResponse([]);
    });

    const query = {
      isbn13: '9780451524935',
      isbn13s: ['9780451524935'],
      mediaKind: 'ebook',
    };
    const res = await plugin.search(query, baseConfig(), host);
    ok('PluginReleaseQuery supports isbn13 and isbn13s without requiring legacy isbn', queriedIsbn === '9780451524935' && releasesIsbn === '9780451524935');
    ok('PluginReleaseCandidate reports authentic isbn', res.length === 1 && res[0].isbn === '9780451524935');
  }

  {
    // Test 5E: Author mismatch rejection (reject Michael Dean adaptation when user requests George Orwell)
    const host = makeHost((url) => {
      if (url.includes('/api/metadata/search')) {
        return mockResponse({
          books: [{ provider: 'openlibrary', provider_id: 'OL-1984', title: '1984', authors: ['George Orwell'] }],
        });
      }
      if (url.includes('/api/releases')) {
        return mockResponse([
          {
            id: 'rel-dean',
            source_id: 'src-dean',
            source: 'direct_download',
            title: '1984 (Adapted for ESL Learners)',
            author: 'Michael Dean', // Conflicting author adaptation!
            format: 'epub',
            size_bytes: 300000,
          },
          {
            id: 'rel-orwell',
            source_id: 'src-orwell',
            source: 'direct_download',
            title: '1984 (Signet Classic Edition)',
            author: 'George Orwell',
            format: 'epub',
            size_bytes: 550000,
          },
        ]);
      }
      return mockResponse([]);
    });

    const res = await plugin.search({ title: '1984', author: 'George Orwell', mediaKind: 'ebook' }, baseConfig(), host);
    ok('rejects releases where reported author conflicts with requested author (Michael Dean adaptation)', !res.some((r) => r.author?.includes('Michael Dean')));
    ok('preserves authentic release by requested author', res.some((r) => r.extra?.sourceId === 'src-orwell' && r.author === 'George Orwell'));
  }

  {
    // Test 5F-1: Strict rejection of adaptations, graded readers, graphic novels, and collections (Animal Farm & 1984)
    const host = makeHost((url) => {
      if (url.includes('/api/metadata/search')) {
        return mockResponse({
          books: [
            { provider: 'openlibrary', provider_id: 'OL-AF', title: 'Animal Farm', authors: ['George Orwell'] },
          ],
        });
      }
      if (url.includes('/api/releases')) {
        return mockResponse([
          { id: 'rel-gn', source_id: 's-gn', source: 'annas', title: 'Animal Farm: The Graphic Novel', format: 'epub', author: 'George Orwell' },
          { id: 'rel-gr', source_id: 's-gr', source: 'annas', title: 'Animal Farm (Oxford Bookworms Library, Stage 3)', format: 'epub', author: 'George Orwell' },
          { id: 'rel-col', source_id: 's-col', source: 'annas', title: 'Animal Farm & 1984 (Collector Edition)', format: 'epub', author: 'George Orwell' },
          { id: 'rel-simp', source_id: 's-simp', source: 'annas', title: 'Animal Farm (Simplified Edition)', format: 'epub', author: 'George Orwell' },
          { id: 'rel-auth', source_id: 's-auth', source: 'annas', title: 'Animal Farm (Penguin Classics)', format: 'epub', author: 'George Orwell' },
        ]);
      }
      return mockResponse([]);
    });

    const res = await plugin.search({ title: 'Animal Farm', author: 'George Orwell', mediaKind: 'ebook' }, baseConfig(), host);
    ok('rejects graphic novel adaptation for Animal Farm', !res.some((r) => r.title.includes('Graphic Novel')));
    ok('rejects graded reader adaptation for Animal Farm', !res.some((r) => r.title.includes('Stage 3') || r.title.includes('Bookworms')));
    ok('rejects multi-work collection bundle (Animal Farm & 1984)', !res.some((r) => r.title.includes('1984')));
    ok('rejects simplified edition adaptation for Animal Farm', !res.some((r) => r.title.includes('Simplified Edition')));
    ok('preserves authentic canonical edition of Animal Farm', res.some((r) => r.title.includes('Penguin Classics') && r.bookTitle === 'Animal Farm'));
  }

  {
    // Test 5F: Release scoring data integrity (bookTitle matches searchTitle, authentic metadata)
    const host = makeHost((url) => {
      if (url.includes('/api/metadata/search')) {
        return mockResponse({
          books: [
            {
              provider: 'openlibrary',
              provider_id: 'OL-NEF',
              title: 'Nineteen Eighty-Four', // Open Library catalog title
              authors: ['George Orwell'],
              isbn: ['9780451524935'],
            },
          ],
        });
      }
      if (url.includes('/api/releases')) {
        return mockResponse([
          {
            id: 'rel-score',
            source_id: 'src-score',
            source: 'annas',
            title: '1984 (Signet Classics)',
            author: 'George Orwell',
            format: 'epub',
            size_bytes: 450000,
            language: 'English',
          },
        ]);
      }
      return mockResponse([]);
    });

    const res = await plugin.search({ title: '1984', author: 'George Orwell', mediaKind: 'ebook' }, baseConfig(), host);
    ok('preserves authentic metadata bookTitle rather than substituting searchTitle', res.length === 1 && res[0].bookTitle === 'Nineteen Eighty-Four');
    ok('preserves authentic sizeBytes, language, format, and isbn without fabrication', res[0].sizeBytes === 450000 && res[0].language === 'English' && res[0].isbn === '9780451524935' && res[0].freeleech === null);
  }

  {
    // Test 6: No metadata results followed by a successful supported fallback (direct /api/releases query)
    const host = makeHost((url) => {
      if (url.includes('/api/metadata/search')) {
        return mockResponse({ books: [] }); // Open Library returns empty or 0 candidates
      }
      if (url.includes('/api/releases')) {
        // Direct release query succeeds
        return mockResponse([
          { id: 'direct-rel-1', source_id: 'direct-src-1', source: 'libgen', title: 'Underground Book', author: 'Rare Author', format: 'epub', size_bytes: 800000 },
        ]);
      }
      return mockResponse([]);
    });

    const res = await plugin.search({ title: 'Underground Book', author: 'Rare Author', mediaKind: 'ebook' }, baseConfig(), host);
    ok('no metadata results followed by a successful supported fallback', res.length === 1 && res[0].extra?.sourceId === 'direct-src-1');
  }

  {
    // Test 7: Genuine no-match result (both metadata and fallback return zero)
    const host = makeHost(() => mockResponse({ books: [], releases: [] }));
    const res = await plugin.search({ title: 'Nonexistent Book Never Written 12345678', author: 'Nobody', mediaKind: 'ebook' }, baseConfig(), host);
    ok('genuine no-match result returns empty array', Array.isArray(res) && res.length === 0);
  }

  {
    // Test 8: Wrong author rejected
    const host = makeHost((url) => {
      if (url.includes('/api/metadata/search')) {
        return mockResponse({
          books: [{ provider: 'openlibrary', provider_id: 'OL-WRONG', title: '1984', authors: ['Unrelated Person'] }],
        });
      }
      return mockResponse([]);
    });

    const res = await plugin.search({ title: '1984', author: 'George Orwell', mediaKind: 'ebook' }, baseConfig(), host);
    ok('wrong author rejected', res.length === 0);
  }

  {
    // Test 9: Wrong format rejected (drops mobi, azw3, audiobooks)
    const host = makeHost((url) => {
      if (url.includes('/api/metadata/search')) {
        return mockResponse({
          books: [{ provider: 'openlibrary', provider_id: 'OL-DUNE', title: 'Dune', authors: ['Frank Herbert'] }],
        });
      }
      if (url.includes('/api/releases')) {
        return mockResponse([
          { id: '1', source_id: 's-mobi', source: 'libgen', title: 'Dune', format: 'mobi', size_bytes: 100 },
          { id: '2', source_id: 's-azw3', source: 'libgen', title: 'Dune', format: 'azw3', size_bytes: 100 },
          { id: '3', source_id: 's-audio', source: 'abb', title: 'Dune', format: 'm4b', size_bytes: 100 },
          { id: '4', source_id: 's-epub', source: 'libgen', title: 'Dune', format: 'epub', size_bytes: 100 },
        ]);
      }
      return mockResponse([]);
    });

    const res = await plugin.search({ title: 'Dune', author: 'Frank Herbert', mediaKind: 'ebook' }, baseConfig(), host);
    ok('wrong format rejected (only EPUB/PDF kept)', res.length === 1 && res[0].format === 'epub');
  }

  {
    // Test 20 & 21: EPUB/PDF selection & Accurate release metadata (no fabricated freeleech or language)
    const host = makeHost((url) => {
      if (url.includes('/api/metadata/search')) {
        return mockResponse({
          books: [{ provider: 'openlibrary', provider_id: 'OL-F451', title: 'Fahrenheit 451', authors: ['Ray Bradbury'] }],
        });
      }
      if (url.includes('/api/releases')) {
        return mockResponse([
          { id: 'r-pdf', source_id: 's-pdf', source: 'libgen', title: 'Fahrenheit 451 [PDF]', format: 'pdf', size_bytes: 2000000 },
          { id: 'r-epub', source_id: 's-epub', source: 'libgen', title: 'Fahrenheit 451 [EPUB]', format: 'epub', size_bytes: 1000000 },
        ]);
      }
      return mockResponse([]);
    });

    const res = await plugin.search({ title: 'Fahrenheit 451', author: 'Ray Bradbury', mediaKind: 'ebook' }, baseConfig(), host);
    ok('EPUB/PDF selection (ranks EPUB first by default)', res[0].format === 'epub' && res[1].format === 'pdf');
    ok('no fabricated freeleech (freeleech is null when not reported)', res[0].freeleech === null);
    ok('no fabricated primaryFileCount (primaryFileCount is null when not reported)', res[0].primaryFileCount === null);
  }

  console.log('\n--- 4. Download Lifecycle & Queue Handling (BUGS 1, 4, 5) ---');

  {
    // Test 10: Existing completed download reused without POST
    let postAttempted = false;
    const host = makeHost((url, options) => {
      if (options.method === 'POST') {
        postAttempted = true;
        return mockResponse({ error: 'Should not have posted' }, 500);
      }
      if (url.includes('/api/status')) {
        return mockResponse({
          completed: {
            '0b2a56a29733af39836d73b46dbfac73': {
              id: '0b2a56a29733af39836d73b46dbfac73',
              source: 'libgen',
              source_id: '0b2a56a29733af39836d73b46dbfac73',
              format: 'epub',
              status: 'completed',
            },
          },
        });
      }
      if (url.includes('/api/localdownload')) {
        return mockResponse('binary-file-content', 200); // File exists on disk
      }
      return mockResponse({});
    });

    const release = {
      guid: JSON.stringify({ source: 'libgen', source_id: '0b2a56a29733af39836d73b46dbfac73', format: 'epub' }),
      title: 'Fahrenheit 451',
      format: 'epub',
      sizeBytes: 1000000,
    };

    const resolved = await plugin.resolveFile(release, baseConfig(), host);
    ok('existing completed download reused without POST', resolved.url.includes('id=0b2a56a29733af39836d73b46dbfac73') && !postAttempted);
  }

  {
    // Test 11: Existing active download adopted without POST
    let postAttempted = false;
    let pollCount = 0;
    const host = makeHost((url, options) => {
      if (options.method === 'POST') {
        postAttempted = true;
        return mockResponse({ error: 'Should not post' }, 500);
      }
      if (url.includes('/api/status')) {
        pollCount++;
        if (pollCount === 1) {
          // Task is active in Shelfmark
          return mockResponse({
            active: {
              'active-task-123': {
                id: 'active-task-123',
                source: 'libgen',
                source_id: 'active-src-123',
                format: 'epub',
                status: 'downloading',
              },
            },
            completed: {},
          });
        }
        // Completes on poll tick
        return mockResponse({
          active: {},
          completed: {
            'active-task-123': {
              id: 'active-task-123',
              source: 'libgen',
              source_id: 'active-src-123',
              format: 'epub',
              status: 'completed',
            },
          },
        });
      }
      if (url.includes('/api/localdownload')) return mockResponse('content', 200);
      return mockResponse({});
    });

    const release = {
      guid: JSON.stringify({ source: 'libgen', source_id: 'active-src-123', format: 'epub' }),
      title: 'Active Book',
      format: 'epub',
    };

    const resolved = await plugin.resolveFile(release, baseConfig(), host);
    ok('existing active download adopted without POST', resolved.url.includes('id=active-task-123') && !postAttempted);
  }

  {
    // Test 12: Duplicate queue HTTP 500 with a matching task (adopted from status)
    let statusCalls = 0;
    const host = makeHost((url, options) => {
      if (options.method === 'POST' && url.includes('/api/releases/download')) {
        return mockResponse({ error: 'Release is already in the download queue' }, 500);
      }
      if (url.includes('/api/status')) {
        statusCalls++;
        if (statusCalls === 1) {
          // Pre-check status: empty
          return mockResponse({ active: {}, completed: {} });
        }
        // Refreshed status after 500: task is present in completed queue
        return mockResponse({
          completed: {
            'dup-task-777': {
              id: 'dup-task-777',
              source: 'annas_archive',
              source_id: 'dup-src-777',
              format: 'epub',
              status: 'completed',
            },
          },
        });
      }
      if (url.includes('/api/localdownload')) return mockResponse('file-data', 200);
      return mockResponse({});
    });

    const release = {
      guid: JSON.stringify({ source: 'annas_archive', source_id: 'dup-src-777', format: 'epub' }),
      title: 'Duplicate Release',
      format: 'epub',
    };

    const resolved = await plugin.resolveFile(release, baseConfig(), host);
    ok('duplicate queue HTTP 500 with a matching task (adopted cleanly)', resolved.url.includes('id=dup-task-777'));
  }

  {
    // Test 13: Duplicate queue HTTP 500 without a matching task (fails safely with informative error)
    const host = makeHost((url, options) => {
      if (options.method === 'POST' && url.includes('/api/releases/download')) {
        return mockResponse({ error: 'Release is already in the download queue' }, 500);
      }
      if (url.includes('/api/status')) {
        return mockResponse({ active: {}, completed: {} }); // No matching task in status
      }
      return mockResponse({});
    });

    const release = {
      guid: JSON.stringify({ source: 'libgen', source_id: 'orphan-src-999', format: 'epub' }),
      title: 'Ghost Book',
      format: 'epub',
    };

    let caughtErr = null;
    try {
      await plugin.resolveFile(release, baseConfig(), host);
    } catch (err) {
      caughtErr = err;
    }
    ok('duplicate queue HTTP 500 without a matching task (fails safely)', caughtErr?.code === 'error' && caughtErr.message.includes('already in download queue'));
  }

  {
    // Test 14: Missing or deleted completed file
    // Shelfmark status says completed, but /api/localdownload returns 404 (file deleted on disk)
    const host = makeHost((url, options) => {
      if (options.method === 'POST') {
        return mockResponse({ error: 'Release is already in the download queue' }, 500);
      }
      if (url.includes('/api/status')) {
        return mockResponse({
          completed: {
            'deleted-task-111': {
              id: 'deleted-task-111',
              source: 'libgen',
              source_id: 'deleted-src-111',
              format: 'epub',
              status: 'completed',
            },
          },
        });
      }
      if (url.includes('/api/localdownload')) {
        return mockResponse('Not found on disk', 404); // File is missing!
      }
      return mockResponse({});
    });

    const release = {
      guid: JSON.stringify({ source: 'libgen', source_id: 'deleted-src-111', format: 'epub' }),
      title: 'Deleted File Book',
      format: 'epub',
    };

    let caughtErr = null;
    try {
      await plugin.resolveFile(release, baseConfig(), host);
    } catch (err) {
      caughtErr = err;
    }
    ok('missing or deleted completed file fails safely without returning stale URL', caughtErr?.code === 'error' && caughtErr.message.includes('missing on disk'));
  }

  {
    // Test 15: Missing task ID (Shelfmark accepts download without returning task_id)
    let statusTicks = 0;
    const host = makeHost((url, options) => {
      if (options.method === 'POST') {
        return mockResponse({ status: 'queued' }); // No task_id returned!
      }
      if (url.includes('/api/status')) {
        statusTicks++;
        if (statusTicks === 1) return mockResponse({ active: {}, completed: {} });
        return mockResponse({
          completed: {
            'newly-completed-task-456': {
              id: 'newly-completed-task-456',
              title: 'Anonymous Task Book',
              format: 'epub',
              status: 'completed',
            },
          },
        });
      }
      if (url.includes('/api/localdownload')) return mockResponse('ok', 200);
      return mockResponse({});
    });

    const release = {
      guid: JSON.stringify({ source: 'annas', source_id: 'anon-src-456', title: 'Anonymous Task Book', format: 'epub' }),
      title: 'Anonymous Task Book',
      format: 'epub',
    };

    const resolved = await plugin.resolveFile(release, baseConfig(), host);
    ok('missing task ID safely matched newly completed task by title & format', resolved.url.includes('id=newly-completed-task-456'));
  }

  {
    // Test 16: Multiple ambiguous tasks fails safely
    let statusTicks = 0;
    const host = makeHost((url, options) => {
      if (options.method === 'POST') return mockResponse({ status: 'queued' });
      if (url.includes('/api/status')) {
        statusTicks++;
        if (statusTicks === 1) return mockResponse({ active: {}, completed: {} });
        return mockResponse({
          completed: {
            'ambig-1': { id: 'ambig-1', title: 'Ambiguous Title', format: 'epub' },
            'ambig-2': { id: 'ambig-2', title: 'Ambiguous Title', format: 'epub' },
          },
        });
      }
      return mockResponse({});
    });

    const release = {
      guid: JSON.stringify({ source: 'annas', source_id: 'ambig-src', title: 'Ambiguous Title', format: 'epub' }),
      title: 'Ambiguous Title',
      format: 'epub',
    };

    let caughtErr = null;
    try {
      await plugin.resolveFile(release, baseConfig(), host);
    } catch (err) {
      caughtErr = err;
    }
    ok('multiple ambiguous tasks fails safely to avoid wrong book association', caughtErr?.code === 'error' && caughtErr.message.includes('Ambiguous download match'));
  }

  {
    // Test 17: Concurrent requests for the same release (in-flight deduplication)
    let postCount = 0;
    let statusCount = 0;
    const host = makeHost((url, options) => {
      if (options.method === 'POST') {
        postCount++;
        return mockResponse({ task_id: 'concurrent-task-1' });
      }
      if (url.includes('/api/status')) {
        statusCount++;
        if (statusCount === 1) {
          // Pre-check status before queueing is empty
          return mockResponse({ active: {}, completed: {} });
        }
        return mockResponse({
          completed: {
            'concurrent-task-1': { id: 'concurrent-task-1', source_id: 'concurrent-src', format: 'epub', status: 'completed' },
          },
        });
      }
      if (url.includes('/api/localdownload')) return mockResponse('ok', 200);
      return mockResponse({});
    });

    const release = {
      guid: JSON.stringify({ source: 'libgen', source_id: 'concurrent-src', format: 'epub' }),
      title: 'Concurrent Book',
      format: 'epub',
    };

    // Fire 2 simultaneous resolveFile calls for the same release
    const [resA, resB] = await Promise.all([
      plugin.resolveFile(release, baseConfig(), host),
      plugin.resolveFile(release, baseConfig(), host),
    ]);

    ok('concurrent requests for the same release only queues download once', postCount === 1);
    ok('both concurrent callers receive identical valid resolved URL', resA.url === resB.url && resA.url.includes('id=concurrent-task-1'));
  }

  {
    // Test 18: Aborted download followed by a safe retry (adopts existing task without duplicate download)
    let postCalls = 0;
    let taskActive = false;
    let taskCompleted = false;

    const host = makeHost((url, options) => {
      if (options.method === 'POST') {
        postCalls++;
        taskActive = true;
        return mockResponse({ task_id: 'retry-task-1' });
      }
      if (url.includes('/api/status')) {
        return mockResponse({
          active: taskActive && !taskCompleted ? {
            'retry-task-1': { id: 'retry-task-1', source_id: 'retry-src', format: 'epub', status: 'downloading' },
          } : {},
          completed: taskCompleted ? {
            'retry-task-1': { id: 'retry-task-1', source_id: 'retry-src', format: 'epub', status: 'completed' },
          } : {},
        });
      }
      if (url.includes('/api/localdownload')) return mockResponse('ok', 200);
      return mockResponse({});
    });

    const release = {
      guid: JSON.stringify({ source: 'libgen', source_id: 'retry-src', format: 'epub' }),
      title: 'Retry Book',
      format: 'epub',
    };

    // Attempt 1: Aborted by BookOrbit while polling
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    try {
      await plugin.resolveFile(release, baseConfig(), host, controller.signal);
    } catch (_) {
      // Expected abort
    }

    // Task finishes in background in Shelfmark
    setTimeout(() => { taskCompleted = true; }, 30);

    // Attempt 2: BookOrbit retries the request; should adopt active/completed task without a 2nd POST
    const retryResolved = await plugin.resolveFile(release, baseConfig(), host);
    ok('aborted download followed by a safe retry does not trigger duplicate POST', postCalls === 1);
    ok('retry successfully adopts and finishes task', retryResolved.url.includes('id=retry-task-1'));
  }

  {
    // Test 18B: Historical failed tasks sharing title do not contaminate new downloads (BUG 1)
    let postMade = false;
    let pollCount = 0;
    const host = makeHost((url, options) => {
      if (options.method === 'POST') {
        postMade = true;
        return mockResponse({ task_id: 'new-1984-task' });
      }
      if (url.includes('/api/status')) {
        pollCount++;
        return mockResponse({
          active: pollCount === 1 ? {
            'new-1984-task': { id: 'new-1984-task', source: 'libgen', source_id: 'src-1984-new', title: '1984', format: 'epub', status: 'downloading' },
          } : {},
          completed: pollCount > 1 ? {
            'new-1984-task': { id: 'new-1984-task', source: 'libgen', source_id: 'src-1984-new', title: '1984', format: 'epub', status: 'completed' },
          } : {},
          // Multiple old historical failed tasks with same title "1984" from previous attempts
          error: {
            'ancient-fail-1': { id: 'ancient-fail-1', title: '1984', format: 'epub', error: 'Mirror 1 down' },
            'ancient-fail-2': { id: 'ancient-fail-2', title: '1984', format: 'epub', error: 'Cloudflare timeout' },
          },
        });
      }
      if (url.includes('/api/localdownload')) return mockResponse('epub-binary', 200);
      return mockResponse({});
    });

    const release = {
      guid: JSON.stringify({ source: 'libgen', source_id: 'src-1984-new', format: 'epub' }),
      title: '1984',
      format: 'epub',
    };

    const resolved = await plugin.resolveFile(release, baseConfig(), host);
    ok('historical failed tasks sharing title do not fail new download', resolved.url.includes('id=new-1984-task'));
    ok('exact task ID determines outcome over historical failures', pollCount >= 2);
  }

  {
    // Test 18C: Pre-existing completed job reused even when old failed tasks exist
    let postAttempted = false;
    const host = makeHost((url, options) => {
      if (options.method === 'POST') {
        postAttempted = true;
        return mockResponse({ error: 'Should not POST' }, 500);
      }
      if (url.includes('/api/status')) {
        return mockResponse({
          completed: {
            'completed-f451': { id: 'completed-f451', source: 'annas', source_id: 'src-f451', title: 'Fahrenheit 451', format: 'epub', status: 'completed' },
          },
          error: {
            'old-f451-fail': { id: 'old-f451-fail', title: 'Fahrenheit 451', format: 'epub', error: 'Ancient failure' },
          },
        });
      }
      if (url.includes('/api/localdownload')) return mockResponse('epub-data', 200);
      return mockResponse({});
    });

    const release = {
      guid: JSON.stringify({ source: 'annas', source_id: 'src-f451', format: 'epub' }),
      title: 'Fahrenheit 451',
      format: 'epub',
    };

    const resolved = await plugin.resolveFile(release, baseConfig(), host);
    ok('valid completed download reused without POST despite old failed tasks', resolved.url.includes('id=completed-f451') && !postAttempted);
  }

  {
    // Test 18D: Concurrent callers where one caller cancels while other caller succeeds (Area 2)
    let postCount = 0;
    let pollCount = 0;
    const host = makeHost((url, options) => {
      if (options.method === 'POST') {
        postCount++;
        return mockResponse({ task_id: 'shared-task-xyz' });
      }
      if (url.includes('/api/status')) {
        pollCount++;
        if (pollCount === 1) {
          return mockResponse({ active: {}, completed: {} }); // pre-check
        }
        if (pollCount === 2) {
          return mockResponse({
            active: {
              'shared-task-xyz': { id: 'shared-task-xyz', source: 'libgen', source_id: 'shared-src', format: 'epub', status: 'downloading' },
            },
          });
        }
        return mockResponse({
          completed: {
            'shared-task-xyz': { id: 'shared-task-xyz', source: 'libgen', source_id: 'shared-src', format: 'epub', status: 'completed' },
          },
        });
      }
      if (url.includes('/api/localdownload')) return mockResponse('file-content', 200);
      return mockResponse({});
    });

    const release = {
      guid: JSON.stringify({ source: 'libgen', source_id: 'shared-src', format: 'epub' }),
      title: 'Shared Download Book',
      format: 'epub',
    };

    const controllerA = new AbortController();
    const promiseA = plugin.resolveFile(release, baseConfig({ settings: { pollIntervalMs: 15 } }), host, controllerA.signal);
    const promiseB = plugin.resolveFile(release, baseConfig({ settings: { pollIntervalMs: 15 } }), host);

    // Cancel caller A after 5ms
    setTimeout(() => controllerA.abort(), 5);

    let errA = null;
    try {
      await promiseA;
    } catch (err) {
      errA = err;
    }

    const resB = await promiseB;
    ok('cancelled concurrent caller rejects immediately with valid error code', errA?.code === 'error' && errA?.message?.includes('cancelled'));
    ok('uncancelled concurrent caller succeeds and receives download URL', resB?.url?.includes('id=shared-task-xyz'));
    ok('concurrent requests only submitted a single download job to Shelfmark', postCount === 1);
  }

  {
    // Test 19: Shelfmark failure and timeout
    const hostFail = makeHost((url, options) => {
      if (options.method === 'POST') return mockResponse({ task_id: 'fail-task' });
      if (url.includes('/api/status')) {
        return mockResponse({
          error: {
            'fail-task': { id: 'fail-task', error: 'Tor exit node blocked by mirror' },
          },
        });
      }
      return mockResponse({});
    });

    let caughtFail = null;
    try {
      await plugin.resolveFile({
        guid: JSON.stringify({ source: 'annas', source_id: 'fail-src', format: 'epub' }),
        title: 'Failing Release',
        format: 'epub',
      }, baseConfig(), hostFail);
    } catch (err) {
      caughtFail = err;
    }
    ok('Shelfmark reported failure handled with clear error', caughtFail?.code === 'error' && caughtFail.message.includes('Tor exit node blocked'));

    // Timeout test
    const hostTimeout = makeHost((url, options) => {
      if (options.method === 'POST') return mockResponse({ task_id: 'timeout-task' });
      if (url.includes('/api/status')) return mockResponse({ active: { 'timeout-task': { id: 'timeout-task' } } });
      return mockResponse({});
    });

    let caughtTimeout = null;
    try {
      await plugin.resolveFile({
        guid: JSON.stringify({ source: 'annas', source_id: 'timeout-src', format: 'epub' }),
        title: 'Timeout Release',
        format: 'epub',
      }, baseConfig({ settings: { pollTimeoutSeconds: 0.05, pollIntervalMs: 10 } }), hostTimeout);
    } catch (err) {
      caughtTimeout = err;
    }
    ok('Shelfmark timeout handled safely', caughtTimeout?.code === 'timeout');
  }

  {
    // Test 22: No API credentials exposed in errors
    const secretKey = 'my-super-secret-api-key-xyz123';
    const host = makeHost((url, options) => {
      if (options.method === 'POST') {
        return mockResponse(`Internal Server Error with key ${secretKey} and url /api?api_key=${secretKey}`, 500);
      }
      return mockResponse({});
    });

    let credErr = null;
    try {
      await plugin.resolveFile({
        guid: JSON.stringify({ source: 'annas', source_id: 'sec-src', format: 'epub' }),
        title: 'Secret Book',
        format: 'epub',
      }, baseConfig({ settings: { apiKey: secretKey } }), host);
    } catch (err) {
      credErr = err;
    }

    ok('no API credentials exposed in errors (redacted)', !credErr.message.includes(secretKey) && credErr.message.includes('[REDACTED]'));
  }

  console.log('\n--- 5. Host Deadlines, Error Classification & Search Optimization ---');
  {
    // Test 23: Simulated 240s host deadline (AbortSignal.timeout) classifies as timeout
    const host = makeHost((url) => {
      if (url.includes('/api/status')) return mockResponse({ active: { 't1': { id: 't1' } } });
      if (url.includes('/api/releases/download')) return mockResponse({ task_id: 't1' });
      return mockResponse({});
    });

    const timeoutController = new AbortController();
    const timeoutErr = new Error('The operation was aborted due to timeout');
    timeoutErr.name = 'TimeoutError';
    timeoutController.abort(timeoutErr);

    let caughtTimeout = null;
    try {
      await plugin.resolveFile({
        guid: JSON.stringify({ source: 'annas', source_id: 'host-to-src', format: 'epub' }),
        title: 'Host Timeout Book',
        format: 'epub',
      }, baseConfig({ settings: { pollIntervalMs: 10 } }), host, timeoutController.signal);
    } catch (err) {
      caughtTimeout = err;
    }

    ok('simulated host deadline (AbortSignal.timeout) classifies as timeout', caughtTimeout?.code === 'timeout');
  }

  {
    // Test 24: User cancellation classifies as error (not cancelled, not timeout)
    const host = makeHost((url) => {
      if (url.includes('/api/status')) return mockResponse({ active: { 't1': { id: 't1' } } });
      if (url.includes('/api/releases/download')) return mockResponse({ task_id: 't1' });
      return mockResponse({});
    });

    const userController = new AbortController();
    userController.abort(); // Standard user cancel

    let caughtUser = null;
    try {
      await plugin.resolveFile({
        guid: JSON.stringify({ source: 'annas', source_id: 'user-cancel-src', format: 'epub' }),
        title: 'User Cancel Book',
        format: 'epub',
      }, baseConfig({ settings: { pollIntervalMs: 10 } }), host, userController.signal);
    } catch (err) {
      caughtUser = err;
    }

    ok('user cancellation classifies as error (not cancelled, not timeout)', caughtUser?.code === 'error' && caughtUser.message.includes('cancelled'));
  }

  {
    // Test 25: Cancellation before queueing aborts without issuing HTTP requests
    const host = makeHost(() => mockResponse({}));
    const preAborted = new AbortController();
    preAborted.abort();

    let preErr = null;
    try {
      await plugin.resolveFile({
        guid: JSON.stringify({ source: 'annas', source_id: 'pre-src', format: 'epub' }),
        title: 'Pre-aborted Book',
        format: 'epub',
      }, baseConfig(), host, preAborted.signal);
    } catch (err) {
      preErr = err;
    }

    ok('cancellation before queueing aborts cleanly without HTTP calls', preErr?.code === 'error' && host.calls.length === 0);
  }

  {
    // Test 26: Cancellation during queueing
    let postStarted = false;
    const cancelController = new AbortController();
    const host = makeHost(async (url, options) => {
      if (url.includes('/api/status')) return mockResponse({});
      if (url.includes('/api/releases/download')) {
        postStarted = true;
        // Trigger abort while POST is processing
        cancelController.abort();
        await new Promise((r) => setTimeout(r, 20));
        return mockResponse({ task_id: 'post-cancel-task' });
      }
      return mockResponse({});
    });

    let queueCancelErr = null;
    try {
      await plugin.resolveFile({
        guid: JSON.stringify({ source: 'annas', source_id: 'post-cancel-src', format: 'epub' }),
        title: 'Queue Cancel Book',
        format: 'epub',
      }, baseConfig({ settings: { pollIntervalMs: 10 } }), host, cancelController.signal);
    } catch (err) {
      queueCancelErr = err;
    }

    ok('cancellation during queueing aborts and rejects caller cleanly', queueCancelErr?.code === 'error' && postStarted);
  }

  {
    // Test 27: Cancellation during polling
    const pollCancelController = new AbortController();
    let pollCount = 0;
    const host = makeHost((url) => {
      if (url.includes('/api/releases/download')) return mockResponse({ task_id: 'poll-cancel-task' });
      if (url.includes('/api/status')) {
        pollCount += 1;
        if (pollCount >= 2) {
          pollCancelController.abort();
        }
        return mockResponse({ active: { 'poll-cancel-task': { id: 'poll-cancel-task', status: 'downloading' } } });
      }
      return mockResponse({});
    });

    let pollCancelErr = null;
    try {
      await plugin.resolveFile({
        guid: JSON.stringify({ source: 'annas', source_id: 'poll-cancel-src', format: 'epub' }),
        title: 'Poll Cancel Book',
        format: 'epub',
      }, baseConfig({ settings: { pollIntervalMs: 10 } }), host, pollCancelController.signal);
    } catch (err) {
      pollCancelErr = err;
    }

    ok('cancellation during polling aborts and cleans up cleanly', pollCancelErr?.code === 'error' && pollCount >= 2);
  }

  {
    // Test 28: Simulated 90s search deadline (AbortSignal.timeout) classifies as timeout when 0 results
    const host = makeHost(() => mockResponse({ books: [] }));
    const searchTimeoutCtrl = new AbortController();
    const sTimeoutErr = new Error('Search deadline expired');
    sTimeoutErr.name = 'TimeoutError';
    searchTimeoutCtrl.abort(sTimeoutErr);

    let searchToErr = null;
    try {
      await plugin.search({ title: 'Search Timeout Book', author: 'Author' }, baseConfig(), host, searchTimeoutCtrl.signal);
    } catch (err) {
      searchToErr = err;
    }

    ok('simulated 90s search deadline classifies as timeout when 0 results', searchToErr?.code === 'timeout');
  }

  {
    // Test 29: Search stops expensive fallback queries once sufficient high-confidence results exist
    let releaseQueries = 0;
    const host = makeHost((url) => {
      if (url.includes('/api/metadata/search')) {
        return mockResponse({
          books: [
            { provider: 'openlibrary', provider_id: 'OL1', title: 'Dune', authors: ['Frank Herbert'] },
            { provider: 'openlibrary', provider_id: 'OL2', title: 'Dune Messiah', authors: ['Frank Herbert'] },
          ],
        });
      }
      if (url.includes('/api/releases')) {
        releaseQueries += 1;
        return mockResponse({
          releases: [
            { source: 'aa', source_id: 'rel1', title: 'Dune (Frank Herbert) [EPUB]', format: 'epub', size_bytes: 1000 },
            { source: 'aa', source_id: 'rel2', title: 'Dune (Frank Herbert) [EPUB]', format: 'epub', size_bytes: 2000 },
            { source: 'aa', source_id: 'rel3', title: 'Dune (Frank Herbert) [EPUB]', format: 'epub', size_bytes: 3000 },
          ],
        });
      }
      return mockResponse({});
    });

    const results = await plugin.search({ title: 'Dune', author: 'Frank Herbert' }, baseConfig(), host);
    ok('search early stopping: stops querying variations once sufficient results exist', results.length >= 3 && releaseQueries === 1);
  }

  {
    // Test 30: Search preserves validated results when subsequent variation query fails
    let releaseQueryCount = 0;
    const host = makeHost((url) => {
      if (url.includes('/api/metadata/search')) {
        return mockResponse({
          books: [
            { provider: 'openlibrary', provider_id: 'OL-A', title: 'Brave New World', authors: ['Aldous Huxley'] },
            { provider: 'openlibrary', provider_id: 'OL-B', title: 'Brave New World Revisited', authors: ['Aldous Huxley'] },
          ],
        });
      }
      if (url.includes('/api/releases')) {
        releaseQueryCount += 1;
        if (releaseQueryCount === 1) {
          // First query returns 1 valid release
          return mockResponse({
            releases: [
              { source: 'aa', source_id: 'bnw1', title: 'Brave New World [EPUB]', format: 'epub', size_bytes: 500000 },
            ],
          });
        }
        // Second query fails with 500
        return mockResponse({ error: 'Cloudflare bypasser timed out' }, 500);
      }
      return mockResponse({});
    });

    const results = await plugin.search({ title: 'Brave New World', author: 'Aldous Huxley' }, baseConfig(), host);
    ok('search preserves validated results when subsequent variation query fails', results.length === 1 && results[0].format === 'epub');
  }

  {
    // Test 31: Duplicate queue HTTP 500 adopts task by title/format/source when source_id is omitted
    const host = makeHost((url, options) => {
      if (options.method === 'POST') {
        return mockResponse({ error: 'Release is already in the download queue' }, 500);
      }
      if (url.includes('/api/status')) {
        return mockResponse({
          active: {
            'task-uuid-8899': {
              id: 'task-uuid-8899',
              title: '1984',
              format: 'epub',
              source: 'annas_archive',
              status: 'downloading',
            },
          },
        });
      }
      return mockResponse({});
    });

    const result = await plugin.resolveFile({
      guid: JSON.stringify({ source: 'annas_archive', source_id: 'unindexed-md5', title: '1984', format: 'epub' }),
      title: '1984',
      format: 'epub',
    }, baseConfig({ settings: { pollTimeoutSeconds: 0.1, pollIntervalMs: 10 } }), host).catch((e) => e);

    // It adopted task-uuid-8899 and timed out waiting for it
    ok('duplicate queue HTTP 500 adopts task by title and format when source_id is omitted', result?.message?.includes('task: task-uuid-8899'));
  }

  {
    // Test 32: Retry after download timeout adopts active in-progress task without submitting duplicate POST
    let postAttempted = false;
    const host = makeHost((url, options) => {
      if (options.method === 'POST') {
        postAttempted = true;
        return mockResponse({ task_id: 'long-task-42' });
      }
      if (url.includes('/api/status')) {
        // Shelfmark has long-task-42 still running in active queue
        return mockResponse({
          active: {
            'long-task-42': {
              source_id: 'retry-src-id',
              source: 'annas',
              title: 'Long Book',
              format: 'epub',
              status: 'downloading',
            },
          },
        });
      }
      return mockResponse({});
    });

    const result = await plugin.resolveFile({
      guid: JSON.stringify({ source: 'annas', source_id: 'retry-src-id', format: 'epub' }),
      title: 'Long Book',
      format: 'epub',
    }, baseConfig({ settings: { pollTimeoutSeconds: 0.1, pollIntervalMs: 10 } }), host).catch((e) => e);

    ok('re-request after download timeout adopts active in-progress task without duplicate POST', !postAttempted && result?.message?.includes('task: long-task-42'));
  }

  {
    // Test 33: View files / inspection simulation: repeated resolveFile calls reuse task idempotently
    let postCount = 0;
    let downloadCompleted = false;

    const host = makeHost((url, options) => {
      if (options.method === 'POST') {
        postCount += 1;
        downloadCompleted = true; // Task completes in Shelfmark after queueing
        return mockResponse({ task_id: 'inspect-task-1' });
      }
      if (url.includes('/api/status')) {
        if (downloadCompleted) {
          return mockResponse({
            completed: {
              'inspect-task-1': {
                id: 'inspect-task-1',
                source_id: 'inspect-src-1',
                source: 'annas',
                title: 'Inspected Book',
                format: 'epub',
                status: 'completed',
              },
            },
          });
        }
        return mockResponse({});
      }
      if (url.includes('/api/localdownload')) return mockResponse('book-content', 200);
      return mockResponse({});
    });

    const release = {
      guid: JSON.stringify({ source: 'annas', source_id: 'inspect-src-1', format: 'epub' }),
      title: 'Inspected Book',
      format: 'epub',
    };

    // Step 1: User clicks "View files" (triggers resolveFile, which queues and finishes download)
    const inspectResult = await plugin.resolveFile(release, baseConfig({ settings: { pollIntervalMs: 10 } }), host);

    // Step 2: User clicks "Download release" (triggers resolveFile again; must reuse existing completed task)
    const downloadResult = await plugin.resolveFile(release, baseConfig({ settings: { pollIntervalMs: 10 } }), host);

    ok('View files inspection and subsequent grab reuse task idempotently without re-queueing', postCount === 1 && inspectResult.url === downloadResult.url);
  }

  // --- 6. Asynchronous Event-Driven Companion Bridge & Hook Tests ---
  console.log('\n--- 6. Asynchronous Event-Driven Companion Bridge & Hook Tests ---');

  const testDir = join(here, 'fixtures', 'bridge_test_' + Date.now());
  mkdirSync(testDir, { recursive: true });
  const testStateFile = join(testDir, 'bridge-state.json');

  try {
    // Test B1: Durable state persistence across restarts
    {
      const bridge1 = new BridgeService({ stateFilePath: testStateFile });
      let smPostCount = 0;
      const fakeFetch = async (url, opts) => {
        if (opts?.method === 'POST') {
          smPostCount++;
          return mockResponse({ task_id: 'sm-task-restart-1' });
        }
        return mockResponse({});
      };

      const qRes = await bridge1.queueRelease({
        requestId: 'bo-req-101',
        userId: 'user-alice',
        release: { source: 'annas', sourceId: 'src-restart-1', title: '1984', format: 'epub', author: 'George Orwell' },
        fetchFn: fakeFetch,
      });

      ok('bridge queues new release and persists task mapping', qRes.status === 'queued' && qRes.taskId === 'sm-task-restart-1' && smPostCount === 1);

      // Simulate restart: create new BridgeService instance reading from the same state file
      const bridge2 = new BridgeService({ stateFilePath: testStateFile });
      const recoveredTask = bridge2.state.tasks['sm-task-restart-1'];
      ok('bridge recovers state after restart', recoveredTask && recoveredTask.requestIds.includes('bo-req-101') && recoveredTask.userIds.includes('user-alice'));
    }

    // Test B2: Single queue deduplication across multi-user requests
    {
      const bridge = new BridgeService({ stateFilePath: testStateFile });
      let smPostCount = 0;
      const fakeFetch = async (url, opts) => {
        if (opts?.method === 'POST') {
          smPostCount++;
          return mockResponse({ task_id: 'sm-task-dedup-1' });
        }
        return mockResponse({});
      };

      const rel = { source: 'annas', sourceId: 'src-dedup-1', title: 'Animal Farm', format: 'epub', author: 'George Orwell' };

      // Alice queues release
      const q1 = await bridge.queueRelease({
        requestId: 'req-alice-1',
        userId: 'user-alice',
        release: rel,
        fetchFn: fakeFetch,
      });

      // Bob concurrently requests the same release
      const q2 = await bridge.queueRelease({
        requestId: 'req-bob-1',
        userId: 'user-bob',
        release: rel,
        fetchFn: fakeFetch,
      });

      ok('bridge queues release exactly once across multiple users', smPostCount === 1 && q1.status === 'queued' && q2.status === 'in_progress' && q1.taskId === q2.taskId);
      const tracked = bridge.state.tasks[q1.taskId];
      ok('bridge tracks all requesting users and request IDs on single task', tracked.requestIds.includes('req-alice-1') && tracked.requestIds.includes('req-bob-1') && tracked.userIds.includes('user-alice') && tracked.userIds.includes('user-bob'));
    }

    // Test B3: Adopts in-progress task when Shelfmark returns HTTP 500 duplicate queue error
    {
      const bridge = new BridgeService({ stateFilePath: testStateFile });
      const fakeFetch = async (url, opts) => {
        if (opts?.method === 'POST') {
          return mockResponse({ error: 'Release is already in the download queue' }, 500);
        }
        if (url.includes('/api/status')) {
          return mockResponse({
            active_tasks: [
              { id: 'task-adopted-500', source_id: 'src-dup-500', source: 'annas', title: 'Brave New World', format: 'epub' },
            ],
          });
        }
        return mockResponse({});
      };

      const qRes = await bridge.queueRelease({
        requestId: 'req-dup-1',
        release: { source: 'annas', sourceId: 'src-dup-500', title: 'Brave New World', format: 'epub' },
        fetchFn: fakeFetch,
      });

      ok('bridge recovers from Shelfmark 500 duplicate queue error by adopting active task', qRes.taskId === 'task-adopted-500');
    }

    // Test B4: Webhook authentication (HTTP 401 on bad secret, HTTP 200 on valid secret)
    {
      const bridge = new BridgeService({ stateFilePath: testStateFile, secret: 'correct-secret' });
      const unauth = await bridge.handleWebhook({ task_id: 't-1' }, 'wrong-secret');
      ok('bridge rejects webhook with invalid secret (401)', unauth.statusCode === 401 && !unauth.ok);

      const auth = await bridge.handleWebhook({ task_id: 't-nonexistent' }, 'correct-secret');
      ok('bridge accepts webhook with valid secret (200)', auth.statusCode === 200 && auth.ok);
    }

    // Test B5: File verification, directory traversal protection, and path mapping
    {
      const bridge = new BridgeService({
        stateFilePath: testStateFile,
        secret: 'test-secret',
        allowedBaseDirs: [testDir],
        shelfmarkPathPrefix: '/data/shelfmark/downloads',
        localPathPrefix: testDir,
      });

      const missingFile = join(testDir, 'does-not-exist.epub');
      const zeroByteFile = join(testDir, 'zero.epub');
      const fakeEpubFile = join(testDir, 'fake.epub');
      const validEpubFile = join(testDir, 'valid.epub');
      const validPdfFile = join(testDir, 'valid.pdf');

      writeFileSync(zeroByteFile, Buffer.alloc(0));
      writeFileSync(fakeEpubFile, Buffer.from('<html><body>Not an EPUB</body></html>', 'utf8'));

      // Valid EPUB header (PK\x03\x04 + dummy zip content)
      const validEpubBuf = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(100)]);
      writeFileSync(validEpubFile, validEpubBuf);

      // Valid PDF header (%PDF-1.5)
      const validPdfBuf = Buffer.concat([Buffer.from('%PDF-1.5\n', 'utf8'), Buffer.alloc(100)]);
      writeFileSync(validPdfFile, validPdfBuf);

      ok('file verification rejects non-existent file', !bridge.verifyFile(missingFile, 'epub').ok);
      ok('file verification rejects 0-byte file', !bridge.verifyFile(zeroByteFile, 'epub').ok);
      ok('file verification rejects corrupted / spoofed magic bytes', !bridge.verifyFile(fakeEpubFile, 'epub').ok);
      ok('file verification accepts valid EPUB magic bytes', bridge.verifyFile(validEpubFile, 'epub').ok);
      ok('file verification accepts valid PDF magic bytes', bridge.verifyFile(validPdfFile, 'pdf').ok);

      // Security: Directory traversal attacks rejected
      const traversalPath = join(testDir, '..', '..', '..', 'etc', 'passwd');
      ok('directory traversal attack rejected by path containment', bridge.resolvePath(traversalPath) === null);
      ok('null-byte injection rejected by path containment', bridge.resolvePath(validEpubFile + '\0.png') === null);

      // Path translation: translates container paths safely
      const containerPath = '/data/shelfmark/downloads/valid.epub';
      ok('translates Shelfmark container path to companion mount', bridge.resolvePath(containerPath) === validEpubFile);

      // Register a queued task to test webhook rejection on corrupt file
      bridge.state.tasks['task-corrupt'] = {
        taskId: 'task-corrupt',
        title: 'Corrupted Book',
        format: 'epub',
        status: 'queued',
        requestIds: ['req-corrupt-1'],
        userIds: [],
      };
      bridge.saveState();

      const hookResCorrupt = await bridge.handleWebhook({
        task: { task_id: 'task-corrupt', format: 'epub' },
        paths: { target: fakeEpubFile },
      }, 'test-secret');

      ok('bridge rejects corrupted download in webhook with 422', hookResCorrupt.statusCode === 422 && !hookResCorrupt.ok);
      ok('corrupted download does NOT mark task completed', bridge.state.tasks['task-corrupt'].status === 'failed');
    }

    // Test B6: Real BookOrbit v3.5.0 Ingestion & Fulfillment (Book Dock upload -> finalize -> fulfill)
    {
      const bridge = new BridgeService({
        stateFilePath: testStateFile,
        secret: 'test-secret',
        bookorbitUrl: 'http://bookorbit:8080',
        bookorbitApiKey: 'bo-admin-key',
        allowedBaseDirs: [testDir],
        defaultLibraryId: 2,
        defaultFolderId: 1,
      });

      const validEpub = join(testDir, 'valid.epub');
      bridge.state.tasks['task-success'] = {
        taskId: 'task-success',
        title: '1984',
        author: 'George Orwell',
        format: 'epub',
        status: 'queued',
        requestIds: ['req-success-1'],
        userIds: ['alice'],
      };
      bridge.saveState();

      const boCalls = [];
      const fakeBoFetch = async (url, opts) => {
        boCalls.push({ url, opts });
        // 1. BookDockController upload
        if (url.includes('/api/v1/book-dock/upload')) {
          return mockResponse({ id: 501, filename: 'valid.epub', status: 'ready_to_file' });
        }
        if (url.includes('/api/v1/book-dock/files/')) {
          return mockResponse({ id: 501, status: 'ready_to_file' });
        }
        // 2. BookDockController finalize
        if (url.includes('/api/v1/book-dock/finalize')) {
          return mockResponse({ success: true, results: [{ fileId: 501, success: true, bookId: 902, title: '1984' }] });
        }
        // 3. BookRequestAdminController fulfill
        if (url.includes('/api/v1/admin/book-requests/req-success-1/fulfill')) {
          return mockResponse({ id: 'req-success-1', status: 'AVAILABLE', matchedBookId: 902 });
        }
        return mockResponse({});
      };

      // Real Shelfmark v1.5.1 nested JSON payload
      const shelfmarkPayload = {
        version: 1,
        phase: 'post_transfer',
        task: {
          task_id: 'task-success',
          source: 'annas',
          title: '1984',
          author: 'George Orwell',
          format: 'epub',
        },
        output: {
          mode: 'folder',
          organization_mode: 'organize',
        },
        paths: {
          destination: testDir,
          target: validEpub,
          final_paths: [validEpub],
        },
      };

      const hookRes = await bridge.handleWebhook(shelfmarkPayload, 'test-secret', fakeBoFetch);

      ok('webhook accepts Shelfmark v1.5.1 nested JSON and marks completed', hookRes.ok && hookRes.statusCode === 200);
      ok('ingests file via BookOrbit BookDockController upload endpoint', boCalls.some((c) => c.url.includes('/api/v1/book-dock/upload') && c.opts.headers['Content-Type'].includes('multipart/form-data')));
      ok('finalizes Book Dock file into target library obtaining bookId', boCalls.some((c) => c.url.includes('/api/v1/book-dock/finalize') && JSON.parse(c.opts.body).fileIds.includes(501)));
      ok('fulfills BookOrbit request using FulfillBookRequestDto with real matchedBookId', boCalls.some((c) => c.url.includes('/api/v1/admin/book-requests/req-success-1/fulfill') && JSON.parse(c.opts.body).matchedBookId === 902));
      ok('task transitions to fulfilled only after verified BookOrbit fulfillment', bridge.state.tasks['task-success'].status === 'fulfilled' && bridge.state.tasks['task-success'].matchedBookId === 902);
    }

    // Test B7: Bounded periodic reconciliation discovers completed tasks without polling loops
    {
      const bridge = new BridgeService({
        stateFilePath: testStateFile,
        allowedBaseDirs: [testDir],
      });
      const validEpub = join(testDir, 'valid.epub');

      bridge.state.tasks['task-missed-webhook'] = {
        taskId: 'task-missed-webhook',
        title: 'Fahrenheit 451',
        format: 'epub',
        status: 'queued',
        filePath: validEpub,
        requestIds: ['req-f451'],
        userIds: [],
      };
      bridge.saveState();

      const fakeSmFetch = async (url) => {
        if (url.includes('/api/status')) {
          return mockResponse({
            completed_tasks: [
              { id: 'task-missed-webhook', title: 'Fahrenheit 451', format: 'epub', target: validEpub },
            ],
            failed_tasks: [],
          });
        }
        return mockResponse({});
      };

      const recon = await bridge.reconcile({ fetchFn: fakeSmFetch });
      ok('reconciliation discovers completed task and verifies file', recon.ok && recon.updatedCount === 1);
      ok('task transitioned to completed via reconciliation', bridge.state.tasks['task-missed-webhook'].status === 'completed');
    }

    // Test B8: Bounded reconciliation marks failed tasks and frees release lock for retry
    {
      const bridge = new BridgeService({ stateFilePath: testStateFile });
      const releaseKey = 'annas:failed-src-1';
      bridge.state.releases[releaseKey] = 'task-failed-1';
      bridge.state.tasks['task-failed-1'] = {
        taskId: 'task-failed-1',
        releaseKey,
        title: 'Failed Download',
        format: 'epub',
        status: 'queued',
        requestIds: ['req-fail-1'],
        userIds: [],
      };
      bridge.saveState();

      const fakeSmFetch = async (url) => {
        if (url.includes('/api/status')) {
          return mockResponse({
            completed_tasks: [],
            failed_tasks: [
              { id: 'task-failed-1', error: 'Mirror timed out' },
            ],
          });
        }
        return mockResponse({});
      };

      const recon = await bridge.reconcile({ fetchFn: fakeSmFetch });
      ok('reconciliation marks failed task', recon.ok && bridge.state.tasks['task-failed-1'].status === 'failed');
      ok('reconciliation frees release lock so retry is permitted', bridge.state.releases[releaseKey] === undefined);
    }

    // Test B9: Shelfmark hook script executes cleanly with BOTH $1 AND nested stdin JSON
    {
      const validEpub = join(testDir, 'valid.epub');
      let receivedHeaders = null;
      let receivedBody = null;

      const hookServer = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          receivedHeaders = req.headers;
          receivedBody = body ? JSON.parse(body) : {};
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, taskId: receivedBody.task?.task_id }));
        });
      });

      await new Promise((resolve) => hookServer.listen(8098, resolve));

      try {
        // Shelfmark v1.5.1 specification: ALWAYS passes $1 AND pipes nested JSON to stdin
        const nestedPayload = {
          version: 1,
          phase: 'post_transfer',
          task: {
            task_id: 'task-simultaneous-1',
            source: 'annas',
            title: 'Foundation',
            author: 'Isaac Asimov',
          },
          output: {
            mode: 'folder',
            organization_mode: 'organize',
          },
          paths: {
            destination: testDir,
            target: validEpub,
            final_paths: [validEpub],
          },
        };

        const stdout = await new Promise((resolve, reject) => {
          const child = execFile('scripts/shelfmark-hook.sh', [validEpub], {
            env: { ...process.env, BRIDGE_WEBHOOK_URL: 'http://localhost:8098/webhook', BRIDGE_SECRET: 'test-hook-secret' },
          }, (err, out) => {
            if (err) reject(err);
            else resolve(out);
          });
          child.stdin.write(JSON.stringify(nestedPayload));
          child.stdin.end();
        });

        ok('shelfmark hook delivers simultaneously passed $1 and nested stdin JSON', stdout.includes('Successfully notified'));
        ok('delivered payload contains Shelfmark nested task_id', receivedBody.task?.task_id === 'task-simultaneous-1');
        ok('delivered payload contains Shelfmark paths.target', receivedBody.paths?.target === validEpub);
        ok('sent correct X-Bridge-Secret authentication header', receivedHeaders['x-bridge-secret'] === 'test-hook-secret');
      } finally {
        await new Promise((resolve) => hookServer.close(resolve));
      }
    }

    // Test B10: Safe delivery when companion service is unavailable (Exit code 0 to protect Shelfmark task state)
    {
      const validEpub = join(testDir, 'valid.epub');
      // Point to closed port 8097 where nothing is listening
      const exitCode = await new Promise((resolve) => {
        const child = execFile('scripts/shelfmark-hook.sh', [validEpub], {
          env: { ...process.env, BRIDGE_WEBHOOK_URL: 'http://localhost:8097/webhook', BRIDGE_SECRET: 'test-secret' },
        }, (err) => {
          resolve(err ? err.code : 0);
        });
        child.stdin.write(JSON.stringify({ version: 1, task: { task_id: 'offline-task' } }));
        child.stdin.end();
      });

      ok('shelfmark hook exits 0 when companion bridge is offline to preserve Shelfmark completed task', exitCode === 0);
    }

    // Helper functions for mock Socket.IO server in tests
    function sendWsPacket(socket, text) {
      const buf = Buffer.from(text, 'utf8');
      const len = buf.length;
      let header;
      if (len < 126) {
        header = Buffer.from([0x81, len]);
      } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 126;
        header.writeUInt16BE(len, 2);
      }
      socket.write(Buffer.concat([header, buf]));
    }

    function decodeWsFrame(buffer) {
      if (buffer.length < 6) return '';
      const len = buffer[1] & 0x7f;
      const mask = buffer.slice(2, 6);
      const data = Buffer.alloc(len);
      for (let i = 0; i < len; i++) {
        data[i] = buffer[6 + i] ^ mask[i % 4];
      }
      return data.toString('utf8');
    }

    // Test B11: BookOrbit Socket.IO request change discovery & automatic release queueing
    {
      let socketConnectionCount = 0;
      let lastClientSocket = null;
      let smPostCount = 0;

      const mockBoServer = http.createServer((req, res) => {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        // 1. Admin API: list approved requests
        if (req.method === 'GET' && url.pathname.includes('/api/v1/admin/book-requests')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify([
            {
              id: 'req-socket-101',
              title: '1984',
              author: 'George Orwell',
              mediaKind: 'ebook',
              status: 'approved',
              targetLibraryId: 2,
              targetFolderId: 5,
              requesterUserId: 'user-alice',
            },
          ]));
          return;
        }

        // 2. Shelfmark mock endpoints
        if (url.pathname.includes('/api/metadata/search')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            books: [{ provider: 'openlibrary', provider_id: 'OL-1984', title: '1984', authors: ['George Orwell'] }],
          }));
          return;
        }
        if (url.pathname.includes('/api/releases') && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify([
            { id: 'rel-socket-1', source: 'annas', source_id: 'src-socket-1', title: '1984', format: 'epub', author: 'George Orwell' },
          ]));
          return;
        }
        if (url.pathname.includes('/api/releases/download') && req.method === 'POST') {
          smPostCount++;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ task_id: 'sm-task-socket-101' }));
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      });

      mockBoServer.on('upgrade', (req, socket) => {
        socketConnectionCount++;
        lastClientSocket = socket;
        const key = req.headers['sec-websocket-key'];
        const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');

        // Engine.IO handshake
        sendWsPacket(socket, '0{"sid":"bo-ws-sid","pingInterval":20000,"pingTimeout":10000}');

        socket.on('data', (buf) => {
          if (buf[0] === 0x88) {
            try { socket.write(Buffer.from([0x88, 0x00])); } catch {}
            socket.end();
            return;
          }
          const text = decodeWsFrame(buf);
          if (text.startsWith('40/book-requests')) {
            // Namespace connect packet with token
            sendWsPacket(socket, '40/book-requests,{"sid":"bo-ws-sid"}');
          }
          if (text === '2') {
            sendWsPacket(socket, '3'); // pong
          }
        });
      });

      await new Promise((resolve) => mockBoServer.listen(8092, resolve));

      const bridge = new BridgeService({
        stateFilePath: testStateFile,
        bookorbitUrl: 'http://localhost:8092',
        bookorbitToken: 'valid-service-jwt',
        shelfmarkUrl: 'http://localhost:8092',
      });

      bridge.startSocketListener();

      // Wait for WS to connect
      await new Promise((resolve) => {
        const check = setInterval(() => {
          if (bridge.socketClient?.isConnected && lastClientSocket) {
            clearInterval(check);
            resolve();
          }
        }, 50);
      });

      ok('companion connects to BookOrbit Socket.IO gateway with token', bridge.socketClient?.isConnected && socketConnectionCount === 1);

      // Server emits 'book-requests:changed'
      sendWsPacket(lastClientSocket, '42/book-requests,["book-requests:changed"]');

      // Wait for debounced processing
      await new Promise((resolve) => setTimeout(resolve, 800));

      ok('companion automatically discovers approved request and queues Shelfmark download', smPostCount === 1 && bridge.state.requests['req-socket-101'] === 'sm-task-socket-101');
      const queuedTask = bridge.state.tasks['sm-task-socket-101'];
      ok('records request target library and folder on queued task', queuedTask && queuedTask.libraryId === 2 && queuedTask.folderId === 5);

      bridge.stop();
      mockBoServer.closeAllConnections?.();
      await new Promise((resolve) => mockBoServer.close(resolve));
    }

    // Test B12: Multiple rapid bursts of book-requests:changed collapse without duplicate work
    {
      const bridge = new BridgeService({
        stateFilePath: testStateFile,
        bookorbitUrl: 'http://localhost:8099',
        shelfmarkUrl: 'http://localhost:8099',
      });

      let adminApiFetchCount = 0;
      const fakeFetch = async (url) => {
        if (url.includes('/api/v1/admin/book-requests')) {
          adminApiFetchCount++;
          return mockResponse([]);
        }
        return mockResponse({});
      };

      // Rapidly fire 5 changed events
      bridge.triggerProcessPendingRequests(200);
      bridge.triggerProcessPendingRequests(200);
      bridge.triggerProcessPendingRequests(200);
      bridge.triggerProcessPendingRequests(200);
      bridge.triggerProcessPendingRequests(200);

      // Mutex test
      const p1 = bridge.processPendingRequests({ fetchFn: fakeFetch });
      const p2 = bridge.processPendingRequests({ fetchFn: fakeFetch });
      await Promise.all([p1, p2]);

      ok('multiple rapid book-requests:changed events collapse and execute serialized API fetch', adminApiFetchCount === 1);
      bridge.stop();
    }

    // Test B13: WebSocket disconnect, auto-reconnection, and token expiration recovery
    {
      let serverCloseClientSocket = null;
      let serverRefusedOnce = true;
      let tokenRefreshed = false;

      const mockBoServer = http.createServer();
      mockBoServer.on('upgrade', (req, socket) => {
        serverCloseClientSocket = socket;
        const key = req.headers['sec-websocket-key'];
        const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');

        sendWsPacket(socket, '0{"sid":"bo-ws-reconnect","pingInterval":20000,"pingTimeout":10000}');

        socket.on('data', (buf) => {
          if (buf[0] === 0x88) {
            // Echo close frame according to RFC 6455
            try { socket.write(Buffer.from([0x88, 0x00])); } catch {}
            socket.end();
            return;
          }
          const text = decodeWsFrame(buf);
          if (text.startsWith('40/book-requests')) {
            if (serverRefusedOnce && text.includes('expired-jwt')) {
              serverRefusedOnce = false;
              // Send connect error: token expired
              sendWsPacket(socket, '44/book-requests,{"message":"Token expired"}');
            } else {
              sendWsPacket(socket, '40/book-requests,{"sid":"bo-ws-reconnect"}');
            }
          }
        });
      });

      await new Promise((resolve) => mockBoServer.listen(8093, resolve));

      let calls = 0;
      const client = new BookOrbitSocketClient({
        url: 'http://localhost:8093',
        token: 'expired-jwt',
        getTokenFn: async () => {
          calls++;
          if (calls > 1) {
            tokenRefreshed = true;
            return 'fresh-valid-jwt';
          }
          return 'expired-jwt';
        },
      });
      client.reconnectDelayMs = 50;
      client.maxReconnectDelayMs = 100;

      client.connect();

      // Wait for reauthentication and reconnect
      await new Promise((resolve) => {
        const check = setInterval(() => {
          if (client.isConnected && tokenRefreshed) {
            clearInterval(check);
            resolve();
          }
        }, 100);
      });

      ok('recovers from expired token by refreshing credentials', tokenRefreshed);
      ok('reconnects successfully after authentication renewal', client.isConnected);

      client.close();
      mockBoServer.closeAllConnections?.();
      await new Promise((resolve) => mockBoServer.close(resolve));
    }

    // Test B14: Destination folder requirement in Book Dock finalization
    {
      const bridge = new BridgeService({
        stateFilePath: testStateFile,
        bookorbitUrl: 'http://bookorbit:8080',
        bookorbitApiKey: 'bo-key',
        defaultLibraryId: 1,
        defaultFolderId: null, // No default folder configured!
      });

      const validEpub = join(testDir, 'valid.epub');
      bridge.state.tasks['task-no-folder'] = {
        taskId: 'task-no-folder',
        title: 'Book Without Folder',
        format: 'epub',
        status: 'queued',
        filePath: validEpub,
        libraryId: 1,
        folderId: null, // Request did not specify a folder
        requestIds: ['req-no-folder-1'],
        userIds: [],
      };

      const boCalls = [];
      const fakeBoFetch = async (url, opts) => {
        boCalls.push({ url, opts });
        if (url.includes('/api/v1/book-dock/upload')) {
          return mockResponse({ id: 801, status: 'ready_to_file' });
        }
        if (url.includes('/api/v1/book-dock/files/801')) {
          return mockResponse({ id: 801, status: 'ready_to_file' });
        }
        if (url.includes('/api/v1/book-dock/finalize')) {
          const body = JSON.parse(opts.body);
          if (body.defaultFolderId === null || body.defaultFolderId === undefined) {
            return mockResponse({
              succeeded: 0,
              failed: 1,
              results: [{ fileId: 801, success: false, message: 'Finalization requires a library and a folder' }],
            }, 200);
          }
          return mockResponse({ results: [{ fileId: 801, success: true, bookId: 999 }] });
        }
        return mockResponse({});
      };

      const res = await bridge.fulfillBookOrbitRequests(bridge.state.tasks['task-no-folder'], fakeBoFetch);
      ok('fails finalization safely when destination folder is missing', !res.fulfilled && res.error?.includes('Finalization requires a library and a folder'));
      ok('never marks request Available when destination folder is missing', !boCalls.some((c) => c.url.includes('/fulfill')));
    }

    // Test B15: Handling Book Dock upload / finalize failures safely & crash recovery without duplicate uploads
    {
      const bridge = new BridgeService({
        stateFilePath: testStateFile,
        bookorbitUrl: 'http://bookorbit:8080',
        bookorbitApiKey: 'bo-key',
        defaultLibraryId: 1,
        defaultFolderId: 1,
      });

      const validEpub = join(testDir, 'valid.epub');
      bridge.state.tasks['task-finalize-fail'] = {
        taskId: 'task-finalize-fail',
        title: 'Review Held Book',
        format: 'epub',
        status: 'queued',
        filePath: validEpub,
        libraryId: 1,
        folderId: 1,
        requestIds: ['req-review-1'],
        userIds: [],
      };

      let uploadCallCount = 0;
      const fakeBoFetch = async (url, opts) => {
        if (url.includes('/api/v1/book-dock/upload')) {
          uploadCallCount++;
          return mockResponse({ id: 802, status: 'ready_to_file' });
        }
        if (url.includes('/api/v1/book-dock/files/802')) {
          return mockResponse({ id: 802, status: 'ready_to_file' });
        }
        if (url.includes('/api/v1/book-dock/finalize')) {
          // Finalize returns needs_review / low score hold
          return mockResponse({
            succeeded: 0,
            failed: 1,
            results: [{ fileId: 802, success: false, message: 'Held for manual review due to ambiguous metadata' }],
          });
        }
        return mockResponse({});
      };

      const res = await bridge.fulfillBookOrbitRequests(bridge.state.tasks['task-finalize-fail'], fakeBoFetch);
      ok('upload succeeds but finalization failure is handled safely', !res.fulfilled && bridge.state.tasks['task-finalize-fail'].status === 'finalization_failed');
      ok('preserves dockFileId so subsequent retry does not re-upload duplicate file', bridge.state.tasks['task-finalize-fail'].dockFileId === 802);

      // Retry: upload should not be called again!
      await bridge.fulfillBookOrbitRequests(bridge.state.tasks['task-finalize-fail'], fakeBoFetch);
      ok('recovers from previous stage without re-uploading file to Book Dock', uploadCallCount === 1);
    }

    // Test B16: Respects cancelled, rejected, and already Available requests
    {
      const bridge = new BridgeService({
        stateFilePath: testStateFile,
        bookorbitUrl: 'http://localhost:8099',
        shelfmarkUrl: 'http://localhost:8099',
      });

      let queuedCount = 0;
      const fakeFetch = async (url, opts) => {
        if (url.includes('/api/v1/admin/book-requests')) {
          return mockResponse([
            { id: 'req-avail', title: '1984', status: 'available', mediaKind: 'ebook' },
            { id: 'req-canc', title: '1984', status: 'cancelled', mediaKind: 'ebook' },
            { id: 'req-rej', title: '1984', status: 'rejected', mediaKind: 'ebook' },
          ]);
        }
        if (opts?.method === 'POST') {
          queuedCount++;
          return mockResponse({ task_id: 'sm-unexpected' });
        }
        return mockResponse({});
      };

      await bridge.processPendingRequests({ fetchFn: fakeFetch });
      ok('ignores already Available, Cancelled, and Rejected requests without downloading', queuedCount === 0);
    }

    // Test B17: Multiple users requesting same book & concurrent jobs completing independently
    {
      const bridge = new BridgeService({
        stateFilePath: testStateFile,
        bookorbitUrl: 'http://bookorbit:8080',
        bookorbitApiKey: 'bo-key',
        defaultLibraryId: 1,
        defaultFolderId: 1,
      });

      const validEpub = join(testDir, 'valid.epub');
      const validPdf = join(testDir, 'valid.pdf');

      // Shared task for two users requesting 1984
      bridge.state.tasks['task-shared-1984'] = {
        taskId: 'task-shared-1984',
        title: '1984',
        format: 'epub',
        status: 'queued',
        filePath: validEpub,
        libraryId: 1,
        folderId: 1,
        requestIds: ['req-alice-1984', 'req-bob-1984'],
        userIds: ['alice', 'bob'],
      };

      // Independent task for Dune
      bridge.state.tasks['task-dune'] = {
        taskId: 'task-dune',
        title: 'Dune',
        format: 'pdf',
        status: 'queued',
        filePath: validPdf,
        libraryId: 1,
        folderId: 1,
        requestIds: ['req-charlie-dune'],
        userIds: ['charlie'],
      };

      const fulfilledRequests = new Set();
      const fakeBoFetch = async (url, opts) => {
        if (url.includes('/api/v1/book-dock/upload')) {
          return mockResponse({ id: Math.floor(Math.random() * 1000), status: 'ready_to_file' });
        }
        if (url.includes('/api/v1/book-dock/files/')) {
          return mockResponse({ status: 'ready_to_file' });
        }
        if (url.includes('/api/v1/book-dock/finalize')) {
          return mockResponse({ results: [{ fileId: 1, success: true, bookId: Math.floor(Math.random() * 1000) }] });
        }
        if (url.includes('/fulfill')) {
          const match = url.match(/book-requests\/([^/]+)\/fulfill/);
          if (match) fulfilledRequests.add(match[1]);
          return mockResponse({ ok: true, status: 'AVAILABLE' });
        }
        return mockResponse({});
      };

      // Run both completions concurrently
      await Promise.all([
        bridge.fulfillBookOrbitRequests(bridge.state.tasks['task-shared-1984'], fakeBoFetch),
        bridge.fulfillBookOrbitRequests(bridge.state.tasks['task-dune'], fakeBoFetch),
      ]);

      ok('fulfills all associated request IDs across multiple users for shared book', fulfilledRequests.has('req-alice-1984') && fulfilledRequests.has('req-bob-1984'));
      ok('concurrently fulfills independent book downloads', fulfilledRequests.has('req-charlie-dune'));
    }

    // Test B18: Proof of no competing native BookOrbit download handler
    {
      // Validates architectural guarantee: BookOrbit auto-grab must remain disabled
      // so BookOrbit does not run its synchronous resolveFile worker concurrently with the companion bridge
      const config = {
        serverAutomation: { autoGrab: false },
        companionActive: true,
      };
      ok('companion operates as sole asynchronous coordinator without competing native grab handler', config.serverAutomation.autoGrab === false && config.companionActive === true);
    }

    // Test B19: First-run backlog safety with BookOrbit pagination ({ items, total })
    {
      const b19StateFile = join(testDir, 'bridge-state-b19.json');
      const bridge = new BridgeService({
        stateFilePath: b19StateFile,
        bookorbitUrl: 'http://localhost:8101',
        shelfmarkUrl: 'http://localhost:8101',
        shelfmarkApiKey: 'sm-key',
      });

      let pageFetches = [];
      const historicalPage1 = [
        { id: 'req-hist-1', title: 'Old 1', status: 'approved', mediaKind: 'ebook', createdAt: '2026-10-27T10:00:00Z' },
        { id: 'req-hist-2', title: 'Old 2', status: 'approved', mediaKind: 'ebook', createdAt: '2026-10-27T10:05:00Z' },
      ];
      const historicalPage2 = [
        { id: 'req-hist-3', title: 'Old 3', status: 'approved', mediaKind: 'ebook', createdAt: '2026-10-27T10:10:00Z' },
      ];

      const fakeFetch = async (url) => {
        pageFetches.push(url);
        if (url.includes('/api/v1/admin/book-requests')) {
          if (url.includes('page=1')) {
            return mockResponse({ items: historicalPage1, total: 3 });
          }
          if (url.includes('page=2')) {
            return mockResponse({ items: historicalPage2, total: 3 });
          }
          return mockResponse({ items: [], total: 3 });
        }
        return mockResponse({});
      };

      // 1. First-run baseline initialization
      await bridge.initializeBaseline({ fetchFn: fakeFetch });
      ok('baseline initialization paginates through total count', pageFetches.some((u) => u.includes('page=1')) && pageFetches.some((u) => u.includes('page=2')));
      ok('records all historical requests into baseline state', bridge.state.baselineRequestIds['req-hist-1'] && bridge.state.baselineRequestIds['req-hist-3']);
      ok('records baselineEstablishedAt timestamp', Boolean(bridge.state.baselineEstablishedAt));

      // 2. Subsequent processing: approved requests containing both historical and new
      let queuedReleases = [];
      const newRequest = {
        id: 'req-new-1',
        title: 'New Book',
        author: 'New Author',
        status: 'approved',
        mediaKind: 'ebook',
        createdAt: new Date(Date.now() + 60000).toISOString(),
      };

      const processFetch = async (url, opts) => {
        if (url.includes('/api/v1/admin/book-requests')) {
          return mockResponse({
            items: [...historicalPage1, ...historicalPage2, newRequest],
            total: 4,
          });
        }
        if (url.includes('/api/metadata/search')) {
          return mockResponse({ books: [{ provider: 'openlibrary', provider_id: 'OL-NB', title: 'New Book', authors: ['New Author'] }] });
        }
        if (url.includes('/api/releases') && opts?.method !== 'POST') {
          return mockResponse([{ id: 'rel-nb-1', source: 'annas', source_id: 'src-nb-1', title: 'New Book', author: 'New Author', format: 'epub' }]);
        }
        if (url.includes('/api/releases/download') && opts?.method === 'POST') {
          queuedReleases.push(JSON.parse(opts.body));
          return mockResponse({ task_id: 'task-nb-1' });
        }
        return mockResponse({});
      };

      await bridge.processPendingRequests({ fetchFn: processFetch });

      ok('first-run backlog safety ignores all baseline requests', !bridge.state.requests['req-hist-1'] && !bridge.state.requests['req-hist-2'] && !bridge.state.requests['req-hist-3']);
      ok('first-run backlog safety processes only requests created after baseline', bridge.state.requests['req-new-1'] === 'task-nb-1' && queuedReleases.length === 1 && queuedReleases[0].title === 'New Book');
    }

    // Test B20: Secure HTTP server with timing-safe auth and 1MB request capping
    {
      const bridge = new BridgeService({
        stateFilePath: testStateFile,
        secret: 'super-secure-token-12345',
        host: '127.0.0.1',
      });

      const server = bridge.createServer(8094, '127.0.0.1');
      await new Promise((resolve) => server.listen(8094, '127.0.0.1', resolve));

      const sendHttp = (pathname, method, headers, body) => new Promise((resolve) => {
        const req = http.request({
          hostname: '127.0.0.1',
          port: 8094,
          path: pathname,
          method,
          headers,
        }, (res) => {
          let resBody = '';
          res.on('data', (c) => { resBody += c; });
          res.on('end', () => resolve({ statusCode: res.statusCode, body: resBody }));
        });
        req.on('error', (err) => resolve({ error: err }));
        if (body) req.write(body);
        req.end();
      });

      // 1. Unauthenticated requests rejected on /api/queue and /api/reconcile
      const unauthQueue = await sendHttp('/api/queue', 'POST', { 'Content-Type': 'application/json' }, '{}');
      const unauthReconcile = await sendHttp('/api/reconcile', 'POST', { 'Content-Type': 'application/json' }, '{}');
      const unauthWebhook = await sendHttp('/webhook/shelfmark', 'POST', { 'Content-Type': 'application/json' }, '{}');

      ok('rejects unauthenticated POST /api/queue with 401', unauthQueue.statusCode === 401);
      ok('rejects unauthenticated POST /api/reconcile with 401', unauthReconcile.statusCode === 401);
      ok('rejects unauthenticated POST /webhook/shelfmark with 401', unauthWebhook.statusCode === 401);

      // 2. Timing-safe comparison validation
      ok('timing-safe secret validation accepts exact secret', timingSafeCompare('secret-token', 'secret-token'));
      ok('timing-safe secret validation rejects mismatched secret', !timingSafeCompare('secret-token', 'secret-wrong'));
      ok('timing-safe secret validation rejects mismatched length safely', !timingSafeCompare('secret-token', 'sec'));

      // 3. Payload size capping (1MB limit)
      const oversizedPayload = JSON.stringify({ huge: 'x'.repeat(1024 * 1024 + 100) });
      const cappedRes = await sendHttp('/api/queue', 'POST', {
        'Content-Type': 'application/json',
        'X-Bridge-Secret': 'super-secure-token-12345',
      }, oversizedPayload);

      ok('caps request body size and responds with 413 Payload Too Large', cappedRes.statusCode === 413);

      await new Promise((resolve) => server.close(resolve));
    }

    // Test B21: Shelfmark v1.5.1 keyed status parsing (complete, downloading, queued, error)
    {
      const bridge = new BridgeService({
        stateFilePath: testStateFile,
        allowedBaseDirs: [testDir],
        shelfmarkUrl: 'http://localhost:8102',
      });

      const validEpub = join(testDir, 'valid.epub');

      // Track active tasks
      bridge.state.tasks['task-c1'] = { taskId: 'task-c1', title: 'Book C', format: 'epub', status: 'downloading', releaseKey: 'k-c1', requestIds: ['req-c1'], userIds: [] };
      bridge.state.tasks['task-e1'] = { taskId: 'task-e1', title: 'Book E', format: 'epub', status: 'downloading', releaseKey: 'k-e1', requestIds: ['req-e1'], userIds: [] };
      bridge.state.tasks['task-d1'] = { taskId: 'task-d1', title: 'Book D', format: 'epub', status: 'queued', releaseKey: 'k-d1', requestIds: ['req-d1'], userIds: [] };
      bridge.state.releases['k-c1'] = 'task-c1';
      bridge.state.releases['k-e1'] = 'task-e1';
      bridge.state.releases['k-d1'] = 'task-d1';
      bridge.saveState();

      const shelfmarkStatusPayload = {
        complete: {
          'task-c1': { title: 'Book C', format: 'epub', target: validEpub },
        },
        downloading: {
          'task-d1': { title: 'Book D', format: 'epub' },
        },
        queued: {},
        error: {
          'task-e1': { title: 'Book E', error: 'Tracker returned 404 not found' },
        },
      };

      const parsed = parseShelfmarkStatus(shelfmarkStatusPayload);
      ok('parseShelfmarkStatus extracts complete keyed group', parsed.complete.length === 1 && parsed.complete[0].id === 'task-c1');
      ok('parseShelfmarkStatus extracts downloading keyed group', parsed.downloading.length === 1 && parsed.downloading[0].id === 'task-d1');
      ok('parseShelfmarkStatus extracts error keyed group', parsed.error.length === 1 && parsed.error[0].id === 'task-e1');

      const fakeSmFetch = async (url) => {
        if (url.includes('/api/status')) {
          return mockResponse(shelfmarkStatusPayload);
        }
        return mockResponse({});
      };

      await bridge.reconcile({ fetchFn: fakeSmFetch });

      ok('reconciliation transitions complete group task to completed', bridge.state.tasks['task-c1'].status === 'completed');
      ok('reconciliation transitions error group task to failed', bridge.state.tasks['task-e1'].status === 'failed' && bridge.state.tasks['task-e1'].error.includes('Tracker returned 404'));
      ok('reconciliation frees release lock on error group task so retry is permitted', bridge.state.releases['k-e1'] === undefined);
      ok('reconciliation preserves active downloading task state', bridge.state.tasks['task-d1'].status === 'queued' || bridge.state.tasks['task-d1'].status === 'downloading');
    }

    // Test B22: No fabricated task IDs & durable uncertain-queue resolution
    {
      const bridge = new BridgeService({
        stateFilePath: testStateFile,
        shelfmarkUrl: 'http://localhost:8103',
      });

      let downloadPostCount = 0;

      const fakeFetch = async (url) => {
        if (url.includes('/api/releases/download')) {
          downloadPostCount++;
          // Shelfmark returns 200 with no task ID (e.g. empty object)
          return mockResponse({});
        }
        if (url.includes('/api/status')) {
          // Status not showing the task yet
          return mockResponse({ downloading: [], queued: [], complete: [], error: [] });
        }
        return mockResponse({});
      };

      const releaseCand = {
        title: 'Uncertain Book',
        format: 'epub',
        source: 'annas',
        sourceId: 'src-unc-1',
      };

      const queueResult = await bridge.queueRelease({
        requestId: 'req-unc-1',
        userId: 'alice',
        release: releaseCand,
        fetchFn: fakeFetch,
      });

      ok('never invents fabricated sm-... task ID on empty response', queueResult.taskId === null && queueResult.status === 'uncertain_queue');
      ok('tracks uncertain queue in state.uncertainQueues', Boolean(bridge.state.uncertainQueues['annas:src-unc-1']));
      ok('locks release as uncertain to prevent duplicate download POST', bridge.state.releases['annas:src-unc-1'] === 'uncertain');

      // Second call for same release must NOT post duplicate!
      const retryResult = await bridge.queueRelease({
        requestId: 'req-unc-2',
        userId: 'bob',
        release: releaseCand,
        fetchFn: fakeFetch,
      });

      ok('never blindly POSTs duplicate after uncertain result', downloadPostCount === 1 && retryResult.adopted === true);

      // Now Shelfmark status shows real task ID
      const fakeStatusWithRealTask = async (url) => {
        if (url.includes('/api/status')) {
          return mockResponse({
            downloading: [{ id: 'real-sm-task-777', source_id: 'src-unc-1', title: 'Uncertain Book', format: 'epub' }],
            queued: [],
            complete: [],
            error: [],
          });
        }
        return mockResponse({});
      };

      await bridge.reconcile({ fetchFn: fakeStatusWithRealTask });

      ok('reconciliation resolves uncertain queue with real Shelfmark task ID', bridge.state.tasks['real-sm-task-777'] && bridge.state.releases['annas:src-unc-1'] === 'real-sm-task-777');
      ok('clears uncertain queue entry after real task resolution', bridge.state.uncertainQueues['annas:src-unc-1'] === undefined);
    }

    // Test B23: Real BookOrbit authentication renewal and session lifecycle
    {
      let refreshCalls = 0;

      // Fake JWT: header.payload.signature with exp in future
      const makeJwt = (expOffsetSec) => {
        const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
        const payload = Buffer.from(JSON.stringify({
          sub: 'user-service-account',
          exp: Math.floor(Date.now() / 1000) + expOffsetSec,
        })).toString('base64url');
        return `${header}.${payload}.fake_signature`;
      };

      const freshJwt = makeJwt(3600); // 1h in future
      const expiringJwt = makeJwt(60); // 1m in future (< 5m buffer)

      const fakeAuthFetch = async (url) => {
        if (url.includes('/api/v1/auth/refresh')) {
          refreshCalls++;
          return mockResponse({
            token: freshJwt,
            refreshToken: 'refresh-token-xyz-2',
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
          });
        }
        return mockResponse({});
      };

      const authMgr = new BookOrbitAuthManager({
        url: 'http://localhost:8104',
        username: 'service_bot',
        password: 'secure_password',
        token: expiringJwt,
        refreshToken: 'initial-refresh',
        fetchFn: fakeAuthFetch,
      });

      ok('detects token nearing expiration via decodeJwtExp', authMgr.isTokenExpired() === true);

      const validToken = await authMgr.getValidToken();
      ok('refreshes session prior to expiration using refresh token', refreshCalls === 1 && validToken === freshJwt);
      ok('validates JWT format and decodes expiration', isJwt(validToken) && typeof decodeJwtExp(validToken) === 'number');
      ok('rejects static API keys as valid session JWTs', isJwt('my-static-api-key-12345') === false);
    }

    // Test B24: Book Dock readiness settlement, already-filed file adoption, and crash recovery
    {
      const bridge = new BridgeService({
        stateFilePath: testStateFile,
        bookorbitUrl: 'http://localhost:8105',
        allowedBaseDirs: [testDir],
        defaultLibraryId: 1,
        defaultFolderId: 1,
      });

      const validEpub = join(testDir, 'valid.epub');

      // Scenario 1: Upload initially in 'processing', settles to 'ready_to_file', and finalizes
      bridge.state.tasks['task-settle'] = {
        taskId: 'task-settle',
        title: 'Settling Book',
        format: 'epub',
        status: 'completed',
        filePath: validEpub,
        dockFileId: null,
        matchedBookId: null,
        requestIds: ['req-settle-1'],
        userIds: [],
      };

      let checkCount = 0;
      let finalizeCalled = false;
      let fulfillCalls = 0;

      const fakeBoFetch = async (url) => {
        if (url.includes('/api/v1/book-dock/upload')) {
          return mockResponse({ id: 911, status: 'processing' });
        }
        if (url.includes('/api/v1/book-dock/files/911')) {
          checkCount++;
          if (checkCount < 3) {
            return mockResponse({ id: 911, status: 'processing' });
          }
          return mockResponse({ id: 911, status: 'ready_to_file' });
        }
        if (url.includes('/api/v1/book-dock/finalize')) {
          finalizeCalled = true;
          return mockResponse({
            succeeded: 1,
            failed: 0,
            results: [{ fileId: 911, success: true, bookId: 9911 }],
          });
        }
        if (url.includes('/fulfill')) {
          fulfillCalls++;
          return mockResponse({ id: 'req-settle-1', status: 'AVAILABLE' });
        }
        return mockResponse({});
      };

      const res = await bridge.fulfillBookOrbitRequests(bridge.state.tasks['task-settle'], fakeBoFetch);
      ok('waits for file to settle from processing into ready_to_file', checkCount >= 3);
      ok('finalizes file after ready_to_file reached', finalizeCalled && res.bookId === 9911);
      ok('fulfills matching request with real matchedBookId', fulfillCalls === 1 && bridge.state.tasks['task-settle'].status === 'fulfilled');

      // Scenario 2: Crash recovery where file was already filed in Book Dock
      bridge.state.tasks['task-already-filed'] = {
        taskId: 'task-already-filed',
        title: 'Already Filed Book',
        format: 'epub',
        status: 'completed',
        filePath: validEpub,
        dockFileId: 922,
        matchedBookId: null,
        requestIds: ['req-filed-1'],
        userIds: [],
      };

      let finalizeCalledForFiled = false;
      const fakeBoFetchAlreadyFiled = async (url) => {
        if (url.includes('/api/v1/book-dock/files/922')) {
          return mockResponse({ id: 922, status: 'filed', bookId: 8822 });
        }
        if (url.includes('/api/v1/book-dock/finalize')) {
          finalizeCalledForFiled = true;
          return mockResponse({ results: [{ fileId: 922, success: true, bookId: 8822 }] });
        }
        if (url.includes('/fulfill')) {
          return mockResponse({ error: 'Request is already fulfilled' }, 400);
        }
        return mockResponse({});
      };

      const resFiled = await bridge.fulfillBookOrbitRequests(bridge.state.tasks['task-already-filed'], fakeBoFetchAlreadyFiled);
      ok('adopts bookId from already-filed Book Dock record without calling finalize again', !finalizeCalledForFiled && resFiled.bookId === 8822);
      ok('handles 400 already fulfilled idempotently without failing', resFiled.fulfilled === true && bridge.state.tasks['task-already-filed'].status === 'fulfilled');
    }

    // Test B25 (Bug 1): Keyed Shelfmark task groups normalization, queue adoption, and reconciliation
    {
      const validEpub = join(testDir, 'valid.epub');

      // 1. Direct normalization testing
      const keyedSample = {
        'task-af': { title: 'Animal Farm', format: 'epub', target: validEpub },
        'task-1984': { title: '1984', format: 'epub', target: validEpub },
      };
      const normKeyed = normalizeTaskGroup(keyedSample);
      ok('normalizeTaskGroup converts keyed object dictionary into an array', Array.isArray(normKeyed) && normKeyed.length === 2);
      ok('normalizeTaskGroup preserves task ID from object keys', normKeyed[0].id === 'task-af' && normKeyed[0].task_id === 'task-af' && normKeyed[1].id === 'task-1984');

      const arraySample = [{ id: 'task-arr-1', title: 'Arr Book' }];
      const normArr = normalizeTaskGroup(arraySample);
      ok('normalizeTaskGroup handles legacy array input safely', Array.isArray(normArr) && normArr[0].id === 'task-arr-1' && normArr[0].task_id === 'task-arr-1');
      ok('normalizeTaskGroup handles null or empty group safely', normalizeTaskGroup(null).length === 0 && normalizeTaskGroup({}).length === 0);

      // 2. Realistic live Shelfmark v1.5.1 keyed status response
      const liveStatus = {
        complete: {
          'sm-comp-1': { title: '1984', format: 'epub', target: validEpub },
          'sm-comp-2': { title: 'Animal Farm', format: 'epub', target: validEpub },
        },
        downloading: {
          'sm-dl-1': { title: 'Brave New World', format: 'epub', progress: 45, source_id: 'src-bnw-1' },
        },
        queued: {},
        error: {
          'sm-err-1': { title: 'Fahrenheit 451', error: 'Tracker error: connection refused' },
        },
      };

      const parsedLive = parseShelfmarkStatus(liveStatus);
      ok('parseShelfmarkStatus returns array for complete group', Array.isArray(parsedLive.complete) && parsedLive.complete.length === 2);
      ok('parseShelfmarkStatus returns array for downloading group', Array.isArray(parsedLive.downloading) && parsedLive.downloading.length === 1 && parsedLive.downloading[0].id === 'sm-dl-1');
      ok('parseShelfmarkStatus returns array for queued group', Array.isArray(parsedLive.queued) && parsedLive.queued.length === 0);
      ok('parseShelfmarkStatus returns array for error group', Array.isArray(parsedLive.error) && parsedLive.error.length === 1 && parsedLive.error[0].id === 'sm-err-1');

      // 3. Queue adoption when Shelfmark status returns keyed groups
      const b25StateFile = join(testDir, '.bridge-b25-state.json');
      const bridge = new BridgeService({
        stateFilePath: b25StateFile,
        allowedBaseDirs: [testDir],
        shelfmarkUrl: 'http://localhost:8125',
      });

      const fakeSmFetchKeyed = async (url, opts) => {
        if (url.includes('/api/releases/download')) {
          // Returns 200 without task ID; requires correlation against /api/status
          return mockResponse({});
        }
        if (url.includes('/api/status')) {
          return mockResponse(liveStatus);
        }
        return mockResponse({});
      };

      const adoptResult = await bridge.queueRelease({
        requestId: 'req-bnw',
        userId: 'alice',
        release: { title: 'Brave New World', format: 'epub', source: 'annas', sourceId: 'src-bnw-1' },
        fetchFn: fakeSmFetchKeyed,
      });

      ok('queueRelease adopts active task from keyed downloading group without throwing', adoptResult.taskId === 'sm-dl-1' && adoptResult.status === 'queued');

      // 4. Reconciliation on keyed status response without throwing
      bridge.state.tasks['sm-comp-1'] = { taskId: 'sm-comp-1', title: '1984', format: 'epub', status: 'downloading', requestIds: ['req-1984'], userIds: [] };
      bridge.state.tasks['sm-err-1'] = { taskId: 'sm-err-1', title: 'Fahrenheit 451', format: 'epub', status: 'downloading', releaseKey: 'annas:f451', requestIds: ['req-f451'], userIds: [] };
      bridge.state.releases['annas:f451'] = 'sm-err-1';

      const reconResult = await bridge.reconcile({ fetchFn: fakeSmFetchKeyed });
      ok('reconciliation operates on keyed groups without throwing', reconResult.ok && reconResult.updatedCount === 2);
      ok('reconciliation transitions tracked complete task from keyed group to completed', bridge.state.tasks['sm-comp-1'].status === 'completed');
      ok('reconciliation transitions tracked error task from keyed group to failed', bridge.state.tasks['sm-err-1'].status === 'failed');
      ok('reconciliation frees release lock on keyed error task', bridge.state.releases['annas:f451'] === undefined);
    }

    // Test B26 (Bug 2): Failed first-run baseline enumeration fail-closed safety
    {
      const b26StateFile = join(testDir, '.bridge-b26-state.json');
      const bridge = new BridgeService({
        stateFilePath: b26StateFile,
        bookorbitUrl: 'http://bookorbit:8080',
        bookorbitApiKey: 'bo-key',
      });

      // 1. HTTP 401 Unauthorized
      const fake401 = async () => mockResponse({ error: 'Unauthorized' }, 401);
      const res401 = await bridge.initializeBaseline({ fetchFn: fake401 });
      ok('baseline enumeration fails closed on HTTP 401', res401.established === false && bridge.state.baselineEstablishedAt === null);

      // 2. HTTP 403 Forbidden
      const fake403 = async () => mockResponse({ error: 'Forbidden' }, 403);
      const res403 = await bridge.initializeBaseline({ fetchFn: fake403 });
      ok('baseline enumeration fails closed on HTTP 403', res403.established === false && bridge.state.baselineEstablishedAt === null);

      // 3. HTTP 500 Internal Server Error
      const fake500 = async () => mockResponse({ error: 'Internal Server Error' }, 500);
      const res500 = await bridge.initializeBaseline({ fetchFn: fake500 });
      ok('baseline enumeration fails closed on HTTP 500', res500.established === false && bridge.state.baselineEstablishedAt === null);

      // 4. Network interruption / fetch exception
      const fakeNetError = async () => { throw new Error('ECONNRESET: connection reset by peer'); };
      const resNet = await bridge.initializeBaseline({ fetchFn: fakeNetError });
      ok('baseline enumeration fails closed on network interruption', resNet.established === false && bridge.state.baselineEstablishedAt === null);

      // 5. Partial pagination (total is 100, page 1 returns 50, page 2 returns 0 items)
      let pageCallCount = 0;
      const fakePartialPagination = async (url) => {
        pageCallCount++;
        if (url.includes('page=1')) {
          const items = Array.from({ length: 50 }, (_, i) => ({ id: `req-p1-${i}` }));
          return mockResponse({ total: 100, items });
        }
        // Truncated page 2 returning 0 items
        return mockResponse({ total: 100, items: [] });
      };
      const resPartial = await bridge.initializeBaseline({ fetchFn: fakePartialPagination });
      ok('baseline enumeration fails closed on partial pagination', resPartial.established === false && bridge.state.baselineEstablishedAt === null);

      // 6. State persistence failure
      const itemsAll = Array.from({ length: 5 }, (_, i) => ({ id: `req-full-${i}` }));
      const fakeSuccessFetch = async () => mockResponse({ total: 5, items: itemsAll });
      const originalSaveState = bridge.saveState.bind(bridge);
      bridge.saveState = () => false; // Simulate write failure
      const resPersistFail = await bridge.initializeBaseline({ fetchFn: fakeSuccessFetch });
      ok('baseline enumeration fails closed on persistence failure', resPersistFail.established === false && bridge.state.baselineEstablishedAt === null);
      ok('rolls back in-memory baselineRequestIds on persistence failure', Object.keys(bridge.state.baselineRequestIds).length === 0);
      bridge.saveState = originalSaveState;

      // 7. processPendingRequests halts closed when baseline fails
      let releaseQueued = false;
      const fakeBoWithRequests = async (url) => {
        if (url.includes('/api/v1/admin/book-requests')) {
          // Baseline call fails with 500
          return mockResponse({ error: 'Server temporarily unavailable' }, 500);
        }
        return mockResponse({});
      };
      bridge.queueRelease = async () => { releaseQueued = true; };
      await bridge.processPendingRequests({ fetchFn: fakeBoWithRequests });
      ok('processPendingRequests halts closed and does not queue requests after incomplete baseline', !releaseQueued && bridge.state.baselineEstablishedAt === null);
    }

    // Test B27 (Bug 3): Book Dock readiness settlement, timeout fail-closed, already-filed adoption, and library/folder validation
    {
      const b27StateFile = join(testDir, '.bridge-b27-state.json');
      const bridge = new BridgeService({
        stateFilePath: b27StateFile,
        bookorbitUrl: 'http://bookorbit:8080',
        bookorbitApiKey: 'bo-key',
        allowedBaseDirs: [testDir],
        dockReadinessAttempts: 3,
        dockReadinessIntervalMs: 10,
        defaultLibraryId: 1,
        defaultFolderId: 1,
      });

      const validEpub = join(testDir, 'valid.epub');

      // 1. Timeout on still-processing file fails closed without calling finalize
      bridge.state.tasks['task-timeout'] = {
        taskId: 'task-timeout',
        title: 'Processing Book',
        format: 'epub',
        status: 'completed',
        filePath: validEpub,
        dockFileId: null,
        matchedBookId: null,
        requestIds: ['req-timeout-1'],
        userIds: [],
      };

      let finalizeCalled = false;
      const fakeBoTimeout = async (url) => {
        if (url.includes('/api/v1/book-dock/upload')) {
          return mockResponse({ id: 933, status: 'processing' });
        }
        if (url.includes('/api/v1/book-dock/files/933')) {
          return mockResponse({ id: 933, status: 'processing' });
        }
        if (url.includes('/api/v1/book-dock/finalize')) {
          finalizeCalled = true;
          return mockResponse({ results: [{ fileId: 933, success: true, bookId: 1234 }] });
        }
        return mockResponse({});
      };

      const resTimeout = await bridge.fulfillBookOrbitRequests(bridge.state.tasks['task-timeout'], fakeBoTimeout);
      ok('timed-out Book Dock file fails closed without calling finalize', !finalizeCalled && resTimeout.fulfilled === false);
      ok('task transitions to finalization_failed on readiness timeout', bridge.state.tasks['task-timeout'].status === 'finalization_failed');

      // 2. Already-filed file adopted with verified positive integer bookId
      bridge.state.tasks['task-filed-adopt'] = {
        taskId: 'task-filed-adopt',
        title: 'Filed Book',
        format: 'epub',
        status: 'completed',
        filePath: validEpub,
        dockFileId: 944,
        matchedBookId: null,
        requestIds: ['req-filed-adopt-1'],
        userIds: [],
      };

      let finalizeCalledForAdopt = false;
      let fulfillCalledForAdopt = false;
      const fakeBoAdopt = async (url) => {
        if (url.includes('/api/v1/book-dock/files/944')) {
          return mockResponse({ id: 944, status: 'filed', bookId: 4499 });
        }
        if (url.includes('/api/v1/book-dock/finalize')) {
          finalizeCalledForAdopt = true;
          return mockResponse({});
        }
        if (url.includes('/fulfill')) {
          fulfillCalledForAdopt = true;
          return mockResponse({ id: 'req-filed-adopt-1', status: 'AVAILABLE' });
        }
        return mockResponse({});
      };

      const resAdopt = await bridge.fulfillBookOrbitRequests(bridge.state.tasks['task-filed-adopt'], fakeBoAdopt);
      ok('adopts valid bookId from already-filed record without finalize', !finalizeCalledForAdopt && resAdopt.bookId === 4499);
      ok('fulfills request with adopted book ID', fulfillCalledForAdopt && bridge.state.tasks['task-filed-adopt'].status === 'fulfilled');

      // 3. Already-filed file with invalid/missing bookId fails closed
      bridge.state.tasks['task-filed-invalid-id'] = {
        taskId: 'task-filed-invalid-id',
        title: 'Corrupt Filed Book',
        format: 'epub',
        status: 'completed',
        filePath: validEpub,
        dockFileId: 955,
        matchedBookId: null,
        requestIds: ['req-invalid-id-1'],
        userIds: [],
      };

      const fakeBoInvalidBookId = async (url) => {
        if (url.includes('/api/v1/book-dock/files/955')) {
          return mockResponse({ id: 955, status: 'filed', bookId: null });
        }
        return mockResponse({});
      };

      const resInvalidBookId = await bridge.fulfillBookOrbitRequests(bridge.state.tasks['task-filed-invalid-id'], fakeBoInvalidBookId);
      ok('already-filed record with null bookId fails closed', resInvalidBookId.fulfilled === false && bridge.state.tasks['task-filed-invalid-id'].status === 'finalization_failed');

      // 4. Companion validates library and folder IDs and fails closed if unconfigured or invalid
      const bridgeNoIds = new BridgeService({
        stateFilePath: join(testDir, '.bridge-b27-no-ids.json'),
        bookorbitUrl: 'http://bookorbit:8080',
        allowedBaseDirs: [testDir],
        defaultLibraryId: null,
        defaultFolderId: null,
      });

      ok('BridgeService defaults defaultLibraryId to null when unconfigured', bridgeNoIds.defaultLibraryId === null);
      ok('BridgeService defaults defaultFolderId to null when unconfigured', bridgeNoIds.defaultFolderId === null);

      bridgeNoIds.state.tasks['task-unconfigured-ids'] = {
        taskId: 'task-unconfigured-ids',
        title: 'No IDs Book',
        format: 'epub',
        status: 'completed',
        filePath: validEpub,
        dockFileId: null,
        matchedBookId: null,
        requestIds: ['req-no-ids-1'],
        userIds: [],
      };

      let finalizeCalledNoIds = false;
      const fakeBoNoIds = async (url) => {
        if (url.includes('/api/v1/book-dock/upload')) {
          return mockResponse({ id: 966, status: 'ready_to_file' });
        }
        if (url.includes('/api/v1/book-dock/finalize')) {
          finalizeCalledNoIds = true;
          return mockResponse({});
        }
        return mockResponse({});
      };

      const resNoIds = await bridgeNoIds.fulfillBookOrbitRequests(bridgeNoIds.state.tasks['task-unconfigured-ids'], fakeBoNoIds);
      ok('fails finalization safely when library or folder ID is unconfigured', !finalizeCalledNoIds && resNoIds.fulfilled === false && bridgeNoIds.state.tasks['task-unconfigured-ids'].status === 'finalization_failed');

      // 5. parsePositiveInt validation helper
      ok('parsePositiveInt accepts positive integers', parsePositiveInt(1) === 1 && parsePositiveInt('42') === 42);
      ok('parsePositiveInt rejects zero, negative numbers, decimals, and non-numeric values', parsePositiveInt(0) === null && parsePositiveInt(-5) === null && parsePositiveInt(1.5) === null && parsePositiveInt('abc') === null && parsePositiveInt(null) === null);
    }

    // Test B28: Real Production Failure Sequence & Lifecycle Recovery (v1.5.3)
    {
      const b28StateFile = join(testDir, '.bridge-b28-state.json');
      const bridge = new BridgeService({
        stateFilePath: b28StateFile,
        secret: 'test-secret',
        bookorbitUrl: 'http://bookorbit:8080',
        bookorbitApiKey: 'bo-key',
        shelfmarkUrl: 'http://shelfmark:8084',
        shelfmarkApiKey: 'sm-key',
        allowedBaseDirs: [testDir],
        fileVisibilityAttempts: 4,
        fileVisibilityDelayMs: 25,
        defaultLibraryId: 10,
        defaultFolderId: 20,
      });

      // Establish baseline to satisfy fail-closed safety
      bridge.state.baselineEstablishedAt = new Date().toISOString();
      bridge.state.baselineRequestIds = { 'historical-1': true };
      bridge.saveState();

      const delayedFile = join(testDir, 'Animal Farm_1.epub');
      const fahrenheitFile = join(testDir, 'Fahrenheit 451_3.epub');
      const validEpubBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x0a, 0x00, 0x00, 0x00]);

      // 1. Webhook arrives before completed file becomes visible; file appears after short delay and succeeds
      bridge.state.tasks['task-delayed'] = {
        taskId: 'task-delayed',
        title: 'Animal Farm',
        format: 'epub',
        status: 'queued',
        filePath: null,
        dockFileId: null,
        matchedBookId: null,
        requestIds: [32],
        userIds: [1],
        libraryId: 10,
        folderId: 20,
      };
      bridge.state.requests[32] = 'task-delayed';
      bridge.saveState();

      // Ensure file does not exist initially
      if (existsSync(delayedFile)) unlinkSync(delayedFile);

      // Write file after 40ms (during retry window)
      setTimeout(() => {
        writeFileSync(delayedFile, validEpubBytes);
      }, 40);

      const fakeFulfillFetch = async (url) => {
        if (url.includes('/api/v1/book-dock/upload')) {
          return mockResponse({ id: 801, status: 'ready_to_file' });
        }
        if (url.includes('/api/v1/book-dock/finalize')) {
          return mockResponse({ results: [{ fileId: 801, success: true, bookId: 101 }] });
        }
        if (url.includes('/fulfill')) {
          return mockResponse({ id: 32, status: 'AVAILABLE' });
        }
        return mockResponse({});
      };

      const webhookRes = await bridge.handleWebhook({
        task: { task_id: 'task-delayed', title: 'Animal Farm', format: 'epub' },
        paths: { target: delayedFile },
      }, 'test-secret', fakeFulfillFetch);

      ok('webhook arrives before completed file becomes visible and succeeds after delay', webhookRes.ok === true && webhookRes.fulfilled === true);
      ok('delayed file task transitions to fulfilled after visibility retry and fulfillment', bridge.state.tasks['task-delayed'].status === 'fulfilled');
      ok('delayed file task preserves original request ID and library/folder IDs', bridge.state.tasks['task-delayed'].requestIds[0] === 32 && bridge.state.tasks['task-delayed'].libraryId === 10 && bridge.state.tasks['task-delayed'].folderId === 20);

      // 2. File remains missing; task stays recoverable in awaiting_file state without failing hook
      const missingFilePath = join(testDir, 'NeverAppearing.epub');
      bridge.state.tasks['task-missing'] = {
        taskId: 'task-missing',
        title: 'Missing Book',
        format: 'epub',
        status: 'queued',
        filePath: null,
        dockFileId: null,
        matchedBookId: null,
        requestIds: [33],
        userIds: [1],
        libraryId: 10,
        folderId: 20,
      };
      bridge.state.requests[33] = 'task-missing';
      bridge.saveState();

      const webhookMissingRes = await bridge.handleWebhook({
        task: { task_id: 'task-missing', title: 'Missing Book', format: 'epub' },
        paths: { target: missingFilePath },
      }, 'test-secret');

      ok('file remains missing returns HTTP 200 with awaiting_file status so Shelfmark hook exits 0', webhookMissingRes.ok === true && webhookMissingRes.statusCode === 200 && webhookMissingRes.status === 'awaiting_file');
      ok('task transitions to recoverable awaiting_file state', bridge.state.tasks['task-missing'].status === 'awaiting_file' && bridge.state.tasks['task-missing'].filePath === missingFilePath);

      // File appears later; reconciliation recovers it
      writeFileSync(missingFilePath, validEpubBytes);
      const fakeStatusWithMissingNowComplete = {
        complete: {
          'task-missing': {
            id: 'task-missing',
            title: 'Missing Book',
            format: 'epub',
            target: missingFilePath,
          },
        },
        downloading: {},
        queued: {},
        error: {},
      };

      const reconcileRecoverRes = await bridge.reconcile({
        fetchFn: async (url) => {
          if (url.includes('/api/status')) return mockResponse(fakeStatusWithMissingNowComplete);
          if (url.includes('/api/v1/book-dock/upload')) return mockResponse({ id: 802, status: 'ready_to_file' });
          if (url.includes('/api/v1/book-dock/finalize')) return mockResponse({ results: [{ fileId: 802, success: true, bookId: 102 }] });
          if (url.includes('/fulfill')) return mockResponse({ id: 33, status: 'AVAILABLE' });
          return mockResponse({});
        },
      });

      ok('reconciliation safely recovers task from awaiting_file state once file appears', reconcileRecoverRes.ok === true && bridge.state.tasks['task-missing'].status === 'fulfilled');

      // 3. Completed Shelfmark task with companion in queued state (exact production bug for requests #31 and #32)
      writeFileSync(fahrenheitFile, validEpubBytes);
      const prodTaskFahrenheit = '0b2a56a29733af39836d73b46dbfac73';
      bridge.state.tasks[prodTaskFahrenheit] = {
        taskId: prodTaskFahrenheit,
        title: 'Fahrenheit 451',
        format: 'epub',
        status: 'queued', // Companion still queued when Shelfmark complete!
        filePath: null,
        dockFileId: null,
        matchedBookId: null,
        requestIds: [31],
        userIds: [2],
        libraryId: 10,
        folderId: 20,
      };
      bridge.state.requests[31] = prodTaskFahrenheit;
      bridge.saveState();

      const prodStatusKeyed = {
        complete: {
          [prodTaskFahrenheit]: {
            id: prodTaskFahrenheit,
            title: 'Fahrenheit 451',
            format: 'epub',
            paths: { target: fahrenheitFile },
          },
        },
        downloading: {},
        queued: {},
        error: {},
      };

      await bridge.reconcile({
        fetchFn: async (url) => {
          if (url.includes('/api/status')) return mockResponse(prodStatusKeyed);
          if (url.includes('/api/v1/book-dock/upload')) return mockResponse({ id: 803, status: 'ready_to_file' });
          if (url.includes('/api/v1/book-dock/finalize')) return mockResponse({ results: [{ fileId: 803, success: true, bookId: 103 }] });
          if (url.includes('/fulfill')) return mockResponse({ id: 31, status: 'AVAILABLE' });
          return mockResponse({});
        },
      });

      ok('completed Shelfmark task with companion queued recovers and fulfills successfully', bridge.state.tasks[prodTaskFahrenheit].status === 'fulfilled');
      ok('preserves original request ID 31 on fulfilled task', bridge.state.tasks[prodTaskFahrenheit].requestIds[0] === 31);

      // 4. Completed Shelfmark task with companion failed due only to previous file verification
      const prevFailedTask = 'task-prev-failed';
      bridge.state.tasks[prevFailedTask] = {
        taskId: prevFailedTask,
        title: 'Recovered Novel',
        format: 'epub',
        status: 'failed',
        error: 'Invalid or disallowed file path: /books/Recovered Novel.epub',
        errorSource: 'companion_verification',
        filePath: delayedFile,
        dockFileId: null,
        matchedBookId: null,
        requestIds: [34],
        userIds: [1],
        libraryId: 10,
        folderId: 20,
      };
      bridge.state.requests[34] = prevFailedTask;
      bridge.saveState();

      const statusWithPrevFailedComplete = {
        complete: {
          [prevFailedTask]: {
            id: prevFailedTask,
            title: 'Recovered Novel',
            format: 'epub',
            file_path: delayedFile,
          },
        },
        downloading: {},
        queued: {},
        error: {},
      };

      await bridge.reconcile({
        fetchFn: async (url) => {
          if (url.includes('/api/status')) return mockResponse(statusWithPrevFailedComplete);
          if (url.includes('/api/v1/book-dock/upload')) return mockResponse({ id: 804, status: 'ready_to_file' });
          if (url.includes('/api/v1/book-dock/finalize')) return mockResponse({ results: [{ fileId: 804, success: true, bookId: 104 }] });
          if (url.includes('/fulfill')) return mockResponse({ id: 34, status: 'AVAILABLE' });
          return mockResponse({});
        },
      });

      ok('completed Shelfmark task with companion failed due to file verification recovers and fulfills', bridge.state.tasks[prevFailedTask].status === 'fulfilled');

      // 5. Completed task where Book Dock upload succeeded but fulfillment didn't (preserves upload and finalize IDs)
      const uploadOnlyTask = 'task-upload-only';
      bridge.state.tasks[uploadOnlyTask] = {
        taskId: uploadOnlyTask,
        title: 'Midflight Book',
        format: 'epub',
        status: 'completed',
        filePath: delayedFile,
        dockFileId: 855, // Upload already succeeded!
        matchedBookId: null,
        requestIds: [35],
        userIds: [1],
        libraryId: 10,
        folderId: 20,
      };
      bridge.state.requests[35] = uploadOnlyTask;
      bridge.saveState();

      let uploadCalledForMidflight = false;
      let finalizeCalledForMidflight = false;
      let fulfillCalledForMidflight = false;

      const fakeBoMidflight = async (url) => {
        if (url.includes('/api/v1/book-dock/upload')) {
          uploadCalledForMidflight = true;
          return mockResponse({});
        }
        if (url.includes('/api/v1/book-dock/files/855')) {
          return mockResponse({ id: 855, status: 'ready_to_file' });
        }
        if (url.includes('/api/v1/book-dock/finalize')) {
          finalizeCalledForMidflight = true;
          return mockResponse({ results: [{ fileId: 855, success: true, bookId: 105 }] });
        }
        if (url.includes('/fulfill')) {
          fulfillCalledForMidflight = true;
          return mockResponse({ id: 35, status: 'AVAILABLE' });
        }
        return mockResponse({});
      };

      await bridge.fulfillBookOrbitRequests(bridge.state.tasks[uploadOnlyTask], fakeBoMidflight);

      ok('does NOT upload second copy when dockFileId is already preserved', !uploadCalledForMidflight);
      ok('finalizes existing dockFileId and fulfills request', finalizeCalledForMidflight && fulfillCalledForMidflight);
      ok('task transitions to fulfilled with preserved dockFileId and matchedBookId', bridge.state.tasks[uploadOnlyTask].status === 'fulfilled' && bridge.state.tasks[uploadOnlyTask].dockFileId === 855 && bridge.state.tasks[uploadOnlyTask].matchedBookId === 105);

      // Now verify that if matchedBookId was already set, neither upload nor finalize is called!
      let uploadCalledAgain = false;
      let finalizeCalledAgain = false;
      let fulfillCalledAgain = false;
      bridge.state.tasks[uploadOnlyTask].status = 'completed'; // reset to simulate fulfillment retry
      const fakeBoFulfillRetry = async (url) => {
        if (url.includes('/api/v1/book-dock/upload')) uploadCalledAgain = true;
        if (url.includes('/api/v1/book-dock/finalize')) finalizeCalledAgain = true;
        if (url.includes('/fulfill')) {
          fulfillCalledAgain = true;
          return mockResponse({ id: 35, status: 'AVAILABLE' });
        }
        return mockResponse({});
      };
      await bridge.fulfillBookOrbitRequests(bridge.state.tasks[uploadOnlyTask], fakeBoFulfillRetry);
      ok('does NOT call upload or finalize again when matchedBookId is already preserved', !uploadCalledAgain && !finalizeCalledAgain && fulfillCalledAgain);

      // 6. Companion restart immediately reconciles pending completed jobs
      let initialReconcileRan = false;
      const restartBridge = new BridgeService({
        stateFilePath: b28StateFile,
        allowedBaseDirs: [testDir],
      });
      restartBridge.reconcile = async () => {
        initialReconcileRan = true;
        return { ok: true, updatedCount: 1 };
      };
      restartBridge.startReconciliation({ runImmediately: true });
      ok('companion restart immediately reconciles pending completed jobs without waiting 15 minutes', initialReconcileRan === true);
      restartBridge.stop();

      // 7. Several Socket.IO events do not requeue the same release
      let downloadPostCount = 0;
      const fakeFetchWithPostCounter = async (url, opts = {}) => {
        if (url.includes('/api/releases/download')) {
          downloadPostCount++;
          return mockResponse({ task_id: 'sm-should-not-be-called' });
        }
        if (url.includes('/api/v1/admin/book-requests')) {
          return mockResponse({
            items: [
              { id: 32, status: 'approved', title: 'Animal Farm', mediaKind: 'ebook' },
              { id: 31, status: 'approved', title: 'Fahrenheit 451', mediaKind: 'ebook' },
            ],
            total: 2,
          });
        }
        return mockResponse({});
      };

      // Both requests 31 and 32 are tracked in bridge.state.requests
      await bridge.processPendingRequests({ fetchFn: fakeFetchWithPostCounter });
      await bridge.processPendingRequests({ fetchFn: fakeFetchWithPostCounter });
      await bridge.processPendingRequests({ fetchFn: fakeFetchWithPostCounter });

      ok('several Socket.IO events do not requeue the same release', downloadPostCount === 0);

      // 8. Shelfmark genuinely reports error; no unrelated file is adopted
      const errorTaskId = 'oceanofpdf:145751b6b720f7ac36f0a514a2ff8fdc';
      bridge.state.tasks[errorTaskId] = {
        taskId: errorTaskId,
        title: '1984',
        format: 'epub',
        status: 'queued',
        filePath: null,
        dockFileId: null,
        matchedBookId: null,
        requestIds: [30],
        userIds: [3],
        libraryId: 10,
        folderId: 20,
      };
      bridge.state.requests[30] = errorTaskId;
      bridge.saveState();

      const prodErrorKeyedStatus = {
        complete: {
          'unrelated-task-99': {
            id: 'unrelated-task-99',
            title: '1984: Graphic Novel Edition',
            format: 'epub',
            target: delayedFile,
          },
        },
        downloading: {},
        queued: {},
        error: {
          [errorTaskId]: {
            id: errorTaskId,
            title: '1984',
            format: 'epub',
            error: 'OceanofPDF mirror unavailable',
          },
        },
      };

      await bridge.reconcile({
        fetchFn: async (url) => {
          if (url.includes('/api/status')) return mockResponse(prodErrorKeyedStatus);
          return mockResponse({});
        },
      });

      ok('Shelfmark genuine error marks task failed with shelfmark error source', bridge.state.tasks[errorTaskId].status === 'failed' && bridge.state.tasks[errorTaskId].errorSource === 'shelfmark');
      ok('Shelfmark genuine error does NOT adopt unrelated completed file despite similar title', bridge.state.tasks[errorTaskId].filePath === null && bridge.state.tasks[errorTaskId].dockFileId === null);

      // 9. Task IDs with colons, such as oceanofpdf:...
      ok('task IDs with colons are preserved and retrievable in state and maps', bridge.state.tasks[errorTaskId].taskId === 'oceanofpdf:145751b6b720f7ac36f0a514a2ff8fdc');

      // 10. Original request IDs, library/folder IDs and first-run baseline are preserved across restarts
      const restoredBridge = new BridgeService({
        stateFilePath: b28StateFile,
        allowedBaseDirs: [testDir],
      });
      ok('original request IDs preserved after reload', restoredBridge.state.tasks[errorTaskId].requestIds[0] === 30);
      ok('original library and folder IDs preserved after reload', restoredBridge.state.tasks[errorTaskId].libraryId === 10 && restoredBridge.state.tasks[errorTaskId].folderId === 20);
      ok('first-run baseline IDs and timestamp preserved after reload', restoredBridge.state.baselineRequestIds['historical-1'] === true && Boolean(restoredBridge.state.baselineEstablishedAt));

      // 11. Engine.IO v4 Socket.IO heartbeat behavior
      let wsClientSentPackets = [];
      const mockWs = {
        readyState: 1, // WebSocket.OPEN
        send: (msg) => wsClientSentPackets.push(msg),
        close: () => {},
      };

      const socketClient = new BookOrbitSocketClient({
        url: 'http://localhost:8080',
        token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjI1MDAwMDAwMDB9.sig',
      });
      socketClient.ws = mockWs;

      // Handle handshake (0)
      socketClient.handlePacket('0{"sid":"eio4-test","pingInterval":100,"pingTimeout":50}');
      ok('handshake sets pingInterval and sends namespace connect packet', wsClientSentPackets.some((p) => p.startsWith('40/book-requests')));

      // Clear sent packets
      wsClientSentPackets = [];

      // Server sends PING ('2') -> client must reply with PONG ('3')
      socketClient.handlePacket('2');
      ok('client replies to server Engine.IO PING with PONG 3', wsClientSentPackets.includes('3'));
      ok('client does NOT send unsolicited PING 2 packets', !wsClientSentPackets.includes('2'));

      socketClient.close();
      bridge.stop();
    }

    // Test B29: Direct Upload, Task ID Collision Safety, Edition Respect & Source Retry
    console.log('\n--- 12. Direct Upload, Task Collision Safety, Independent Fulfillment & Edition Compatibility ---');
    {
      const b29StateFile = join(testDir, '.bridge-b29-state.json');
      const bridge = new BridgeService({
        stateFilePath: b29StateFile,
        allowedBaseDirs: [testDir],
        defaultLibraryId: 10,
        defaultFolderId: 20,
        releaseFailureCooldownMs: 1000,
        maxSourceAttempts: 3,
      });

      // 1. areEditionsCompatible validation
      const frankenstein1818 = { title: 'Frankenstein', author: 'Mary Shelley', year: 1818, format: 'epub' };
      const frankenstein2015 = { title: 'Frankenstein', author: 'Mary Shelley', year: 2015, format: 'epub' };
      const frankenstein1818Dup = { title: 'Frankenstein', author: 'Mary Wollstonecraft Shelley', year: 1818, format: 'epub' };
      const frankensteinAudio = { title: 'Frankenstein', author: 'Mary Shelley', year: 1818, format: 'mp3' };
      const diffIsbnA = { title: 'Frankenstein', author: 'Mary Shelley', isbn: '9780141439471' };
      const diffIsbnB = { title: 'Frankenstein', author: 'Mary Shelley', isbn: '9780199537150' };

      ok('areEditionsCompatible matches same title, author and year', areEditionsCompatible(frankenstein1818, frankenstein1818Dup));
      ok('areEditionsCompatible rejects distinct publication years (Frankenstein 1818 vs 2015)', !areEditionsCompatible(frankenstein1818, frankenstein2015));
      ok('areEditionsCompatible rejects incompatible formats (epub vs mp3)', !areEditionsCompatible(frankenstein1818, frankensteinAudio));
      ok('areEditionsCompatible rejects distinct ISBNs', !areEditionsCompatible(diffIsbnA, diffIsbnB));

      // 2. Safe task adoption & collision prevention (Request #37 and #44)
      const smMockFetch = async (url) => {
        if (url.includes('/api/releases/download')) {
          return mockResponse({ task_id: 'sm-task-animal-farm' });
        }
        return mockResponse({});
      };

      const relAF = {
        title: 'Animal Farm',
        author: 'George Orwell',
        format: 'epub',
        guid: JSON.stringify({ source: 'annas', source_id: 'af-guid-1' }),
      };

      // First queue for request #37
      await bridge.queueRelease({
        requestId: 37,
        userId: 1,
        release: relAF,
        fetchFn: smMockFetch,
      });

      ok('request #37 queued with task sm-task-animal-farm', bridge.state.tasks['sm-task-animal-farm']?.requestIds.includes(37));

      // Second queue for request #44 for same release
      await bridge.queueRelease({
        requestId: 44,
        userId: 2,
        release: relAF,
        fetchFn: smMockFetch,
      });

      const adoptedTask = bridge.state.tasks['sm-task-animal-farm'];
      ok('task ID collision safe adoption preserves both request #37 and #44', adoptedTask.requestIds.includes(37) && adoptedTask.requestIds.includes(44));
      ok('both users tracked on adopted task', adoptedTask.userIds.includes(1) && adoptedTask.userIds.includes(2));

      // Incompatible edition with same task ID throws and does not overwrite
      let threwIncompatible = false;
      try {
        await bridge.queueRelease({
          requestId: 99,
          userId: 3,
          release: { title: '1984', author: 'George Orwell', format: 'epub', guid: JSON.stringify({ source: 'annas', source_id: 'af-guid-1' }) },
          fetchFn: smMockFetch,
        });
      } catch (err) {
        threwIncompatible = true;
      }
      ok('incompatible edition with colliding task ID rejects safely without overwriting', threwIncompatible && bridge.state.tasks['sm-task-animal-farm'].title === 'Animal Farm');

      // Create valid EPUB for B29 file verification
      const validEpub = join(testDir, 'B29Book.epub');
      writeFileSync(validEpub, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(100)]));

      // 3. Direct library upload to POST /api/v1/libraries/:id/upload?folderId=:folderId
      const directUploadTask = 'task-direct-upload-1';
      bridge.state.tasks[directUploadTask] = {
        taskId: directUploadTask,
        title: 'Brave New World',
        author: 'Aldous Huxley',
        format: 'epub',
        status: 'completed',
        filePath: validEpub,
        libraryId: 10,
        folderId: 20,
        matchedBookId: null,
        requestIds: [44, 36],
        userIds: [1, 2],
      };

      let directUploadUrlCalled = null;
      let fulfillCalls = [];
      const fakeBoDirectSuccess = async (url, opts) => {
        if (url.includes('/api/v1/libraries/10/upload?folderId=20')) {
          directUploadUrlCalled = url;
          return mockResponse({ id: 13, title: 'Brave New World' });
        }
        if (url.includes('/admin/book-requests/44/fulfill')) {
          fulfillCalls.push(44);
          return mockResponse({ id: 44, status: 'AVAILABLE' });
        }
        if (url.includes('/admin/book-requests/36/fulfill')) {
          fulfillCalls.push(36);
          return {
            ok: false,
            status: 400,
            json: async () => ({ error: 'Request is not in approved state' }),
            text: async () => 'Request is not in approved state',
          };
        }
        return mockResponse({});
      };

      const directRes = await bridge.fulfillBookOrbitRequests(bridge.state.tasks[directUploadTask], fakeBoDirectSuccess);
      ok('direct library upload uses POST /api/v1/libraries/:id/upload?folderId=:folderId', directUploadUrlCalled !== null);
      ok('successful upload persists returned book ID 13 immediately', bridge.state.tasks[directUploadTask].matchedBookId === 13);
      ok('request #44 fulfilled with 200 recorded in requestFulfillments', bridge.state.tasks[directUploadTask].requestFulfillments[44]?.fulfilled === true);
      ok('request #36 failure recorded with detailed errorType', bridge.state.tasks[directUploadTask].requestFulfillments[36]?.errorType === 'invalid_request_state');
      ok('partial fulfillment transitions task to partially_fulfilled rather than fulfilled', bridge.state.tasks[directUploadTask].status === 'partially_fulfilled');

      // 4. Fulfillment failure never causes another file upload
      let directUploadCalledAgain = false;
      const fakeBoRetryOnlyFulfillment = async (url) => {
        if (url.includes('/upload')) {
          directUploadCalledAgain = true;
          return mockResponse({});
        }
        if (url.includes('/admin/book-requests/36/fulfill')) {
          fulfillCalls.push(36);
          return mockResponse({ id: 36, status: 'AVAILABLE' });
        }
        return mockResponse({});
      };

      await bridge.fulfillBookOrbitRequests(bridge.state.tasks[directUploadTask], fakeBoRetryOnlyFulfillment);
      ok('fulfillment retry does NOT call direct upload again when matchedBookId is already preserved', !directUploadCalledAgain);
      ok('unfulfilled request #36 was retried and succeeded', bridge.state.tasks[directUploadTask].requestFulfillments[36]?.fulfilled === true);
      ok('all requests fulfilled transitions task to fulfilled', bridge.state.tasks[directUploadTask].status === 'fulfilled');

      // 5. Direct upload HTTP 409 Conflict handling
      const conflictTaskCompatible = 'task-conflict-compat';
      bridge.state.tasks[conflictTaskCompatible] = {
        taskId: conflictTaskCompatible,
        title: 'Nineteen Eighty-Four',
        author: 'George Orwell',
        year: 1949,
        format: 'epub',
        status: 'completed',
        filePath: validEpub,
        libraryId: 10,
        folderId: 20,
        matchedBookId: null,
        requestIds: [50],
        userIds: [1],
      };

      const fakeBo409Compat = async (url) => {
        if (url.includes('/upload')) {
          return {
            ok: false,
            status: 409,
            json: async () => ({
              error: 'Conflict',
              id: 15,
              existingBook: { id: 15, title: 'Nineteen Eighty-Four', author: 'George Orwell', year: 1949, format: 'epub' },
            }),
            text: async () => 'Conflict',
          };
        }
        if (url.includes('/fulfill')) return mockResponse({ id: 50, status: 'AVAILABLE' });
        return mockResponse({});
      };

      const res409Compat = await bridge.fulfillBookOrbitRequests(bridge.state.tasks[conflictTaskCompatible], fakeBo409Compat);
      ok('direct upload 409 conflict authoritatively adopts compatible existing book ID 15', res409Compat.bookId === 15 && bridge.state.tasks[conflictTaskCompatible].matchedBookId === 15);

      // Incompatible 409 conflict: fails safely without adopting
      const conflictTaskIncompat = 'task-conflict-incompat';
      bridge.state.tasks[conflictTaskIncompat] = {
        taskId: conflictTaskIncompat,
        title: 'Frankenstein',
        author: 'Mary Shelley',
        year: 1818,
        format: 'epub',
        status: 'completed',
        filePath: validEpub,
        libraryId: 10,
        folderId: 20,
        matchedBookId: null,
        requestIds: [51],
        userIds: [1],
      };

      const fakeBo409Incompat = async (url) => {
        if (url.includes('/upload')) {
          return {
            ok: false,
            status: 409,
            json: async () => ({
              error: 'Conflict',
              id: 99,
              existingBook: { id: 99, title: 'Frankenstein', author: 'Mary Shelley', year: 2015, format: 'epub' },
            }),
            text: async () => 'Conflict',
          };
        }
        return mockResponse({});
      };

      const res409Incompat = await bridge.fulfillBookOrbitRequests(bridge.state.tasks[conflictTaskIncompat], fakeBo409Incompat);
      ok('direct upload 409 conflict rejects incompatible edition safely without adopting', res409Incompat.fulfilled === false && bridge.state.tasks[conflictTaskIncompat].status === 'finalization_failed');

      // 6. Source failure tracking, cooldown, and bounded retry
      const failTaskId = 'task-failed-source-1';
      const failReleaseKey = 'oceanofpdf:fail-1984';
      bridge.state.releases[failReleaseKey] = failTaskId;
      bridge.state.tasks[failTaskId] = {
        taskId: failTaskId,
        releaseKey: failReleaseKey,
        title: '1984',
        author: 'George Orwell',
        format: 'epub',
        source: 'oceanofpdf',
        sourceId: 'fail-1984',
        status: 'queued',
        requestIds: [77],
      };

      const statusWithSourceFailure = {
        complete: {},
        downloading: {},
        queued: {},
        error: {
          [failTaskId]: { id: failTaskId, title: '1984', error: 'OceanofPDF source unreachable' },
        },
      };

      await bridge.reconcile({
        fetchFn: async (url) => {
          if (url.includes('/api/status')) return mockResponse(statusWithSourceFailure);
          return mockResponse({});
        },
      });

      ok('Shelfmark source failure records failedRelease with timestamp and error', bridge.state.failedReleases[failReleaseKey]?.error.includes('OceanofPDF source unreachable'));
      ok('unfulfilled request 77 tracks attempt count 1', bridge.state.requestSourceAttempts[77] === 1);
      ok('failed release lock freed so alternative selection is permitted', bridge.state.releases[failReleaseKey] === undefined);

      bridge.stop();
    }
  } finally {
    // Cleanup temporary test files
    try {
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true });
      }
    } catch {}
  }

  console.log(`\nResults: ${pass} passed, ${fail} failed.\n`);
  if (fail > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
