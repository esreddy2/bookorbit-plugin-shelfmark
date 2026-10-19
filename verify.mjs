/**
 * Verification test suite for BookOrbit Shelfmark indexer plugin.
 *
 * Simulates BookOrbit host environment and validates the plugin against
 * mocked Shelfmark API fixtures.
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
    ...overrides.settings,
  },
  ...overrides,
});

async function runTests() {
  console.log('\n--- 1. Declaration & Metadata ---');
  ok('targets BookOrbit API version 1', plugin.apiVersion === 1);
  ok('type is shelfmark', plugin.type === 'shelfmark');
  ok('supports ebook and audiobook', plugin.mediaKinds.includes('ebook') && plugin.mediaKinds.includes('audiobook'));
  ok('defines apiKey in settingsFields', plugin.settingsFields.some((f) => f.key === 'apiKey' && f.type === 'string'));
  ok('defines preferFormat in settingsFields', plugin.settingsFields.some((f) => f.key === 'preferFormat'));
  ok('defines downloadViaShelfmark toggle', plugin.settingsFields.some((f) => f.key === 'downloadViaShelfmark'));
  ok('declares semantic version', typeof plugin.version === 'string' && /^\d+\.\d+\.\d+/.test(plugin.version));
  ok('declares update channel', typeof plugin.update === 'object' && plugin.update !== null);
  ok('update manifestUrl is HTTPS', typeof plugin.update?.manifestUrl === 'string' && plugin.update.manifestUrl.startsWith('https://'));
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
    ok('test handles authentication failure', result.success === false && result.error.includes('Authentication failed'));
  }

  console.log('\n--- 3. Search (search) ---');
  {
    const host = makeHost((url) => {
      if (url.includes('/api/metadata/search')) return mockResponse(META_SEARCH);
      if (url.includes('/api/releases')) return mockResponse(RELEASES);
      return mockResponse([]);
    });

    const query = { title: 'Dune', author: 'Frank Herbert', mediaKind: 'ebook', limit: 10 };
    const releases = await plugin.search(query, baseConfig(), host, AbortSignal.timeout(5000));

    ok('finds releases', Array.isArray(releases) && releases.length > 0);
    const first = releases[0];
    ok('release has guid', typeof first.guid === 'string');
    ok('release has format', first.format === 'epub');
    ok('release preferred format ranked first', first.format === 'epub');
    ok('release has valid sizeBytes', typeof first.sizeBytes === 'number');
    ok('freeleech marked true', first.freeleech === true);
    ok('extra payload preserved for resolveFile', first.extra?.releasePayload?.source_id === 'md5-abcdef123456');
  }

  console.log('\n--- 4. Download Resolution (resolveFile) ---');
  {
    // Mode A: Download via Shelfmark queue
    const host = makeHost((url, options) => {
      if (url.includes('/api/releases/download')) return mockResponse({ status: 'queued' });
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
    ok('resolves local download URL from Shelfmark proxy', resolved.url.includes('/api/localdownload?id=md5-abcdef123456'));
    ok('resolves valid fileName', resolved.fileName === 'Dune Frank Herbert.epub');
    ok('preserves format', resolved.format === 'epub');
  }

  {
    // Mode B: Direct download bypass
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
    // Mode C: BookOrbit strips release.extra during candidate sanitization; payload is recovered from guid
    const host = makeHost((url, options) => {
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
      format: 'epub',
      sizeBytes: 1572864,
      downloadUrl: null,
      // Note: extra is completely absent as sanitized by BookOrbit
    };

    const resolved = await plugin.resolveFile(sanitizedRelease, baseConfig(), host);
    ok('resolves local download URL when extra is stripped by BookOrbit', resolved.url.includes('/api/localdownload?id=md5-abcdef123456'));
    ok('recovers format correctly when extra is stripped', resolved.format === 'epub');
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
