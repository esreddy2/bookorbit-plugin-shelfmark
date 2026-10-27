/**
 * Shelfmark indexer plugin for BookOrbit.
 *
 * Connects BookOrbit book requests to a self-hosted Shelfmark instance
 * (https://github.com/calibrain/shelfmark) via its REST API.
 *
 * Supports searching book metadata by title, validating title and author,
 * finding EPUB and PDF releases across configured sources (Anna's Archive, Libgen, etc.),
 * and routing downloads through Shelfmark's download pipeline.
 *
 * Single-file and dependency-free following BookOrbit's indexer plugin specification.
 */

const USER_AGENT = 'BookOrbit-Shelfmark-Plugin/1.1.0';

/** Fallback maximum number of releases to return per search. */
const MAX_RESULTS = 25;

/** Supported format preferences (prioritizing EPUB, supporting PDF). */
const FORMAT_PREFERENCE = ['epub', 'pdf'];

export default {
  apiVersion: 1,
  version: '1.1.0',
  update: {
    manifestUrl: 'https://raw.githubusercontent.com/esreddy2/bookorbit-plugin-shelfmark/main/updates/shelfmark.json',
    ed25519PublicKey: '-0aHVhXqg7cGaDchc2p1Y8tDnn8A7cJ0WREKspNv5Bc',
  },
  type: 'shelfmark',
  label: 'Shelfmark',
  mediaKinds: ['ebook'],
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
      hint: 'File format given priority in search ranking: epub or pdf.',
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
   * @param {AbortSignal} [signal] - Cancellation signal.
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

      // Check if status endpoint is accessible
      const statusRes = await host.fetch(`${baseUrl}/api/status`, {
        headers,
        signal,
      });

      if (statusRes.status === 401 || statusRes.status === 403) {
        return {
          success: false,
          error: 'Authentication failed on status endpoint. Check your Shelfmark API key.',
        };
      }

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

    // Shelfmark's Open Library metadata provider returns 0 results when title and author
    // are combined in the query string (e.g. "Little Fires Everywhere Celeste Ng").
    // Therefore, we query metadata by title only, and validate title and author afterwards.
    const searchTitle = (query.title || '').trim();
    const searchAuthor = (query.author || '').trim();
    const metadataQuery = searchTitle || searchAuthor;

    if (!metadataQuery) {
      return [];
    }

    // Step 1: Query Shelfmark metadata search by title
    const metadataUrl = new URL(`${baseUrl}/api/metadata/search`);
    metadataUrl.searchParams.set('query', metadataQuery);
    metadataUrl.searchParams.set('content_type', 'ebook');
    metadataUrl.searchParams.set('limit', '10');

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

    // Validate title and author: never automatically select a clearly incorrect book
    const validBooks = books.filter((book) => {
      const titleMatches = isTitleMatch(book.title, query.title);
      const authorMatches = isAuthorMatch(book.authors || book.author, query.author);
      return titleMatches && authorMatches;
    });

    if (validBooks.length === 0) {
      return [];
    }

    // Sort valid books by match quality
    validBooks.sort((a, b) => scoreBookMatch(b, query) - scoreBookMatch(a, query));

    const preferredFormat = (config.settings?.preferFormat || 'epub').toLowerCase();
    const source = (config.settings?.releaseSource || 'all').toLowerCase();
    const releases = [];
    const maxResults = query.limit || MAX_RESULTS;

    // Step 2: Search available download releases across top validated book metadata matches
    for (const book of validBooks.slice(0, 2)) {
      if (signal?.aborted) break;

      const releasesUrl = new URL(`${baseUrl}/api/releases`);
      releasesUrl.searchParams.set('provider', book.provider || 'openlibrary');
      releasesUrl.searchParams.set('book_id', book.provider_id || book.id || '');
      releasesUrl.searchParams.set('title', book.title || query.title || '');
      releasesUrl.searchParams.set(
        'author',
        (Array.isArray(book.authors) && book.authors[0]) || book.author || query.author || ''
      );
      releasesUrl.searchParams.set('content_type', 'ebook');
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
        // Detect format: support EPUB and PDF only (prioritizing EPUB)
        const rawFormat = (rel.format || rel.extension || '').toLowerCase().replace(/^\./, '');
        let detectedFormat = null;
        if (rawFormat === 'epub' || rawFormat === 'pdf') {
          detectedFormat = rawFormat;
        } else {
          const textToCheck = `${rel.title || ''} ${rel.download_url || ''}`.toLowerCase();
          if (textToCheck.includes('.epub') || textToCheck.includes('[epub]')) {
            detectedFormat = 'epub';
          } else if (textToCheck.includes('.pdf') || textToCheck.includes('[pdf]')) {
            detectedFormat = 'pdf';
          }
        }

        // Only include EPUB and PDF releases
        if (!detectedFormat) {
          continue;
        }

        const sizeBytes = toNumber(rel.size_bytes || rel.sizeBytes || rel.size);
        const directUrl = rel.download_url || rel.downloadUrl || rel.url || null;

        const payload = {
          source: rel.source,
          source_id: rel.source_id || rel.id,
          title: rel.title || book.title || query.title,
          format: detectedFormat,
        };

        // Standard BookOrbit release record
        releases.push({
          guid: JSON.stringify(payload),
          title: rel.title || book.title || query.title,
          bookTitle: book.title || query.title,
          author: (Array.isArray(book.authors) ? book.authors.join(', ') : book.author) || query.author || null,
          format: detectedFormat,
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

    // Rank results based on preferred format (epub prioritised by default) and limit
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

    // Reconstruct payload: first check extra, then try parsing guid
    let payload = release.extra?.releasePayload;
    if (!payload && release.guid) {
      try {
        payload = JSON.parse(release.guid);
      } catch (_) {
        // Guid was not JSON
      }
    }

    const rawFormat = (release.format || payload?.format || 'epub').toLowerCase();
    const resolvedFormat = rawFormat === 'pdf' ? 'pdf' : 'epub';
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

    // Snapshot pre-existing completed task IDs prior to triggering the download.
    // This guarantees we never match an old download from hours/days ago when task IDs are omitted.
    let preExistingCompletedIds = new Set();
    try {
      const initialStatusRes = await host.fetch(`${baseUrl}/api/status`, { headers, signal });
      if (initialStatusRes.ok) {
        const initialData = await initialStatusRes.json().catch(() => ({}));
        const initialCompleted = initialData.complete || initialData.completed || {};
        preExistingCompletedIds = new Set(Object.keys(initialCompleted));
      }
    } catch (err) {
      if (signal?.aborted) {
        throw host.fail('cancelled', 'Download resolution was aborted.');
      }
      // If initial status check fails, proceed with empty set
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
      if (queueRes.status === 401 || queueRes.status === 403) {
        throw host.fail('unauthorized', 'Shelfmark rejected authentication. Verify API key.');
      }
      const errBody = await queueRes.text().catch(() => '');
      throw host.fail('error', `Shelfmark download request failed (${queueRes.status}): ${errBody}`);
    }

    const queueData = await queueRes.json().catch(() => ({}));
    let queuedTaskId = queueData.task_id || queueData.taskId || queueData.id || null;

    // Step 2: Bounded polling with sensible backoff while this specific download is active
    const rawSourceId = payload.source_id || payload.id;
    const sourceId = rawSourceId ? String(rawSourceId) : null;
    const timeoutSec = toNumber(config.settings?.pollTimeoutSeconds) || 180;
    const startTime = Date.now();
    let completedTaskId = null;

    const initialDelay = toNumber(config.settings?.pollIntervalMs) || 1000;
    let pollDelay = initialDelay; // Start at 1s (or configured interval) for fast detection
    const maxDelay = 5000; // Cap backoff at 5s
    const backoffFactor = 1.5;

    while (Date.now() - startTime < timeoutSec * 1000) {
      if (signal?.aborted) {
        throw host.fail('cancelled', 'Download resolution was aborted.');
      }

      await sleep(pollDelay, signal);

      if (signal?.aborted) {
        throw host.fail('cancelled', 'Download resolution was aborted.');
      }

      pollDelay = Math.min(Math.round(pollDelay * backoffFactor), maxDelay);

      let statusRes;
      try {
        statusRes = await host.fetch(`${baseUrl}/api/status`, { headers, signal });
      } catch (pollErr) {
        if (signal?.aborted) {
          throw host.fail('cancelled', 'Download resolution was aborted.');
        }
        // Transient network issue while polling, retry on next tick
        continue;
      }

      if (!statusRes.ok) {
        if (statusRes.status === 401 || statusRes.status === 403) {
          throw host.fail('unauthorized', 'Shelfmark authentication failed while polling download status.');
        }
        continue;
      }

      const statusData = await statusRes.json().catch(() => ({}));
      const completed = statusData.complete || statusData.completed || {};
      const failed = statusData.error || statusData.failed || {};
      const active = statusData.active || statusData.queued || {};

      // Matcher helper function
      const isTargetTask = (taskId, task, checkPreExisting = true) => {
        // Priority 1: Exact queued task ID if known
        if (queuedTaskId) {
          if (
            taskId === String(queuedTaskId) ||
            String(task.id) === String(queuedTaskId) ||
            String(task.task_id) === String(queuedTaskId)
          ) {
            return true;
          }
        }

        // Priority 2: Exact source_id match
        if (sourceId) {
          if (
            taskId === sourceId ||
            String(task.source_id) === sourceId ||
            String(task.book_id) === sourceId ||
            String(task.id) === sourceId
          ) {
            return true;
          }
        }

        // Priority 3: Fallback title and format match when task ID was omitted by Shelfmark
        if (checkPreExisting && preExistingCompletedIds.has(taskId)) {
          return false; // Never match a task completed before this download started
        }

        const taskTitle = task.title || task.book_title || '';
        const targetTitle = payload.title || release.title || '';
        if (taskTitle && targetTitle && isTitleMatch(taskTitle, targetTitle)) {
          const taskFmt = (task.format || '').toLowerCase();
          return !taskFmt || !resolvedFormat || taskFmt === resolvedFormat;
        }

        return false;
      };

      // If queuedTaskId was omitted by Shelfmark, inspect active queue to lock in the taskId
      if (!queuedTaskId) {
        const activeMatches = [];
        for (const [taskId, task] of Object.entries(active)) {
          if (isTargetTask(taskId, task, false)) {
            activeMatches.push(taskId);
          }
        }
        if (activeMatches.length === 1) {
          queuedTaskId = activeMatches[0];
        }
      }

      // Check for failed tasks
      const matchingFailed = [];
      for (const [taskId, task] of Object.entries(failed)) {
        if (isTargetTask(taskId, task, true)) {
          matchingFailed.push(task.error || task.status || 'unknown error');
        }
      }
      if (matchingFailed.length === 1) {
        throw host.fail('error', `Shelfmark reported download failed: ${matchingFailed[0]}`);
      } else if (matchingFailed.length > 1) {
        throw host.fail('error', `Ambiguous download failure: multiple failed tasks match "${release.title}".`);
      }

      // Check for completed tasks
      const matchingCompleted = [];
      for (const [taskId, task] of Object.entries(completed)) {
        if (isTargetTask(taskId, task, true)) {
          matchingCompleted.push(taskId);
        }
      }

      if (matchingCompleted.length === 1) {
        completedTaskId = matchingCompleted[0];
        break;
      } else if (matchingCompleted.length > 1) {
        // Fail safely on ambiguous matches: never associate with the wrong book!
        throw host.fail(
          'error',
          `Ambiguous download match: multiple completed tasks match "${release.title}". Download aborted to prevent incorrect book association.`
        );
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
        headers: { ...headers, Accept: '*/*' },
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

function normalizeString(str) {
  if (!str) return '';
  return String(str)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getTokens(str) {
  return normalizeString(str)
    .split(' ')
    .filter((t) => t.length > 0);
}

function isTitleMatch(candidateTitle, requestedTitle) {
  if (!requestedTitle) return true;
  if (!candidateTitle) return false;

  const normCand = normalizeString(candidateTitle);
  const normReq = normalizeString(requestedTitle);
  if (!normCand || !normReq) return false;

  if (normCand === normReq) return true;
  if (normCand.startsWith(normReq) || normReq.startsWith(normCand)) return true;
  if (normCand.includes(normReq) || normReq.includes(normCand)) return true;

  const candTokens = getTokens(candidateTitle);
  const reqTokens = getTokens(requestedTitle);
  if (reqTokens.length === 0) return true;

  const matchingTokens = reqTokens.filter((t) => candTokens.includes(t));
  return matchingTokens.length / reqTokens.length >= 0.7;
}

function isAuthorMatch(candidateAuthors, requestedAuthor) {
  if (!requestedAuthor) return true;
  if (!candidateAuthors) return false;

  const authorList = Array.isArray(candidateAuthors)
    ? candidateAuthors
    : String(candidateAuthors).split(/[,;&]/);

  if (authorList.length === 0) return false;

  const reqNorm = normalizeString(requestedAuthor);
  const reqTokens = getTokens(requestedAuthor);
  if (reqTokens.length === 0) return true;

  for (const cand of authorList) {
    const candNorm = normalizeString(cand);
    const candTokens = getTokens(cand);
    if (candTokens.length === 0) continue;

    // Direct match or substring
    if (candNorm === reqNorm || candNorm.includes(reqNorm) || reqNorm.includes(candNorm)) {
      return true;
    }

    // Token set containment
    const matchingTokens = reqTokens.filter((t) => candTokens.includes(t));
    if (matchingTokens.length === reqTokens.length) {
      return true;
    }

    // Surname + initials / first name match
    const reqSurname = reqTokens[reqTokens.length - 1];
    if (candTokens.includes(reqSurname)) {
      if (reqTokens.length === 1) return true;
      const reqFirst = reqTokens[0];
      if (candTokens.some((t) => t === reqFirst || t.startsWith(reqFirst[0]) || reqFirst.startsWith(t[0]))) {
        return true;
      }
    }
  }

  return false;
}

function scoreBookMatch(book, query) {
  let score = 0;
  const normQueryTitle = normalizeString(query.title);
  const normBookTitle = normalizeString(book.title);
  if (normBookTitle === normQueryTitle) score += 50;
  else if (normBookTitle.startsWith(normQueryTitle)) score += 30;
  else if (normBookTitle.includes(normQueryTitle)) score += 20;

  if (query.author) {
    const normQueryAuthor = normalizeString(query.author);
    const authors = Array.isArray(book.authors) ? book.authors : [book.authors || ''];
    for (const a of authors) {
      const normA = normalizeString(a);
      if (normA === normQueryAuthor) {
        score += 50;
        break;
      } else if (normA.includes(normQueryAuthor) || normQueryAuthor.includes(normA)) {
        score += 25;
        break;
      }
    }
  }
  return score;
}

function rankFormat(format, preferred) {
  if (!format) return 99;
  const f = format.toLowerCase();
  if (preferred === 'pdf') {
    return f === 'pdf' ? 0 : f === 'epub' ? 1 : 99;
  }
  // Default: EPUB preferred
  return f === 'epub' ? 0 : f === 'pdf' ? 1 : 99;
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

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}
