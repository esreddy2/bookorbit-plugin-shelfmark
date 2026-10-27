/**
 * Shelfmark indexer plugin for BookOrbit.
 *
 * Connects BookOrbit book requests to a self-hosted Shelfmark instance
 * (https://github.com/calibrain/shelfmark) via its REST API.
 *
 * Supports searching book metadata by title, validating title and author,
 * finding EPUB and PDF releases across configured sources (Anna's Archive, Libgen, etc.),
 * adopting existing or active tasks, handling duplicate queue errors safely,
 * and routing downloads through Shelfmark's download pipeline.
 *
 * Single-file and dependency-free following BookOrbit's indexer plugin specification.
 */

const USER_AGENT = 'BookOrbit-Shelfmark-Plugin/1.2.0';

/** Fallback maximum number of releases to return per search. */
const MAX_RESULTS = 25;

/** Supported format preferences (prioritizing EPUB, supporting PDF). */
const FORMAT_PREFERENCE = ['epub', 'pdf'];

/** In-flight resolution cache to prevent concurrent requests from double-queueing. */
const inFlightResolutions = new Map();

/** Confident bidirectional title equivalents. */
const KNOWN_TITLE_EQUIVALENTS = new Map([
  ['1984', ['nineteen eighty four', 'nineteen eighty-four']],
  ['nineteen eighty four', ['1984']],
  ['nineteen eighty-four', ['1984']],
  ['2001', ['two thousand and one']],
  ['two thousand and one', ['2001']],
]);

