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
  version: '1.0.2',
  update: {
    manifestUrl: 'https://raw.githubusercontent.com/hateitwtf/bookorbit-plugin-shelfmark/main/updates/shelfmark.json',
    ed25519PublicKey: 'CZDs4fE6KQAYxn_xkPUAfITp-n0vVECZ-WjVCu7h-e4',
  },
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
      key: 'releaseSource',
      type: 'string',
      label: 'Release Source',
      hint: 'Release source to query: all (both Libgen and Anna\'s Archive), libgen, or direct_download.',
      default: 'all',
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
  async test(config, host, signal) {
    try {
      const baseUrl = cleanUrl(config.baseUrl);
      const headers = makeHeaders(config);

      // Verify basic connectivity and health endpoint
      const response = await host.fetch(`${baseUrl}/api/health`, {
        headers,
        signal,
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
        signal,
      });

      if (!statusRes.ok) {
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
   * @param {AbortSignal} [signal] - Cancellation signal.
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
      if (signal?.aborted) return [];
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
    const source = (config.settings?.releaseSource || 'all').toLowerCase();
    const releases = [];
    const maxResults = query.limit || MAX_RESULTS;

    // Step 2: Search available download releases across top book metadata matches
    for (const book of books.slice(0, 2)) {
      if (signal?.aborted) break;

      const releasesUrl = new URL(`${baseUrl}/api/releases`);
      releasesUrl.searchParams.set('provider', book.provider);
      releasesUrl.searchParams.set('book_id', book.provider_id);
      releasesUrl.searchParams.set('title', book.title || query.title || '');
      releasesUrl.searchParams.set('author', (book.authors && book.authors[0]) || query.author || '');
      releasesUrl.searchParams.set('content_type', contentType);
      if (source && source !== 'all') {
        releasesUrl.searchParams.set('source', source);
      }

      let relRes;
      try {
        relRes = await host.fetch(releasesUrl.href, { headers, signal });
      } catch (err) {
        if (signal?.aborted) break;
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
        const directUrl = rel.download_url || rel.downloadUrl || rel.url || null;

        const payload = {
          source: rel.source,
          source_id: rel.source_id || rel.id,
          title: rel.title || book.title || query.title,
          format: rawFormat || 'epub',
        };

        // Standard BookOrbit release record.
        // We pack the payload into guid so BookOrbit's candidate sanitizer preserves it.
        releases.push({
          guid: JSON.stringify(payload),
          title: rel.title || book.title || query.title,
          bookTitle: book.title || query.title,
          author: (book.authors && book.authors.join(', ')) || query.author || null,
          format: rawFormat || null,
          sizeBytes,
          seeders: null,
          leechers: null,
          downloadUrl: directUrl,
          freeleech: true,
          primaryFileCount: 1,
          extra: {
            releasePayload: payload,
            bookMetadata: book,
            source: rel.source,
            sourceId: rel.source_id || rel.id,
          },
        });
      }
    }

    // Rank results based on preferred format and availability, then limit
    return releases
      .sort((a, b) => rankFormat(a.format, preferredFormat) - rankFormat(b.format, preferredFormat))
      .slice(0, maxResults);
  },

  /**
   * Resolves the downloadable file for an approved release.
   *
   * @param {object} release - Chosen BookOrbit release.
   * @param {object} config - Indexer configuration.
   * @param {object} host - BookOrbit host helper.
   * @param {AbortSignal} [signal] - Cancellation signal.
   * @returns {Promise<{url: string, fileName: string, sizeBytes?: number, format?: string, headers?: object}>}
   */
  async resolveFile(release, config, host, signal) {
    const baseUrl = cleanUrl(config.baseUrl);
    const headers = makeHeaders(config);
    const apiKey = config.settings?.apiKey;
    const downloadViaShelfmark = config.settings?.downloadViaShelfmark !== false;
    const directUrl = release.downloadUrl;

    // Reconstruct payload: first check extra, then try parsing guid (which we packed in search)
    let payload = release.extra?.releasePayload;
    if (!payload && release.guid) {
      try {
        payload = JSON.parse(release.guid);
      } catch (_) {
        // Guid was not JSON
      }
    }

    const resolvedFormat = (release.format || payload?.format || 'epub').toLowerCase();
    const fileName = `${sanitizeFilename(release.title)}.${resolvedFormat}`;

    // Fast path: if not downloading via Shelfmark and direct URL exists
    if (!downloadViaShelfmark && directUrl && directUrl.startsWith('http')) {
      return {
        url: directUrl,
        fileName,
        sizeBytes: release.sizeBytes,
        format: resolvedFormat,
      };
    }

    if (!payload || !payload.source || !payload.source_id) {
      if (directUrl && directUrl.startsWith('http')) {
        return {
          url: directUrl,
          fileName,
          sizeBytes: release.sizeBytes,
          format: resolvedFormat,
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
        signal,
      });
    } catch (err) {
      if (signal?.aborted) {
        throw host.fail('cancelled', 'Download request was cancelled.');
      }
      throw host.fail('unreachable', `Could not trigger download in Shelfmark: ${err.message}`);
    }

    if (!queueRes.ok) {
      const errBody = await queueRes.text().catch(() => '');
      throw host.fail('error', `Shelfmark download request failed (${queueRes.status}): ${errBody}`);
    }

    const queueData = await queueRes.json().catch(() => ({}));
    const queuedTaskId = queueData.task_id || queueData.taskId || queueData.id || null;

    // Step 2: Poll status until task is completed
    const sourceId = String(payload.source_id || payload.id);
    const timeoutSec = toNumber(config.settings?.pollTimeoutSeconds) || 180;
    const startTime = Date.now();
    let completedTaskId = null;

    while (Date.now() - startTime < timeoutSec * 1000) {
      if (signal?.aborted) {
        throw host.fail('cancelled', 'Download resolution was aborted.');
      }

      await sleep(2500);

      if (signal?.aborted) {
        throw host.fail('cancelled', 'Download resolution was aborted.');
      }

      try {
        const statusRes = await host.fetch(`${baseUrl}/api/status`, { headers, signal });
        if (!statusRes.ok) continue;

        const statusData = await statusRes.json().catch(() => ({}));
        // Shelfmark uses "complete" and "error" in its status response
        const completed = statusData.complete || statusData.completed || {};
        const failed = statusData.error || statusData.failed || {};

        // Helper to match a task entry against our queued task or payload
        const isTargetTask = (taskId, task) => {
          if (
            queuedTaskId &&
            (taskId === String(queuedTaskId) ||
              String(task.id) === String(queuedTaskId) ||
              String(task.task_id) === String(queuedTaskId))
          ) {
            return true;
          }
          if (
            sourceId &&
            (taskId === sourceId || String(task.source_id) === sourceId || String(task.id) === sourceId)
          ) {
            return true;
          }
          if (!sourceId && !queuedTaskId && task.title && task.title === payload.title) {
            const taskFormat = (task.format || '').toLowerCase();
            return !taskFormat || !payload.format || taskFormat === payload.format.toLowerCase();
          }
          return false;
        };

        // Look for matching task in completed list
        for (const [taskId, task] of Object.entries(completed)) {
          if (isTargetTask(taskId, task)) {
            completedTaskId = taskId;
            break;
          }
        }

        if (completedTaskId) break;

        // Check if task failed
        for (const [taskId, task] of Object.entries(failed)) {
          if (isTargetTask(taskId, task)) {
            const reason = task.error || task.status || 'unknown error';
            throw host.fail('error', `Shelfmark reported download failed: ${reason}`);
          }
        }
      } catch (pollErr) {
        if (pollErr.code) throw pollErr; // Re-throw host.fail
        if (signal?.aborted) {
          throw host.fail('cancelled', 'Download resolution was aborted.');
        }
        // Transient network issue while polling, retry
      }
    }

    // If completed in Shelfmark, return local download proxy URL
    if (completedTaskId) {
      let downloadUrl = `${baseUrl}/api/localdownload?id=${encodeURIComponent(completedTaskId)}`;
      if (apiKey) {
        downloadUrl += `&api_key=${encodeURIComponent(apiKey)}`;
      }
      return {
        url: downloadUrl,
        headers,
        fileName,
        sizeBytes: release.sizeBytes,
        format: resolvedFormat,
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
