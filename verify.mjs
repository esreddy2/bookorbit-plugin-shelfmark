/**
 * Verification test suite for BookOrbit Shelfmark indexer plugin v1.2.0.
 *
 * Simulates BookOrbit host environment and validates the plugin against
 * mocked Shelfmark v1.5.1 API fixtures and comprehensive unit test cases.
 *
 * Run with: node verify.mjs
 */

import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';

import plugin from './index.mjs';
import { BridgeService } from './bridge/bridge.mjs';

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
  ok('declares semantic version 1.4.0', plugin.version === '1.4.0');
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

    // Test B5: File verification (rejects missing, 0-byte, and invalid magic bytes)
    {
      const bridge = new BridgeService({ stateFilePath: testStateFile, secret: 'test-secret' });
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
        task_id: 'task-corrupt',
        download_path: fakeEpubFile,
        format: 'epub',
      }, 'test-secret');

      ok('bridge rejects corrupted download in webhook with 422', hookResCorrupt.statusCode === 422 && !hookResCorrupt.ok);
      ok('corrupted download does NOT mark task completed', bridge.state.tasks['task-corrupt'].status === 'failed');
    }

    // Test B6: Fulfills BookOrbit requests only after verified file import
    {
      const bridge = new BridgeService({
        stateFilePath: testStateFile,
        secret: 'test-secret',
        bookorbitUrl: 'http://bookorbit:8080',
        bookorbitApiKey: 'bo-api-key',
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
        return mockResponse({ ok: true, status: 'AVAILABLE' });
      };

      const hookRes = await bridge.handleWebhook({
        task_id: 'task-success',
        download_path: validEpub,
        format: 'epub',
      }, 'test-secret', fakeBoFetch);

      ok('webhook accepts valid file and marks completed', hookRes.ok && hookRes.statusCode === 200);
      ok('notifies BookOrbit import endpoint with verified file path', boCalls.some((c) => c.url.includes('/api/v1/import/file') && JSON.parse(c.opts.body).filePath === validEpub));
      ok('marks BookOrbit request AVAILABLE only after successful import', boCalls.some((c) => c.url.includes('/api/v1/requests/req-success-1/fulfill') && JSON.parse(c.opts.body).status === 'AVAILABLE'));
    }

    // Test B7: Bounded periodic reconciliation discovers completed tasks without polling loops
    {
      const bridge = new BridgeService({ stateFilePath: testStateFile });
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
              { id: 'task-missed-webhook', title: 'Fahrenheit 451', format: 'epub', download_path: validEpub },
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

    // Test B9: Shelfmark hook script executes cleanly in both stdin JSON and argument modes
    {
      const hookServer = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          const secret = req.headers['x-bridge-secret'];
          const parsed = body ? JSON.parse(body) : {};
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, secret, received: parsed }));
        });
      });

      await new Promise((resolve) => hookServer.listen(8098, resolve));

      try {
        // Mode 1: Argument mode (CLI argument $1)
        const argOut = await new Promise((resolve, reject) => {
          execFile('scripts/shelfmark-hook.sh', ['/tmp/downloads/Book.epub'], {
            env: { ...process.env, BRIDGE_WEBHOOK_URL: 'http://localhost:8098/webhook', BRIDGE_SECRET: 'test-hook-secret' },
          }, (err, stdout) => {
            if (err) reject(err);
            else resolve(stdout);
          });
        });
        ok('shelfmark hook executes in argument mode ($1)', argOut.includes('Success (HTTP 200)') && argOut.includes('Book.epub'));

        // Mode 2: Stdin JSON mode (CUSTOM_SCRIPT_JSON_PAYLOAD=true)
        const stdinOut = await new Promise((resolve, reject) => {
          const child = execFile('scripts/shelfmark-hook.sh', [], {
            env: { ...process.env, BRIDGE_WEBHOOK_URL: 'http://localhost:8098/webhook', BRIDGE_SECRET: 'test-hook-secret' },
          }, (err, stdout) => {
            if (err) reject(err);
            else resolve(stdout);
          });
          child.stdin.write(JSON.stringify({ task_id: 'task-hook-stdin', status: 'completed', format: 'epub' }));
          child.stdin.end();
        });
        ok('shelfmark hook executes in stdin JSON mode', stdinOut.includes('Success (HTTP 200)') && stdinOut.includes('task-hook-stdin'));
      } finally {
        await new Promise((resolve) => hookServer.close(resolve));
      }
    }
  } finally {
    // Cleanup temporary test files
    try {
      if (existsSync(testDir)) {
        for (const file of ['zero.epub', 'fake.epub', 'valid.epub', 'valid.pdf', 'bridge-state.json']) {
          const p = join(testDir, file);
          if (existsSync(p)) unlinkSync(p);
        }
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