export default {
  apiVersion: 1,
  version: '1.2.0',
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
      hint: 'Maximum time to wait for Shelfmark to finish downloading a release before timing out (default: 240).',
      default: 240,
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
        error: error instanceof Error ? sanitizeError(error.message, config.settings?.apiKey) : String(error),
      };
    }
  },

  /**
   * Search Shelfmark for book releases matching a query.
   *
   * @param {object} query - Search query object from BookOrbit (title, author, isbn, mediaKind, limit, etc.).
   * @param {object} config - Indexer configuration (baseUrl, settings).
   * @param {object} host - BookOrbit host helper.
   * @param {AbortSignal} [signal] - Cancellation signal.
   * @returns {Promise<Array<object>>} - List of BookOrbit release objects.
   */
  async search(query, config, host, signal) {
    const baseUrl = cleanUrl(config.baseUrl);
    const headers = makeHeaders(config);
    const apiKey = config.settings?.apiKey;

    // Convert inputs to strings safely to prevent type errors on numbers (e.g. 1984)
    const searchTitle = String(query?.title ?? '').trim();
    const searchAuthor = String(query?.author ?? '').trim();
    const searchIsbn = query?.isbn ? String(query.isbn).trim() : null;
    const metadataQuery = searchTitle || searchIsbn || searchAuthor;

    if (!metadataQuery) {
      return [];
    }

    const preferredFormat = (config.settings?.preferFormat || 'epub').toLowerCase();
    const source = (config.settings?.releaseSource || 'all').toLowerCase();
    const maxResults = query.limit || MAX_RESULTS;
    const releases = [];
    const seenReleaseKeys = new Set();

    // Helper to add release without duplicates or fabricated attributes
    const addRelease = (rel, book) => {
      const detectedFormat = detectFormat(rel.format || rel.extension, rel.title, rel.download_url);
      if (!detectedFormat) return;

      const relSource = rel.source || 'shelfmark';
      const relSourceId = String(rel.source_id || rel.id || '').trim();
      if (!relSourceId) return;

      const dedupKey = `${relSource.toLowerCase()}:${relSourceId.toLowerCase()}:${detectedFormat}`;
      if (seenReleaseKeys.has(dedupKey)) {
        return;
      }
      seenReleaseKeys.add(dedupKey);

      const sizeBytes = toNumber(rel.size_bytes || rel.sizeBytes || rel.size);
      const directUrl = rel.download_url || rel.downloadUrl || rel.url || null;

      const payload = {
        source: relSource,
        source_id: relSourceId,
        title: rel.title || book?.title || searchTitle,
        format: detectedFormat,
      };

      const authorList = Array.isArray(book?.authors)
        ? book.authors.map(toNaturalAuthor).filter(Boolean)
        : [toNaturalAuthor(book?.author)].filter(Boolean);
      const displayAuthor =
        authorList.length > 0
          ? authorList.join(', ')
          : toNaturalAuthor(rel.author) || toNaturalAuthor(searchAuthor) || null;

      releases.push({
        guid: JSON.stringify(payload),
        title: rel.title || book?.title || searchTitle,
        bookTitle: book?.title || searchTitle,
        author: displayAuthor,
        format: detectedFormat,
        sizeBytes,
        language: rel.language || book?.language || null,
        seeders: toNumber(rel.seeders),
        leechers: toNumber(rel.leechers),
        downloadUrl: directUrl,
        freeleech: typeof rel.freeleech === 'boolean' ? rel.freeleech : null,
        primaryFileCount: toNumber(rel.primaryFileCount ?? rel.file_count),
        extra: {
          releasePayload: payload,
          bookMetadata: book || null,
          source: relSource,
          sourceId: relSourceId,
        },
      });
    };

    // Step 1: Query Shelfmark metadata search
    let books = [];
    let providerError = null;

    const metadataUrl = new URL(`${baseUrl}/api/metadata/search`);
    metadataUrl.searchParams.set('query', metadataQuery);
    metadataUrl.searchParams.set('content_type', 'ebook');
    metadataUrl.searchParams.set('limit', '25');

    try {
      const metaRes = await host.fetch(metadataUrl.href, { headers, signal });
      if (metaRes.ok) {
        const metaData = await metaRes.json().catch(() => ({ books: [] }));
        books = Array.isArray(metaData.books) ? metaData.books : [];
      } else if (metaRes.status === 401 || metaRes.status === 403) {
        throw host.fail('unauthorized', 'Shelfmark rejected authentication. Verify API key.');
      } else {
        providerError = `Metadata search returned HTTP ${metaRes.status}`;
      }
    } catch (err) {
      if (signal?.aborted) return [];
      if (err.code) throw err;
      providerError = err.message;
    }

    // Step 1 Fallback A: Known confident alternate title representations (e.g. "1984" -> "Nineteen Eighty-Four")
    if (books.length === 0 && searchTitle) {
      const normTitle = normalizeString(searchTitle);
      const equivalents = KNOWN_TITLE_EQUIVALENTS.get(normTitle);
      if (equivalents) {
        for (const eq of equivalents) {
          if (signal?.aborted) break;
          const altMetaUrl = new URL(`${baseUrl}/api/metadata/search`);
          altMetaUrl.searchParams.set('query', eq);
          altMetaUrl.searchParams.set('content_type', 'ebook');
          altMetaUrl.searchParams.set('limit', '25');
          try {
            const altRes = await host.fetch(altMetaUrl.href, { headers, signal });
            if (altRes.ok) {
              const altData = await altRes.json().catch(() => ({ books: [] }));
              if (Array.isArray(altData.books) && altData.books.length > 0) {
                books = altData.books;
                break;
              }
            }
          } catch (_) {
            // Continue fallback
          }
        }
      }
    }

    // Step 1 Fallback B: ISBN search when title search returned empty
    if (books.length === 0 && searchIsbn && searchIsbn !== metadataQuery) {
      const isbnMetaUrl = new URL(`${baseUrl}/api/metadata/search`);
      isbnMetaUrl.searchParams.set('query', searchIsbn);
      isbnMetaUrl.searchParams.set('content_type', 'ebook');
      isbnMetaUrl.searchParams.set('limit', '10');
      try {
        const isbnRes = await host.fetch(isbnMetaUrl.href, { headers, signal });
        if (isbnRes.ok) {
          const isbnData = await isbnRes.json().catch(() => ({ books: [] }));
          if (Array.isArray(isbnData.books) && isbnData.books.length > 0) {
            books = isbnData.books;
          }
        }
      } catch (_) {
        // Continue fallback
      }
    }

    // Validate metadata books against title and author
    const validBooks = books.filter((book) => {
      const titleMatches = isTitleMatch(book.title, searchTitle);
      const authorMatches = isAuthorMatch(book.authors || book.author, searchAuthor);
      return titleMatches && authorMatches;
    });

    if (validBooks.length > 0) {
      // Sort valid books by match quality
      validBooks.sort((a, b) => scoreBookMatch(b, searchTitle, searchAuthor) - scoreBookMatch(a, searchTitle, searchAuthor));

      // Query releases across top matching books
      for (const book of validBooks.slice(0, 3)) {
        if (signal?.aborted) break;

        const bookTitle = book.title || searchTitle;
        const coreTitle = extractCoreTitle(bookTitle);
        const naturalAuthor = toNaturalAuthor(
          (Array.isArray(book.authors) && book.authors[0]) || book.author || searchAuthor || ''
        );
        const isbn = extractIsbn(book, query);

        // Build list of title variations to query for release providers
        const titlesToQuery = [coreTitle];

        // If the user's search title differs from book's core title, also query user's search title
        // e.g. user searched "1984", but Open Library matched "Nineteen Eighty-Four"
        if (searchTitle) {
          const coreSearch = extractCoreTitle(searchTitle);
          if (normalizeString(coreSearch) !== normalizeString(coreTitle)) {
            titlesToQuery.push(coreSearch);
          }
        }

        // Check known confident equivalents (e.g. "1984" <-> "Nineteen Eighty-Four")
        const normCore = normalizeString(coreTitle);
        const normSearch = normalizeString(searchTitle);
        const eqSet = new Set([
          ...(KNOWN_TITLE_EQUIVALENTS.get(normCore) || []),
          ...(KNOWN_TITLE_EQUIVALENTS.get(normSearch) || []),
        ]);
        for (const eq of eqSet) {
          if (!titlesToQuery.some((t) => normalizeString(t) === normalizeString(eq))) {
            titlesToQuery.push(eq);
          }
        }

        for (const queryTitle of titlesToQuery) {
          if (signal?.aborted) break;

          const releasesUrl = new URL(`${baseUrl}/api/releases`);
          releasesUrl.searchParams.set('provider', book.provider || 'openlibrary');
          releasesUrl.searchParams.set('book_id', book.provider_id || book.id || '');
          releasesUrl.searchParams.set('title', queryTitle);
          if (naturalAuthor) {
            releasesUrl.searchParams.set('author', naturalAuthor);
          }
          if (isbn) {
            releasesUrl.searchParams.set('isbn', isbn);
          }
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
            const relTitle = rel.title || '';
            const relAuthor = rel.author || '';
            if (relTitle && !isTitleMatch(relTitle, searchTitle) && !isTitleMatch(relTitle, book.title)) {
              continue;
            }
            if (relAuthor && searchAuthor && !isAuthorMatch(relAuthor, searchAuthor)) {
              continue;
            }
            addRelease(rel, book);
          }
        }
      }
    } else if (searchTitle) {
      // Step 2 Fallback: Direct search via /api/releases if metadata returned zero matches or failed
      const directTitles = [extractCoreTitle(searchTitle)];
      const normSearch = normalizeString(searchTitle);
      const eqSet = KNOWN_TITLE_EQUIVALENTS.get(normSearch) || [];
      for (const eq of eqSet) {
        if (!directTitles.some((t) => normalizeString(t) === normalizeString(eq))) {
          directTitles.push(eq);
        }
      }

      const naturalSearchAuthor = toNaturalAuthor(searchAuthor);
      const queryIsbn = extractIsbn(null, query);

      for (const queryTitle of directTitles) {
        if (signal?.aborted) break;

        const directRelUrl = new URL(`${baseUrl}/api/releases`);
        directRelUrl.searchParams.set('title', queryTitle);
        if (naturalSearchAuthor) {
          directRelUrl.searchParams.set('author', naturalSearchAuthor);
        }
        if (queryIsbn) {
          directRelUrl.searchParams.set('isbn', queryIsbn);
        }
        directRelUrl.searchParams.set('content_type', 'ebook');
        if (source && source !== 'all') {
          directRelUrl.searchParams.set('source', source);
        }

        try {
          const directRelRes = await host.fetch(directRelUrl.href, { headers, signal });
          if (directRelRes.ok) {
            const directData = await directRelRes.json().catch(() => ({ releases: [] }));
            const directReleases = Array.isArray(directData)
              ? directData
              : Array.isArray(directData.releases)
                ? directData.releases
                : [];

            for (const rel of directReleases) {
              const relTitle = rel.title || '';
              const relAuthor = rel.author || '';
              // Strictly validate title and author on direct releases
              if (!isTitleMatch(relTitle, searchTitle)) continue;
              if (searchAuthor && !isAuthorMatch(relAuthor || relTitle, searchAuthor)) continue;
              addRelease(rel, null);
            }
          }
        } catch (err) {
          if (signal?.aborted) return [];
          if (providerError) {
            throw host.fail('unreachable', `Shelfmark search failed: ${providerError}`);
          }
        }
      }
    }

    // Rank results based on preferred format and completeness
    return releases
      .sort((a, b) => {
        const rankDiff = rankFormat(a.format, preferredFormat) - rankFormat(b.format, preferredFormat);
        if (rankDiff !== 0) return rankDiff;
        // Secondary sort: prefer releases with reported size
        return (b.sizeBytes || 0) - (a.sizeBytes || 0);
      })
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

    // Release key for deduplicating concurrent in-flight requests in the same process
    const releaseKey = `${payload.source}:${payload.source_id}:${resolvedFormat}`;

    // If an identical release resolution is already in-flight, await it safely
    const inFlight = inFlightResolutions.get(releaseKey);
    if (inFlight) {
      try {
        return await raceWithSignal(inFlight, signal, host);
      } catch (_) {
        // If prior in-flight failed or aborted, continue to try fresh
      }
    }

    const executionPromise = doResolveFile(
      release,
      payload,
      resolvedFormat,
      fileName,
      baseUrl,
      headers,
      apiKey,
      config,
      host,
      signal
    );
    // Attach noop catch listener to prevent unhandled rejection warnings/exits
    executionPromise.catch(() => {});
    inFlightResolutions.set(releaseKey, executionPromise);

    try {
      return await executionPromise;
    } finally {
      inFlightResolutions.delete(releaseKey);
    }
  },
};

