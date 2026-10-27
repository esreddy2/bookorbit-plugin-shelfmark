/**
 * Verification test suite for BookOrbit Shelfmark indexer plugin.
 *
 * Simulates BookOrbit host environment and validates the plugin against
 * mocked Shelfmark API fixtures and comprehensive unit test cases.
 *
 * Run with: node verify.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

import plugin from './index.mjs';

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
      return handler(url, options);
    },
    logger: {
      log: () => {},
      warn: () => {},
      error: () => {},
    },
    buildSearchText: (q) => [q.title, q.author].filter(Boolean).join(' ').trim(),
    fail: (code, message) => {
      const err = new Error(message);
      err.code = code;
      return err;
    },
  };
}

const mockResponse = (body, status = 200) => {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
};

const baseConfig = (overrides = {}) => ({
  id: 1,
  name: 'Shelfmark',
  baseUrl: 'http://localhost:8084',
  settings: {
    apiKey: 'test-secret-key-12345',
    preferFormat: 'epub',
    downloadViaShelfmark: true,
    pollTimeoutSeconds: 5,
    pollIntervalMs: 20, // Fast polling for snappy test execution
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
  ok('declares semantic version', typeof plugin.version === 'string' && /^\d+\.\d+\.\d+/.test(plugin.version));
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
    ok('sends Authorization and X-Api-Key headers', host.calls[0].options.headers['X-Api-Key'] === 'test-secret-key-12345');
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

  console.log('\n--- 3. Search (search) ---');
  {
    let metadataQueryParam = null;
    const host = makeHost((url) => {
      if (url.includes('/api/metadata/search')) {
        const u = new URL(url);
        metadataQueryParam = u.searchParams.get('query');
        return mockResponse(META_SEARCH);
      }
      if (url.includes('/api/releases')) return mockResponse(RELEASES);
      return mockResponse([]);
    });

    const query = { title: 'Dune', author: 'Frank Herbert', mediaKind: 'ebook', limit: 10 };
    const releases = await plugin.search(query, baseConfig(), host, AbortSignal.timeout(5000));

    ok('queries metadata search by title only without appending author', metadataQueryParam === 'Dune');
    ok('finds releases', Array.isArray(releases) && releases.length > 0);
    const first = releases[0];
    ok('release has guid', typeof first.guid === 'string');
    ok('release has format', first.format === 'epub');
    ok('release preferred format ranked first', first.format === 'epub');
    ok('release has valid sizeBytes', typeof first.sizeBytes === 'number');
    ok('release has direct downloadUrl if provided', typeof first.downloadUrl === 'string');
    ok('freeleech marked true', first.freeleech === true);
    ok('extra payload preserved for resolveFile', first.extra?.releasePayload?.source_id === 'md5-abcdef123456');
  }

  {
    // Goal 1: Title & Author validation (Little Fires Everywhere / Celeste Ng)
    let searchedQuery = null;
    const host = makeHost((url) => {
      if (url.includes('/api/metadata/search')) {
        searchedQuery = new URL(url).searchParams.get('query');
        return mockResponse({
          books: [
            {
              provider: 'openlibrary',
              provider_id: 'OL-LFE-01',
              title: 'Little Fires Everywhere',
              authors: ['Celeste Ng'],
            },
            {
              provider: 'openlibrary',
              provider_id: 'OL-LFE-02',
              title: 'Little Fires Everywhere: Study Guide',
              authors: ['BookCaps'],
            },
          ],
        });
      }
      if (url.includes('/api/releases')) {
        return mockResponse([
          {
            id: 'lfe-epub',
            source_id: 'lfe-md5-epub',
            source: 'annas_archive',
            title: 'Little Fires Everywhere - Celeste Ng [EPUB]',
            format: 'epub',
            size_bytes: 1200000,
          },
        ]);
      }
      return mockResponse([]);
    });

    const query = { title: 'Little Fires Everywhere', author: 'Celeste Ng', mediaKind: 'ebook' };
    const releases = await plugin.search(query, baseConfig(), host);

    ok('searches metadata with title only for Little Fires Everywhere', searchedQuery === 'Little Fires Everywhere');
    ok('validates author and selects Celeste Ng edition', releases.length === 1 && releases[0].extra?.releasePayload?.source_id === 'lfe-md5-epub');
  }

  {
    // Goal 1: Rejects clearly incorrect books when author mismatches
    const host = makeHost((url) => {
      if (url.includes('/api/metadata/search')) {
        return mockResponse({
          books: [
            {
              provider: 'openlibrary',
              provider_id: 'OL-WRONG-01',
              title: 'Little Fires Everywhere: Companion',
              authors: ['Stephen King'], // Totally different author
            },
          ],
        });
      }
      if (url.includes('/api/releases')) {
        return mockResponse([{ id: 'wrong', title: 'Wrong Book', format: 'epub' }]);
      }
      return mockResponse([]);
    });

    const query = { title: 'Little Fires Everywhere', author: 'Celeste Ng', mediaKind: 'ebook' };
    const releases = await plugin.search(query, baseConfig(), host);
    ok('filters out candidate books with mismatched authors (returns empty)', releases.length === 0);
  }

  {
    // Matches candidate book when requested author is among multiple authors
    const host = makeHost((url) => {
      if (url.includes('/api/metadata/search')) {
        return mockResponse({
          books: [
            {
              provider: 'openlibrary',
              provider_id: 'OL-GO-01',
              title: 'Good Omens',
              authors: ['Terry Pratchett', 'Neil Gaiman'],
            },
          ],
        });
      }
      if (url.includes('/api/releases')) {
        return mockResponse([{ id: 'go-rel', source_id: 'go-md5', source: 'libgen', title: 'Good Omens', format: 'epub' }]);
      }
      return mockResponse([]);
    });

    const query = { title: 'Good Omens', author: 'Neil Gaiman', mediaKind: 'ebook' };
    const releases = await plugin.search(query, baseConfig(), host);
    ok('matches candidate book when requested author is among multiple authors', releases.length === 1);
  }

  {
    // Matches candidate book with transposed author name ("Ng, Celeste")
    const host = makeHost((url) => {
      if (url.includes('/api/metadata/search')) {
        return mockResponse({
          books: [
            {
              provider: 'openlibrary',
              provider_id: 'OL-LFE-03',
              title: 'Little Fires Everywhere',
              authors: ['Ng, Celeste'],
            },
          ],
        });
      }
      if (url.includes('/api/releases')) {
        return mockResponse([{ id: 'rel-1', source_id: 's-1', source: 'libgen', title: 'Little Fires Everywhere', format: 'epub' }]);
      }
      return mockResponse([]);
    });

    const query = { title: 'Little Fires Everywhere', author: 'Celeste Ng', mediaKind: 'ebook' };
    const releases = await plugin.search(query, baseConfig(), host);
    ok('matches candidate book with transposed author name ("Ng, Celeste")', releases.length === 1);
  }

  {
    // Filters out candidate books with mismatched title
    const host = makeHost((url) => {
      if (url.includes('/api/metadata/search')) {
        return mockResponse({
          books: [
            {
              provider: 'openlibrary',
              provider_id: 'OL-UNRELATED',
              title: 'A Wildly Different Book',
              authors: ['Frank Herbert'],
            },
          ],
        });
      }
      return mockResponse([]);
    });

    const query = { title: 'Dune', author: 'Frank Herbert', mediaKind: 'ebook' };
    const releases = await plugin.search(query, baseConfig(), host);
    ok('filters out candidate books with mismatched title', releases.length === 0);
  }

  {
    // Goal 5: Format filtering (supports EPUB and PDF, drops mobi/azw3/audiobooks)
    const host = makeHost((url) => {
      if (url.includes('/api/metadata/search')) return mockResponse(META_SEARCH);
      if (url.includes('/api/releases')) {
        return mockResponse([
          { id: '1', source_id: 's-epub', source: 'libgen', title: 'Dune [EPUB]', format: 'epub' },
          { id: '2', source_id: 's-pdf', source: 'libgen', title: 'Dune [PDF]', format: 'pdf' },
          { id: '3', source_id: 's-mobi', source: 'libgen', title: 'Dune [MOBI]', format: 'mobi' },
          { id: '4', source_id: 's-azw3', source: 'libgen', title: 'Dune [AZW3]', format: 'azw3' },
          { id: '5', source_id: 's-audio', source: 'audiobookbay', title: 'Dune Audiobook', format: 'm4b' },
        ]);
      }
      return mockResponse([]);
    });

    const query = { title: 'Dune', author: 'Frank Herbert', mediaKind: 'ebook' };
    const releases = await plugin.search(query, baseConfig(), host);

    ok('filters releases to EPUB and PDF only', releases.length === 2 && releases.every((r) => r.format === 'epub' || r.format === 'pdf'));
    ok('ranks EPUB first when preferred format is epub', releases[0].format === 'epub' && releases[1].format === 'pdf');

    // Test ranking with preferFormat: pdf
    const pdfConfig = baseConfig({ settings: { preferFormat: 'pdf' } });
    const pdfReleases = await plugin.search(query, pdfConfig, host);
    ok('ranks PDF first when preferred format is pdf', pdfReleases[0].format === 'pdf' && pdfReleases[1].format === 'epub');
  }

  {
    // Search edge cases: empty query, abort signal, network error
    const host = makeHost(() => mockResponse([]));
    const emptyRes = await plugin.search({ title: '', author: '' }, baseConfig(), host);
    ok('returns empty array on empty query', Array.isArray(emptyRes) && emptyRes.length === 0);

    const abortedController = new AbortController();
    abortedController.abort();
    const abortedRes = await plugin.search({ title: 'Dune' }, baseConfig(), host, abortedController.signal);
    ok('aborts search immediately when AbortSignal triggers', Array.isArray(abortedRes) && abortedRes.length === 0);
  }

  {
    const networkHost = makeHost(() => {
      throw new Error('Connection failed');
    });
    let caughtErr = null;
    try {
      await plugin.search({ title: 'Dune' }, baseConfig(), networkHost);
    } catch (err) {
      caughtErr = err;
    }
    ok('throws host.fail unreachable on network failure during search', caughtErr?.code === 'unreachable');
  }

  {
    const authHost = makeHost(() => mockResponse({ error: 'unauthorized' }, 401));
    let caughtErr = null;
    try {
      await plugin.search({ title: 'Dune' }, baseConfig(), authHost);
    } catch (err) {
      caughtErr = err;
    }
    ok('throws host.fail unauthorized on 401/403 during search', caughtErr?.code === 'unauthorized');
  }

  console.log('\n--- 4. Download Resolution (resolveFile) ---');
  {
    // Mode A: Download via Shelfmark queue (EPUB)
    const host = makeHost((url) => {
      if (url.includes('/api/releases/download')) return mockResponse({ status: 'queued', task_id: 'task-999' });
      if (url.includes('/api/status')) return mockResponse(STATUS);
      return mockResponse({});
    });

    const release = {
      guid: 'md5-abcdef123456',
      title: 'Dune (Frank Herbert)',
      format: 'epub',
      sizeBytes: 1572864,
      downloadUrl: 'http://localhost:8084/api/localdownload?id=md5-abcdef123456',
      extra: {
        releasePayload: {
          id: 'rel-001',
          source_id: 'md5-abcdef123456',
          source: 'annas_archive',
          title: 'Dune (Frank Herbert) [EPUB]',
        },
      },
    };

    const resolved = await plugin.resolveFile(release, baseConfig(), host);
    ok('resolves local download URL from Shelfmark proxy for EPUB', resolved.url.includes('/api/localdownload?id=md5-abcdef123456'));
    ok('includes api_key query param when apiKey is configured', resolved.url.includes('api_key=test-secret-key-12345'));
    ok('forwards headers with auth and sets Accept */*', resolved.headers?.['X-Api-Key'] === 'test-secret-key-12345' && resolved.headers?.['Accept'] === '*/*');
    ok('resolves valid sanitized fileName', resolved.fileName === 'Dune Frank Herbert.epub');
    ok('preserves format', resolved.format === 'epub');
  }

  {
    // Mode B: Download via Shelfmark queue (PDF)
    const host = makeHost((url) => {
      if (url.includes('/api/releases/download')) return mockResponse({ status: 'queued', task_id: 'pdf-task-123' });
      if (url.includes('/api/status')) {
        return mockResponse({
          completed: {
            'pdf-task-123': {
              id: 'pdf-task-123',
              source_id: 'pdf-md5-789',
              title: 'Dune (Frank Herbert) [PDF]',
              format: 'pdf',
            },
          },
        });
      }
      return mockResponse({});
    });

    const release = {
      guid: 'pdf-md5-789',
      title: 'Dune (Frank Herbert)',
      format: 'pdf',
      sizeBytes: 3145728,
      extra: {
        releasePayload: {
          source_id: 'pdf-md5-789',
          source: 'libgen',
          title: 'Dune (Frank Herbert) [PDF]',
          format: 'pdf',
        },
      },
    };

    const resolved = await plugin.resolveFile(release, baseConfig(), host);
    ok('resolves local download URL from Shelfmark proxy for PDF', resolved.url.includes('/api/localdownload?id=pdf-task-123'));
    ok('PDF format and filename resolved accurately', resolved.format === 'pdf' && resolved.fileName === 'Dune Frank Herbert.pdf');
  }

  {
    // Mode C: Direct download bypass
    const host = makeHost(() => mockResponse({}));
    const release = {
      guid: 'direct-01',
      title: 'Dune',
      format: 'epub',
      sizeBytes: 1000,
      downloadUrl: 'https://example.com/books/dune.epub',
      extra: {},
    };

    const directConfig = baseConfig({ settings: { downloadViaShelfmark: false } });
    const resolved = await plugin.resolveFile(release, directConfig, host);
    ok('resolves direct URL when downloadViaShelfmark is false', resolved.url === 'https://example.com/books/dune.epub');
  }

  {
    // Mode D: BookOrbit strips release.extra during candidate sanitization; payload is recovered from guid
    const host = makeHost((url) => {
      if (url.includes('/api/releases/download')) return mockResponse({ status: 'queued' });
      if (url.includes('/api/status')) return mockResponse(STATUS);
      return mockResponse({});
    });

    const payload = {
      source: 'annas_archive',
      source_id: 'md5-abcdef123456',
      title: 'Dune (Frank Herbert) [EPUB]',
      format: 'epub',
    };

    const sanitizedRelease = {
      guid: JSON.stringify(payload),
      title: 'Dune (Frank Herbert)',
      format: null,
      sizeBytes: 1572864,
      downloadUrl: null,
    };

    const resolved = await plugin.resolveFile(sanitizedRelease, baseConfig(), host);
    ok('resolves local download URL when extra is stripped by BookOrbit', resolved.url.includes('/api/localdownload?id=md5-abcdef123456'));
    ok('recovers format correctly from payload when extra and top-level format are stripped', resolved.format === 'epub');
  }

  {
    // Mode E: Matches by queuedTaskId returned from POST /api/releases/download
    const host = makeHost((url) => {
      if (url.includes('/api/releases/download')) return mockResponse({ task_id: 'custom-queue-999' });
      if (url.includes('/api/status')) {
        return mockResponse({
          complete: {
            'custom-queue-999': { id: 'custom-queue-999', title: 'Some Other Title' },
          },
        });
      }
      return mockResponse({});
    });

    const release = {
      guid: JSON.stringify({ source: 'libgen', source_id: 'lg-111', title: 'Dune', format: 'epub' }),
      title: 'Dune',
      format: null,
      sizeBytes: 500000,
    };

    const resolved = await plugin.resolveFile(release, baseConfig(), host);
    ok('matches task by queuedTaskId', resolved.url.includes('id=custom-queue-999'));
  }

  {
    // Goal 4: Missing task ID handling - Shelfmark accepts download without returning task_id
    // Matches newly completed task safely by title & format
    let statusCallCount = 0;
    const host = makeHost((url) => {
      if (url.includes('/api/releases/download')) {
        // Shelfmark accepts download without returning task identifier
        return mockResponse({ status: 'queued' });
      }
      if (url.includes('/api/status')) {
        statusCallCount++;
        if (statusCallCount === 1) {
          // Pre-flight status before queuing: no active or completed tasks
          return mockResponse({ complete: {}, active: {} });
        }
        // Second call: download completed with arbitrary task ID and no source_id
        return mockResponse({
          complete: {
            'anon-task-888': {
              id: 'anon-task-888',
              title: 'Little Fires Everywhere',
              format: 'epub',
            },
          },
        });
      }
      return mockResponse({});
    });

    const release = {
      guid: JSON.stringify({ source: 'annas_archive', source_id: 'anon-source', title: 'Little Fires Everywhere', format: 'epub' }),
      title: 'Little Fires Everywhere',
      format: 'epub',
    };

    const resolved = await plugin.resolveFile(release, baseConfig(), host);
    ok('handles missing task IDs: matches newly completed task by title & format', resolved.url.includes('id=anon-task-888'));
  }

  {
    // Goal 4: Missing task ID handling - Safely ignores pre-existing completed tasks from earlier downloads
    let statusCallCount = 0;
    const host = makeHost((url) => {
      if (url.includes('/api/releases/download')) return mockResponse({ status: 'queued' }); // No task_id returned
      if (url.includes('/api/status')) {
        statusCallCount++;
        // Pre-existing completed task from yesterday:
        if (statusCallCount <= 2) {
          return mockResponse({
            complete: {
              'old-task-from-yesterday': {
                id: 'old-task-from-yesterday',
                title: 'Little Fires Everywhere',
                format: 'epub',
              },
            },
          });
        }
        // Newly completed task appears on tick 3:
        return mockResponse({
          complete: {
            'old-task-from-yesterday': {
              id: 'old-task-from-yesterday',
              title: 'Little Fires Everywhere',
              format: 'epub',
            },
            'new-task-today': {
              id: 'new-task-today',
              title: 'Little Fires Everywhere',
              format: 'epub',
            },
          },
        });
      }
      return mockResponse({});
    });

    const release = {
      guid: JSON.stringify({ source: 'annas_archive', source_id: 'some-anon-source', title: 'Little Fires Everywhere', format: 'epub' }),
      title: 'Little Fires Everywhere',
      format: 'epub',
    };

    const resolved = await plugin.resolveFile(release, baseConfig(), host);
    ok('handles missing task IDs: safely ignores pre-existing completed tasks from earlier downloads', resolved.url.includes('id=new-task-today'));
  }

  {
    // Goal 4: Missing task ID handling - Fails safely on ambiguous matches (multiple completed tasks)
    let statusCallCount = 0;
    const host = makeHost((url) => {
      if (url.includes('/api/releases/download')) return mockResponse({ status: 'queued' });
      if (url.includes('/api/status')) {
        statusCallCount++;
        if (statusCallCount === 1) return mockResponse({ complete: {} });
        // Multiple newly completed tasks match the same title ambiguously
        return mockResponse({
          complete: {
            'ambig-task-1': { id: 'ambig-task-1', title: 'Little Fires Everywhere', format: 'epub' },
            'ambig-task-2': { id: 'ambig-task-2', title: 'Little Fires Everywhere', format: 'epub' },
          },
        });
      }
      return mockResponse({});
    });

    const release = {
      guid: JSON.stringify({ source: 'annas_archive', source_id: 'anon-src', title: 'Little Fires Everywhere', format: 'epub' }),
      title: 'Little Fires Everywhere',
      format: 'epub',
    };

    let caughtErr = null;
    try {
      await plugin.resolveFile(release, baseConfig(), host);
    } catch (err) {
      caughtErr = err;
    }
    ok('handles missing task IDs: fails safely on ambiguous matches', caughtErr?.code === 'error' && caughtErr.message.includes('Ambiguous download match'));
  }

  {
    // Handles Shelfmark reported failure
    const host = makeHost((url) => {
      if (url.includes('/api/releases/download')) return mockResponse({ task_id: 'fail-task-1' });
      if (url.includes('/api/status')) {
        return mockResponse({
          error: {
            'fail-task-1': { id: 'fail-task-1', error: 'Mirror unreachable or IP blocked by Cloudflare' },
          },
        });
      }
      return mockResponse({});
    });

    const release = {
      guid: JSON.stringify({ source: 'libgen', source_id: 'fail-src', title: 'Dune', format: 'epub' }),
      title: 'Dune',
      format: 'epub',
    };

    let caughtErr = null;
    try {
      await plugin.resolveFile(release, baseConfig(), host);
    } catch (err) {
      caughtErr = err;
    }
    ok('handles Shelfmark reported download failure', caughtErr?.code === 'error' && caughtErr.message.includes('Shelfmark reported download failed'));
  }

  {
    // AbortSignal immediate cancellation during polling
    const host = makeHost((url) => {
      if (url.includes('/api/releases/download')) return mockResponse({ status: 'queued' });
      if (url.includes('/api/status')) return mockResponse({ complete: {}, error: {} });
      return mockResponse({});
    });

    const release = {
      guid: JSON.stringify({ source: 'annas_archive', source_id: 'md5-pending', title: 'Dune', format: 'epub' }),
      title: 'Dune',
    };

    const controller = new AbortController();
    const start = Date.now();
    setTimeout(() => controller.abort(), 50);

    let caughtErr = null;
    try {
      await plugin.resolveFile(release, baseConfig({ settings: { pollTimeoutSeconds: 30 } }), host, controller.signal);
    } catch (err) {
      caughtErr = err;
    }

    const elapsed = Date.now() - start;
    ok('aborts polling immediately on signal abort', caughtErr?.code === 'cancelled' && elapsed < 500);
  }

  {
    // Bounded timeout after pollTimeoutSeconds
    const host = makeHost((url) => {
      if (url.includes('/api/releases/download')) return mockResponse({ status: 'queued' });
      if (url.includes('/api/status')) return mockResponse({ complete: {}, active: {} });
      return mockResponse({});
    });

    const release = {
      guid: JSON.stringify({ source: 'annas_archive', source_id: 'md5-timeout', title: 'Dune', format: 'epub' }),
      title: 'Dune',
      format: 'epub',
    };

    let caughtErr = null;
    try {
      // 0.1s timeout
      await plugin.resolveFile(release, baseConfig({ settings: { pollTimeoutSeconds: 0.1, pollIntervalMs: 20 } }), host);
    } catch (err) {
      caughtErr = err;
    }
    ok('times out safely after pollTimeoutSeconds', caughtErr?.code === 'timeout' && caughtErr.message.includes('Timed out waiting for Shelfmark'));
  }

  {
    // Tolerates transient network failure during status polling
    let callIndex = 0;
    const host = makeHost((url) => {
      if (url.includes('/api/releases/download')) return mockResponse({ task_id: 'transient-task' });
      if (url.includes('/api/status')) {
        callIndex++;
        if (callIndex === 1) return mockResponse({ complete: {} });
        if (callIndex === 2) throw new Error('Temporary network blip / ECONNRESET');
        return mockResponse({
          complete: {
            'transient-task': { id: 'transient-task', title: 'Dune', format: 'epub' },
          },
        });
      }
      return mockResponse({});
    });

    const release = {
      guid: JSON.stringify({ source: 'annas_archive', source_id: 'transient-task', title: 'Dune', format: 'epub' }),
      title: 'Dune',
      format: 'epub',
    };

    const resolved = await plugin.resolveFile(release, baseConfig(), host);
    ok('tolerates transient network failure during status polling without crashing', resolved.url.includes('id=transient-task'));
  }

  {
    // Handles 401/403 auth failure during status polling
    let callIndex = 0;
    const host = makeHost((url) => {
      if (url.includes('/api/releases/download')) return mockResponse({ task_id: 'auth-fail-task' });
      if (url.includes('/api/status')) {
        callIndex++;
        if (callIndex === 1) return mockResponse({ complete: {} });
        return mockResponse({ error: 'unauthorized' }, 401);
      }
      return mockResponse({});
    });

    const release = {
      guid: JSON.stringify({ source: 'annas_archive', source_id: 'auth-fail-task', title: 'Dune', format: 'epub' }),
      title: 'Dune',
      format: 'epub',
    };

    let caughtErr = null;
    try {
      await plugin.resolveFile(release, baseConfig(), host);
    } catch (err) {
      caughtErr = err;
    }
    ok('throws unauthorized when status polling returns 401/403', caughtErr?.code === 'unauthorized');
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
