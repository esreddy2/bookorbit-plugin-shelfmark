/**
 * Shelfmark indexer plugin for BookOrbit.
 *
 * Connects BookOrbit book requests to a self-hosted Shelfmark instance
 * (https://github.com/calibrain/shelfmark) via its REST API.
 *
 * Supports searching book metadata, finding releases across configured sources
 * (Anna's Archive, Libgen, etc.), and routing downloads through Shelfmark's
 * bypass / download pipeline.
 *
 * Single-file and dependency-free following BookOrbit's indexer plugin specification.
 */

const USER_AGENT = 'BookOrbit-Shelfmark-Plugin/1.0.0';

/** Fallback maximum number of releases to return per search. */
const MAX_RESULTS = 25;

/** Default format preferences. */
const FORMAT_PREFERENCE = ['epub', 'mobi', 'azw3', 'pdf', 'm4b', 'mp3'];

export default {
  apiVersion: 1,
  version: '1.0.0',
  type: 'shelfmark',
  label: 'Shelfmark',
  mediaKinds: ['ebook', 'audiobook'],
  requiresCredential: false,
  credentialKind: null,
  usesCategories: false,
  seedsBack: false,

  defaultBaseUrl: 'http://localhost:8084',
  baseUrlHint: 'Base address of your Shelfmark server (e.g. http://localhost:8084 or http://shelfmark:8084).',

  settingsFields: [
    {
      key: 'apiKey',
      type: 'string',
      label: 'Shelfmark API Key',
      hint: 'The SHELFMARK_API_KEY value configured in your Shelfmark environment (optional if auth is disabled).',
      default: '',
    },
    {
      key: 'preferFormat',
      type: 'string',
      label: 'Preferred Format',
      hint: 'File format given priority in search ranking: epub, mobi, azw3, pdf, or any.',
      default: 'epub',
    },
    {
      key: 'downloadViaShelfmark',
      type: 'boolean',
      label: 'Download via Shelfmark',
      hint: 'Trigger download inside Shelfmark and serve file via local proxy. Recommended if bypass/VPN/Tor is required.',
      default: true,
    },
    {
      key: 'pollTimeoutSeconds',
      type: 'number',
      label: 'Download Wait Timeout (seconds)',
      hint: 'Maximum time to wait for Shelfmark to finish downloading a release before timing out.',
      default: 180,
    },
  ],

  /**
   * Health and connectivity test invoked by the BookOrbit web UI.
   *
   * @param {object} config - BookOrbit indexer configuration.
   * @param {object} host - BookOrbit host helper (host.fetch, host.fail, host.logger).
   * @returns {Promise<{success: boolean, indexerName?: string, error?: string}>}
   */
  async test(config, host) {
    try {
      const baseUrl = cleanUrl(config.baseUrl);
      const headers = makeHeaders(config);

      // Verify basic connectivity and health endpoint
      const response = await host.fetch(`${baseUrl}/api/health`, {
        headers,
      });

      if (response.status === 401 || response.status === 403) {
        return {
          success: false,
          error: 'Authentication failed. Check your Shelfmark API key.',
        };
      }

      if (!response.ok) {
        return {
          success: false,
          error: `Shelfmark answered with HTTP ${response.status}`,
        };
      }

      // Check if config or status endpoint is accessible
      const statusRes = await host.fetch(`${baseUrl}/api/status`, {
        headers,
      });

      if (!statusRes.ok && statusRes.status !== 200) {
        return {
          success: false,
          error: `Connected to health endpoint, but status query returned HTTP ${statusRes.status}. Check permissions.`,
        };
      }

      return {
        success: true,
        indexerName: 'Shelfmark',
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },

  /**
   * Search Shelfmark for book releases matching a query.
   *
   * @param {object} query - Search query object from BookOrbit (title, author, mediaKind, limit, etc.).
   * @param {object} config - Indexer configuration (baseUrl, settings).
   * @param {object} host - BookOrbit host helper.
   * @param {AbortSignal} signal - Cancellation signal.
   * @returns {Promise<Array<object>>} - List of BookOrbit release objects.
   */
  async search(query, config, host, signal) {
    const baseUrl = cleanUrl(config.baseUrl);
    const headers = makeHeaders(config);
    const contentType = query.mediaKind === 'audiobook' ? 'audiobook' : 'ebook';

    // Build the query string using host helper or fallback
    const searchText = host.buildSearchText
      ? host.buildSearchText(query)
      : [query.title, query.author].filter(Boolean).join(' ').trim();

    if (!searchText) {
      return [];
    }

    // Step 1: Query Shelfmark metadata search
    const metadataUrl = new URL(`${baseUrl}/api/metadata/search`);
    metadataUrl.searchParams.set('query', searchText);
    metadataUrl.searchParams.set('content_type', contentType);
    metadataUrl.searchParams.set('limit', '5');

    let metaRes;
    try {
      metaRes = await host.fetch(metadataUrl.href, { headers, signal });
    } catch (err) {
      if (signal.aborted) return [];
      throw host.fail('unreachable', `Failed to connect to Shelfmark: ${err.message}`);
    }

    if (!metaRes.ok) {
      if (metaRes.status === 401 || metaRes.status === 403) {
        throw host.fail('unauthorized', 'Shelfmark rejected authentication. Verify API key.');
      }
      throw host.fail('error', `Shelfmark search returned HTTP ${metaRes.status}`);
    }

    const metaData = await metaRes.json().catch(() => ({ books: [] }));
    const books = Array.isArray(metaData.books) ? metaData.books : [];

    if (books.length === 0) {
      return [];
    }

    const preferredFormat = (config.settings?.preferFormat || 'epub').toLowerCase();
    const releases = [];

    // Step 2: For top matching books, search available download releases
    for (const book of books.slice(0, 3)) {
      if (signal.aborted) break;

      const releasesUrl = new URL(`${baseUrl}/api/releases`);
      releasesUrl.searchParams.set('provider', book.provider);
      releasesUrl.searchParams.set('book_id', book.provider_id);
      releasesUrl.searchParams.set('title', book.title || query.title || '');
      releasesUrl.searchParams.set('author', (book.authors && book.authors[0]) || query.author || '');
      releasesUrl.searchParams.set('content_type', contentType);

      let relRes;
      try {
        relRes = await host.fetch(releasesUrl.href, { headers, signal });
      } catch (err) {
        if (signal.aborted) break;
        continue;
      }

      if (!relRes.ok) continue;

      const relData = await relRes.json().catch(() => ({ releases: [] }));
      const foundReleases = Array.isArray(relData)
        ? relData
        : Array.isArray(relData.releases)
          ? relData.releases
          : [];

      for (const rel of foundReleases) {
        const rawFormat = (rel.format || rel.extension || '').toLowerCase().replace(/^\./, '');
        const sizeBytes = toNumber(rel.size_bytes || rel.sizeBytes || rel.size);

        // Standard BookOrbit release record
        releases.push({
          guid: String(rel.source_id || rel.id || rel.guid || `${book.provider_id}-${releases.length}`),
          title: rel.title || book.title || query.title,
          bookTitle: book.title || query.title,
          author: (book.authors && book.authors.join(', ')) || query.author || null,
          format: rawFormat || null,
          sizeBytes,
          seeders: null,
          leechers: null,
          // If direct URL is present and user does not force local routing
          downloadUrl: rel.download_url || rel.url || null,
          freeleech: true,
          primaryFileCount: 1,
          extra: {
            releasePayload: rel,
            bookMetadata: book,
            source: rel.source,
            sourceId: rel.source_id || rel.id,
          },
        });

        if (releases.length >= (query.limit || MAX_RESULTS)) break;
      }

      if (releases.length >= (query.limit || MAX_RESULTS)) break;
    }

    // Rank results based on preferred format and availability
    return releases.sort((a, b) => {
      const aRank = rankFormat(a.format, preferredFormat);
      const bRank = rankFormat(b.format, preferredFormat);
      return aRank - bRank;
    });
  },

  /**
   * Resolves the downloadable file for an approved release.
   *
   * @param {object} release - Chosen BookOrbit release.
   * @param {object} config - Indexer configuration.
   * @param {object} host - BookOrbit host helper.
   * @returns {Promise<{url: string, fileName: string, sizeBytes?: number, format?: string}>}
   */
  async resolveFile(release, config, host) {
    const baseUrl = cleanUrl(config.baseUrl);
    const headers = makeHeaders(config);
    const downloadViaShelfmark = config.settings?.downloadViaShelfmark !== false;
    const directUrl = release.downloadUrl;

    // Fast path: if not downloading via Shelfmark and direct URL exists
    if (!downloadViaShelfmark && directUrl && directUrl.startsWith('http')) {
      return {
        url: directUrl,
        fileName: `${sanitizeFilename(release.title)}.${release.format || 'epub'}`,
        sizeBytes: release.sizeBytes,
        format: release.format || 'epub',
      };
    }

    const payload = release.extra?.releasePayload;
    if (!payload) {
      if (directUrl) {
        return {
          url: directUrl,
          fileName: `${sanitizeFilename(release.title)}.${release.format || 'epub'}`,
          sizeBytes: release.sizeBytes,
          format: release.format || 'epub',
        };
      }
      throw host.fail('error', `Release data for "${release.title}" is missing download information.`);
    }

    // Step 1: Queue the download in Shelfmark
    let queueRes;
    try {
      queueRes = await host.fetch(`${baseUrl}/api/releases/download`, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      throw host.fail('unreachable', `Could not trigger download in Shelfmark: ${err.message}`);
    }

    if (!queueRes.ok) {
      const errBody = await queueRes.text().catch(() => '');
      throw host.fail('error', `Shelfmark download request failed (${queueRes.status}): ${errBody}`);
    }

    // Step 2: Poll status until task is completed
    const sourceId = payload.source_id || payload.id;
    const timeoutSec = toNumber(config.settings?.pollTimeoutSeconds) || 180;
    const startTime = Date.now();
    let completedTaskId = null;

    while (Date.now() - startTime < timeoutSec * 1000) {
      await sleep(2500);

      try {
        const statusRes = await host.fetch(`${baseUrl}/api/status`, { headers });
        if (!statusRes.ok) continue;

        const statusData = await statusRes.json().catch(() => ({}));
        const completed = statusData.completed || {};
        const failed = statusData.failed || {};

        // Look for matching task in completed list
        for (const [taskId, task] of Object.entries(completed)) {
          if (
            taskId === sourceId ||
            task.source_id === sourceId ||
            (task.title && task.title === payload.title) ||
            task.book_id === sourceId
          ) {
            completedTaskId = taskId;
            break;
          }
        }

        if (completedTaskId) break;

        // Check if task failed
        for (const [taskId, task] of Object.entries(failed)) {
          if (
            taskId === sourceId ||
            task.source_id === sourceId ||
            (task.title && task.title === payload.title)
          ) {
            const reason = task.error || task.status || 'unknown error';
            throw host.fail('error', `Shelfmark reported download failed: ${reason}`);
          }
        }
      } catch (pollErr) {
        if (pollErr.code) throw pollErr; // Re-throw host.fail
        // Transient network issue while polling, retry
      }
    }

    // If completed in Shelfmark, return local download proxy URL
    if (completedTaskId) {
      const downloadUrl = `${baseUrl}/api/localdownload?id=${encodeURIComponent(completedTaskId)}`;
      return {
        url: downloadUrl,
        fileName: `${sanitizeFilename(release.title)}.${release.format || 'epub'}`,
        sizeBytes: release.sizeBytes,
        format: release.format || 'epub',
      };
    }

    // Fallback: if timeout exceeded, check if a direct URL exists
    if (directUrl && directUrl.startsWith('http')) {
      return {
        url: directUrl,
        fileName: `${sanitizeFilename(release.title)}.${release.format || 'epub'}`,
        sizeBytes: release.sizeBytes,
        format: release.format || 'epub',
      };
    }

    throw host.fail(
      'timeout',
      `Timed out waiting for Shelfmark to finish downloading "${release.title}" after ${timeoutSec} seconds.`
    );
  },
};

/** Helpers */

function cleanUrl(url) {
  if (!url) return 'http://localhost:8084';
  return String(url).trim().replace(/\/+$/, '');
}

function makeHeaders(config) {
  const headers = {
    Accept: 'application/json',
    'User-Agent': USER_AGENT,
  };
  const apiKey = config.settings?.apiKey;
  if (apiKey) {
    headers['X-Api-Key'] = apiKey;
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  return headers;
}

function rankFormat(format, preferred) {
  if (!format) return 99;
  const f = format.toLowerCase();
  if (preferred !== 'any' && f === preferred) return 0;
  const idx = FORMAT_PREFERENCE.indexOf(f);
  return idx === -1 ? 50 : idx + 1;
}

function sanitizeFilename(title) {
  return (
    String(title || 'book')
      .replace(/[^\p{L}\p{N}\s._-]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100) || 'book'
  );
}

function toNumber(val) {
  if (val === undefined || val === null || val === '') return null;
  const num = Number(val);
  return Number.isFinite(num) ? num : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