/**
 * Internal worker for resolveFile logic.
 */
async function doResolveFile(release, payload, resolvedFormat, fileName, baseUrl, headers, apiKey, config, host, signal) {
  const timeoutSec = toNumber(config.settings?.pollTimeoutSeconds) || 240;
  const initialDelay = toNumber(config.settings?.pollIntervalMs) || 1000;
  const maxDelay = 5000;
  const backoffFactor = 1.5;
  const startTime = Date.now();

  let queuedTaskId = null;
  let preExistingCompletedIds = new Set();

  // Helper to validate whether /api/localdownload can actually serve the file on disk
  const isFileServable = async (taskId) => {
    const checkUrl = buildLocalDownloadUrl(baseUrl, taskId, apiKey);
    try {
      let res = await host.fetch(checkUrl, { method: 'HEAD', headers, signal });
      if (res.status === 405 || !res.ok) {
        // Fallback to GET range check if HEAD is not supported by endpoint
        res = await host.fetch(checkUrl, {
          method: 'GET',
          headers: { ...headers, Range: 'bytes=0-0' },
          signal,
        });
      }
      return res.ok;
    } catch (err) {
      return false;
    }
  };

  // Helper to build successful local download response
  const buildSuccessResult = (taskId) => ({
    url: buildLocalDownloadUrl(baseUrl, taskId, apiKey),
    headers: { ...headers, Accept: '*/*' },
    fileName,
    sizeBytes: release.sizeBytes,
    format: resolvedFormat,
  });

  // Step 1: Pre-queue inspection of /api/status.
  // Inspect existing tasks across active, queued, and completed queues.
  try {
    const statusRes = await host.fetch(`${baseUrl}/api/status`, { headers, signal });
    if (statusRes.ok) {
      const statusData = await statusRes.json().catch(() => ({}));
      const activeTasks = {
        ...(statusData.queued || {}),
        ...(statusData.active || {}),
        ...(statusData.downloading || {}),
        ...(statusData.pending || {}),
      };
      const completedTasks = {
        ...(statusData.completed || {}),
        ...(statusData.complete || {}),
      };

      preExistingCompletedIds = new Set(Object.keys(completedTasks));

      // 1A. Check if an exact matching task is already active/queued -> adopt it!
      const matchingActive = Object.entries(activeTasks).filter(([id, task]) =>
        matchStrongTask(id, task, payload, resolvedFormat)
      );

      if (matchingActive.length === 1) {
        queuedTaskId = matchingActive[0][0];
      } else if (matchingActive.length > 1) {
        throw host.fail(
          'error',
          `Ambiguous active download match: multiple active tasks match release "${release.title}".`
        );
      }

      // 1B. If not active, check if an exact matching task is already completed -> reuse if file is present!
      if (!queuedTaskId) {
        const matchingCompleted = Object.entries(completedTasks).filter(([id, task]) =>
          matchStrongTask(id, task, payload, resolvedFormat)
        );

        if (matchingCompleted.length === 1) {
          const completedId = matchingCompleted[0][0];
          const hasFile = await isFileServable(completedId);
          if (hasFile) {
            return buildSuccessResult(completedId);
          }
          // If file is deleted on disk, do not return stale URL; continue to queue attempt
        } else if (matchingCompleted.length > 1) {
          throw host.fail(
            'error',
            `Ambiguous completed download match: multiple completed tasks match release "${release.title}".`
          );
        }
      }
    }
  } catch (statusErr) {
    if (signal?.aborted) {
      throw host.fail('cancelled', 'Download resolution was aborted.');
    }
    if (statusErr.code) throw statusErr;
  }

  // Step 2: Queue the download in Shelfmark if not already adopted from active queue
  if (!queuedTaskId) {
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
      throw host.fail('unreachable', `Could not trigger download in Shelfmark: ${sanitizeError(err.message, apiKey)}`);
    }

    if (!queueRes.ok) {
      if (queueRes.status === 401 || queueRes.status === 403) {
        throw host.fail('unauthorized', 'Shelfmark rejected authentication. Verify API key.');
      }

      const errText = await queueRes.text().catch(() => '');
      const isDuplicateQueue =
        queueRes.status === 500 &&
        (errText.includes('already in the download queue') || errText.includes('Release is already in the download queue'));

      if (isDuplicateQueue) {
        // Shelfmark duplicate-queue error: refresh status and try to adopt existing task
        const refreshedRes = await host.fetch(`${baseUrl}/api/status`, { headers, signal }).catch(() => null);
        if (refreshedRes && refreshedRes.ok) {
          const refData = await refreshedRes.json().catch(() => ({}));
          const activeTasks = {
            ...(refData.queued || {}),
            ...(refData.active || {}),
            ...(refData.downloading || {}),
            ...(refData.pending || {}),
          };
          const completedTasks = {
            ...(refData.completed || {}),
            ...(refData.complete || {}),
          };

          const matchedActive = Object.entries(activeTasks).filter(([id, task]) =>
            matchStrongTask(id, task, payload, resolvedFormat)
          );
          if (matchedActive.length === 1) {
            queuedTaskId = matchedActive[0][0];
          } else {
            const matchedCompleted = Object.entries(completedTasks).filter(([id, task]) =>
              matchStrongTask(id, task, payload, resolvedFormat)
            );
            if (matchedCompleted.length === 1) {
              const compId = matchedCompleted[0][0];
              const fileOk = await isFileServable(compId);
              if (fileOk) {
                return buildSuccessResult(compId);
              }
              throw host.fail(
                'error',
                `Shelfmark completed task file is missing on disk, but Shelfmark refused to re-download because the release is still tracked in its queue (${compId}). The completed task must be cleared in Shelfmark.`
              );
            }
          }
        }

        if (!queuedTaskId) {
          throw host.fail(
            'error',
            `Shelfmark reported release is already in download queue, but no matching task could be found to adopt.`
          );
        }
      } else {
        throw host.fail('error', `Shelfmark download request failed (${queueRes.status}): ${sanitizeError(errText, apiKey)}`);
      }
    } else {
      const queueData = await queueRes.json().catch(() => ({}));
      queuedTaskId = queueData.task_id || queueData.taskId || queueData.id || null;
    }
  }

  // Step 3: Bounded polling with sensible backoff while this specific download is active
  const rawSourceId = payload.source_id || payload.id;
  const sourceId = rawSourceId ? String(rawSourceId) : null;
  let pollDelay = initialDelay;
  let completedTaskId = null;

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
      continue;
    }

    if (!statusRes.ok) {
      if (statusRes.status === 401 || statusRes.status === 403) {
        throw host.fail('unauthorized', 'Shelfmark authentication failed while polling download status.');
      }
      continue;
    }

    const statusData = await statusRes.json().catch(() => ({}));
    const completed = { ...(statusData.complete || {}), ...(statusData.completed || {}) };
    const failed = { ...(statusData.error || {}), ...(statusData.failed || {}) };
    const active = { ...(statusData.active || {}), ...(statusData.queued || {}), ...(statusData.downloading || {}) };

    const isTargetTask = (taskId, task, checkPreExisting = true) => {
      // 1. Exact queuedTaskId match
      if (queuedTaskId) {
        if (
          taskId === String(queuedTaskId) ||
          String(task.id || '') === String(queuedTaskId) ||
          String(task.task_id || '') === String(queuedTaskId)
        ) {
          return true;
        }
      }

      // 2. Exact source_id match
      if (sourceId) {
        if (
          taskId === sourceId ||
          String(task.source_id || '') === sourceId ||
          String(task.book_id || '') === sourceId ||
          String(task.id || '') === sourceId
        ) {
          return true;
        }
      }

      // 3. Fallback title and format match when task ID and source ID are omitted
      if (checkPreExisting && preExistingCompletedIds.has(taskId)) {
        return false;
      }

      const taskTitle = task.title || task.book_title || '';
      const targetTitle = payload.title || release.title || '';
      if (taskTitle && targetTitle && isTitleMatch(taskTitle, targetTitle)) {
        const taskFmt = (task.format || '').toLowerCase().replace(/^\./, '');
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

    // Check failed tasks
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

    // Check completed tasks
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
      throw host.fail(
        'error',
        `Ambiguous download match: multiple completed tasks match "${release.title}". Download aborted to prevent incorrect book association.`
      );
    }
  }

  if (completedTaskId) {
    const fileAvailable = await isFileServable(completedTaskId);
    if (!fileAvailable) {
      throw host.fail(
        'error',
        'Shelfmark reports task completed, but the download file is missing or unreadable on disk.'
      );
    }
    return buildSuccessResult(completedTaskId);
  }

  throw host.fail(
    'timeout',
    `Timed out waiting for Shelfmark to finish downloading "${release.title}" after ${timeoutSec} seconds.`
  );
}

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

