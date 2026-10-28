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

const USER_AGENT = 'BookOrbit-Shelfmark-Plugin/1.4.1';

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
  version: '1.5.1',
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
      const response = await safeHostFetch(host, `${baseUrl}/api/health`, {
        headers,
      }, signal);

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
      const statusRes = await safeHostFetch(host, `${baseUrl}/api/status`, {
        headers,
      }, signal);

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
    // Support BookOrbit v3.5.0 PluginReleaseQuery contract (isbn13, isbn13s, isbn)
    const searchIsbn = extractIsbn(null, query);
    const metadataQuery = searchTitle || searchIsbn || searchAuthor;

    if (!metadataQuery) {
      return [];
    }

    const preferredFormat = (config.settings?.preferFormat || 'epub').toLowerCase();
    const source = (config.settings?.releaseSource || 'all').toLowerCase();
    const maxResults = query.limit || MAX_RESULTS;
    const releases = [];
    const seenReleaseKeys = new Set();
    const queriedKeys = new Set();

    const searchStartTime = Date.now();
    // BookOrbit v3.5.0 default search timeout is 90 seconds. Reserve a 15-second safety margin
    // to return validated results before host severs the connection.
    const SEARCH_BUDGET_MS = 75000;

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

      // Authentic author attribution:
      // Prefer authentic author reported by the release if present.
      // Otherwise fall back to validated book metadata author or searchAuthor.
      const releaseAuthor = toNaturalAuthor(rel.author);
      const metadataAuthor = Array.isArray(book?.authors)
        ? book.authors.map(toNaturalAuthor).filter(Boolean).join(', ')
        : toNaturalAuthor(book?.author);
      const displayAuthor = releaseAuthor || metadataAuthor || toNaturalAuthor(searchAuthor) || null;

      // Extract authentic ISBN
      const authenticIsbn = extractIsbn(book, query) || (rel.isbn ? String(rel.isbn).trim() : null);

      // Authentic book title:
      // Preserves authentic metadata book title or cleaned core release title.
      // Do NOT blindly substitute searchTitle when the release represents a different edition or title.
      const bookTitle = book?.title || extractCoreTitle(rel.title) || rel.title;

      releases.push({
        guid: JSON.stringify(payload),
        title: rel.title || book?.title || searchTitle,
        bookTitle,
        author: displayAuthor,
        isbn: authenticIsbn,
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

    // Helper to check if search has enough high-confidence results to stop expensive queries early
    const hasSufficientResults = () => {
      if (releases.length >= 3) {
        const matchingPref = releases.filter((r) => r.format === preferredFormat);
        if (matchingPref.length >= 2 || releases.length >= 5) {
          return true;
        }
      }
      return false;
    };

    // Helper to rank and slice releases for return
    const rankAndSlice = () => {
      return releases
        .sort((a, b) => {
          const rankDiff = rankFormat(a.format, preferredFormat) - rankFormat(b.format, preferredFormat);
          if (rankDiff !== 0) return rankDiff;
          return (b.sizeBytes || 0) - (a.sizeBytes || 0);
        })
        .slice(0, maxResults);
    };

    // Step 1: Query Shelfmark metadata search
    let books = [];
    let providerError = null;

    const metadataUrl = new URL(`${baseUrl}/api/metadata/search`);
    metadataUrl.searchParams.set('query', metadataQuery);
    metadataUrl.searchParams.set('content_type', 'ebook');
    metadataUrl.searchParams.set('limit', '25');

    try {
      const metaRes = await safeHostFetch(host, metadataUrl.href, { headers }, signal);
      if (metaRes.ok) {
        const metaData = await metaRes.json().catch(() => ({ books: [] }));
        books = Array.isArray(metaData.books) ? metaData.books : [];
      } else if (metaRes.status === 401 || metaRes.status === 403) {
        throw host.fail('unauthorized', 'Shelfmark rejected authentication. Verify API key.');
      } else {
        providerError = `Metadata search returned HTTP ${metaRes.status}`;
      }
    } catch (err) {
      if (signal?.aborted) {
        if (releases.length > 0) return rankAndSlice();
        throw classifyAbort(signal, host, 'Search was cancelled.');
      }
      if (err.code) throw err;
      providerError = err.message;
    }

    // Step 1 Fallback A: Known confident alternate title representations (e.g. "1984" -> "Nineteen Eighty-Four")
    if (books.length === 0 && searchTitle) {
      const normTitle = normalizeString(searchTitle);
      const equivalents = KNOWN_TITLE_EQUIVALENTS.get(normTitle);
      if (equivalents) {
        for (const eq of equivalents) {
          if (signal?.aborted || Date.now() - searchStartTime >= SEARCH_BUDGET_MS) break;
          const altMetaUrl = new URL(`${baseUrl}/api/metadata/search`);
          altMetaUrl.searchParams.set('query', eq);
          altMetaUrl.searchParams.set('content_type', 'ebook');
          altMetaUrl.searchParams.set('limit', '25');
          try {
            const altRes = await safeHostFetch(host, altMetaUrl.href, { headers }, signal);
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
        const isbnRes = await safeHostFetch(host, isbnMetaUrl.href, { headers }, signal);
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
      // Sort valid books by match quality: prioritize best metadata match
      validBooks.sort((a, b) => scoreBookMatch(b, searchTitle, searchAuthor) - scoreBookMatch(a, searchTitle, searchAuthor));

      // Loop through top books (prioritizing the best match), breaking early as soon as sufficient results found
      for (const book of validBooks.slice(0, 3)) {
        if (hasSufficientResults()) break;
        if (signal?.aborted || Date.now() - searchStartTime >= SEARCH_BUDGET_MS) break;

        const bookTitle = book.title || searchTitle;
        const coreTitle = extractCoreTitle(bookTitle);
        const naturalAuthor = toNaturalAuthor(
          (Array.isArray(book.authors) && book.authors[0]) || book.author || searchAuthor || ''
        );
        const isbn = extractIsbn(book, query);

        // Build list of titles to query: prioritize most promising title first!
        const titlesToQuery = [];
        const primaryTitle = searchTitle ? extractCoreTitle(searchTitle) : coreTitle;
        if (primaryTitle) titlesToQuery.push(primaryTitle);
        if (coreTitle && normalizeString(coreTitle) !== normalizeString(primaryTitle)) {
          titlesToQuery.push(coreTitle);
        }

        // Known title equivalents only added as fallback if needed
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
          if (hasSufficientResults()) break;
          if (signal?.aborted || Date.now() - searchStartTime >= SEARCH_BUDGET_MS) break;

          const queryKey = `${book.provider_id || ''}:${queryTitle.toLowerCase()}:${naturalAuthor.toLowerCase()}:${isbn || ''}`;
          if (queriedKeys.has(queryKey)) continue;
          queriedKeys.add(queryKey);

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
            relRes = await safeHostFetch(host, releasesUrl.href, { headers }, signal);
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
            // Strict author validation:
            // When release metadata specifies an author, it must match the requested author.
            // Never silently accept a release by a conflicting author (e.g. Michael Dean adaptation of Orwell).
            if (relAuthor) {
              const matchesReq = searchAuthor ? isAuthorMatch(relAuthor, searchAuthor) : true;
              const matchesBook = book?.authors || book?.author ? isAuthorMatch(relAuthor, book.authors || book.author) : true;
              if (!matchesReq || !matchesBook) {
                continue;
              }
            }
            if (searchAuthor && !relAuthor) {
              const byMatch = relTitle.split(/\s+by\s+/i);
              if (byMatch.length > 1 && !isAuthorMatch(byMatch[1], searchAuthor)) {
                continue;
              }
            }
            addRelease(rel, book);
          }
        }
      }
    } else if ((searchTitle || searchIsbn) && releases.length === 0) {
      // Step 2 Fallback: Direct search via /api/releases if metadata returned zero matches or failed
      const directTitles = searchTitle ? [extractCoreTitle(searchTitle)] : [''];
      if (searchTitle) {
        const normSearch = normalizeString(searchTitle);
        const eqSet = KNOWN_TITLE_EQUIVALENTS.get(normSearch) || [];
        for (const eq of eqSet) {
          if (!directTitles.some((t) => normalizeString(t) === normalizeString(eq))) {
            directTitles.push(eq);
          }
        }
      }

      const naturalSearchAuthor = toNaturalAuthor(searchAuthor);
      const queryIsbn = extractIsbn(null, query);

      for (const queryTitle of directTitles) {
        if (hasSufficientResults()) break;
        if (signal?.aborted || Date.now() - searchStartTime >= SEARCH_BUDGET_MS) break;

        const queryKey = `direct:${queryTitle.toLowerCase()}:${naturalSearchAuthor.toLowerCase()}:${queryIsbn || ''}`;
        if (queriedKeys.has(queryKey)) continue;
        queriedKeys.add(queryKey);

        const directRelUrl = new URL(`${baseUrl}/api/releases`);
        if (queryTitle) {
          directRelUrl.searchParams.set('title', queryTitle);
        }
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
          const directRelRes = await safeHostFetch(host, directRelUrl.href, { headers }, signal);
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
              if (searchTitle && !isTitleMatch(relTitle, searchTitle)) continue;
              if (searchAuthor && relAuthor && !isAuthorMatch(relAuthor, searchAuthor)) continue;
              if (searchAuthor && !relAuthor && !isAuthorMatch(relTitle, searchAuthor)) {
                // If release has no author and title has "by <Someone Else>", reject
                const byMatch = relTitle.split(/\s+by\s+/i);
                if (byMatch.length > 1 && !isAuthorMatch(byMatch[1], searchAuthor)) {
                  continue;
                }
              }
              addRelease(rel, null);
            }
          }
        } catch (err) {
          if (signal?.aborted) {
            if (releases.length > 0) return rankAndSlice();
            throw classifyAbort(signal, host, 'Search was cancelled.');
          }
          if (providerError && releases.length === 0) {
            throw host.fail('unreachable', `Shelfmark search failed: ${providerError}`);
          }
        }
      }
    }

    // Check deadline / cancellation state
    if (signal?.aborted) {
      if (releases.length > 0) return rankAndSlice();
      throw classifyAbort(signal, host, 'Search was cancelled.');
    }

    if (Date.now() - searchStartTime >= SEARCH_BUDGET_MS && releases.length === 0) {
      throw host.fail('timeout', `Shelfmark search timed out for "${searchTitle}".`);
    }

    return rankAndSlice();
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
    if (signal?.aborted) {
      throw classifyAbort(signal, host, 'Download resolution was cancelled before execution.');
    }

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

    // Single-flight with independent caller cancellation:
    // Multiple concurrent callers for the same release subscribe to a single background worker.
    // If one caller cancels, other callers continue uninterrupted.
    let entry = inFlightResolutions.get(releaseKey);
    if (entry && (entry.settled || entry.controller.signal.aborted)) {
      inFlightResolutions.delete(releaseKey);
      entry = null;
    }

    if (!entry) {
      const controller = new AbortController();
      const subscribers = new Set();
      entry = { controller, subscribers, settled: false };
      inFlightResolutions.set(releaseKey, entry);

      doResolveFile(
        release,
        payload,
        resolvedFormat,
        fileName,
        baseUrl,
        headers,
        apiKey,
        config,
        host,
        controller.signal
      )
        .then((result) => {
          entry.settled = true;
          inFlightResolutions.delete(releaseKey);
          for (const sub of entry.subscribers) {
            sub.signal?.removeEventListener?.('abort', sub.onAbort);
            try { sub.resolve(result); } catch (_) {}
          }
        })
        .catch((err) => {
          entry.settled = true;
          inFlightResolutions.delete(releaseKey);
          for (const sub of entry.subscribers) {
            sub.signal?.removeEventListener?.('abort', sub.onAbort);
            try { sub.reject(err); } catch (_) {}
          }
        })
        .finally(() => {
          entry.settled = true;
          if (inFlightResolutions.get(releaseKey) === entry) {
            inFlightResolutions.delete(releaseKey);
          }
        });
    }

    return new Promise((resolve, reject) => {
      if (entry.settled) {
        // In the rare event entry settled between retrieval and promise creation
        inFlightResolutions.delete(releaseKey);
        // Start a fresh resolution for this caller
        return resolve(
          doResolveFile(
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
          )
        );
      }

      const sub = { resolve, reject, signal };
      entry.subscribers.add(sub);

      const onAbort = () => {
        entry.subscribers.delete(sub);
        signal?.removeEventListener?.('abort', onAbort);
        reject(classifyAbort(signal, host, 'Download resolution was cancelled.'));
        if (entry.subscribers.size === 0) {
          entry.controller.abort();
          if (inFlightResolutions.get(releaseKey) === entry) {
            inFlightResolutions.delete(releaseKey);
          }
        }
      };

      sub.onAbort = onAbort;

      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener?.('abort', onAbort, { once: true });
    });
  },
};

