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

const USER_AGENT = 'BookOrbit-Shelfmark-Plugin/1.7.6';

/** Fallback maximum number of releases to return per search. */
const MAX_RESULTS = 25;

/** Supported format preferences (prioritizing EPUB, supporting PDF). */
const FORMAT_PREFERENCE = ['epub', 'pdf'];

/** In-flight resolution cache to prevent concurrent requests from double-queueing. */
const inFlightResolutions = new Map();

/** Confident bidirectional title equivalents. */
export default {
  apiVersion: 1,
  version: '1.7.6',
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
    {
      key: 'pollIntervalMs',
      type: 'number',
      label: 'Poll Interval (ms)',
      hint: 'Interval between status polls while waiting for a download (default: 1000).',
      default: 1000,
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
      try { await response.json(); } catch (_) {
        return { success: false, error: 'Shelfmark returned invalid JSON.' };
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
    const requestedYear = toNumber(query?.year ?? query?.publicationYear ?? query?.publishYear ?? query?.publishedYear ?? query?.publish_year);
    const requestedLanguage = (query?.language ?? query?.lang) || 'English';
    const metadataQuery = searchTitle || searchIsbn || searchAuthor;

    if (!metadataQuery) {
      return [];
    }

    const preferredFormat = (config.settings?.preferFormat || 'epub').toLowerCase();
    const source = (config.settings?.releaseSource || 'all').toLowerCase();
    const maxResults = (Number.isInteger(query?.limit) && query.limit > 0) ? query.limit : MAX_RESULTS;
    const releases = [];
    const seenReleaseKeys = new Set();
    const queriedKeys = new Set();

    const searchStartTime = Date.now();
    // BookOrbit v3.5.0 default search timeout is 90 seconds. Reserve a 15-second safety margin
    // to return validated results before host severs the connection.
    const SEARCH_BUDGET_MS = 75000;

    // Helper to add release without duplicates or fabricated attributes
    const addRelease = (rel, book) => {
      const detectedFormat = detectFormat(rel.format || rel.extension || rel.extra?.format || rel.extra?.formats || rel.extra?.formats_display, rel.title, `${rel.download_url || ''} ${rel.info_url || ''} ${rel.url || ''}`);
      if (!detectedFormat) return;

      const relSource = rel.source ? String(rel.source).trim() : '';
      if (!relSource) return;
      const relSourceId = String(rel.source_id || rel.id || '').trim();
      if (!relSourceId) return;

      const dedupKey = `${relSource.toLowerCase()}:${relSourceId.toLowerCase()}:${detectedFormat}`;
      if (seenReleaseKeys.has(dedupKey)) {
        return;
      }

      const sizeBytes = parseSizeBytes(rel.size_bytes ?? rel.sizeBytes ?? rel.size);
      const directUrl = rel.download_url || rel.downloadUrl || rel.url || null;
      const infoUrl = rel.info_url || rel.infoUrl || null;
      const sourcePageUrl = infoUrl || directUrl || null;

      const payload = {
        source: String(relSource),
        source_id: String(relSourceId),
        title: String(rel.title || book?.title || searchTitle || ''),
        format: detectedFormat,
        content_type: 'ebook',
        protocol: rel.protocol ? String(rel.protocol).trim() : 'http',
        indexer: rel.indexer ? String(rel.indexer).trim() : 'BookOrbit-Shelfmark-Plugin',
        seeders: toNumber(rel.seeders),
        size: rel.size != null ? String(rel.size) : null,
        size_bytes: sizeBytes,
        extra: rel.extra || null,
      };
      if (directUrl) payload.download_url = directUrl;
      if (infoUrl) payload.info_url = infoUrl;
      if (sourcePageUrl) payload.source_url = sourcePageUrl;

      // Preserve the release's page/download URLs using Shelfmark's accepted field names.
      // OceanofPDF (and other direct-download providers) require this page URL to queue.

      // Authentic author attribution:
      // Prefer authentic author reported by the release if present.
      // Otherwise fall back to validated book metadata author or searchAuthor.
      const releaseAuthor = toNaturalAuthor(rel.extra?.author || rel.extra?.Author);
      const metadataAuthor = Array.isArray(book?.authors)
        ? book.authors.map(toNaturalAuthor).filter(Boolean).join(', ')
        : toNaturalAuthor(book?.author);
      const displayAuthor = releaseAuthor || metadataAuthor || null;

      // Extract authentic ISBN
      // Never claim a release has the request's ISBN without independent evidence.
      // Preserve the release's own ISBN (or metadata book ISBN), never the query ISBN.
      // Never use the parent catalog ISBN as proof of a release's edition: only the
      // release's own ISBN (or EPUB metadata discovered later) is authentic.
      const authenticIsbn = (rel.isbn ? String(rel.isbn).trim() : null) || (rel.extra?.isbn ? String(rel.extra.isbn).trim() : null) || (rel.extra?.isbn13 ? String(rel.extra.isbn13).trim() : null);
      if (searchIsbn && authenticIsbn && !sameIsbn(searchIsbn, authenticIsbn)) {
        const metaPairs = collectMetadataIsbnPairs(book);
        const counterpartVerified = metaPairs.some(([x, y]) => {
          const nx = normalizeIsbn(x);
          const ny = normalizeIsbn(y);
          const a = normalizeIsbn(searchIsbn);
          const b = normalizeIsbn(authenticIsbn);
          return (nx === a && ny === b) || (nx === b && ny === a) || (sameIsbn(nx, a) && sameIsbn(ny, b)) || (sameIsbn(nx, b) && sameIsbn(ny, a));
        });
        if (!counterpartVerified) return;
      }
      const releaseYear = parsePositiveIntLocal(rel.year || rel.publish_year || rel.publication_year || rel.published_year || rel.publicationYear || rel.publishedYear || rel.extra?.year || rel.extra?.publish_year || rel.extra?.publication_year || null);
      if (requestedYear && releaseYear && requestedYear !== releaseYear) return;
      payload.author = displayAuthor || null;
      payload.year = releaseYear;
      payload.language = rel.language || rel.extra?.language || null;
      // Reject known language mismatches; unknown stays unknown.
      if (requestedLanguage && payload.language) {
        const reqCode = normalizeLanguageCode(requestedLanguage);
        const relCode = normalizeLanguageCode(payload.language);
        if (reqCode && relCode && reqCode !== relCode) return;
      }

      payload.isbn = authenticIsbn || null;
      payload.size_bytes = sizeBytes;
      if (payload.size != null) {
        payload.size = String(payload.size);
      } else {
        payload.size = null;
      }

      // Authentic book title:
      // Preserves authentic metadata book title or cleaned core release title.
      // Do NOT blindly substitute searchTitle when the release represents a different edition or title.
      const bookTitle = book?.title || extractCoreTitle(rel.title) || rel.title;

      seenReleaseKeys.add(dedupKey);
      releases.push({
        guid: JSON.stringify(payload),
        title: rel.title || book?.title || searchTitle,
        bookTitle,
        author: displayAuthor,
        isbn: authenticIsbn,
        format: detectedFormat,
        year: releaseYear,
        sizeBytes,
        language: rel.language || rel.extra?.language || null,
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

    const scoreEditionTier = (r) => {
      if (!searchIsbn && !requestedYear) return 0;
      const hasIsbnMatch = Boolean(searchIsbn && r.isbn && (sameIsbn(searchIsbn, r.isbn) || areVerifiedCounterparts(searchIsbn, r.isbn, r?.extra?.bookMetadata, r)));
      const hasYearMatch = Boolean(requestedYear && r.year && r.year === requestedYear);
      if (hasIsbnMatch && hasYearMatch) return 0;
      if (hasIsbnMatch || hasYearMatch) return 1;
      return 2;
    };

    // Helper to rank and slice releases for return
    const rankAndSlice = () => {
      return releases
        .sort((a, b) => {
          const rankDiff = rankFormat(a.format, preferredFormat) - rankFormat(b.format, preferredFormat);
          if (rankDiff !== 0) return rankDiff;
          const tierDiff = scoreEditionTier(a) - scoreEditionTier(b);
          if (tierDiff !== 0) return tierDiff;
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
        books = Array.isArray(metaData.books) ? metaData.books : (Array.isArray(metaData.items) ? metaData.items : (Array.isArray(metaData.results) ? metaData.results : []));
      } else if (metaRes.status === 401 || metaRes.status === 403) {
        throw host.fail('error', 'Shelfmark rejected authentication. Verify API key.');
      } else {
        providerError = `Metadata search returned HTTP ${metaRes.status}`;
      }
    } catch (err) {
      if (signal?.aborted) {
        if (releases.length > 0) return rankAndSlice();
        throw classifyAbort(signal, host, 'Search was cancelled.');
      }
      if (err && err.code) throw err;
      providerError = (err && err.message) ? err.message : String(err ?? 'unknown error');
    }

    // Step 1 Fallback A: Known confident alternate title representations (e.g. "1984" -> "Nineteen Eighty-Four")
    const hasValidCandidates = (bs) => Array.isArray(bs) && bs.some((b) => isTitleMatch(b.search_title || b.title || b.name, searchTitle) && isAuthorMatch(b.search_author || b.authors || b.author, searchAuthor));
    if (searchTitle && (!books.length || !hasValidCandidates(books))) {
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
    if (searchIsbn && searchIsbn !== metadataQuery && (!books.length || !hasValidCandidates(books))) {
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
      const bookTitle = book.search_title || book.title || book.name;
      const bookAuthors = book.search_author || book.authors || book.author;
      const bookYear = toNumber(book.year ?? book.publish_year ?? book.publication_year ?? book.published_year ?? book.publishYear ?? book.publicationYear);
      const titleMatches = isTitleMatch(bookTitle, searchTitle);
      const authorMatches = isAuthorMatch(bookAuthors, searchAuthor);
      // Metadata publication year may represent the original work while the
      // request targets a modern edition; do not eliminate candidates on year.
      return titleMatches && authorMatches;
    });

    if (validBooks.length > 0) {
      // Sort valid books by match quality: prioritize best metadata match
      validBooks.sort((a, b) => scoreBookMatch(b, searchTitle, searchAuthor) - scoreBookMatch(a, searchTitle, searchAuthor));

      // Loop through top books (prioritizing the best match), breaking early as soon as sufficient results found
      for (const book of validBooks.slice(0, 3)) {
        if (hasSufficientResults()) break;
        if (signal?.aborted || Date.now() - searchStartTime >= SEARCH_BUDGET_MS) break;

        const bookTitle = book.search_title || book.title || searchTitle;
        const coreTitle = extractCoreTitle(bookTitle);
        const bookAuthors = book.search_author || book.authors || book.author;
        const naturalAuthor = toNaturalAuthor(
          (Array.isArray(bookAuthors) && bookAuthors[0]) || bookAuthors || searchAuthor || ''
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

          const fetchBookReleases = async (useIsbn) => {
            const key = `${book.provider_id || ''}:${queryTitle.toLowerCase()}:${naturalAuthor.toLowerCase()}:${useIsbn ? (isbn || '') : ''}`;
            if (queriedKeys.has(key)) return [];
            queriedKeys.add(key);
            const releasesUrl = new URL(`${baseUrl}/api/releases`);
            releasesUrl.searchParams.set('provider', book.provider || 'openlibrary');
            releasesUrl.searchParams.set('book_id', book.provider_id || '');
            releasesUrl.searchParams.set('title', queryTitle);
            if (naturalAuthor) {
              releasesUrl.searchParams.set('author', naturalAuthor);
            }
            if (useIsbn && isbn) {
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
                if (signal?.aborted) throw err;
              return [];
            }
            if (!relRes.ok) {
              if (relRes.status === 400) {
                throw host.fail('error', `Shelfmark releases query rejected (HTTP 400): ${await relRes.text().catch(() => '')}`);
              }
              return [];
            }
            const relData = await relRes.json().catch(() => ({ releases: [] }));
            return Array.isArray(relData)
              ? relData
              : Array.isArray(relData.releases)
                ? relData.releases
                : [];
          };

          const filterAndAddReleases = (list) => {
            for (const rel of (list || [])) {
              const relTitle = rel.title || '';
              const relAuthor = toNaturalAuthor(rel.author || rel.extra?.author || rel.extra?.Author);
              if (relTitle && !isTitleMatch(relTitle, searchTitle) && !isTitleMatch(relTitle, book.title)) {
                continue;
              }
              // Strict author validation:
              // When release metadata specifies an author, it must match the requested author.
              // Never silently accept a release by a conflicting author (e.g. Michael Dean adaptation of Orwell).
              if (relAuthor) {
                const matchesReq = searchAuthor ? isAuthorMatch(relAuthor, searchAuthor) : true;
                const matchesBook = Array.isArray(book?.authors) && book.authors.length ? isAuthorMatch(relAuthor, book.authors) : true;
                if (!matchesReq || !matchesBook) {
                  continue;
                }
              }
              if (searchAuthor && !relAuthor) {
                const byMatch = relTitle.split(/\s+by\s+/i);
                if (byMatch.length > 1) {
                  const __suffix = byMatch[1].trim();
                  const __toks = __suffix.split(/\s+/).filter(Boolean);
                  const __looks = __suffix.includes(',') || __toks.length >= 2;
                  if (__looks && !isAuthorMatch(__suffix, searchAuthor)) {
                    continue;
                  }
                }
              }
              addRelease(rel, book);
            }
          };

          const beforeCount = releases.length;
          let triedWithoutIsbn = !isbn;
          try {
            const initialReleases = await fetchBookReleases(true);
            filterAndAddReleases(initialReleases);
            if (releases.length === beforeCount && !triedWithoutIsbn) {
              triedWithoutIsbn = true;
              const fallbackReleases = await fetchBookReleases(false);
              filterAndAddReleases(fallbackReleases);
            }
          } catch (err) {
            if (signal?.aborted) break;
            continue;
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

    // Normalize numeric size to string (or null) to prevent Shelfmark parse_size_string() .strip() crash on numbers.
    // Preserve size_bytes as numeric.
    if (payload) {
      if (typeof payload.size === 'number') {
        if (payload.size_bytes === undefined || payload.size_bytes === null) {
          payload.size_bytes = payload.size;
        }
        payload.size = String(payload.size);
      } else if (payload.size != null && typeof payload.size !== 'string') {
        payload.size = String(payload.size);
      }
      if (payload.size_bytes !== undefined && payload.size_bytes !== null && typeof payload.size_bytes !== 'number') {
        const parsedBytes = Number(payload.size_bytes);
        if (Number.isFinite(parsedBytes)) {
          payload.size_bytes = parsedBytes;
        }
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

      entry.promise = doResolveFile(
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
      );
      entry.promise
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
      const res = await safeHostFetch(host, checkUrl, {
        method: 'GET',
        headers: { ...headers, Range: 'bytes=0-0' },
      }, signal);
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
        ...(statusData.queued_tasks || {}),
        ...(statusData.queuedTasks || {}),
        ...(statusData.active || {}),
        ...(statusData.active_tasks || {}),
        ...(statusData.activeTasks || {}),
        ...(statusData.downloading || {}),
        ...(statusData.downloading_tasks || {}),
        ...(statusData.downloadingTasks || {}),
        ...(statusData.pending || {}),
        ...(statusData.pending_tasks || {}),
        ...(statusData.pendingTasks || {}),
        ...(statusData.resolving || {}),
        ...(statusData.resolving_tasks || {}),
        ...(statusData.resolvingTasks || {}),
        ...(statusData.locating || {}),
        ...(statusData.locating_tasks || {}),
        ...(statusData.locatingTasks || {}),
      };
      // Cancelled tasks are intentionally never treated as active/adoptable.
      const cancelledTasks = { ...(statusData.cancelled || {}) };
      const preExistingCancelledIds = new Set(Object.keys(cancelledTasks));
      const completedTasks = {
        ...(statusData.completed || {}),
        ...(statusData.completed_tasks || {}),
        ...(statusData.completedTasks || {}),
        ...(statusData.complete || {}),
        ...(statusData.complete_tasks || {}),
        ...(statusData.completeTasks || {}),
      };
      const failedTasks = {
        ...(statusData.error || {}),
        ...(statusData.error_tasks || {}),
        ...(statusData.errorTasks || {}),
        ...(statusData.failed || {}),
        ...(statusData.failed_tasks || {}),
        ...(statusData.failedTasks || {}),
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

  // Validate OceanofPDF page URL before attempting to queue.
  const payloadSource = payload?.source || release?.extra?.source || '';
  const payloadPageUrl =
    payload?.source_url || payload?.download_url || payload?.info_url || release?.downloadUrl || null;
  const isOceanofPdf = isOceanofPdfSource(payloadSource, release?.extra?.source, payloadPageUrl);
  if (isOceanofPdf) {
    if (!isValidOceanofPdfPageUrl(payloadPageUrl, payloadSource)) {
      throw host.fail(
        'error',
        `OceanofPDF release "${release?.title || payload?.title || ''}" has no book page URL`
      );
    }
    // Ensure the verified page URL is forwarded under Shelfmark's accepted field name.
    payload.source_url = payloadPageUrl;
    if (!payload.download_url) payload.download_url = payloadPageUrl;
    if (!payload.info_url) payload.info_url = payloadPageUrl;
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
      throw host.fail('error', `Could not trigger download in Shelfmark: ${sanitizeError(err.message, apiKey)}`);
    }

    if (!queueRes.ok) {
      if (queueRes.status === 401 || queueRes.status === 403) {
        throw host.fail('error', 'Shelfmark rejected authentication. Verify API key.');
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
            ...(refData.queued_tasks || {}),
            ...(refData.queuedTasks || {}),
            ...(refData.active || {}),
            ...(refData.active_tasks || {}),
            ...(refData.activeTasks || {}),
            ...(refData.downloading || {}),
            ...(refData.downloading_tasks || {}),
            ...(refData.downloadingTasks || {}),
            ...(refData.pending || {}),
            ...(refData.pending_tasks || {}),
            ...(refData.pendingTasks || {}),
            ...(refData.resolving || {}),
            ...(refData.resolving_tasks || {}),
            ...(refData.resolvingTasks || {}),
            ...(refData.locating || {}),
            ...(refData.locating_tasks || {}),
            ...(refData.locatingTasks || {}),
          };
          const cancelledTasks = { ...(refData.cancelled || {}) };
          const completedTasks = {
            ...(refData.completed || {}),
            ...(refData.completed_tasks || {}),
            ...(refData.completedTasks || {}),
            ...(refData.complete || {}),
            ...(refData.complete_tasks || {}),
            ...(refData.completeTasks || {}),
          };
          const failedTasks = {
            ...(refData.error || {}),
            ...(refData.error_tasks || {}),
            ...(refData.errorTasks || {}),
            ...(refData.failed || {}),
            ...(refData.failed_tasks || {}),
            ...(refData.failedTasks || {}),
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
                  `Shelfmark refused to queue download because a previous attempt failed (${failedId}: ${(failedTask.status_message || failedTask.error || failedTask.message || failedTask.status || 'failed')}). The failed task must be cleared in Shelfmark or container restarted, or choose another release in BookOrbit.`
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
      queuedTaskId = queueData.task_id || queueData.taskId || queueData.id || queueData.task?.id || queueData.task?.task_id || queueData.download_task_id || null;
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
        throw host.fail('error', 'Shelfmark authentication failed while polling download status.');
      }
      continue;
    }

    const statusData = await statusRes.json().catch(() => ({}));
    const completed = { ...(statusData.complete || {}), ...(statusData.completed || {}), ...(statusData.completed_tasks || {}), ...(statusData.completedTasks || {}), ...(statusData.complete_tasks || {}), ...(statusData.completeTasks || {}) };
    const failed = { ...(statusData.error || {}), ...(statusData.failed || {}), ...(statusData.error_tasks || {}), ...(statusData.errorTasks || {}), ...(statusData.failed_tasks || {}), ...(statusData.failedTasks || {}) };
    const active = { ...(statusData.active || {}), ...(statusData.active_tasks || {}), ...(statusData.activeTasks || {}), ...(statusData.queued || {}), ...(statusData.queued_tasks || {}), ...(statusData.queuedTasks || {}), ...(statusData.downloading || {}), ...(statusData.downloading_tasks || {}), ...(statusData.downloadingTasks || {}), ...(statusData.pending || {}), ...(statusData.pending_tasks || {}), ...(statusData.pendingTasks || {}), ...(statusData.resolving || {}), ...(statusData.resolving_tasks || {}), ...(statusData.resolvingTasks || {}), ...(statusData.locating || {}), ...(statusData.locating_tasks || {}), ...(statusData.locatingTasks || {}) };

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
        throw host.fail('error', `Shelfmark reported download failed: ${(failedTask.status_message || failedTask.error || failedTask.message || failedTask.status || 'unknown error')}`);
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
        throw host.fail('error', `Shelfmark reported download failed: ${(strongFailed[0][1].status_message || strongFailed[0][1].error || strongFailed[0][1].message || strongFailed[0][1].status || 'unknown error')}`);
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
        throw host.fail('error', `Shelfmark reported download failed: ${(titleFailed[0][1].status_message || titleFailed[0][1].error || titleFailed[0][1].message || titleFailed[0][1].status || 'unknown error')}`);
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

function stripTrailingSlashes(value) {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
  return value.slice(0, end);
}

function cleanUrl(url) {
  if (!url) return 'http://localhost:8084';
  const trimmed = String(url).trim();
  try {
    const u = new URL(trimmed);
    u.pathname = stripTrailingSlashes(u.pathname);
    u.search = '';
    u.hash = '';
    return stripTrailingSlashes(u.toString());
  } catch (e) {
    return stripTrailingSlashes(trimmed);
  }
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
  return `${baseUrl}/api/localdownload?id=${encodeURIComponent(taskId)}`;
}

function sanitizeError(msg, apiKey) {
  if (!msg) return '';
  let str = String(msg);
  if (apiKey) {
    str = str.replaceAll(apiKey, '[REDACTED]');
  }
  str = str.replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1[REDACTED]');
  str = str.replace(/(apiKey|api_key|token|secret|password)=([^&\s]+)/gi, '$1=[REDACTED]');
  str = str.replace(/([?&]api_key=)[^&]+/gi, '$1[REDACTED]');
  return str;
}

function isHttpUrl(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    const u = new URL(trimmed);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

function isOceanofPdfSource(source, extraSource, url) {
  const blob = `${source || ''} ${extraSource || ''} ${url || ''}`.toLowerCase();
  return blob.includes('oceanofpdf');
}

function isValidOceanofPdfPageUrl(url, source) {
  if (!isHttpUrl(url)) return false;
  try {
    const parsed = new URL(String(url).trim());
    const host = parsed.hostname.toLowerCase();
    // Require a real OceanofPDF host/path, not a synthesized URL containing only a hash.
    if (!host.includes('oceanofpdf')) return false;
    if (!parsed.pathname || parsed.pathname === '/') return false;
    return true;
  } catch (e) {
    return false;
  }
}

// >>> IDENTITY MODULE START
/**
 * Shared identity model for BookOrbit–Shelfmark.
 *
 * Authoritative implementation of normalization, identity evidence, and matching
 * decisions. Used by both the native plugin (index.mjs, inlined at build time)
 * and the companion bridge (bridge/bridge.mjs) so there is exactly one policy.
 *
 * Dependency-free. ESM.
 */

const KNOWN_TITLE_EQUIVALENTS = new Map([
  ['1984', ['nineteen eighty four', 'nineteen eighty-four']],
  ['nineteen eighty four', ['1984']],
  ['nineteen eighty-four', ['1984']],
  ['2001', ['two thousand and one']],
  ['two thousand and one', ['2001']],
]);

function normalizeString(str) {
  if (str == null) return '';
  return String(str)
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeLanguageCode(lang) {
  if (!lang) return null;
  const s = String(lang).trim().toLowerCase();
  if (!s) return null;
  const base = s.split(/[-_]/)[0].trim();
  const codeMap = {
    english: 'en', en: 'en', eng: 'en',
    spanish: 'es', es: 'es', spa: 'es',
    portuguese: 'pt', pt: 'pt', por: 'pt',
    french: 'fr', fr: 'fr', fra: 'fr', fre: 'fr',
    german: 'de', de: 'de', deu: 'de', ger: 'de',
    italian: 'it', it: 'it', ita: 'it',
    russian: 'ru', ru: 'ru', rus: 'ru',
    chinese: 'zh', zh: 'zh', zho: 'zh', chi: 'zh',
    japanese: 'ja', ja: 'ja', jpn: 'ja',
    korean: 'ko', ko: 'ko', kor: 'ko',
    lithuanian: 'lt', lt: 'lt', lit: 'lt',
    dutch: 'nl', nl: 'nl', nld: 'nl', dut: 'nl',
    polish: 'pl', pl: 'pl', pol: 'pl',
    swedish: 'sv', sv: 'sv', swe: 'sv',
    norwegian: 'no', no: 'no', nor: 'no', nob: 'nb', nno: 'nn',
    danish: 'da', da: 'da', dan: 'da',
    finnish: 'fi', fi: 'fi', fin: 'fi',
    arabic: 'ar', ar: 'ar', ara: 'ar',
    hindi: 'hi', hi: 'hi', hin: 'hi',
    greek: 'el', el: 'el', ell: 'el', gre: 'el',
    czech: 'cs', cs: 'cs', ces: 'cs', cze: 'cs',
    hungarian: 'hu', hu: 'hu', hun: 'hu',
    turkish: 'tr', tr: 'tr', tur: 'tr',
    ukrainian: 'uk', uk: 'uk', ukr: 'uk',
    latin: 'la', la: 'la', lat: 'la',
  };
  if (codeMap[s]) return codeMap[s];
  if (codeMap[base]) return codeMap[base];
  if (/^[a-z]{2}$/.test(base)) return base;
  return null;
}

function stripLeadingArticle(str) {
  if (!str) return '';
  return String(str).replace(/^(?:the|a|an)\s+/i, '').trim();
}
function getTokens(str) {
  return normalizeString(str).split(' ').filter((t) => t.length > 0);
}

function stripYearRanges(str) {
  let out = '';
  let ws = '';
  const n = str.length;
  let i = 0;
  while (i < n) {
    const ch = str[i];
    if (/\s/.test(ch)) { ws += ch; i++; continue; }
    const m = matchYearRangeAt(str, i, ws.length > 0);
    if (m > 0) {
      out += ' ';
      ws = '';
      i += m;
      continue;
    }
    out += ws + ch;
    ws = '';
    i++;
  }
  out += ws;
  return out;
}

function matchYearRangeAt(str, i, hasLeadingWs) {
  const n = str.length;
  let pos = i;
  if (pos >= n) return 0;
  if (str[pos] === '(') pos++;
  const prevForBoundary = (str[i] === '(')
    ? '('
    : (hasLeadingWs ? ' ' : (pos > 0 ? str[pos - 1] : null));
  if (pos < n && !boundary(prevForBoundary, str[pos])) return 0;
  if (pos + 4 > n) return 0;
  for (let t = 0; t < 4; t++) if (!/\d/.test(str[pos + t])) return 0;
  pos += 4;
  while (pos < n && /\s/.test(str[pos])) pos++;
  if (pos >= n || !/[-–—]/.test(str[pos])) return 0;
  pos++;
  while (pos < n && /\s/.test(str[pos])) pos++;
  let chosenPos = pos;
  let found = false;
  for (let k = 4; k >= 0; k--) {
    if (pos + k > n) continue;
    let allD = true;
    for (let t = 0; t < k; t++) if (!/\d/.test(str[pos + t])) { allD = false; break; }
    if (!allD) continue;
    const after = pos + k;
    const prev = k > 0 ? str[pos + k - 1] : (pos > 0 ? str[pos - 1] : null);
    const prevForB = (k === 0 && hasLeadingWs && str[i] !== '(') ? ' ' : prev;
    const curr = after < n ? str[after] : null;
    if (boundary(prevForB, curr)) { chosenPos = after; found = true; break; }
  }
  if (!found) return 0;
  pos = chosenPos;
  if (pos < n && str[pos] === ')') pos++;
  return pos - i;
}

function stripParentheticals(str) {
  let out = '';
  let ws = '';
  const n = str.length;
  let i = 0;
  while (i < n) {
    const ch = str[i];
    if (/\s/.test(ch)) { ws += ch; i++; continue; }
    if (ch === '(') {
      const j = str.indexOf(')', i + 1);
      if (j !== -1) {
        out += ' ';
        ws = '';
        i = j + 1;
        continue;
      }
      out += ws + str.slice(i);
      ws = '';
      i = n;
      continue;
    }
    out += ws + ch;
    ws = '';
    i++;
  }
  out += ws;
  return out;
}

function boundary(prev, curr) {
  const pw = prev == null ? false : /[A-Za-z0-9_]/.test(prev);
  const cw = curr == null ? false : /[A-Za-z0-9_]/.test(curr);
  return pw !== cw;
}

function toNaturalAuthor(author) {
  if (!author) return '';
  let s = String(author).trim();
  s = stripYearRanges(s).trim();
  s = stripParentheticals(s).trim();
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

function stripBracketedGroups(str, open, close) {
  let out = '';
  let ws = '';
  let i = 0;
  const n = str.length;
  while (i < n) {
    const ch = str[i];
    if (/\s/.test(ch)) { ws += ch; i++; continue; }
    if (ch === open) {
      const j = str.indexOf(close, i + 1);
      if (j !== -1) {
        i = j + 1;
        while (i < n && /\s/.test(str[i])) i++;
        out += ' ';
        ws = '';
        continue;
      }
      out += ws + str.slice(i);
      ws = '';
      i = n;
      continue;
    }
    out += ws + ch;
    ws = '';
    i++;
  }
  out += ws;
  return out;
}

function extractCoreTitle(title) {
  if (!title) return '';
  let s = String(title).trim();
  s = stripBracketedGroups(s, '[', ']');
  s = stripBracketedGroups(s, '(', ')');
  s = s.replace(/\s+download\b/gi, '').trim();
  const byMatch = s.split(/\s+by\s+/i);
  if (byMatch.length > 1 && byMatch[0].trim().length >= 2) {
    const suffix = byMatch[1].trim();
    const suffixTokens = suffix.split(/\s+/).filter(Boolean);
    const looksLikeAuthor = suffix.includes(',') || (suffixTokens.length >= 2 && suffixTokens.some((t) => t.length >= 5));
    if (looksLikeAuthor) s = byMatch[0].trim();
  }
  const parts = s.split(/(?:\s+[-–—]\s+|[:;/|]|\s*[–—]\s*)/);
  const core = parts[0]?.trim();
  return core && core.length >= 2 ? core : s;
}

function isNoiseDerivative(candidateTitle, requestedTitle) {
  const normCand = normalizeString(candidateTitle);
  const normReq = normalizeString(requestedTitle);
  const noiseMarkers = [
    'summary of', 'study guide', 'cliffsnotes', 'sparknotes', 'analysis of',
    'workbook for', 'book summary', 'companion to', 'teacher guide', 'teachers guide',
    'lesson plans', 'activity guide', 'adapted by', 'retold by', 'simplified edition',
    'simplified retelling', 'retelling', 'abridged', 'graded reader', 'oxford bookworms',
    'penguin active reading', 'penguin readers', 'macmillan readers', 'graphic novel',
    'comic book', 'illustrated novel', 'complete works', 'box set', 'boxed set',
    'omnibus', 'anthology', 'historias de', 'relatos de', 'cuentos de',
    'obras completas', 'coleccion de', 'and other stories', 'and other writings',
    'selected works', 'selected writings', 'short stories', 'complete collection',
  ];
  for (const marker of noiseMarkers) {
    if (normCand.includes(marker) && !normReq.includes(marker)) return true;
  }
  if (/\b(?:stage|level)\s*[1-6]\b/i.test(candidateTitle) && !/\b(?:stage|level)\s*[1-6]\b/i.test(requestedTitle)) return true;
  return false;
}

// ---------- ISBN handling ----------

function normalizeIsbn(value) {
  if (value == null) return '';
  return String(value).replace(/[^0-9Xx]/g, '').trim().toUpperCase();
}

function validateIsbn(value) {
  const n = normalizeIsbn(value);
  if (n.length === 10) {
    // ISBN-10 checksum
    let sum = 0;
    for (let i = 0; i < 9; i++) {
      const d = n.charCodeAt(i) - 48;
      if (d < 0 || d > 9) return { valid: false, type: 'isbn10', normalized: n, reason: 'non_digit' };
      sum += d * (10 - i);
    }
    const last = n[9];
    const check = last === 'X' ? 10 : (last.charCodeAt(0) - 48);
    if (check < 0 || check > 10) return { valid: false, type: 'isbn10', normalized: n, reason: 'bad_check' };
    sum += check;
    const valid = sum % 11 === 0;
    return { valid, type: 'isbn10', normalized: n, reason: valid ? null : 'checksum' };
  }
  if (n.length === 13) {
    let sum = 0;
    for (let i = 0; i < 12; i++) {
      const d = n.charCodeAt(i) - 48;
      if (d < 0 || d > 9) return { valid: false, type: 'isbn13', normalized: n, reason: 'non_digit' };
      sum += d * (i % 2 === 0 ? 1 : 3);
    }
    const check = (10 - (sum % 10)) % 10;
    const last = n[12].charCodeAt(0) - 48;
    const valid = last === check;
    return { valid, type: 'isbn13', normalized: n, reason: valid ? null : 'checksum' };
  }
  return { valid: false, type: null, normalized: n, reason: 'length' };
}

function isbn10To13(isbn10) {
  const n = normalizeIsbn(isbn10);
  if (n.length !== 10) return null;
  const v = validateIsbn(n);
  if (!v.valid) return null;
  const base = '978' + n.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += (base.charCodeAt(i) - 48) * (i % 2 === 0 ? 1 : 3);
  const check = (10 - (sum % 10)) % 10;
  return base + check;
}

function isbn13To10(isbn13) {
  const n = normalizeIsbn(isbn13);
  if (n.length !== 13 || !n.startsWith('978')) return null;
  const v = validateIsbn(n);
  if (!v.valid) return null;
  const base = n.slice(3, 12);
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (base.charCodeAt(i) - 48) * (10 - i);
  const check = (11 - (sum % 11)) % 11;
  return base + (check === 10 ? 'X' : String(check));
}

/** Are two ISBNs the same underlying identifier (including 10/13 conversion)? */
function sameIsbn(a, b) {
  const na = normalizeIsbn(a);
  const nb = normalizeIsbn(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // try conversion
  if (na.length === 10 && nb.length === 13) {
    const c = isbn10To13(na);
    return c !== null && c === nb;
  }
  if (na.length === 13 && nb.length === 10) {
    const c = isbn13To10(na);
    return c !== null && c === nb;
  }
  return false;
}

// ---------- ISBN counterpart collection (scoped) ----------

function collectIsbnPairs(obj) {
  const pairs = [];
  if (!obj || typeof obj !== 'object') return pairs;
  if (Array.isArray(obj)) {
    for (const item of obj) pairs.push(...collectIsbnPairs(item));
    return pairs;
  }
  const counterpartKeys = Object.keys(obj).filter((k) => /counterpart|equivalent/i.test(k));
  if (counterpartKeys.length > 0) {
    const counterpartIsbns = [];
    for (const key of counterpartKeys) {
      const stack = [obj[key]];
      while (stack.length) {
        const cur = stack.pop();
        if (cur == null) continue;
        if (Array.isArray(cur)) { stack.push(...cur); continue; }
        if (typeof cur === 'object') { stack.push(...Object.values(cur)); continue; }
        const cleaned = normalizeIsbn(cur);
        if (cleaned.length === 10 || cleaned.length === 13) counterpartIsbns.push(cleaned);
      }
    }
    const ownIsbns = [];
    for (const [key, value] of Object.entries(obj)) {
      if (/isbn/i.test(key) && !/counterpart|equivalent/i.test(key)) {
        const stack = [value];
        while (stack.length) {
          const cur = stack.pop();
          if (cur == null) continue;
          if (Array.isArray(cur)) { stack.push(...cur); continue; }
          if (typeof cur === 'object') { stack.push(...Object.values(cur)); continue; }
          const cleaned = normalizeIsbn(cur);
          if (cleaned.length === 10 || cleaned.length === 13) ownIsbns.push(cleaned);
        }
      }
    }
    if (counterpartIsbns.length > 0 && ownIsbns.length > 0) {
      if (counterpartIsbns.length === ownIsbns.length) {
        for (let i = 0; i < counterpartIsbns.length; i++) pairs.push([counterpartIsbns[i], ownIsbns[i]]);
      } else if (counterpartIsbns.length === 1) {
        for (const o of ownIsbns) pairs.push([counterpartIsbns[0], o]);
      } else if (ownIsbns.length === 1) {
        for (const c of counterpartIsbns) pairs.push([c, ownIsbns[0]]);
      }
      // otherwise do not infer cartesian pairs
    } else if (counterpartIsbns.length >= 2) {
      // Only pair counterparts that are explicitly listed as equivalents, not all combinations.
      for (let i = 0; i < counterpartIsbns.length; i++)
        for (let j = i + 1; j < counterpartIsbns.length; j++)
          pairs.push([counterpartIsbns[i], counterpartIsbns[j]]);
    }
  }
  for (const [key, value] of Object.entries(obj)) {
    if (counterpartKeys.includes(key)) continue;
    if (Array.isArray(value)) {
      for (const item of value) pairs.push(...collectIsbnPairs(item));
    } else if (value && typeof value === 'object') {
      pairs.push(...collectIsbnPairs(value));
    }
  }
  return pairs;
}

function collectIsbns(obj, out = new Set()) {
  for (const [a, b] of collectIsbnPairs(obj)) {
    const na = normalizeIsbn(a); const nb = normalizeIsbn(b);
    if (na.length === 10 || na.length === 13) out.add(na);
    if (nb.length === 10 || nb.length === 13) out.add(nb);
  }
  return out;
}

function areVerifiedCounterparts(isbnA, isbnB, ...contexts) {
  const a = normalizeIsbn(isbnA);
  const b = normalizeIsbn(isbnB);
  if (!a || !b) return false;
  if (sameIsbn(a, b)) return true;
  for (const ctx of contexts) {
    if (!ctx) continue;
    const pairs = [];
    if (typeof ctx === 'object') {
      if (ctx.bookMetadata && typeof ctx.bookMetadata === 'object') pairs.push(...collectIsbnPairs(ctx.bookMetadata));
      if (ctx.metadata && typeof ctx.metadata === 'object') pairs.push(...collectIsbnPairs(ctx.metadata));
      pairs.push(...collectIsbnPairs(ctx));
      if (ctx.extra && typeof ctx.extra === 'object') {
        if (ctx.extra.bookMetadata && typeof ctx.extra.bookMetadata === 'object') pairs.push(...collectIsbnPairs(ctx.extra.bookMetadata));
        pairs.push(...collectIsbnPairs(ctx.extra));
      }
    }
    for (const [x, y] of pairs) {
      const nx = normalizeIsbn(x); const ny = normalizeIsbn(y);
      if ((sameIsbn(nx, a) && sameIsbn(ny, b)) || (sameIsbn(nx, b) && sameIsbn(ny, a))) return true;
    }
  }
  return false;
}

// ---------- Title matching ----------

function isNoiseDerivativeWrapper(candidateTitle, requestedTitle) {
  return isNoiseDerivative(candidateTitle, requestedTitle);
}

function safePrefix(candidate, requested) {
  const c = normalizeString(candidate);
  const r = normalizeString(requested);
  if (!c || !r) return c === r;
  if (!c.startsWith(r) || c === r) return c === r;
  const rest = c.slice(r.length);
  return /^[\s]*[:;\-–—(\[]/.test(rest);
}

function titleMatchDecision(candidateTitle, requestedTitle) {
  const evidence = [];
  const conflicts = [];
  const reasonCodes = [];
  if (!requestedTitle) {
    evidence.push({ field: 'title', value: candidateTitle, level: 'work', status: 'missing' });
    return { outcome: 'unknown', workConfidence: 'none', editionConfidence: 'none', evidence, conflicts, reasonCodes };
  }
  if (!candidateTitle) {
    conflicts.push('missing_candidate_title');
    return { outcome: 'reject', workConfidence: 'none', editionConfidence: 'none', evidence, conflicts, reasonCodes };
  }
  if (isNoiseDerivative(candidateTitle, requestedTitle)) {
    conflicts.push('noise_derivative');
    reasonCodes.push('noise_derivative');
    return { outcome: 'reject', workConfidence: 'none', editionConfidence: 'none', evidence, conflicts, reasonCodes };
  }
  const normCand = normalizeString(candidateTitle);
  const normReq = normalizeString(requestedTitle);
  if (!normCand || !normReq) {
    return { outcome: 'unknown', workConfidence: 'none', editionConfidence: 'none', evidence, conflicts, reasonCodes };
  }
  // translated compound
  try {
    const escaped = String(requestedTitle).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(escaped + '-[\\p{L}]+', 'iu').test(candidateTitle)) {
      conflicts.push('translated_compound');
      return { outcome: 'reject', workConfidence: 'none', editionConfidence: 'none', evidence, conflicts, reasonCodes };
    }
  } catch (e) {}

  if (normCand === normReq) {
    evidence.push({ field: 'title', value: normCand, level: 'work', status: 'verified' });
    return { outcome: 'match', workConfidence: 'high', editionConfidence: 'medium', evidence, conflicts, reasonCodes };
  }
  const normCandNoArt = stripLeadingArticle(normCand);
  const normReqNoArt = stripLeadingArticle(normReq);
  if (normCandNoArt && normReqNoArt && normCandNoArt === normReqNoArt) {
    evidence.push({ field: 'title', value: normCand, level: 'work', status: 'verified' });
    return { outcome: 'match', workConfidence: 'high', editionConfidence: 'medium', evidence, conflicts, reasonCodes };
  }
  if (safePrefix(candidateTitle, requestedTitle) || safePrefix(requestedTitle, candidateTitle)) {
    evidence.push({ field: 'title', value: normCand, level: 'work', status: 'verified' });
    return { outcome: 'match', workConfidence: 'high', editionConfidence: 'medium', evidence, conflicts, reasonCodes };
  }
  if (normCand.includes(normReq) || normReq.includes(normCand)) {
    const cTokens = getTokens(candidateTitle);
    const rTokens = getTokens(requestedTitle);
    const boundaryOk = (normCand === normReq) || safePrefix(normCand, normReq) || safePrefix(normReq, normCand);
    if (rTokens.length > 1 && rTokens.every((t) => cTokens.includes(t)) && boundaryOk) {
      evidence.push({ field: 'title', value: normCand, level: 'work', status: 'verified' });
      return { outcome: 'match', workConfidence: 'high', editionConfidence: 'medium', evidence, conflicts, reasonCodes };
    }
  }
  const equivalents = KNOWN_TITLE_EQUIVALENTS.get(normReq);
  if (equivalents) {
    for (const eq of equivalents) {
      const normEq = normalizeString(eq);
      if (normCand === normEq || safePrefix(normCand, normEq) || safePrefix(normEq, normCand)) {
        evidence.push({ field: 'title', value: normCand, level: 'work', status: 'verified' });
        return { outcome: 'match', workConfidence: 'high', editionConfidence: 'medium', evidence, conflicts, reasonCodes };
      }
    }
  }
  const candEquivalents = KNOWN_TITLE_EQUIVALENTS.get(normCand);
  if (candEquivalents) {
    for (const eq of candEquivalents) {
      const normEq = normalizeString(eq);
      if (normReq === normEq || safePrefix(normReq, normEq) || safePrefix(normEq, normReq)) {
        evidence.push({ field: 'title', value: normCand, level: 'work', status: 'verified' });
        return { outcome: 'match', workConfidence: 'high', editionConfidence: 'medium', evidence, conflicts, reasonCodes };
      }
    }
  }
  const coreCand = normalizeString(extractCoreTitle(candidateTitle));
  const coreReq = normalizeString(extractCoreTitle(requestedTitle));
  if (coreCand && coreReq && (coreCand === coreReq || coreCand === normReq || normCand === coreReq)) {
    evidence.push({ field: 'title', value: coreCand, level: 'work', status: 'verified' });
    return { outcome: 'match', workConfidence: 'high', editionConfidence: 'medium', evidence, conflicts, reasonCodes };
  }
  const coreCandNoArt = stripLeadingArticle(coreCand);
  const coreReqNoArt = stripLeadingArticle(coreReq);
  if (coreCandNoArt && coreReqNoArt && (coreCandNoArt === coreReqNoArt || coreCandNoArt === normReqNoArt || normCandNoArt === coreReqNoArt)) {
    evidence.push({ field: 'title', value: coreCand, level: 'work', status: 'verified' });
    return { outcome: 'match', workConfidence: 'high', editionConfidence: 'medium', evidence, conflicts, reasonCodes };
  }
  const candTokens = getTokens(candidateTitle);
  const reqTokens = getTokens(requestedTitle);
  if (reqTokens.length === 0) {
    return { outcome: 'unknown', workConfidence: 'low', editionConfidence: 'none', evidence, conflicts, reasonCodes };
  }
  if (reqTokens.length === 1) {
    reasonCodes.push('single_token_title_conservative');
    return { outcome: 'unknown', workConfidence: 'low', editionConfidence: 'none', evidence, conflicts, reasonCodes };
  }
  const artCandTokens = candTokens.filter((t) => !['the', 'a', 'an'].includes(t));
  const artReqTokens = reqTokens.filter((t) => !['the', 'a', 'an'].includes(t));
  if (artReqTokens.length > 0 && artCandTokens.length === artReqTokens.length) {
    if (artReqTokens.every((t) => artCandTokens.includes(t))) {
      evidence.push({ field: 'title', value: normCand, level: 'work', status: 'verified' });
      return { outcome: 'match', workConfidence: 'high', editionConfidence: 'medium', evidence, conflicts, reasonCodes };
    }
  }
  if (artReqTokens.length > 1 && artCandTokens.length === artReqTokens.length + 1) {
    const isPrefix = safePrefix(normCand, normReq) || safePrefix(normReq, normCand);
    const hasConnectors = /\b(?:and|with|\&|historias|stories|collection)\b/i.test(candidateTitle);
    if (isPrefix && !hasConnectors && artReqTokens.every((t) => artCandTokens.includes(t))) {
      evidence.push({ field: 'title', value: normCand, level: 'work', status: 'verified' });
      return { outcome: 'match', workConfidence: 'high', editionConfidence: 'medium', evidence, conflicts, reasonCodes };
    }
  }
  conflicts.push('title_mismatch');
  return { outcome: 'reject', workConfidence: 'none', editionConfidence: 'none', evidence, conflicts, reasonCodes };
}

function isTitleMatch(candidateTitle, requestedTitle) {
  if (!requestedTitle) return true;
  if (!candidateTitle) return false;
  const d = titleMatchDecision(candidateTitle, requestedTitle);
  return d.outcome === 'match' || d.outcome === 'provisional';
}

function authorMatchDecision(candidateAuthors, requestedAuthor) {
  const evidence = [];
  const conflicts = [];
  const reasonCodes = [];
  if (!requestedAuthor) {
    return { outcome: 'unknown', workConfidence: 'none', editionConfidence: 'none', evidence, conflicts, reasonCodes };
  }
  if (!candidateAuthors) {
    conflicts.push('missing_candidate_author');
    return { outcome: 'reject', workConfidence: 'none', editionConfidence: 'none', evidence, conflicts, reasonCodes };
  }
  const rawList = Array.isArray(candidateAuthors) ? candidateAuthors : String(candidateAuthors).split(/[;&]/);
  const authorList = rawList.map((a) => toNaturalAuthor(a)).filter(Boolean);
  if (authorList.length === 0) {
    conflicts.push('empty_candidate_author');
    return { outcome: 'reject', workConfidence: 'none', editionConfidence: 'none', evidence, conflicts, reasonCodes };
  }
  const reqNorm = normalizeString(toNaturalAuthor(requestedAuthor));
  const reqTokens = getTokens(reqNorm);
  if (reqTokens.length === 0) {
    return { outcome: 'unknown', workConfidence: 'none', editionConfidence: 'none', evidence, conflicts, reasonCodes };
  }
  for (const cand of authorList) {
    const candNorm = normalizeString(cand);
    const candTokens = getTokens(cand);
    if (candTokens.length === 0) continue;
    if (candNorm === reqNorm) {
      evidence.push({ field: 'author', value: candNorm, level: 'work', status: 'verified' });
      return { outcome: 'match', workConfidence: 'high', editionConfidence: 'medium', evidence, conflicts, reasonCodes };
    }
    const matchingTokens = reqTokens.filter((t) => candTokens.includes(t));
    if (matchingTokens.length === reqTokens.length && reqTokens.length > 0) {
      evidence.push({ field: 'author', value: candNorm, level: 'work', status: 'verified' });
      return { outcome: 'match', workConfidence: 'high', editionConfidence: 'medium', evidence, conflicts, reasonCodes };
    }
    const reqSurname = reqTokens[reqTokens.length - 1];
    if (candTokens.includes(reqSurname) && reqTokens.length > 1) {
      const reqFirst = reqTokens[0];
      const candFirsts = candTokens.filter((t) => t !== reqSurname);
      const compatibleFirst = candFirsts.some((t) => {
        if (t === reqFirst) return true;
        if (t.length === 1 || reqFirst.length === 1) {
          return t.startsWith(reqFirst[0]) || reqFirst.startsWith(t[0]);
        }
        return false;
      });
      if (compatibleFirst) {
        evidence.push({ field: 'author', value: candNorm, level: 'work', status: 'verified' });
        return { outcome: 'match', workConfidence: 'high', editionConfidence: 'medium', evidence, conflicts, reasonCodes };
      }
    }
    // transposed
    const candSurname = candTokens[0];
    if (reqTokens.includes(candSurname) && candTokens.length > 1) {
      const candFirst = candTokens[candTokens.length - 1];
      const reqFirst = reqTokens[0];
      if (candFirst === reqFirst) {
        evidence.push({ field: 'author', value: candNorm, level: 'work', status: 'verified' });
        return { outcome: 'match', workConfidence: 'high', editionConfidence: 'medium', evidence, conflicts, reasonCodes };
      }
      if ((candFirst.length === 1 || reqFirst.length === 1) && (candFirst.startsWith(reqFirst[0]) || reqFirst.startsWith(candFirst[0]))) {
        evidence.push({ field: 'author', value: candNorm, level: 'work', status: 'verified' });
        return { outcome: 'match', workConfidence: 'high', editionConfidence: 'medium', evidence, conflicts, reasonCodes };
      }
    }
  }
  conflicts.push('author_mismatch');
  return { outcome: 'reject', workConfidence: 'none', editionConfidence: 'none', evidence, conflicts, reasonCodes };
}

function isAuthorMatch(candidateAuthors, requestedAuthor) {
  if (!requestedAuthor) return true;
  const d = authorMatchDecision(candidateAuthors, requestedAuthor);
  return d.outcome === 'match';
}

// ---------- Edition compatibility ----------

function editionCompatibility(a, b, options = {}) {
  const evidence = [];
  const conflicts = [];
  const reasonCodes = [];
  if (!a || !b) {
    return { outcome: 'unknown', workConfidence: 'none', editionConfidence: 'none', evidence, conflicts, reasonCodes: ['missing_input'] };
  }
  const requireVerifiedEdition = Boolean(options?.requireVerifiedEdition || options?.strict || options?.stage === 'final');

  // title
  const titleA = (a.bookTitle || a.title || '').trim();
  const titleB = (b.bookTitle || b.title || '').trim();
  let titleOk = true;
  if (titleA && titleB) {
    const td = titleMatchDecision(titleA, titleB);
    if (td.outcome !== 'match') { titleOk = false; conflicts.push('incompatible_title'); }
  } else if (titleA || titleB) {
    // one side missing title: cannot establish work identity
    titleOk = false; conflicts.push('missing_title');
  }
  // author
  const authorsA = Array.isArray(a.authors) && a.authors.length ? a.authors : (a.author ? [a.author] : []);
  const authorsB = Array.isArray(b.authors) && b.authors.length ? b.authors : (b.author ? [b.author] : []);
  let authorOk = true;
  if (authorsA.length && authorsB.length) {
    // require at least one compatible author pair
    let anyMatch = false;
    for (const aa of authorsA) for (const bb of authorsB) {
      if (authorMatchDecision(aa, bb).outcome === 'match') anyMatch = true;
    }
    if (!anyMatch) { authorOk = false; conflicts.push('incompatible_author'); }
  } else if (authorsA.length || authorsB.length) {
    authorOk = false; conflicts.push('missing_author');
  }
  // format
  const fmtA = (a.format || '').trim().toLowerCase();
  const fmtB = (b.format || '').trim().toLowerCase();
  let formatOk = true;
  if (fmtA && fmtB && fmtA !== fmtB) { formatOk = false; conflicts.push('incompatible_format'); }
  // language
  const langA = normalizeLanguageCode(a.language || a.epubMetadata?.language || '') || 'en';
  const langB = normalizeLanguageCode(b.language || b.epubMetadata?.language || '');
  let langOk = true;
  if (langA && langB && langA !== langB) { langOk = false; conflicts.push('language_mismatch'); }

  // ISBN (collect all authentic ISBNs on each side, including OPF multi-identifier lists)
  const collectIsbnList = (obj) => {
    const out = [];
    const seen = new Set();
    const sources = [
      obj?.isbn13,
      obj?.isbn13s,
      obj?.isbn,
      obj?.extra?.isbn,
      obj?.extra?.isbn13,
      obj?.extra?.isbn_13,
      obj?.epubMetadata?.isbns,
      obj?.epubMetadata?.isbn,
    ];
    for (const src of sources) {
      const vals = Array.isArray(src) ? src : [src];
      for (const v of vals) {
        if (v == null) continue;
        const c = normalizeIsbn(v);
        if ((c.length === 10 || c.length === 13) && !seen.has(c)) {
          seen.add(c);
          out.push(c);
        }
      }
    }
    return out;
  };
  const isbnsA = collectIsbnList(a);
  const isbnsB = collectIsbnList(b);
  const isbnA = isbnsA[0] || '';
  const isbnB = isbnsB[0] || '';
  let isbnOk = true;
  let isbnVerified = false;
  if (isbnsA.length > 0 && isbnsB.length > 0) {
    let matchedIsbn = false;
    for (const ia of isbnsA) {
      for (const ib of isbnsB) {
        if (sameIsbn(ia, ib) || areVerifiedCounterparts(ia, ib, a?.trustedIsbns, a?.bookMetadata, a?.extra?.bookMetadata, b?.trustedIsbns, b?.bookMetadata, b?.extra?.bookMetadata, a, b)) {
          matchedIsbn = true;
          break;
        }
      }
      if (matchedIsbn) break;
    }
    if (matchedIsbn) {
      isbnVerified = true;
    } else {
      isbnOk = false;
      conflicts.push('conflicting_isbn');
    }
  } else if (isbnsA.length > 0 && isbnsB.length === 0) {
    reasonCodes.push('unknown_release_isbn');
    if (requireVerifiedEdition && options?.requireIsbn !== false) {
      isbnOk = false;
      conflicts.push('unverified_isbn');
    }
  }

  // year (collect primary year on A and all authentic publication years on B)
  const extractYears = (obj) => {
    const out = [];
    const seen = new Set();
    const candidates = [
      obj?.year,
      obj?.publicationYear,
      obj?.publishedYear,
      obj?.publishYear,
      obj?.publish_year,
      obj?.publication_year,
      obj?.published_year,
      ...(Array.isArray(obj?.epubMetadata?.years) ? obj.epubMetadata.years : []),
      obj?.epubMetadata?.year,
    ];
    for (const c of candidates) {
      const y = parsePositiveIntLocal(c);
      if (y && !seen.has(y)) {
        seen.add(y);
        out.push(y);
      }
    }
    return out;
  };
  const yearsA = extractYears(a);
  const yearsB = extractYears(b);
  const yearA = yearsA[0] || null;
  const yearB = yearsB[0] || null;
  let yearOk = true;
  let yearVerified = false;
  if (yearA && yearsB.length > 0) {
    if (yearsB.includes(yearA)) {
      yearVerified = true;
    } else {
      yearOk = false;
      conflicts.push('incompatible_year');
    }
  } else if (yearA && yearsB.length === 0) {
    reasonCodes.push('unknown_release_year');
    if (!isbnVerified && requireVerifiedEdition) {
      yearOk = false;
      conflicts.push('unverified_edition_year');
    }
  }

  const allOk = titleOk && authorOk && formatOk && langOk && isbnOk && yearOk;
  const hasUnverifiedRequestedEdition = Boolean(
    (yearA && !yearVerified && !isbnVerified) ||
    (isbnsA.length > 0 && !isbnVerified)
  );
  // Determine edition confidence:
  //   'high'   — verified by ISBN/counterpart or publication year with zero conflicts
  //   'medium' — no specific edition year/ISBN requested and zero conflicts
  //   'low'    — plausible work/expression candidate, but requested year/ISBN is missing on candidate (requires post-download inspection)
  //   'none'   — conflicting evidence or missing required evidence in final stage
  let editionConfidence = 'none';
  if (allOk) {
    if (isbnVerified || yearVerified) editionConfidence = 'high';
    else if (hasUnverifiedRequestedEdition) editionConfidence = 'low';
    else editionConfidence = 'medium';
  }
  const outcome = allOk ? (editionConfidence === 'high' ? 'match' : 'provisional') : 'reject';
  // work confidence based on title+author
  const workConfidence = (titleOk && authorOk) ? 'high' : 'none';

  evidence.push({ field: 'title', value: titleA, level: 'work', status: titleOk ? 'verified' : 'contradictory' });
  const authorAVal = Array.isArray(a.authors) ? (a.authors[0] || a.author || '') : (a.author || '');
  evidence.push({ field: 'author', value: authorAVal, level: 'work', status: authorOk ? 'verified' : 'contradictory' });
  if (fmtA || fmtB) evidence.push({ field: 'format', value: fmtA || fmtB, level: 'edition', status: formatOk ? 'verified' : 'contradictory' });
  if (isbnA || isbnB) {
    const isbnStatus = (isbnsA.length > 0 && isbnsB.length > 0 && !isbnOk)
      ? 'contradictory'
      : (isbnVerified ? 'verified' : 'unverified');
    evidence.push({ field: 'isbn', value: isbnA || isbnB, candidateValue: isbnB || null, level: 'edition', status: isbnStatus });
  }
  if (yearA || yearB) {
    const yearStatus = (yearA && yearsB.length > 0 && !yearsB.includes(yearA))
      ? 'contradictory'
      : (yearVerified ? 'verified' : 'unverified');
    evidence.push({ field: 'year', value: yearA || yearB, candidateValue: yearB || null, level: 'edition', status: yearStatus });
  }
  if (langA || langB) evidence.push({ field: 'language', value: langA || langB, candidateValue: langB || null, level: 'expression', status: langOk ? (langB ? 'verified' : 'unverified') : 'contradictory' });

  return { outcome, workConfidence, editionConfidence, evidence, conflicts, reasonCodes };
}

function candidateCompatibility(request, candidate) {
  return editionCompatibility(request, candidate, { stage: 'candidate' });
}

function parsePositiveIntLocal(val) {
  let p = null;
  if (typeof val === 'number') p = Number.isInteger(val) && val > 0 ? val : null;
  else if (typeof val === 'string' && /^\d+$/.test(val.trim())) {
    const parsed = parseInt(val.trim(), 10);
    p = parsed > 0 ? parsed : null;
  }
  if (p !== null && (p < 1000 || p > 2100)) return null;
  return p;
}

function areEditionsCompatible(a, b) {
  const d = editionCompatibility(a, b);
  if (d.outcome === 'reject' || d.outcome === 'unknown') return false;
  const reqYearA = parsePositiveIntLocal(a?.year || a?.publicationYear || a?.publishedYear || a?.publishYear || a?.publish_year || a?.publication_year || a?.published_year || a?.epubMetadata?.year);
  const reqIsbnA = normalizeIsbn(
    (Array.isArray(a?.isbn13s) ? a.isbn13s[0] : null) ||
    a?.isbn13 || a?.isbn || a?.extra?.isbn || a?.extra?.isbn_13 || a?.epubMetadata?.isbn || ''
  );
  // Authoritative compatibility: when `a` specifies a known edition year or ISBN,
  // an unverified candidate (`provisional` without verified year or ISBN) is NOT
  // treated as a verified match. Pre-download candidate selection uses
  // `candidateCompatibility` / `editionCompatibility` directly.
  if (reqYearA || (reqIsbnA.length === 10 || reqIsbnA.length === 13)) {
    return d.outcome === 'match';
  }
  return d.outcome === 'match' || d.outcome === 'provisional';
}

// ---------- extractIsbn ----------

function extractIsbn(book, query) {
  const candidates = [
    query?.isbn13,
    ...(Array.isArray(query?.isbn13s) ? query.isbn13s : (query?.isbn13s ? [query.isbn13s] : [])),
    query?.isbn,
    ...(Array.isArray(book?.isbn_13) ? book.isbn_13 : (book?.isbn_13 ? [book.isbn_13] : [])),
    ...(Array.isArray(book?.isbn) ? book.isbn : (book?.isbn ? [book.isbn] : [])),
    ...(Array.isArray(book?.isbn_10) ? book.isbn_10 : (book?.isbn_10 ? [book.isbn_10] : [])),
  ];
  for (const cand of candidates) {
    if (!cand) continue;
    const cleaned = normalizeIsbn(cand);
    if (cleaned.length === 10 || cleaned.length === 13) return cleaned;
  }
  return null;
}

// ---------- Export matchDecision aggregate ----------

function matchDecision(request, candidate) {
  const titleD = titleMatchDecision(request?.title || request?.bookTitle, candidate?.title || candidate?.bookTitle);
  const authorD = authorMatchDecision(request?.author || request?.authors, candidate?.author || candidate?.authors);
  const editionD = editionCompatibility(request, candidate);
  // work confidence
  let workConfidence = 'none';
  if (titleD.outcome === 'match' && (request?.author ? authorD.outcome === 'match' : true)) workConfidence = 'high';
  else if (titleD.outcome === 'match') workConfidence = 'medium';
  const outcome = editionD.outcome;
  const evidence = [...titleD.evidence, ...authorD.evidence, ...editionD.evidence];
  const conflicts = [...new Set([...titleD.conflicts, ...authorD.conflicts, ...editionD.conflicts])];
  const reasonCodes = [...new Set([...titleD.reasonCodes, ...authorD.reasonCodes, ...editionD.reasonCodes])];
  return { outcome, workConfidence, editionConfidence: editionD.editionConfidence, evidence, conflicts, reasonCodes };
}

// Back-compat aliases for bridge names
const collectMetadataIsbnPairs = collectIsbnPairs;
function collectMetadataIsbns(obj, out = new Set()) {
  for (const [a, b] of collectIsbnPairs(obj)) {
    const na = normalizeIsbn(a); const nb = normalizeIsbn(b);
    if (na.length === 10 || na.length === 13) out.add(na);
    if (nb.length === 10 || nb.length === 13) out.add(nb);
  }
  return out;
}

// <<< IDENTITY MODULE END

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

  // Edition-aware checks: do not adopt a task for a different year/author/ISBN.
  if (task.year && payload.year && String(task.year) !== String(payload.year)) return false;
  if (task.isbn && payload.isbn && !sameIsbn(task.isbn, payload.isbn)) return false;
  if (task.author && payload.author && !isAuthorMatch(task.author, payload.author)) return false;

  return true;
}

function scoreBookMatch(book, searchTitle, searchAuthor) {
  let score = 0;
  const normQueryTitle = normalizeString(searchTitle);
  const normBookTitle = normalizeString(book.title);
  if (normBookTitle === normQueryTitle) score += 50;
  else if (safePrefix(normBookTitle, normQueryTitle) || safePrefix(normQueryTitle, normBookTitle)) score += 30;
  else if (getTokens(normQueryTitle).length > 1 && getTokens(normQueryTitle).every((t) => getTokens(normBookTitle).includes(t))) score += 20;

  if (searchAuthor) {
    const normQueryAuthor = normalizeString(toNaturalAuthor(searchAuthor));
    const authors = Array.isArray(book.authors) ? book.authors : [book.authors || ''];
    for (const a of authors) {
      const normA = normalizeString(toNaturalAuthor(a));
      if (normA === normQueryAuthor) {
        score += 50;
        break;
      } else {
        const aTokens = getTokens(normA);
        const qTokens = getTokens(normQueryAuthor);
        if (qTokens.length > 0 && qTokens.every((t) => aTokens.includes(t)) && aTokens.length <= qTokens.length + 2) {
          score += 25;
          break;
        }
      }
    }
  }
  return score;
}

function detectFormat(formatVal, titleVal, urlVal) {
  const rawVal = Array.isArray(formatVal) ? formatVal.join(' ') : formatVal;
  const raw = String(rawVal || '').toLowerCase().replace(/^\./, '').trim();
  if (raw === 'epub' || raw === 'pdf') return raw;
  if (raw.includes('epub')) return 'epub';
  if (raw.includes('pdf')) return 'pdf';

  const textToCheck = `${titleVal || ''} ${urlVal || ''}`.toLowerCase();
  if (textToCheck.includes('.epub') || textToCheck.includes('[epub]') || /\bepub\b/.test(textToCheck)) return 'epub';
  if (textToCheck.includes('.pdf') || textToCheck.includes('[pdf]') || /\bpdf\b/.test(textToCheck)) return 'pdf';
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
  if (typeof val === 'boolean') return null;
  if (Array.isArray(val)) return null;
  if (typeof val === 'number') return Number.isFinite(val) ? val : null;
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
    const num = Number(trimmed);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

function parseSizeBytes(val) {
  if (val === undefined || val === null || val === '') return null;
  if (typeof val === 'number') return Number.isFinite(val) ? val : null;
  const direct = toNumber(val);
  if (direct !== null) return direct;
  const match = String(val).trim().match(/^([\d.]+)\s*(b|kb|kib|mb|mib|gb|gib|tb|tib)?$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  const unit = (match[2] || 'b').toLowerCase();
  const multipliers = { b: 1, kb: 1000, kib: 1024, mb: 1000000, mib: 1048576, gb: 1000000000, gib: 1073741824, tb: 1000000000000, tib: 1099511627776 };
  return Math.round(amount * (multipliers[unit] || 1));
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

  // Source-identity guard: do not adopt a task for a different release/source_id.
  const taskSourceId = String(task.source_id || task.book_id || task.id || task.task_id || '').trim();
  const payloadSourceId = String(payload.source_id || payload.id || '').trim();
  if (taskSourceId && payloadSourceId && taskSourceId !== payloadSourceId) return false;

  // Edition-aware checks: do not adopt a task for a different year/author/ISBN.
  if (task.year && payload.year && String(task.year) !== String(payload.year)) return false;
  if (task.isbn && payload.isbn && !sameIsbn(task.isbn, payload.isbn)) return false;
  if (task.author && payload.author && !isAuthorMatch(task.author, payload.author)) return false;

  return true;
}

export {
  normalizeString,
  getTokens,
  toNaturalAuthor,
  extractCoreTitle,
  isTitleMatch,
  isAuthorMatch,
  extractIsbn,
  normalizeIsbn,
  validateIsbn,
  sameIsbn,
  isbn10To13,
  isbn13To10,
  collectIsbnPairs,
  collectMetadataIsbns,
  collectMetadataIsbnPairs,
  areVerifiedCounterparts,
  titleMatchDecision,
  authorMatchDecision,
  editionCompatibility,
  candidateCompatibility,
  matchDecision,
  areEditionsCompatible,
};