function buildLocalDownloadUrl(baseUrl, taskId, apiKey) {
  let url = `${baseUrl}/api/localdownload?id=${encodeURIComponent(taskId)}`;
  if (apiKey) {
    url += `&api_key=${encodeURIComponent(apiKey)}`;
  }
  return url;
}

function sanitizeError(msg, apiKey) {
  if (!msg) return '';
  let str = String(msg);
  if (apiKey) {
    str = str.replaceAll(apiKey, '[REDACTED]');
  }
  str = str.replace(/([?&]api_key=)[^&]+/gi, '$1[REDACTED]');
  return str;
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

/**
 * Normalizes author name strings to natural first-last name order.
 * E.g., "Orwell, George, 1903-1950" -> "George Orwell"
 *       "Bradbury, Ray" -> "Ray Bradbury"
 *       "Celeste Ng" -> "Celeste Ng"
 */
function toNaturalAuthor(author) {
  if (!author) return '';
  let s = String(author).trim();
  // Remove life dates like "1903-1950", "1920-", "(1920-2012)"
  s = s.replace(/\s*\(?\b\d{4}\s*[-–—]\s*\d{0,4}\b\)?/g, ' ').trim();
  // Remove parenthetical annotations like "(writer)", "(illustrator)"
  s = s.replace(/\s*\([^)]*\)/g, ' ').trim();
  // Remove trailing punctuation
  s = s.replace(/[,.;]+$/, '').trim();
  if (s.includes(',')) {
    const parts = s.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length === 2) {
      const [last, first] = parts;
      if (!/^(jr|sr|ii|iii|iv|v|phd|md|esq)\.?$/i.test(first)) {
        return `${first} ${last}`.trim();
      }
    }
  }
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Extracts a clean 10 or 13 digit ISBN from metadata or search query.
 */