/**
 * Internal worker for resolveFile logic.
 */
async function doResolveFile(release, payload, resolvedFormat, fileName, baseUrl, headers, apiKey, config, host, signal) {
  const configuredTimeout = toNumber(config.settings?.pollTimeoutSeconds) || 240;
  // Reserve a 15-second safety margin below host deadline (when deadline >= 30s) so plugin
  // can return cleanly before BookOrbit's host deadline aborts the request.
  const timeoutSec = configuredTimeout >= 30
    ? configuredTimeout - 15
    : configuredTimeout;
  const initialDelay = toNumber(config.settings?.pollIntervalMs) || 1000;
  const maxDelay = 5000;
  const backoffFactor = 1.5;
  const startTime = Date.now();

  let queuedTaskId = null;
  let preExistingCompletedIds = new Set();
  let preExistingActiveIds = new Set();
  let preExistingFailedIds = new Set();

  // Helper to validate whether /api/localdownload can actually serve the file on disk
  const isFileServable = async (taskId) => {
    const checkUrl = buildLocalDownloadUrl(baseUrl, taskId, apiKey);
    try {
      let res = await safeHostFetch(host, checkUrl, { method: 'HEAD', headers }, signal);
      if (res.status === 405 || !res.ok) {
        // Fallback to GET range check if HEAD is not supported by endpoint
        res = await safeHostFetch(host, checkUrl, {
          method: 'GET',
          headers: { ...headers, Range: 'bytes=0-0' },
        }, signal);
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
  // Snapshot existing tasks across active, queued, completed, and failed queues.
  try {
    const statusRes = await safeHostFetch(host, `${baseUrl}/api/status`, { headers }, signal);
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
      const failedTasks = {
        ...(statusData.error || {}),
        ...(statusData.failed || {}),
      };

      preExistingActiveIds = new Set(Object.keys(activeTasks));
      preExistingCompletedIds = new Set(Object.keys(completedTasks));
      preExistingFailedIds = new Set(Object.keys(failedTasks));

      // 1A. Check if an exact matching task is already active/queued -> adopt it!
      let matchingActive = Object.entries(activeTasks).filter(([id, task]) =>
        matchStrongTask(id, task, payload, resolvedFormat)
      );
      if (matchingActive.length === 0) {
        matchingActive = Object.entries(activeTasks).filter(([id, task]) =>
          matchTaskByDetails(task, payload, resolvedFormat)
        );
      }

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
        let matchingCompleted = Object.entries(completedTasks).filter(([id, task]) =>
          matchStrongTask(id, task, payload, resolvedFormat)
        );
        if (matchingCompleted.length === 0) {
          matchingCompleted = Object.entries(completedTasks).filter(([id, task]) =>
            matchTaskByDetails(task, payload, resolvedFormat)
          );
        }

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
      throw classifyAbort(signal, host, 'Download resolution was cancelled.');
    }
    if (statusErr.code) throw statusErr;
  }

  // Step 2: Queue the download in Shelfmark if not already adopted from active queue
  if (!queuedTaskId) {
    let queueRes;
    try {
      queueRes = await safeHostFetch(host, `${baseUrl}/api/releases/download`, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      }, signal);
    } catch (err) {
      if (signal?.aborted) {
        throw classifyAbort(signal, host, 'Download request was cancelled.');
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
        const refreshedRes = await safeHostFetch(host, `${baseUrl}/api/status`, { headers }, signal).catch(() => null);
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
          const failedTasks = {
            ...(refData.error || {}),
            ...(refData.failed || {}),
          };

          let matchedActive = Object.entries(activeTasks).filter(([id, task]) =>
            matchStrongTask(id, task, payload, resolvedFormat)
          );
          if (matchedActive.length === 0) {
            matchedActive = Object.entries(activeTasks).filter(([id, task]) =>
              matchTaskByDetails(task, payload, resolvedFormat)
            );
          }

          if (matchedActive.length === 1) {
            queuedTaskId = matchedActive[0][0];
          } else {
            let matchedCompleted = Object.entries(completedTasks).filter(([id, task]) =>
              matchStrongTask(id, task, payload, resolvedFormat)
            );
            if (matchedCompleted.length === 0) {
              matchedCompleted = Object.entries(completedTasks).filter(([id, task]) =>
                matchTaskByDetails(task, payload, resolvedFormat)
              );
            }

            if (matchedCompleted.length === 1) {
              const compId = matchedCompleted[0][0];
              const fileOk = await isFileServable(compId);
              if (fileOk) {
                return buildSuccessResult(compId);
              }
              throw host.fail(
                'error',
                `Shelfmark completed task file is missing on disk, but Shelfmark refused to re-download because the release is still tracked in its queue (${compId}). The completed task must be cleared in Shelfmark or container restarted.`
              );
            } else {
              // Check if a failed task is tracked by Shelfmark for this release
              let matchedFailed = Object.entries(failedTasks).filter(([id, task]) =>
                matchStrongTask(id, task, payload, resolvedFormat)
              );
              if (matchedFailed.length === 0) {
                matchedFailed = Object.entries(failedTasks).filter(([id, task]) =>
                  matchTaskByDetails(task, payload, resolvedFormat)
                );
              }
              if (matchedFailed.length === 1) {
                const [failedId, failedTask] = matchedFailed[0];
                throw host.fail(
                  'error',
                  `Shelfmark refused to queue download because a previous attempt failed (${failedId}: ${failedTask.error || failedTask.status || 'failed'}). The failed task must be cleared in Shelfmark or container restarted, or choose another release in BookOrbit.`
                );
              }
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
  let pollDelay = initialDelay;
  let completedTaskId = null;

  while (Date.now() - startTime < timeoutSec * 1000) {
    if (signal?.aborted) {
      throw classifyAbort(signal, host, 'Download resolution was cancelled.');
    }

    await sleep(pollDelay, signal);

    if (signal?.aborted) {
      throw classifyAbort(signal, host, 'Download resolution was cancelled.');
    }

    pollDelay = Math.min(Math.round(pollDelay * backoffFactor), maxDelay);

    let statusRes;
    try {
      statusRes = await safeHostFetch(host, `${baseUrl}/api/status`, { headers }, signal);
    } catch (pollErr) {
      if (signal?.aborted) {
        throw classifyAbort(signal, host, 'Download resolution was cancelled.');
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

    // --- CASE A: EXACT TASK ID IS KNOWN ---
    if (queuedTaskId) {
      const qIdStr = String(queuedTaskId);
      const isExactMatch = (id, task) =>
        id === qIdStr ||
        String(task?.id || '') === qIdStr ||
        String(task?.task_id || '') === qIdStr;

      // 1. Check if our exact task completed
      const exactCompletedEntry = Object.entries(completed).find(([id, task]) => isExactMatch(id, task));
      if (exactCompletedEntry) {
        completedTaskId = exactCompletedEntry[0];
        break;
      }

      // 2. Check if our exact task failed
      const exactFailedEntry = Object.entries(failed).find(([id, task]) => isExactMatch(id, task));
      if (exactFailedEntry) {
        const failedTask = exactFailedEntry[1];
        throw host.fail('error', `Shelfmark reported download failed: ${failedTask.error || failedTask.status || 'unknown error'}`);
      }

      // 3. If exact task is in active, it is still downloading -> continue polling
      const exactActiveEntry = Object.entries(active).find(([id, task]) => isExactMatch(id, task));
      if (exactActiveEntry) {
        continue;
      }

      // If exact task is not in any map yet, it might be in transition -> continue polling
      continue;
    }

    // --- CASE B: TASK ID WAS NOT RETURNED (CORRELATE NEWLY OBSERVED TASKS) ---
    // Ignore all historical pre-existing tasks to avoid contamination from past attempts
    const isNew = (id) => !preExistingActiveIds.has(id) && !preExistingCompletedIds.has(id) && !preExistingFailedIds.has(id);

    const newActive = Object.entries(active).filter(([id]) => isNew(id));
    const newCompleted = Object.entries(completed).filter(([id]) => isNew(id));
    const newFailed = Object.entries(failed).filter(([id]) => isNew(id));

    // B1. Try matching newly observed tasks using strong identifiers (source + source_id)
    const strongActive = newActive.filter(([id, task]) => matchStrongTask(id, task, payload, resolvedFormat));
    const strongCompleted = newCompleted.filter(([id, task]) => matchStrongTask(id, task, payload, resolvedFormat));
    const strongFailed = newFailed.filter(([id, task]) => matchStrongTask(id, task, payload, resolvedFormat));
    const totalStrong = strongActive.length + strongCompleted.length + strongFailed.length;

    if (totalStrong === 1) {
      if (strongCompleted.length === 1) {
        completedTaskId = strongCompleted[0][0];
        break;
      }
      if (strongFailed.length === 1) {
        throw host.fail('error', `Shelfmark reported download failed: ${strongFailed[0][1].error || 'unknown error'}`);
      }
      if (strongActive.length === 1) {
        queuedTaskId = strongActive[0][0];
        continue;
      }
    } else if (totalStrong > 1) {
      throw host.fail('error', `Ambiguous download match: multiple new tasks match "${release.title}".`);
    }

    // B2. If strong matching found nothing, evaluate newly observed tasks by title and format
    const isTitleFmtMatch = (task) => {
      const taskTitle = task.title || task.book_title || '';
      const targetTitle = payload.title || release.title || '';
      if (!taskTitle || !targetTitle || !isTitleMatch(taskTitle, targetTitle)) return false;
      const taskFmt = (task.format || '').toLowerCase().replace(/^\./, '');
      return !taskFmt || !resolvedFormat || taskFmt === resolvedFormat;
    };

    const titleActive = newActive.filter(([id, task]) => isTitleFmtMatch(task));
    const titleCompleted = newCompleted.filter(([id, task]) => isTitleFmtMatch(task));
    const titleFailed = newFailed.filter(([id, task]) => isTitleFmtMatch(task));
    const totalTitleMatches = titleActive.length + titleCompleted.length + titleFailed.length;

    if (totalTitleMatches === 1) {
      if (titleCompleted.length === 1) {
        completedTaskId = titleCompleted[0][0];
        break;
      }
      if (titleFailed.length === 1) {
        throw host.fail('error', `Shelfmark reported download failed: ${titleFailed[0][1].error || 'unknown error'}`);
      }
      if (titleActive.length === 1) {
        queuedTaskId = titleActive[0][0];
        continue;
      }
    } else if (totalTitleMatches > 1) {
      throw host.fail('error', `Ambiguous download match: multiple new tasks match "${release.title}".`);
    }

    // If no new tasks observed yet, continue polling
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
    `Timed out waiting for Shelfmark to finish downloading "${release.title}" after ${timeoutSec} seconds${queuedTaskId ? ` (task: ${queuedTaskId})` : ''}. The download may still be running in Shelfmark and can be adopted on retry.`
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
 * Supports BookOrbit v3.5.0 PluginReleaseQuery (isbn13, isbn13s, legacy isbn).
 */
function extractIsbn(book, query) {
  const candidates = [
    query?.isbn13,
    ...(Array.isArray(query?.isbn13s) ? query.isbn13s : [query?.isbn13s]),
    query?.isbn,
    ...(Array.isArray(book?.isbn_13) ? book.isbn_13 : [book?.isbn_13]),
    ...(Array.isArray(book?.isbn) ? book.isbn : [book?.isbn]),
    ...(Array.isArray(book?.isbn_10) ? book.isbn_10 : [book?.isbn_10]),
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
 * Detects derivative, adaptation, graded reader, graphic novel, collection,
 * or study guide / summary noise that should not be matched to single-work book queries.
 */
function isNoiseDerivative(candidateTitle, requestedTitle) {
  const normCand = normalizeString(candidateTitle);
  const normReq = normalizeString(requestedTitle);
  const noiseMarkers = [
    // Study guides & summaries
    'summary of',
    'study guide',
    'cliffsnotes',
    'sparknotes',
    'analysis of',
    'workbook for',
    'book summary',
    'companion to',
    'teacher guide',
    'teachers guide',
    'lesson plans',
    'activity guide',
    // Adaptations & abridgments
    'adapted by',
    'retold by',
    'simplified edition',
    'abridged',
    // Graded readers
    'graded reader',
    'oxford bookworms',
    'penguin active reading',
    'penguin readers',
    'macmillan readers',
    // Graphic novels & comics
    'graphic novel',
    'comic book',
    'illustrated novel',
    // Collections & boxed sets
    'complete works',
    'box set',
    'boxed set',
    'omnibus',
    'anthology',
  ];
  for (const marker of noiseMarkers) {
    if (normCand.includes(marker) && !normReq.includes(marker)) {
      return true;
    }
  }

  // Graded reader stage / level markers: e.g. "stage 1", "level 3"
  if (/\b(?:stage|level)\s*[1-6]\b/i.test(candidateTitle) && !/\b(?:stage|level)\s*[1-6]\b/i.test(requestedTitle)) {
    return true;
  }

  // Multi-work collections (e.g. "Animal Farm & 1984" when user searched only one of them)
  const hasAnimalFarm = normCand.includes('animal farm');
  const has1984 = normCand.includes('1984') || normCand.includes('nineteen eighty four');
  if (hasAnimalFarm && has1984) {
    const reqHasBoth =
      normReq.includes('animal farm') && (normReq.includes('1984') || normReq.includes('nineteen eighty four'));
    if (!reqHasBoth) {
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
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    };
    timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/**
 * Checks whether an AbortSignal was triggered by a timeout (e.g. AbortSignal.timeout(ms)).
 */
function isTimeoutSignal(signal) {
  if (!signal?.aborted) return false;
  const reason = signal.reason;
  if (!reason) return false;
  if (reason.name === 'TimeoutError') return true;
  const str = String(reason.message || reason).toLowerCase();
  return str.includes('timeout') || str.includes('timed out');
}

/**
 * Classifies an abort event into BookOrbit's valid failure codes (timeout vs error).
 * Note: 'cancelled' is NOT a valid BookOrbit PluginSearchFailure code.
 */
function classifyAbort(signal, host, fallbackMessage = 'Operation was cancelled.') {
  if (isTimeoutSignal(signal)) {
    return host.fail('timeout', 'Operation timed out before completion.');
  }
  return host.fail('error', fallbackMessage);
}

/**
 * Wrapper for BookOrbit's host.fetch that strictly conforms to PluginRequestInit
 * (which does not accept signal) while properly racing with the cancellation signal
 * and ensuring abort listeners are cleaned up immediately.
 */
function safeHostFetch(host, url, options = {}, signal) {
  if (signal?.aborted) {
    return Promise.reject(classifyAbort(signal, host, 'Request was aborted before execution.'));
  }

  const fetchOpts = {};
  if (options.method) fetchOpts.method = options.method;
  if (options.headers) fetchOpts.headers = options.headers;
  if (options.body) fetchOpts.body = options.body;

  const fetchPromise = host.fetch(url, fetchOpts);
  if (!signal) return fetchPromise;

  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(classifyAbort(signal, host, 'Request was cancelled during execution.'));
    };

    signal.addEventListener('abort', onAbort, { once: true });

    fetchPromise.then(
      (res) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(res);
      },
      (err) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}

/**
 * Matches an active or completed task by details (title, format, source)
 * when task ID is not a direct match or source_id is omitted by Shelfmark.
 */
function matchTaskByDetails(task, payload, resolvedFormat) {
  if (!task || !payload) return false;
  const taskTitle = task.title || task.book_title || '';
  const targetTitle = payload.title || '';
  if (!taskTitle || !targetTitle || !isTitleMatch(taskTitle, targetTitle)) return false;

  const taskFmt = (task.format || '').toLowerCase().replace(/^\./, '');
  if (taskFmt && resolvedFormat && taskFmt !== resolvedFormat.toLowerCase()) return false;

  const taskSource = (task.source || '').toLowerCase();
  const payloadSource = (payload.source || '').toLowerCase();
  if (taskSource && payloadSource && taskSource !== payloadSource) return false;

  return true;
}