function extractIsbn(book, query) {
  const candidates = [
    ...(Array.isArray(book?.isbn) ? book.isbn : [book?.isbn]),
    ...(Array.isArray(book?.isbn_13) ? book.isbn_13 : [book?.isbn_13]),
    ...(Array.isArray(book?.isbn_10) ? book.isbn_10 : [book?.isbn_10]),
    query?.isbn,
  ];
  for (const cand of candidates) {
    if (!cand) continue;
    const cleaned = String(cand).replace(/[^0-9Xx]/g, '').trim();
    if (cleaned.length === 10 || cleaned.length === 13) {
      return cleaned;
    }
  }
  return null;
}

/**
 * Detects derivative / study guide / summary noise that should not match book titles.
 */
function isNoiseDerivative(candidateTitle, requestedTitle) {
  const normCand = normalizeString(candidateTitle);
  const normReq = normalizeString(requestedTitle);
  const noiseMarkers = [
    'summary of',
    'study guide',
    'cliffsnotes',
    'analysis of',
    'workbook for',
    'book summary',
    'companion to',
    'sparknotes',
  ];
  for (const marker of noiseMarkers) {
    if (normCand.includes(marker) && !normReq.includes(marker)) {
      return true;
    }
  }
  return false;
}

function extractCoreTitle(title) {
  if (!title) return '';
  let s = String(title).trim();
  // Remove bracketed tags like [EPUB], [PDF] and parentheticals like (Retail), (Signet)
  s = s.replace(/\s*\[[^\]]*\]\s*/g, ' ').replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  // Remove trailing download keywords (e.g. from OceanofPDF titles)
  s = s.replace(/\s+download\b/gi, '').trim();
  // Split on " by " if it separates title from author (e.g. "1984 by George Orwell")
  const byMatch = s.split(/\s+by\s+/i);
  if (byMatch.length > 1 && byMatch[0].trim().length >= 2) {
    s = byMatch[0].trim();
  }
  // Split on subtitle and series delimiters (colons, semicolons, slashes, pipes, or spaced dashes)
  const parts = s.split(/(?:\s+[-–—]\s+|[:;/|]|\s*[–—]\s*)/);
  const core = parts[0]?.trim();
  return core && core.length >= 2 ? core : s;
}

function isTitleMatch(candidateTitle, requestedTitle) {
  if (!requestedTitle) return true;
  if (!candidateTitle) return false;

  if (isNoiseDerivative(candidateTitle, requestedTitle)) {
    return false;
  }

  const normCand = normalizeString(candidateTitle);
  const normReq = normalizeString(requestedTitle);
  if (!normCand || !normReq) return false;

  if (normCand === normReq) return true;
  if (normCand.startsWith(normReq) || normReq.startsWith(normCand)) return true;
  if (normCand.includes(normReq) || normReq.includes(normCand)) return true;

  // Check confident equivalents (e.g. 1984 vs Nineteen Eighty-Four)
  const equivalents = KNOWN_TITLE_EQUIVALENTS.get(normReq);
  if (equivalents) {
    for (const eq of equivalents) {
      const normEq = normalizeString(eq);
      if (normCand === normEq || normCand.startsWith(normEq) || normCand.includes(normEq)) {
        return true;
      }
    }
  }

  const candEquivalents = KNOWN_TITLE_EQUIVALENTS.get(normCand);
  if (candEquivalents) {
    for (const eq of candEquivalents) {
      const normEq = normalizeString(eq);
      if (normReq === normEq || normReq.startsWith(normEq) || normReq.includes(normEq)) {
        return true;
      }
    }
  }

  // Check core title match (e.g. "Animal Farm: A Fairy Story" vs "Animal Farm")
  const coreCand = normalizeString(extractCoreTitle(candidateTitle));
  const coreReq = normalizeString(extractCoreTitle(requestedTitle));
  if (coreCand && coreReq && (coreCand === coreReq || coreCand === normReq || normCand === coreReq)) {
    return true;
  }

  const candTokens = getTokens(candidateTitle);
  const reqTokens = getTokens(requestedTitle);
  if (reqTokens.length === 0) return true;

  const matchingTokens = reqTokens.filter((t) => candTokens.includes(t));
  return matchingTokens.length / reqTokens.length >= 0.7;
}

function isAuthorMatch(candidateAuthors, requestedAuthor) {
  if (!requestedAuthor) return true;
  if (!candidateAuthors) return false;

  const rawList = Array.isArray(candidateAuthors)
    ? candidateAuthors
    : String(candidateAuthors).split(/[;&]/);

  const authorList = rawList.map((a) => toNaturalAuthor(a)).filter(Boolean);
  if (authorList.length === 0) return false;

  const reqNorm = normalizeString(toNaturalAuthor(requestedAuthor));
  const reqTokens = getTokens(reqNorm);
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

    // Transposed author match
    const candSurname = candTokens[0];
    if (reqTokens.includes(candSurname)) {
      if (candTokens.length === 1) return true;
      const candFirst = candTokens[candTokens.length - 1];
      const reqFirst = reqTokens[0];
      if (reqTokens.some((t) => t === candFirst || t.startsWith(candFirst[0]) || candFirst.startsWith(t[0]))) {
        return true;
      }
    }
  }

  return false;
}

function matchStrongTask(taskId, task, payload, resolvedFormat) {
  if (!task || !payload) return false;
  const sourceId = String(payload.source_id || payload.id || '').trim();
  if (!sourceId) return false;

  const idMatches =
    String(taskId) === sourceId ||
    String(task.source_id || '') === sourceId ||
    String(task.book_id || '') === sourceId ||
    String(task.id || '') === sourceId ||
    String(task.task_id || '') === sourceId;

  if (!idMatches) return false;

  const taskFmt = (task.format || '').toLowerCase().replace(/^\./, '');
  if (taskFmt && resolvedFormat && taskFmt !== resolvedFormat.toLowerCase()) return false;

  const taskSource = (task.source || '').toLowerCase();
  const payloadSource = (payload.source || '').toLowerCase();
  if (taskSource && payloadSource && taskSource !== payloadSource) return false;

  return true;
}

function scoreBookMatch(book, searchTitle, searchAuthor) {
  let score = 0;
  const normQueryTitle = normalizeString(searchTitle);
  const normBookTitle = normalizeString(book.title);
  if (normBookTitle === normQueryTitle) score += 50;
  else if (normBookTitle.startsWith(normQueryTitle)) score += 30;
  else if (normBookTitle.includes(normQueryTitle)) score += 20;

  if (searchAuthor) {
    const normQueryAuthor = normalizeString(toNaturalAuthor(searchAuthor));
    const authors = Array.isArray(book.authors) ? book.authors : [book.authors || ''];
    for (const a of authors) {
      const normA = normalizeString(toNaturalAuthor(a));
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

function detectFormat(formatVal, titleVal, urlVal) {
  const raw = String(formatVal || '').toLowerCase().replace(/^\./, '').trim();
  if (raw === 'epub' || raw === 'pdf') return raw;
  if (raw.includes('epub')) return 'epub';
  if (raw.includes('pdf')) return 'pdf';

  const textToCheck = `${titleVal || ''} ${urlVal || ''}`.toLowerCase();
  if (textToCheck.includes('.epub') || textToCheck.includes('[epub]')) return 'epub';
  if (textToCheck.includes('.pdf') || textToCheck.includes('[pdf]')) return 'pdf';
  return null;
}

function rankFormat(format, preferred) {
  if (!format) return 99;
  const f = format.toLowerCase();
  if (preferred === 'pdf') {
    return f === 'pdf' ? 0 : f === 'epub' ? 1 : 99;
  }
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

function raceWithSignal(promise, signal, host) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(host.fail('cancelled', 'Download resolution was cancelled.'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(host.fail('cancelled', 'Download resolution was cancelled.'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (res) => {
        signal.removeEventListener('abort', onAbort);
        resolve(res);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}
