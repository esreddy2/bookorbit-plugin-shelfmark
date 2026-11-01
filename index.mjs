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

const USER_AGENT = 'BookOrbit-Shelfmark-Plugin/1.7.7';

/** Fallback maximum number of releases to return per search. */
const MAX_RESULTS = 25;

/** Supported format preferences (prioritizing EPUB, supporting PDF). */
const FORMAT_PREFERENCE = ['epub', 'pdf'];

/** In-flight resolution cache to prevent concurrent requests from double-queueing. */
const inFlightResolutions = new Map();

/** Confident bidirectional title equivalents. */
export default {
  apiVersion: 1,
  version: '1.8.0',
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
    const querySubtitle = String(query?.subtitle ?? '').trim();
    const querySeriesName = String(query?.seriesName ?? query?.series ?? '').trim();
    const querySeriesIndex = toNumber(query?.seriesIndex ?? query?.seriesPosition ?? query?.series_position);
    // Support BookOrbit v3.5.0 PluginReleaseQuery contract (isbn13, isbn13s, isbn)
    const searchIsbn = extractIsbn(null, query);
    const requestedYear = toNumber(query?.year ?? query?.publicationYear ?? query?.publishYear ?? query?.publishedYear ?? query?.publish_year);
    const requestedLanguage = (query?.language ?? query?.lang) || 'English';
    const metadataQuery = searchTitle || searchIsbn || searchAuthor;
    const decompOpts = {
      author: searchAuthor,
      subtitle: querySubtitle,
      seriesName: querySeriesName,
      seriesIndex: querySeriesIndex,
    };
    const reqVolumeNumber = extractSeriesVolumeNumber(searchTitle, { seriesIndex: querySeriesIndex });
    const titleMatchOpts = {
      reqAuthor: searchAuthor,
      reqSeriesName: querySeriesName,
      reqSeriesIndex: reqVolumeNumber,
    };

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

      // Extract authentic ISBN and year passively (never fabricate from query or parent catalog).
      // ISBN is positive ranking evidence only: different or absent ISBN never blocks discovery.
      // Publication year never affects matching, ranking, or discovery.
      const authenticIsbn = (rel.isbn ? String(rel.isbn).trim() : null) || (rel.extra?.isbn ? String(rel.extra.isbn).trim() : null) || (rel.extra?.isbn13 ? String(rel.extra.isbn13).trim() : null);
      const releaseYear = parsePositiveIntLocal(rel.year || rel.publish_year || rel.publication_year || rel.published_year || rel.publicationYear || rel.publishedYear || rel.extra?.year || rel.extra?.publish_year || rel.extra?.publication_year || null);
      payload.author = displayAuthor || null;
      payload.year = releaseYear;
      // Treat release language metadata as a ranking hint, not authoritative truth; unknown stays null.
      payload.language = rel.language || rel.extra?.language || null;

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

    const reqLangCode = normalizeLanguageCode(requestedLanguage) || 'en';
    const getLanguageHintTier = (r) => {
      const relCode = normalizeLanguageCode(r.language);
      if (!relCode) return 1; // unknown language metadata
      return relCode === reqLangCode ? 0 : 2; // 0 = matching hint, 2 = conflicting hint
    };
    const isNonConflictingLanguageHint = (r) => getLanguageHintTier(r) < 2;

    // Helper to check if search has enough non-conflicting results to stop expensive queries early
    const hasSufficientResults = () => {
      const nonConflicting = releases.filter(isNonConflictingLanguageHint);
      if (nonConflicting.length >= 3) {
        const matchingPref = nonConflicting.filter((r) => r.format === preferredFormat);
        if (matchingPref.length >= 2 || nonConflicting.length >= 5) {
          return true;
        }
      }
      return false;
    };

    const hasExactIsbnBoost = (r) => {
      if (!searchIsbn || !r.isbn) return false;
      return Boolean(sameIsbn(searchIsbn, r.isbn) || areVerifiedCounterparts(searchIsbn, r.isbn, r?.extra?.bookMetadata, r));
    };

    // Helper to rank and slice releases for return:
    // 1. Non-conflicting language hint ahead of conflicting language hint
    // 2. Preferred format (epub before pdf by default)
    // 3. Exact/counterpart ISBN match boost (different ISBN and absent ISBN tie with zero penalty)
    // 4. Positive language hint (explicitly matching language hint ahead of absent language hint)
    // 5. Larger file size tie-breaker (publication year is never used)
    const rankAndSlice = () => {
      return releases
        .sort((a, b) => {
          const langConflictDiff = (getLanguageHintTier(a) === 2 ? 1 : 0) - (getLanguageHintTier(b) === 2 ? 1 : 0);
          if (langConflictDiff !== 0) return langConflictDiff;
          const rankDiff = rankFormat(a.format, preferredFormat) - rankFormat(b.format, preferredFormat);
          if (rankDiff !== 0) return rankDiff;
          const isbnBoostDiff = (hasExactIsbnBoost(a) ? 0 : 1) - (hasExactIsbnBoost(b) ? 0 : 1);
          if (isbnBoostDiff !== 0) return isbnBoostDiff;
          const langHintDiff = getLanguageHintTier(a) - getLanguageHintTier(b);
          if (langHintDiff !== 0) return langHintDiff;
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

    const extractBookSeriesHint = (b) => {
      if (b?.series || b?.series_name || b?.seriesName) return String(b.series || b.series_name || b.seriesName).trim();
      if (Array.isArray(b?.genres)) {
        const g = b.genres.find((x) => typeof x === 'string' && /^serie:/i.test(x));
        if (g) return g.replace(/^serie:/i, '').replace(/_/g, ' ').trim();
      }
      return '';
    };

    const isBookCandidateValid = (b) => {
      const bookTitle = b?.search_title || b?.title || b?.name;
      const rawAuthors = b?.search_author || b?.authors || b?.author;
      const bookSeries = extractBookSeriesHint(b);
      const titleOk = isTitleMatch(bookTitle, searchTitle, {
        ...titleMatchOpts,
        candAuthor: Array.isArray(rawAuthors) ? rawAuthors[0] : rawAuthors,
        candSeriesName: bookSeries,
        reqSeriesName: querySeriesName || bookSeries,
      });
      if (!titleOk) return false;
      if (isNoiseDerivative(bookTitle, searchTitle) || hasCompilationIndicator(bookTitle)) return false;
      const authorsList = Array.isArray(rawAuthors) ? rawAuthors.filter(Boolean) : (rawAuthors ? [rawAuthors] : []);
      if (!searchAuthor || authorsList.length === 0) return true;
      return isAuthorMatch(authorsList, searchAuthor);
    };

    // Step 1 Fallback A: Canonical decomposed work titles, edition-stripped titles, and known title equivalents
    const hasValidCandidates = (bs) => Array.isArray(bs) && bs.some(isBookCandidateValid);
    if (searchTitle && (!books.length || !hasValidCandidates(books))) {
      const queriedMetaNorms = new Set([normalizeString(metadataQuery)]);
      const rawCandidates = extractSearchTitleCandidates(searchTitle, decompOpts);
      const fallbackMetaQueries = [];
      for (const cand of rawCandidates) {
        fallbackMetaQueries.push(cand);
        if (searchAuthor) {
          const natAuthor = toNaturalAuthor(searchAuthor);
          fallbackMetaQueries.push(`${cand} ${natAuthor}`);
        }
      }
      if (searchAuthor) {
        const natAuthor = toNaturalAuthor(searchAuthor);
        fallbackMetaQueries.push(`${searchTitle} ${natAuthor}`);
      }
      for (const altQuery of fallbackMetaQueries) {
        if (signal?.aborted || Date.now() - searchStartTime >= SEARCH_BUDGET_MS) break;
        const normAlt = normalizeString(altQuery);
        if (!normAlt || queriedMetaNorms.has(normAlt)) continue;
        queriedMetaNorms.add(normAlt);
        const altMetaUrl = new URL(`${baseUrl}/api/metadata/search`);
        altMetaUrl.searchParams.set('query', altQuery);
        altMetaUrl.searchParams.set('content_type', 'ebook');
        altMetaUrl.searchParams.set('limit', '25');
        try {
          const altRes = await safeHostFetch(host, altMetaUrl.href, { headers }, signal);
          if (altRes.ok) {
            const altData = await altRes.json().catch(() => ({ books: [] }));
            const altBooks = Array.isArray(altData.books) ? altData.books : (Array.isArray(altData.items) ? altData.items : (Array.isArray(altData.results) ? altData.results : []));
            if (altBooks.length > 0) {
              books = [...books, ...altBooks];
              if (hasValidCandidates(books)) {
                break;
              }
            }
          }
        } catch (_) {
          // Continue fallback
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
            books = [...books, ...isbnData.books];
          }
        }
      } catch (_) {
        // Continue fallback
      }
    }

    // Deduplicate metadata books by provider:provider_id (or normalized title+author) and validate against title, series volume, and author
    const seenBookKeys = new Set();
    const validBooks = books.filter((book) => {
      const dedupId = book?.provider_id
        ? `${book.provider || 'openlibrary'}:${book.provider_id}`
        : `${normalizeString(book?.title || book?.name)}:${normalizeString(Array.isArray(book?.authors) ? book.authors[0] : book?.author)}`;
      if (seenBookKeys.has(dedupId)) return false;
      seenBookKeys.add(dedupId);
      // Metadata publication year may represent the original work while the
      // request targets a modern edition; do not eliminate candidates on year.
      return isBookCandidateValid(book);
    });

    if (validBooks.length > 0) {
      // Sort valid books by match quality: prioritize best metadata match
      validBooks.sort((a, b) => scoreBookMatch(b, searchTitle, searchAuthor) - scoreBookMatch(a, searchTitle, searchAuthor));

      // Loop through top books (prioritizing the best match), breaking early as soon as sufficient results found
      for (const book of validBooks.slice(0, 3)) {
        if (hasSufficientResults()) break;
        if (signal?.aborted || Date.now() - searchStartTime >= SEARCH_BUDGET_MS) break;

        const bookTitle = book.search_title || book.title || searchTitle;
        const bookAuthors = book.search_author || book.authors || book.author;
        const naturalAuthor = toNaturalAuthor(
          (Array.isArray(bookAuthors) && bookAuthors[0]) || bookAuthors || searchAuthor || ''
        );
        const coreTitle = extractCoreTitle(bookTitle, { author: naturalAuthor });
        const isbn = extractIsbn(book, query);

        // Build list of titles to query: prioritize canonical decomposed work title first!
        const titlesToQuery = [];
        const addTitleQuery = (val) => {
          if (!val) return;
          const normV = normalizeString(val);
          if (!normV || titlesToQuery.some((t) => normalizeString(t) === normV)) return;
          titlesToQuery.push(val);
        };
        const reqCandidates = searchTitle ? extractSearchTitleCandidates(searchTitle, decompOpts) : [];
        if (reqCandidates.length > 0) addTitleQuery(reqCandidates[0]);
        addTitleQuery(coreTitle);
        for (const rc of reqCandidates.slice(1)) addTitleQuery(rc);

        // Known title equivalents for book metadata coreTitle if not already added
        const normCore = normalizeString(coreTitle);
        for (const eq of (KNOWN_TITLE_EQUIVALENTS.get(normCore) || [])) {
          addTitleQuery(eq);
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

          const bookSeriesHint = extractBookSeriesHint(book);
          const filterAndAddReleases = (list) => {
            for (const rel of (list || [])) {
              const relTitle = rel.title || '';
              const relAuthor = toNaturalAuthor(rel.author || rel.extra?.author || rel.extra?.Author);
              if (relTitle) {
                if (searchTitle && isNoiseDerivative(relTitle, searchTitle)) {
                  continue;
                }
                const relOpts = {
                  ...titleMatchOpts,
                  candAuthor: relAuthor || naturalAuthor,
                  reqSeriesName: querySeriesName || bookSeriesHint,
                };
                const reqDecision = searchTitle ? titleMatchDecision(relTitle, searchTitle, relOpts) : null;
                if (reqDecision && reqDecision.conflicts.includes('incompatible_series_volume')) {
                  continue;
                }
                const matchesReqTitle = !searchTitle || (reqDecision && (reqDecision.outcome === 'match' || reqDecision.outcome === 'provisional'));
                const matchesBookTitle = Boolean(book.title && isTitleMatch(relTitle, book.title, {
                  candAuthor: relAuthor || naturalAuthor,
                  reqAuthor: naturalAuthor || searchAuthor,
                  reqSeriesName: querySeriesName || bookSeriesHint,
                  reqSeriesIndex: reqVolumeNumber,
                }));
                if (!matchesReqTitle && !matchesBookTitle) {
                  continue;
                }
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

          const beforeNonConflicting = releases.filter(isNonConflictingLanguageHint).length;
          let triedWithoutIsbn = !isbn;
          try {
            const initialReleases = await fetchBookReleases(true);
            filterAndAddReleases(initialReleases);
            if (releases.filter(isNonConflictingLanguageHint).length === beforeNonConflicting && !triedWithoutIsbn) {
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

const NUMBER_ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
];
const NUMBER_TENS = [
  '', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety',
];
const NUMBER_WORD_VALUES = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  hundred: 100, thousand: 1000,
};

function numberToWordsUnder100(n) {
  if (n < 20) return [NUMBER_ONES[n]];
  const ten = NUMBER_TENS[Math.floor(n / 10)];
  const rem = n % 10;
  if (rem === 0) return [ten];
  return [`${ten}-${NUMBER_ONES[rem]}`, `${ten} ${NUMBER_ONES[rem]}`];
}

function numberToWords(n) {
  if (n < 0 || n > 999999 || !Number.isInteger(n)) return [];
  const results = new Set();

  if (n < 100) {
    for (const w of numberToWordsUnder100(n)) results.add(w);
  } else if (n >= 1100 && n <= 1999) {
    // 4-digit year format (e.g. 1984 -> "nineteen eighty-four", "nineteen eighty four")
    const century = Math.floor(n / 100);
    const rem = n % 100;
    const centuryWords = NUMBER_ONES[century];
    if (rem === 0) {
      results.add(`${centuryWords} hundred`);
    } else {
      for (const rw of numberToWordsUnder100(rem)) {
        results.add(`${centuryWords} ${rw}`);
      }
    }
    // Also cardinal format (e.g. "one thousand nine hundred eighty-four")
    for (const rw of numberToWordsUnder100(rem)) {
      results.add(`one thousand ${NUMBER_ONES[century - 10]} hundred and ${rw}`);
      results.add(`one thousand ${NUMBER_ONES[century - 10]} hundred ${rw}`);
    }
  } else if (n >= 2000 && n <= 2099) {
    // Millennium/year format (e.g. 2001 -> "two thousand and one", "two thousand one")
    const rem = n % 100;
    if (rem === 0) {
      results.add('two thousand');
    } else {
      for (const rw of numberToWordsUnder100(rem)) {
        results.add(`two thousand and ${rw}`);
        results.add(`two thousand ${rw}`);
      }
    }
  } else if (n >= 100 && n < 1000) {
    const h = Math.floor(n / 100);
    const rem = n % 100;
    if (rem === 0) {
      results.add(`${NUMBER_ONES[h]} hundred`);
    } else {
      for (const rw of numberToWordsUnder100(rem)) {
        results.add(`${NUMBER_ONES[h]} hundred and ${rw}`);
        results.add(`${NUMBER_ONES[h]} hundred ${rw}`);
        results.add(`${NUMBER_ONES[h]} ${rw}`);
      }
    }
  } else if (n >= 1000) {
    const th = Math.floor(n / 1000);
    const rem = n % 1000;
    const thWords = numberToWords(th);
    for (const tw of thWords) {
      if (rem === 0) {
        results.add(`${tw} thousand`);
      } else {
        const remWords = numberToWords(rem);
        for (const rw of remWords) {
          results.add(`${tw} thousand ${rw}`);
          results.add(`${tw} thousand and ${rw}`);
        }
      }
    }
  }

  return [...results];
}

function parseNumberWords(str) {
  if (!str) return null;
  const tokens = String(str).toLowerCase().replace(/[-]/g, ' ').split(/\s+/).filter((t) => t && t !== 'and');
  if (tokens.length === 0) return null;
  if (!tokens.every((t) => Object.prototype.hasOwnProperty.call(NUMBER_WORD_VALUES, t))) return null;

  // Year format: two 2-digit groups, e.g. "nineteen eighty four" (1984)
  if (tokens.length >= 2) {
    const t0Val = NUMBER_WORD_VALUES[tokens[0]];
    if (t0Val >= 11 && t0Val <= 19) {
      let remVal = 0;
      let validYear = true;
      for (let i = 1; i < tokens.length; i++) {
        const v = NUMBER_WORD_VALUES[tokens[i]];
        if (v === 100 || v === 1000) { validYear = false; break; }
        remVal += v;
      }
      if (validYear && remVal >= 0 && remVal < 100) {
        return t0Val * 100 + remVal;
      }
    }
  }

  // Colloquial 3-digit format: e.g. "four fifty one" (451)
  if (tokens.length >= 2) {
    const t0Val = NUMBER_WORD_VALUES[tokens[0]];
    if (t0Val >= 1 && t0Val <= 9) {
      let remVal = 0;
      let valid3Digit = true;
      for (let i = 1; i < tokens.length; i++) {
        const v = NUMBER_WORD_VALUES[tokens[i]];
        if (v === 100 || v === 1000) { valid3Digit = false; break; }
        remVal += v;
      }
      if (valid3Digit && remVal >= 10 && remVal < 100) {
        return t0Val * 100 + remVal;
      }
    }
  }

  // General cardinal parsing
  let total = 0;
  let current = 0;
  for (const t of tokens) {
    const val = NUMBER_WORD_VALUES[t];
    if (val === 1000) {
      current = (current === 0 ? 1 : current) * 1000;
      total += current;
      current = 0;
    } else if (val === 100) {
      current = (current === 0 ? 1 : current) * 100;
    } else {
      current += val;
    }
  }
  total += current;
  return total;
}

function getNumericTitleEquivalents(title) {
  if (!title) return [];
  const str = String(title).trim();
  const out = new Set();
  const lower = str.toLowerCase();

  // 1. Pure digits: "1984", "2001", "451"
  if (/^\d+$/.test(str)) {
    const n = parseInt(str, 10);
    for (const w of numberToWords(n)) out.add(w);
    return [...out];
  }

  // 2. Pure number words: "nineteen eighty four", "two thousand and one"
  const pureNum = parseNumberWords(str);
  if (pureNum !== null && pureNum >= 0 && pureNum <= 999999) {
    out.add(String(pureNum));
    for (const w of numberToWords(pureNum)) {
      if (w.toLowerCase() !== lower) out.add(w);
    }
    return [...out];
  }

  // 3. Embedded digits in title: "Catch 22", "Fahrenheit 451"
  const digitMatch = str.match(/\b\d+\b/);
  if (digitMatch) {
    const n = parseInt(digitMatch[0], 10);
    const words = numberToWords(n);
    for (const w of words) {
      out.add(str.replace(digitMatch[0], w));
    }
  }

  return [...out];
}

// Algorithmic numeric title equivalences: dynamically computes word and digit equivalents
// for any numeric title (1984, 2001, Catch 22, Fahrenheit 451, etc.) without any hardcoded map.
const KNOWN_TITLE_EQUIVALENTS = {
  get(key) {
    if (!key) return [];
    return getNumericTitleEquivalents(key);
  },
  has(key) {
    if (!key) return false;
    const res = getNumericTitleEquivalents(key);
    return Boolean(res && res.length > 0);
  },
};

function normalizeString(str) {
  if (str == null) return '';
  return String(str)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[şŞ]/g, 'sh')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\b([a-z]{2,})our([a-z]*)\b/g, '$1or$2')
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

const VOLUME_WORD_NUMBERS = new Map([
  ['one', 1], ['first', 1], ['1st', 1],
  ['two', 2], ['second', 2], ['2nd', 2],
  ['three', 3], ['third', 3], ['3rd', 3],
  ['four', 4], ['fourth', 4], ['4th', 4],
  ['five', 5], ['fifth', 5], ['5th', 5],
  ['six', 6], ['sixth', 6], ['6th', 6],
  ['seven', 7], ['seventh', 7], ['7th', 7],
  ['eight', 8], ['eighth', 8], ['8th', 8],
  ['nine', 9], ['ninth', 9], ['9th', 9],
  ['ten', 10], ['tenth', 10], ['10th', 10],
  ['eleven', 11], ['eleventh', 11], ['11th', 11],
  ['twelve', 12], ['twelfth', 12], ['12th', 12],
  ['thirteen', 13], ['thirteenth', 13], ['13th', 13],
  ['fourteen', 14], ['fourteenth', 14], ['14th', 14],
  ['fifteen', 15], ['fifteenth', 15], ['15th', 15],
  ['sixteen', 16], ['sixteenth', 16], ['16th', 16],
  ['seventeen', 17], ['seventeenth', 17], ['17th', 17],
  ['eighteen', 18], ['eighteenth', 18], ['18th', 18],
  ['nineteen', 19], ['nineteenth', 19], ['19th', 19],
  ['twenty', 20], ['twentieth', 20], ['20th', 20],
]);

const ROMAN_VOLUME_NUMBERS = new Map([
  ['i', 1], ['ii', 2], ['iii', 3], ['iv', 4], ['v', 5],
  ['vi', 6], ['vii', 7], ['viii', 8], ['ix', 9], ['x', 10],
  ['xi', 11], ['xii', 12], ['xiii', 13], ['xiv', 14], ['xv', 15],
  ['xvi', 16], ['xvii', 17], ['xviii', 18], ['xix', 19], ['xx', 20],
]);

function parseVolumeToken(rawToken, allowRoman = false) {
  if (!rawToken) return null;
  const tok = String(rawToken).trim().toLowerCase().replace(/^#/, '');
  if (!tok) return null;
  if (/^\d{1,2}$/.test(tok)) {
    const n = parseInt(tok, 10);
    return n >= 1 && n <= 50 ? n : null;
  }
  if (VOLUME_WORD_NUMBERS.has(tok)) return VOLUME_WORD_NUMBERS.get(tok);
  if (allowRoman && ROMAN_VOLUME_NUMBERS.has(tok)) return ROMAN_VOLUME_NUMBERS.get(tok);
  return null;
}

const VOLUME_NUM_PATTERN = '(?:\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|[ivx]{1,4})';

const MULTI_VOLUME_RANGE_RE = new RegExp(
  `\\b(?:books?|vols?\\.?|volumes?|parts?|tomes?)\\s*#?0*${VOLUME_NUM_PATTERN}\\s*(?:[-–—]|to|through|thru|&|and)\\s*#?0*${VOLUME_NUM_PATTERN}\\b`,
  'i'
);
const HASH_VOLUME_RANGE_RE = /(?:^|[\s([,])#\s*0*\d{1,2}\s*[-–—]\s*#?\s*0*\d{1,2}\b/i;
const MULTI_BOOK_PACK_RE = /\b(?:\d{1,2}\s*[-–—]?\s*books?\s+(?:set|pack|bundle|collection|series|omnibus|in\s+1|in\s+one)|\d{1,2}\s*-\s*in\s*-\s*1|complete\s+(?:series|collection|works|stories)|\bcomplete\b|\bomnibus\b|\banthology\b|series\s+collection|\d{1,3}\s+(?:short\s+)?stories|\d{1,2}\s+novels|\d{1,3}\s+tales)\b/i;

function hasMultiVolumeIndicator(title) {
  if (!title) return false;
  const s = String(title);
  if (s.length > 1000) return false;
  if (MULTI_VOLUME_RANGE_RE.test(s) || HASH_VOLUME_RANGE_RE.test(s) || MULTI_BOOK_PACK_RE.test(s)) {
    return true;
  }
  // Slash-separated multi-title compilations (e.g. "The Lightning Thief / The Sea of Monsters")
  if (/\s+\/\s+/.test(s)) {
    const slashParts = s.split(/\s+\/\s+/).map(p => p.trim()).filter(Boolean);
    if (slashParts.length >= 2) {
      // Check if it's a bilingual title (e.g. "Amor en Juego / The Long Game")
      // If one side has very similar length/tokens or matches, or if it's just two language variants of the same title, do not treat as multi-volume anthology.
      // Specifically, if there are exactly 2 parts and one part is clearly a translation/equivalent or has substantial token overlap, or if we check common bilingual patterns.
      // Let's implement a robust check: if slashParts.length === 2 and one part contains the other's core tokens or if they are both translations (e.g. Spanish/English), skip multi-volume.
      // Even simpler: if slashParts.length === 2, check if any token from part 1 appears in part 2 or vice versa, or if one is a translation.
      const p0Norm = normalizeString(slashParts[0]);
      const p1Norm = normalizeString(slashParts[1]);
      const t0 = getTokens(p0Norm);
      const t1 = getTokens(p1Norm);
      const overlap = t0.filter(t => t1.includes(t));
      // If there's token overlap or if one side has common bilingual indicators or similar length without distinct volume numbers/different book names (e.g. different proper nouns)
      // Actually, standard bilingual titles often share at least one word or are translations. But if they share no words (e.g. "Book A / Book B"), it's an anthology.
      // If overlap.length > 0 or (t0.length <= 3 && t1.length <= 3), or if they are bilingual. Let's check if overlap.length === 0 and both have >= 2 distinct substantive tokens (like "Lightning Thief / Sea of Monsters").
      const substantive0 = t0.filter(t => t.length > 3);
      const substantive1 = t1.filter(t => t.length > 3);
      const hasDistinctSubstantiveOverlap = substantive0.some(t => substantive1.includes(t));
      if (slashParts.length === 2 && !hasDistinctSubstantiveOverlap && substantive0.length >= 2 && substantive1.length >= 2) {
        // Distinct books like "Lightning Thief / Sea of Monsters"
        return true;
      }
      if (slashParts.length > 2) {
        return true;
      }
    }
  }
  return false;
}

const hasCompilationIndicator = hasMultiVolumeIndicator;

const EXPLICIT_VOLUME_KEYWORD_RE = new RegExp(
  `\\b(?:book|vol\\.?|volume|part|tome)\\s+#?0*(${VOLUME_NUM_PATTERN})\\b`,
  'i'
);
const ORDINAL_BEFORE_VOLUME_RE = /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d{1,2}(?:st|nd|rd|th))\s+(?:book|volume|part|tome)\b/i;
const COMPANION_VOLUME_RE = /\b(?:companion\s+books?|episode|installment)\s+#?0*(\d{1,2})\b/i;
const HASH_SINGLE_VOLUME_RE = /(?:^|[\s([,-])#\s*0*([1-9]\d?)\b/;

function extractSeriesVolumeNumber(title, options = {}) {
  const optIdx = options?.seriesIndex ?? options?.seriesPosition ?? options?.series_position;
  if (optIdx !== undefined && optIdx !== null && optIdx !== '') {
    const parsedOpt = typeof optIdx === 'number' ? optIdx : Number(String(optIdx).trim());
    if (Number.isInteger(parsedOpt) && parsedOpt >= 1 && parsedOpt <= 99) {
      return parsedOpt;
    }
  }
  if (!title) return null;
  const s = String(title);
  if (s.length > 1000 || hasMultiVolumeIndicator(s)) return null;

  const kwMatch = s.match(EXPLICIT_VOLUME_KEYWORD_RE);
  if (kwMatch) {
    const v = parseVolumeToken(kwMatch[1], true);
    if (v !== null) return v;
  }
  const ordMatch = s.match(ORDINAL_BEFORE_VOLUME_RE);
  if (ordMatch) {
    const v = parseVolumeToken(ordMatch[1], false);
    if (v !== null) return v;
  }
  const compMatch = s.match(COMPANION_VOLUME_RE);
  if (compMatch) {
    const v = parseVolumeToken(compMatch[1], false);
    if (v !== null) return v;
  }
  const hashMatch = s.match(HASH_SINGLE_VOLUME_RE);
  if (hashMatch) {
    const v = parseVolumeToken(hashMatch[1], false);
    if (v !== null) return v;
  }

  // Check parentheticals like "(Percy Jackson and the Olympians 5)" or "(Series Name, 05)"
  const parenRe = /\(([^()]{2,120})\)/g;
  let pm;
  while ((pm = parenRe.exec(s)) !== null) {
    const inner = pm[1].trim();
    const m = inner.match(/^([\p{L}][\p{L}\s'’&-]{2,}?)[,\s]+0*([1-9]|[12]\d|30)$/u);
    if (m) {
      const prefixWords = getTokens(m[1]);
      if (prefixWords.length >= 2 && !/\b(?:edition|anniversary|printing|version|grade|level|stage)\b/i.test(m[1])) {
        return parseInt(m[2], 10);
      }
    }
  }

  return null;
}

const EDITION_DESCRIPTOR_WORD = '(?:enhanced|illustrated|deluxe|special|collector\'?s?|unabridged|expanded|revised|updated|definitive|annotated|critical|restored|author\'?s?\\s+preferred|author\'?s?|signature|gift|luxury|leatherbound|hardcover|paperback|mass\\s+market|trade|ebook|e-book|digital|kindle|nook|library|international|us|uk|new|modern\\s+library|penguin\\s+classics|oxford\\s+world\'?s?\\s+classics|vintage\\s+classics|movie\\s+tie[- ]in|tv\\s+tie[- ]in|film\\s+tie[- ]in|tie[- ]in)';
const FULL_EDITION_SEGMENT_RE = new RegExp(
  `^(?:the\\s+)?(?:(?:\\d{1,3}(?:st|nd|rd|th)\\s+)?(?:anniversary|centennial|bicentennial)|(?:${EDITION_DESCRIPTOR_WORD}\\s+)*${EDITION_DESCRIPTOR_WORD})\\s+edition$`,
  'i'
);
const TRAILING_EDITION_SUFFIX_RE = new RegExp(
  `[,\\s]+(?:(?:\\d{1,3}(?:st|nd|rd|th)\\s+)?(?:anniversary|centennial|bicentennial)|(?:${EDITION_DESCRIPTOR_WORD}\\s+)*${EDITION_DESCRIPTOR_WORD})\\s+edition$`,
  'i'
);

function stripEditionDescriptors(str) {
  if (!str) return '';
  let s = String(str).trim();
  if (!s || s.length > 1000) return s;
  if (FULL_EDITION_SEGMENT_RE.test(s)) return '';
  const stripped = s.replace(TRAILING_EDITION_SUFFIX_RE, '').trim();
  if (stripped && (stripped.match(/[\p{L}\p{N}]/gu) || []).length >= 2) {
    return stripped;
  }
  return s;
}

function isGenericOrDescriptiveSubtitle(seg) {
  if (!seg) return false;
  const s = String(seg).trim();
  if (!s) return true;
  if (FULL_EDITION_SEGMENT_RE.test(s)) return true;
  const norm = normalizeString(s);
  if (!norm) return true;
  if (/^or\s+/.test(norm)) return true;
  if (/^(?:a|an|the)?\s*(?:[\p{L}\p{N}]+\s+){0,3}(?:novel|novella|memoir|biography|autobiography|thriller|mystery|romance|story|stories|fairy\s+story|tale|tales|fable|saga|chronicle|adventure|play|poems|poetry|essays|guide|handbook|manual|journal|diary|classics?)$/iu.test(norm)) {
    return true;
  }
  if (/^(?:a|an|the|your|my|our)\s+(?:brief|short|complete|new|secret|untold|true|intimate|definitive|concise|illustrated|real|official|unauthorized|authorized|practical|essential|ultimate|insiders?)?\s*(?:history|story|biography|memoir|guide|handbook|account|portrait|chronicle|journey|life|lives|world|fates|rise|fall|making|origins|science|art|power|psychology|philosophy|odyssey|way)\b/.test(norm)) {
    return true;
  }
  if (/^(?:sequel|prequel|companion|continuation|follow-?up)\s+to\b/i.test(norm)) return true;
  if (/^(?:how|why|what|when|where|who)\s+/.test(norm)) return true;
  return false;
}

const PURE_VOLUME_SEGMENT_RE = new RegExp(
  `^(?:(?:book|vol\\.?|volume|part|tome)\\s+#?0*(${VOLUME_NUM_PATTERN})|#?0*([1-9]|[12]\\d|30))$`,
  'i'
);
const SERIES_WITH_EXPLICIT_VOLUME_SEGMENT_RE = new RegExp(
  `^(.+?)(?:[,\\s]+(?:book|vol\\.?|volume|part|tome)\\s+#?0*(${VOLUME_NUM_PATTERN})|[,\\s]+#\\s*0*([1-9]\\d?)|\\s+companion\\s+books?\\s+#?0*(\\d{1,2}))$`,
  'i'
);
const SERIES_WITH_BARE_NUMBER_SEGMENT_RE = /^([\p{L}][\p{L}\s'’&.-]{2,}?)\s+0*([1-9]|[12]\d|30)$/u;
const ATTRIBUTION_PREFIX_SEGMENT_RE = /^from\s+(?:the\s+(?:files|world|pages|journals?|chronicles|universe|desk|archives)\s+of\s+)?[\p{L}\p{N}][\p{L}\p{N}\s'’&.-]{1,70}$/iu;
const UNPUNCTUATED_SERIES_VOLUME_RE = /^(.+?)\s+(?:(?:series|trilogy|duology|saga|chronicles?)\s+)?(?:(?:book|vol\.?|volume|part|tome)\s+#?0*([1-9]\d?)|#\s*0*([1-9]\d?)|0*([1-9]\d?))\s+(?=[A-Za-z\p{L}])(.+)$/iu;

const NON_PERSON_TITLE_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'from', 'by', 'into', 'about',
  'book', 'volume', 'vol', 'part', 'tome', 'edition', 'chapter', 'story', 'stories', 'tales', 'tale',
  'chronicles', 'adventures', 'history', 'guide', 'summary', 'notes', 'analysis', 'study', 'companion',
  'world', 'war', 'secret', 'secrets', 'last', 'first', 'new', 'old', 'dark', 'light', 'house', 'city',
]);

function looksLikePersonNamePrefix(seg) {
  if (!seg || seg.length > 60) return false;
  const s = String(seg).trim();
  // Transposed "Last, First"
  if (/^[\p{Lu}][\p{L}'’-]+,\s*[\p{Lu}][\p{L}.'’\s-]{0,30}$/u.test(s)) {
    const toks = getTokens(s);
    if (toks.length >= 2 && toks.length <= 4 && toks.every((t) => !NON_PERSON_TITLE_WORDS.has(t))) return true;
  }
  const rawParts = s.split(/\s+/).filter(Boolean);
  if (rawParts.length < 2 || rawParts.length > 4) return false;
  // Require initials (e.g. "J K Rowling", "J.K. Rowling")
  const hasInitial = rawParts.slice(0, -1).some((p) => /^(?:[\p{Lu}]\.?){1,2}$/u.test(p));
  if (hasInitial) {
    const toks = getTokens(s);
    return toks.length >= 2 && toks.every((t) => !NON_PERSON_TITLE_WORDS.has(t));
  }
  // Standard capitalized 2-3 word person name (e.g. "Agatha Christie", "Arthur Conan Doyle")
  if (rawParts.length >= 2 && rawParts.length <= 3 && rawParts.every((p) => /^[\p{Lu}][\p{Ll}'’-]{1,25}$/u.test(p))) {
    const toks = getTokens(s);
    if (toks.length >= 2 && toks.every((t) => !NON_PERSON_TITLE_WORDS.has(t))) {
      return true;
    }
  }
  return false;
}

function decomposeTitleStructure(title, options = {}) {
  if (!title) {
    return {
      canonicalTitle: '',
      rawCore: '',
      hasExplicitPrefix: false,
      seriesPrefix: null,
      substantiveTail: null,
      colonRhsWorkCandidate: null,
      volumeNumber: extractSeriesVolumeNumber('', options),
    };
  }
  const rawStr = String(title).trim();
  // Fast linear fallback for adversarial/oversized inputs
  if (rawStr.length > 1000) {
    let fast = stripBracketedGroups(rawStr, '[', ']');
    fast = stripBracketedGroups(fast, '(', ')').trim();
    const fastParts = fast.split(/(?:\s+[-–—]\s+|[:;|]|\s*[–—]\s*)/);
    const fastCore = fastParts[0]?.trim() || fast;
    return {
      canonicalTitle: fastCore,
      rawCore: fastCore,
      hasExplicitPrefix: false,
      seriesPrefix: null,
      substantiveTail: null,
      colonRhsWorkCandidate: null,
      volumeNumber: null,
    };
  }

  let volumeNumber = extractSeriesVolumeNumber(rawStr, options);

  let s = stripBracketedGroups(rawStr, '[', ']');
  s = stripBracketedGroups(s, '(', ')');
  s = s.replace(/\s+download\b/gi, '').trim();

  const byMatch = s.split(/\s+by\s+/i);
  if (byMatch.length > 1 && byMatch[0].trim().length >= 2) {
    const suffix = byMatch[1].trim();
    const suffixTokens = suffix.split(/\s+/).filter(Boolean);
    const looksLikeAuthor = suffix.includes(',') || (suffixTokens.length >= 2 && suffixTokens.some((t) => t.length >= 5));
    if (looksLikeAuthor) s = byMatch[0].trim();
  }

  // Note: '/' is intentionally NOT a core-truncation delimiter so "Title A / Title B" omnibuses never collapse to "Title A".
  const rawSegments = s.split(/(?:\s+[-–—]\s+|[:;|]|\s*[–—]\s*)/).map((p) => p.trim()).filter(Boolean);
  const unpunctSegments = [];
  for (const seg of rawSegments) {
    const m = seg.match(UNPUNCTUATED_SERIES_VOLUME_RE);
    if (m && m[1].length >= 2 && m[5].length >= 2 && !/\b(?:edition|anniversary|version|no|nr)\.?$/i.test(m[1].trim())) {
      const vol = m[2] || m[3] || m[4];
      unpunctSegments.push(`${m[1]} #${vol}`.trim(), m[5].trim());
    } else {
      unpunctSegments.push(seg);
    }
  }

  const cleanedSegments = [];
  for (const seg of unpunctSegments) {
    const strippedSeg = stripEditionDescriptors(seg);
    if (strippedSeg) cleanedSegments.push(strippedSeg);
  }

  if (cleanedSegments.length === 0) {
    const fallback = stripEditionDescriptors(s) || s;
    return {
      canonicalTitle: fallback,
      rawCore: fallback,
      hasExplicitPrefix: false,
      seriesPrefix: null,
      substantiveTail: null,
      colonRhsWorkCandidate: null,
      volumeNumber,
    };
  }

  const optAuthor = options?.author || '';
  if (cleanedSegments.length > 1) {
    const lastSeg = cleanedSegments[cleanedSegments.length - 1];
    if ((optAuthor && isAuthorMatch(lastSeg, optAuthor)) || (!optAuthor && /\s+[-–—]\s+/.test(s) && looksLikePersonNamePrefix(lastSeg))) {
      cleanedSegments.pop();
    }
  }

  const rawCore = cleanedSegments[0];
  let idx = 0;
  let hasExplicitPrefix = false;
  let seriesPrefix = null;
  const normOptSeries = normalizeString(options?.seriesName || '');

  // Peel up to 3 leading series/volume/franchise/author prefix segments when followed by a real work title segment
  let hops = 0;
  while (idx < cleanedSegments.length - 1 && hops < 3) {
    hops++;
    const seg = cleanedSegments[idx];
    const nextSeg = cleanedSegments[idx + 1];
    if (!nextSeg || (nextSeg.match(/[\p{L}\p{N}]/gu) || []).length < 2) break;

    // 1. Pure volume segment (e.g. "Book 1: Harry Potter..." or "... - 05 - The Last Olympian")
    const pureVol = seg.match(PURE_VOLUME_SEGMENT_RE);
    if (pureVol) {
      const parsedV = parseVolumeToken(pureVol[1] || pureVol[2], Boolean(pureVol[1]));
      // Only treat bare number segment like "05" as volume when preceded by a series/author prefix
      if (pureVol[1] || idx > 0) {
        if (volumeNumber === null && parsedV !== null) volumeNumber = parsedV;
        hasExplicitPrefix = true;
        idx++;
        continue;
      }
    }

    // 2. Series + explicit volume segment (e.g. "Percy Jackson and the Olympians, Book Five")
    const explicitSeriesVol = seg.match(SERIES_WITH_EXPLICIT_VOLUME_SEGMENT_RE);
    if (explicitSeriesVol) {
      const parsedV = parseVolumeToken(
        explicitSeriesVol[2] || explicitSeriesVol[3] || explicitSeriesVol[4],
        Boolean(explicitSeriesVol[2])
      );
      if (volumeNumber === null && parsedV !== null) volumeNumber = parsedV;
      if (!seriesPrefix) seriesPrefix = explicitSeriesVol[1].trim();
      hasExplicitPrefix = true;
      idx++;
      continue;
    }

    // 3. Series segment followed by a pure volume segment and then a work title (e.g. "Percy Jackson - 05 - The Last Olympian")
    if (idx + 2 < cleanedSegments.length) {
      const midPure = nextSeg.match(PURE_VOLUME_SEGMENT_RE);
      const afterMid = cleanedSegments[idx + 2];
      if (midPure && afterMid && !isGenericOrDescriptiveSubtitle(afterMid)) {
        const parsedV = parseVolumeToken(midPure[1] || midPure[2], Boolean(midPure[1]));
        if (volumeNumber === null && parsedV !== null) volumeNumber = parsedV;
        if (!seriesPrefix) seriesPrefix = seg;
        hasExplicitPrefix = true;
        idx += 2;
        continue;
      }
    }

    // Remaining prefix rules require nextSeg not to be a generic/descriptive subtitle (preserves "From Russia with Love: A Novel")
    if (isGenericOrDescriptiveSubtitle(nextSeg)) break;

    // 4. Series prefix ending in bare 1..30 volume number (e.g. "Percy Jackson 5 - The Last Olympian" or "ACOTAR 3 - A Court of Wings and Ruin")
    const bareSeriesVol = seg.match(SERIES_WITH_BARE_NUMBER_SEGMENT_RE);
    if (bareSeriesVol) {
      const prefixTokens = getTokens(bareSeriesVol[1]);
      if (prefixTokens.length >= 1) {
        const parsedV = parseInt(bareSeriesVol[2], 10);
        if (volumeNumber === null && parsedV >= 1 && parsedV <= 30) volumeNumber = parsedV;
        if (!seriesPrefix) seriesPrefix = bareSeriesVol[1].trim();
        hasExplicitPrefix = true;
        idx++;
        continue;
      }
    }

    // 5. Universe/attribution prefix ("From Percy Jackson: Camp Half-Blood Confidential")
    if (ATTRIBUTION_PREFIX_SEGMENT_RE.test(seg)) {
      if (!seriesPrefix) seriesPrefix = seg.replace(/^from\s+(?:the\s+(?:files|world|pages|journals?|chronicles|universe|desk|archives)\s+of\s+)?/i, '').trim();
      hasExplicitPrefix = true;
      idx++;
      continue;
    }

    // 6. Explicit seriesName match from structured request/metadata
    const normSeg = normalizeString(seg);
    if (normOptSeries && (normSeg === normOptSeries || stripLeadingArticle(normSeg) === stripLeadingArticle(normOptSeries))) {
      if (!seriesPrefix) seriesPrefix = seg;
      hasExplicitPrefix = true;
      idx++;
      continue;
    }

    // 7. Author prefix before dash/colon ("J. K. Rowling - Harry Potter..." or matching known author)
    if ((optAuthor && isAuthorMatch(seg, optAuthor)) || (!optAuthor && /\s+[-–—]\s+/.test(s) && looksLikePersonNamePrefix(seg))) {
      hasExplicitPrefix = true;
      idx++;
      continue;
    }

    break;
  }

  const workSeg = stripEditionDescriptors(cleanedSegments[idx]) || cleanedSegments[idx];
  const tailSeg = idx + 1 < cleanedSegments.length ? cleanedSegments[idx + 1] : null;

  let substantiveTail = null;
  let colonRhsWorkCandidate = null;
  const isVolumeOrSeriesSeg = (seg) => {
    if (!seg) return false;
    return /#\s*\d+/i.test(seg) ||
      PURE_VOLUME_SEGMENT_RE.test(seg) ||
      SERIES_WITH_EXPLICIT_VOLUME_SEGMENT_RE.test(seg) ||
      SERIES_WITH_BARE_NUMBER_SEGMENT_RE.test(seg) ||
      /\b(?:series|book|vol|volume|part)\s+\d+/i.test(seg);
  };

  if (!hasExplicitPrefix && idx === 0 && tailSeg && !isGenericOrDescriptiveSubtitle(tailSeg)) {
    const tailTokens = getTokens(tailSeg).filter((t) => !['the', 'a', 'an'].includes(t));
    if (tailTokens.length >= 1) {
      substantiveTail = tailSeg;
      // If original title used ':' or '-' and both sides have >= 2 words, RHS may be the standalone work title of an unnumbered series entry
      // (only if RHS is not a series/volume segment)
      const delimParts = s.split(/(?:\s+[-–—]\s+|:)/);
      if (delimParts.length === 2 && getTokens(workSeg).length >= 2 && getTokens(tailSeg).length >= 2 && !isVolumeOrSeriesSeg(tailSeg)) {
        colonRhsWorkCandidate = tailSeg;
      }
    }
  }

  let canonicalTitle = (workSeg && workSeg.length >= 2) ? workSeg : (rawCore && rawCore.length >= 2 ? rawCore : s);
  if (!hasExplicitPrefix && idx === 0 && substantiveTail && volumeNumber !== null) {
    if (isVolumeOrSeriesSeg(substantiveTail)) {
      if (!seriesPrefix) seriesPrefix = substantiveTail;
      canonicalTitle = workSeg;
    } else {
      if (!seriesPrefix) seriesPrefix = workSeg;
      hasExplicitPrefix = true;
      canonicalTitle = substantiveTail;
    }
  }
  return {
    canonicalTitle,
    rawCore,
    hasExplicitPrefix,
    seriesPrefix,
    substantiveTail,
    colonRhsWorkCandidate,
    volumeNumber,
  };
}

function extractCoreTitle(title, options = {}) {
  if (!title) return '';
  return decomposeTitleStructure(title, options).canonicalTitle;
}

function extractSearchTitleCandidates(title, options = {}) {
  const out = [];
  const seen = new Set();
  const pushCandidate = (val) => {
    if (!val) return;
    const trimmed = String(val).trim();
    const norm = normalizeString(trimmed);
    if (!norm || norm.length < 2 || seen.has(norm)) return;
    seen.add(norm);
    out.push(trimmed);
  };

  if (!title && !options?.subtitle) return out;
  const rawTitle = String(title || '').trim();
  const decomp = decomposeTitleStructure(rawTitle, options);

  // Prioritize specific colon RHS work candidate over generic franchise prefix
  // (e.g. "Sherlock Holmes: A Study in Scarlet" -> "A Study in Scarlet")
  if (decomp.colonRhsWorkCandidate && decomp.canonicalTitle !== decomp.colonRhsWorkCandidate) {
    pushCandidate(decomp.colonRhsWorkCandidate);
  }

  // 1. Canonical decomposed work title (e.g. "The Last Olympian", "The Chalice of the Gods", "Harry Potter and the Chamber of Secrets", "Guards! Guards!")
  pushCandidate(decomp.canonicalTitle);

  // Raw core if distinct
  if (decomp.rawCore && decomp.canonicalTitle !== decomp.rawCore) {
    pushCandidate(decomp.rawCore);
  }

  // Substantive tail if distinct
  if (decomp.substantiveTail && decomp.canonicalTitle !== decomp.substantiveTail) {
    pushCandidate(decomp.substantiveTail);
  }

  // 2. Edition-stripped & bracket-stripped full string if distinct (e.g. strips "(Enhanced Edition)" or "(From the World of ...)")
  let strippedFull = stripBracketedGroups(rawTitle, '[', ']');
  strippedFull = stripBracketedGroups(strippedFull, '(', ')').trim();
  strippedFull = stripEditionDescriptors(strippedFull);
  pushCandidate(strippedFull);

  // Extract substantive non-edition parenthetical text (e.g. "The Stranger (L'Etranger)")
  const parenMatch = rawTitle.match(/\(([^)]+)\)/);
  if (parenMatch) {
    const parenContent = parenMatch[1].trim();
    if (!/^(?:book|vol|volume|part|edition|version|\d+)/i.test(parenContent) && getTokens(parenContent).length >= 1) {
      pushCandidate(parenContent);
    }
  }

  // 3. Secondary colon RHS work title for unnumbered "Series Name: Work Title"
  if (decomp.colonRhsWorkCandidate) {
    pushCandidate(decomp.colonRhsWorkCandidate);
  }

  // 4. Structured subtitle if provided separately by BookOrbit and substantive
  if (options?.subtitle && !isGenericOrDescriptiveSubtitle(options.subtitle)) {
    const cleanSub = stripEditionDescriptors(options.subtitle);
    if (getTokens(cleanSub).length >= 2) pushCandidate(cleanSub);
  }

  // 5. Known numeric/word title equivalents and work-level translations
  for (const existing of [...out, rawTitle]) {
    const eqs = KNOWN_TITLE_EQUIVALENTS.get(normalizeString(existing));
    if (eqs) {
      for (const eq of eqs) pushCandidate(eq);
    }
  }

  return out;
}

function isNoiseDerivative(candidateTitle, requestedTitle) {
  const normCand = normalizeString(candidateTitle);
  const normReq = normalizeString(requestedTitle);
  const reqHasCompilation = hasMultiVolumeIndicator(requestedTitle) || /\b(?:complete|collection|set|omnibus|stories|anthology|adventures)\b/i.test(requestedTitle);
  const noiseMarkers = [
    'summary of', 'study guide', 'cliffsnotes', 'sparknotes', 'analysis of',
    'workbook for', 'book summary', 'companion to', 'teacher guide', 'teachers guide',
    'lesson plans', 'activity guide', 'adapted by', 'retold by', 'simplified edition',
    'simplified retelling', 'retelling', 'abridged', 'graded reader', 'oxford bookworms',
    'penguin active reading', 'penguin readers', 'macmillan readers', 'graphic novel',
    'comic book', 'illustrated novel', 'complete works', 'box set', 'boxed set',
    'omnibus', 'anthology', 'historias de', 'relatos de', 'cuentos de',
    'obras completas', 'coleccion de', 'and other stories', 'and other writings',
    'other writings', 'selected works', 'selected writings', 'short stories', 'complete collection',
    'trivia', 'supersummary', 'fastreads', 'adaptation', '4 vols', 'box-set', 'boxed-set',
  ];
  for (const marker of noiseMarkers) {
    if (normCand.includes(marker) && !normReq.includes(marker) && !reqHasCompilation) return true;
  }
  if (/\b(?:stage|level)\s*[1-6]\b/i.test(candidateTitle) && !/\b(?:stage|level)\s*[1-6]\b/i.test(requestedTitle)) return true;
  const isSlashBilingual = /\s+\/\s+/.test(candidateTitle) &&
    candidateTitle.split(/\s+\/\s+/).some((p) => {
      const pNorm = normalizeString(p);
      return pNorm === normReq || stripLeadingArticle(pNorm) === stripLeadingArticle(normReq);
    });
  if (hasMultiVolumeIndicator(candidateTitle) && !reqHasCompilation && !isSlashBilingual) return true;
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

function sameCanonicalWorkPhrase(a, b) {
  const na = normalizeString(a);
  const nb = normalizeString(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const naNoArt = stripLeadingArticle(na);
  const nbNoArt = stripLeadingArticle(nb);
  if (naNoArt && nbNoArt && naNoArt === nbNoArt) return true;
  const eqA = KNOWN_TITLE_EQUIVALENTS.get(na);
  if (eqA && eqA.some((eq) => normalizeString(eq) === nb || stripLeadingArticle(normalizeString(eq)) === nbNoArt)) return true;
  const eqB = KNOWN_TITLE_EQUIVALENTS.get(nb);
  if (eqB && eqB.some((eq) => normalizeString(eq) === na || stripLeadingArticle(normalizeString(eq)) === naNoArt)) return true;
  return false;
}

function titleMatchDecision(candidateTitle, requestedTitle, options = {}) {
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

  const candDecomp = decomposeTitleStructure(candidateTitle, {
    author: options?.candAuthor || options?.author,
    seriesName: options?.candSeriesName || options?.seriesName,
    seriesIndex: options?.candSeriesIndex,
  });
  const reqDecomp = decomposeTitleStructure(requestedTitle, {
    author: options?.reqAuthor || options?.author,
    seriesName: options?.reqSeriesName || options?.seriesName,
    seriesIndex: options?.reqSeriesIndex,
  });

  // Series-volume identity guard: conflicting explicit volume numbers always reject, even if work title words overlap
  if (candDecomp.volumeNumber !== null && reqDecomp.volumeNumber !== null && candDecomp.volumeNumber !== reqDecomp.volumeNumber) {
    conflicts.push('incompatible_series_volume');
    reasonCodes.push('incompatible_series_volume');
    return { outcome: 'reject', workConfidence: 'none', editionConfidence: 'none', evidence, conflicts, reasonCodes };
  }

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

  // Bilingual slash title: if one side of a slash matches requestedTitle
  if (/\s+\/\s+/.test(candidateTitle)) {
    const slashParts = candidateTitle.split(/\s+\/\s+/);
    for (const part of slashParts) {
      const pNorm = normalizeString(part);
      if (pNorm === normReq || stripLeadingArticle(pNorm) === stripLeadingArticle(normReq)) {
        evidence.push({ field: 'title', value: pNorm, level: 'work', status: 'verified' });
        return { outcome: 'match', workConfidence: 'high', editionConfidence: 'medium', evidence, conflicts, reasonCodes };
      }
    }
  }

  const coreCand = normalizeString(candDecomp.canonicalTitle);
  const coreReq = normalizeString(reqDecomp.canonicalTitle);

  // Guard against two different works sharing an unnumbered series/franchise prefix (e.g. "Series: Book A" vs "Series: Book B")
  if (!candDecomp.hasExplicitPrefix && !reqDecomp.hasExplicitPrefix &&
      coreCand && coreReq && sameCanonicalWorkPhrase(coreCand, coreReq) &&
      candDecomp.substantiveTail && reqDecomp.substantiveTail &&
      !sameCanonicalWorkPhrase(candDecomp.substantiveTail, reqDecomp.substantiveTail)) {
    conflicts.push('title_mismatch');
    reasonCodes.push('conflicting_subtitle_or_series_entry');
    return { outcome: 'reject', workConfidence: 'none', editionConfidence: 'none', evidence, conflicts, reasonCodes };
  }

  const candPrefixAllowed = !candDecomp.hasExplicitPrefix && safePrefix(candidateTitle, requestedTitle);
  const reqPrefixAllowed = !reqDecomp.hasExplicitPrefix && safePrefix(requestedTitle, candidateTitle);
  if (candPrefixAllowed || reqPrefixAllowed) {
    evidence.push({ field: 'title', value: normCand, level: 'work', status: 'verified' });
    return { outcome: 'match', workConfidence: 'high', editionConfidence: 'medium', evidence, conflicts, reasonCodes };
  }
  if (!candDecomp.hasExplicitPrefix && !reqDecomp.hasExplicitPrefix && (normCand.includes(normReq) || normReq.includes(normCand))) {
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
      if (normCand === normEq || (!candDecomp.hasExplicitPrefix && safePrefix(normCand, normEq)) || (!reqDecomp.hasExplicitPrefix && safePrefix(normEq, normCand))) {
        evidence.push({ field: 'title', value: normCand, level: 'work', status: 'verified' });
        return { outcome: 'match', workConfidence: 'high', editionConfidence: 'medium', evidence, conflicts, reasonCodes };
      }
    }
  }
  const candEquivalents = KNOWN_TITLE_EQUIVALENTS.get(normCand);
  if (candEquivalents) {
    for (const eq of candEquivalents) {
      const normEq = normalizeString(eq);
      if (normReq === normEq || (!reqDecomp.hasExplicitPrefix && safePrefix(normReq, normEq)) || (!candDecomp.hasExplicitPrefix && safePrefix(normEq, normReq))) {
        evidence.push({ field: 'title', value: normCand, level: 'work', status: 'verified' });
        return { outcome: 'match', workConfidence: 'high', editionConfidence: 'medium', evidence, conflicts, reasonCodes };
      }
    }
  }

  // Canonical decomposed work-title match (handles series/volume prefixes, "From ..." prefixes, and edition descriptors)
  if (coreCand && coreReq && sameCanonicalWorkPhrase(coreCand, coreReq)) {
    evidence.push({ field: 'title', value: coreCand, level: 'work', status: 'verified' });
    return { outcome: 'match', workConfidence: 'high', editionConfidence: 'medium', evidence, conflicts, reasonCodes };
  }
  if (!candDecomp.hasExplicitPrefix && coreReq && sameCanonicalWorkPhrase(normCand, coreReq)) {
    evidence.push({ field: 'title', value: coreReq, level: 'work', status: 'verified' });
    return { outcome: 'match', workConfidence: 'high', editionConfidence: 'medium', evidence, conflicts, reasonCodes };
  }
  const reqSeries = normalizeString(reqDecomp.seriesPrefix || options?.reqSeriesName || options?.seriesName || '');
  if (!candDecomp.hasExplicitPrefix && reqSeries && coreReq && normCand.includes(coreReq) && normCand.includes(reqSeries) && getTokens(coreReq).length >= 2) {
    evidence.push({ field: 'title', value: coreReq, level: 'work', status: 'verified' });
    return { outcome: 'match', workConfidence: 'high', editionConfidence: 'medium', evidence, conflicts, reasonCodes };
  }
  if (!reqDecomp.hasExplicitPrefix && coreCand && sameCanonicalWorkPhrase(coreCand, normReq)) {
    evidence.push({ field: 'title', value: coreCand, level: 'work', status: 'verified' });
    return { outcome: 'match', workConfidence: 'high', editionConfidence: 'medium', evidence, conflicts, reasonCodes };
  }
  // Allow canonical core + descriptive subtitle prefix (e.g. req "From Percy Jackson: Camp Half-Blood Confidential" vs cand "Camp Half-Blood Confidential: Your Real Guide...")
  if (coreCand && coreReq && ((!candDecomp.substantiveTail && safePrefix(coreCand, coreReq)) || (!reqDecomp.substantiveTail && safePrefix(coreReq, coreCand)))) {
    evidence.push({ field: 'title', value: coreReq, level: 'work', status: 'verified' });
    return { outcome: 'match', workConfidence: 'high', editionConfidence: 'medium', evidence, conflicts, reasonCodes };
  }

  // Unnumbered "Series Name: Work Title" request matching standalone "Work Title" candidate
  if (reqDecomp.colonRhsWorkCandidate && !candDecomp.colonRhsWorkCandidate && sameCanonicalWorkPhrase(coreCand, reqDecomp.colonRhsWorkCandidate)) {
    evidence.push({ field: 'title', value: normalizeString(reqDecomp.colonRhsWorkCandidate), level: 'work', status: 'verified' });
    return { outcome: 'match', workConfidence: 'high', editionConfidence: 'medium', evidence, conflicts, reasonCodes };
  }
  // Candidate "Series Name: Work Title" when candidate's prefix matches request's known series prefix or explicit series keyword
  if (candDecomp.colonRhsWorkCandidate && sameCanonicalWorkPhrase(candDecomp.colonRhsWorkCandidate, coreReq)) {
    const candPrefixNorm = normalizeString(candDecomp.rawCore);
    const reqSeriesNorm = normalizeString(reqDecomp.seriesPrefix || options?.reqSeriesName || options?.seriesName || '');
    const explicitSeriesWord = /\b(?:series|saga|trilogy|chronicles|universe|world\s+of|adventures\s+of)\b/i.test(candDecomp.rawCore || '');
    if ((reqSeriesNorm && sameCanonicalWorkPhrase(candPrefixNorm, reqSeriesNorm)) || explicitSeriesWord) {
      evidence.push({ field: 'title', value: coreReq, level: 'work', status: 'verified' });
      return { outcome: 'match', workConfidence: 'high', editionConfidence: 'medium', evidence, conflicts, reasonCodes };
    }
  }

  const candTokens = getTokens(candDecomp.canonicalTitle || candidateTitle);
  const reqTokens = getTokens(reqDecomp.canonicalTitle || requestedTitle);
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
      evidence.push({ field: 'title', value: coreCand || normCand, level: 'work', status: 'verified' });
      return { outcome: 'match', workConfidence: 'high', editionConfidence: 'medium', evidence, conflicts, reasonCodes };
    }
  }
  if (!candDecomp.hasExplicitPrefix && !reqDecomp.hasExplicitPrefix && artReqTokens.length > 1 && artCandTokens.length === artReqTokens.length + 1) {
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

function isTitleMatch(candidateTitle, requestedTitle, options = {}) {
  if (!requestedTitle) return true;
  if (!candidateTitle) return false;
  const d = titleMatchDecision(candidateTitle, requestedTitle, options);
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
  // Check co-authors if requestedAuthor has "and", "&" or ","
  const subReqs = /\s+(?:and|&)\s+|\s*,\s*/.test(requestedAuthor) 
    ? String(requestedAuthor).split(/\s+(?:and|&)\s+|\s*,\s*/).map(a => toNaturalAuthor(a)).filter(Boolean)
    : [requestedAuthor];

  for (const subReq of subReqs) {
    if (subReq === requestedAuthor) continue;
    const subD = authorMatchDecision(candidateAuthors, subReq);
    if (subD.outcome === 'match') {
      return subD;
    }
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
    // Check if candTokens matches one of the sub-authors
    if (subReqs.length > 1) {
      const matchesAnySub = subReqs.some(sub => {
        const subTokens = getTokens(normalizeString(toNaturalAuthor(sub)));
        return subTokens.length > 0 && subTokens.every(t => candTokens.includes(t)) && candTokens.length <= subTokens.length + 2;
      });
      if (matchesAnySub) {
        evidence.push({ field: 'author', value: candNorm, level: 'work', status: 'verified' });
        return { outcome: 'match', workConfidence: 'high', editionConfidence: 'medium', evidence, conflicts, reasonCodes };
      }
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
    // Single-token mononym / classical name with Latin stem or minor spelling variant (e.g. Virgil vs Publius Vergilius Maro)
    if (reqTokens.length === 1 && reqTokens[0].length >= 4) {
      const srt = reqTokens[0].replace(/(?:ius|us|is|es)$/, '');
      const hasStemMatch = candTokens.some((ct) => {
        const sct = ct.replace(/(?:ius|us|is|es)$/, '');
        if (sct === srt) return true;
        if (srt.length >= 4 && sct.length >= 4 && Math.abs(sct.length - srt.length) <= 1) {
          let diffs = 0;
          const minLen = Math.min(sct.length, srt.length);
          for (let i = 0; i < minLen; i++) {
            if (sct[i] !== srt[i]) diffs++;
          }
          if (diffs + Math.abs(sct.length - srt.length) <= 1) return true;
        }
        return false;
      });
      if (hasStemMatch) {
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

// ---------- Work + language compatibility (ISBN positive-only, year ignored) ----------

function editionCompatibility(a, b, options = {}) {
  const evidence = [];
  const conflicts = [];
  const reasonCodes = [];
  if (!a || !b) {
    return {
      outcome: 'unknown',
      workConfidence: 'none',
      editionConfidence: 'none',
      languageHint: 'unknown',
      isbnVerified: false,
      evidence,
      conflicts,
      reasonCodes: ['missing_input'],
    };
  }
  const treatLanguageAsHint = Boolean(options?.treatLanguageAsHint || options?.stage === 'candidate');

  // 1. Work title & series-volume identity (preserves canonical equivalents & rejects summaries/anthologies/abridgments/wrong volumes)
  const titleA = (a.bookTitle || a.title || a.requestTitle || '').trim();
  const titleB = (b.bookTitle || b.title || b.requestTitle || '').trim();
  const authorsA = Array.isArray(a.authors) && a.authors.length ? a.authors : (a.author ? [a.author] : []);
  const authorsB = Array.isArray(b.authors) && b.authors.length ? b.authors : (b.author ? [b.author] : []);
  let titleOk = true;
  if (titleA && titleB) {
    const td = titleMatchDecision(titleB, titleA, {
      candAuthor: authorsB[0] || '',
      reqAuthor: authorsA[0] || '',
      candSeriesName: b.seriesName || b.requestSeriesName || b.series || '',
      reqSeriesName: a.seriesName || a.requestSeriesName || a.series || '',
      candSeriesIndex: b.seriesIndex ?? b.requestSeriesIndex ?? b.seriesPosition ?? b.series_position,
      reqSeriesIndex: a.seriesIndex ?? a.requestSeriesIndex ?? a.seriesPosition ?? a.series_position,
    });
    if (td.outcome !== 'match' || isNoiseDerivative(titleA, titleB)) {
      titleOk = false;
      if (td.conflicts.includes('incompatible_series_volume')) {
        conflicts.push('incompatible_series_volume');
      }
      conflicts.push('incompatible_title');
    }
  } else if (titleA || titleB) {
    // one side missing title: cannot establish work identity
    titleOk = false; conflicts.push('missing_title');
  }

  // 2. Work author
  let authorOk = true;
  if (authorsA.length && authorsB.length) {
    let anyMatch = false;
    for (const aa of authorsA) for (const bb of authorsB) {
      if (authorMatchDecision(aa, bb).outcome === 'match') anyMatch = true;
    }
    if (!anyMatch) { authorOk = false; conflicts.push('incompatible_author'); }
  } else if (authorsA.length || authorsB.length) {
    authorOk = false; conflicts.push('missing_author');
  }

  // 3. File format
  const fmtA = (a.format || '').trim().toLowerCase();
  const fmtB = (b.format || '').trim().toLowerCase();
  let formatOk = true;
  if (fmtA && fmtB && fmtA !== fmtB) { formatOk = false; conflicts.push('incompatible_format'); }

  // 4. Language (defaults to English 'en'; treated as a hint in candidate discovery)
  const langA = normalizeLanguageCode(a.requestLanguage || a.language || a.epubMetadata?.language || '') || 'en';
  const langB = normalizeLanguageCode(b.requestLanguage || b.language || b.epubMetadata?.language || '');
  let langOk = true;
  let languageHint = 'unknown';
  if (langB) {
    if (langA === langB) {
      languageHint = 'match';
    } else {
      languageHint = 'mismatch';
      if (treatLanguageAsHint) {
        reasonCodes.push('language_hint_mismatch');
      } else {
        langOk = false;
        conflicts.push('language_mismatch');
      }
    }
  } else {
    reasonCodes.push('unknown_release_language');
  }

  // 5. ISBN — positive evidence ONLY (exact/counterpart match boosts priority; different or absent ISBN never penalizes or blocks)
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
  let isbnVerified = false;
  if (isbnsA.length > 0 && isbnsB.length > 0) {
    for (const ia of isbnsA) {
      for (const ib of isbnsB) {
        if (sameIsbn(ia, ib) || areVerifiedCounterparts(ia, ib, a?.trustedIsbns, a?.bookMetadata, a?.extra?.bookMetadata, b?.trustedIsbns, b?.bookMetadata, b?.extra?.bookMetadata, a, b)) {
          isbnVerified = true;
          break;
        }
      }
      if (isbnVerified) break;
    }
  }

  // Note: Publication year is intentionally NOT used for matching, ranking, or rejection.

  const allOk = titleOk && authorOk && formatOk && langOk;
  let editionConfidence = 'none';
  if (allOk) {
    if (isbnVerified && languageHint !== 'mismatch') editionConfidence = 'high';
    else if (languageHint === 'mismatch') editionConfidence = 'low';
    else editionConfidence = 'medium';
  }
  const outcome = allOk ? (isbnVerified && languageHint !== 'mismatch' ? 'match' : 'provisional') : 'reject';
  const workConfidence = (titleOk && authorOk) ? 'high' : 'none';

  evidence.push({ field: 'title', value: titleA, level: 'work', status: titleOk ? 'verified' : 'contradictory' });
  const authorAVal = Array.isArray(a.authors) ? (a.authors[0] || a.author || '') : (a.author || '');
  evidence.push({ field: 'author', value: authorAVal, level: 'work', status: authorOk ? 'verified' : 'contradictory' });
  if (fmtA || fmtB) evidence.push({ field: 'format', value: fmtA || fmtB, level: 'edition', status: formatOk ? 'verified' : 'contradictory' });
  if (isbnA || isbnB) {
    const isbnStatus = isbnVerified ? 'verified' : (isbnB ? 'informational' : 'absent');
    evidence.push({ field: 'isbn', value: isbnA || isbnB, candidateValue: isbnB || null, level: 'edition', status: isbnStatus });
  }
  if (langA || langB) {
    const langStatus = !langOk
      ? 'contradictory'
      : (languageHint === 'match' ? 'hint_match' : (languageHint === 'mismatch' ? 'hint_conflict' : 'unverified'));
    evidence.push({ field: 'language', value: langA || langB, candidateValue: langB || null, level: 'expression', status: langStatus });
  }

  return { outcome, workConfidence, editionConfidence, languageHint, isbnVerified, evidence, conflicts, reasonCodes };
}

function candidateCompatibility(request, candidate) {
  return editionCompatibility(request, candidate, { stage: 'candidate', treatLanguageAsHint: true });
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
  const titleD = titleMatchDecision(candidate?.title || candidate?.bookTitle, request?.title || request?.bookTitle, {
    candAuthor: candidate?.author || (Array.isArray(candidate?.authors) ? candidate.authors[0] : ''),
    reqAuthor: request?.author || (Array.isArray(request?.authors) ? request.authors[0] : ''),
    candSeriesName: candidate?.seriesName || candidate?.series || '',
    reqSeriesName: request?.seriesName || request?.series || '',
    candSeriesIndex: candidate?.seriesIndex ?? candidate?.seriesPosition ?? candidate?.series_position,
    reqSeriesIndex: request?.seriesIndex ?? request?.seriesPosition ?? request?.series_position,
  });
  const authorD = authorMatchDecision(candidate?.author || candidate?.authors, request?.author || request?.authors);
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

function scoreBookMatch(book, searchTitle, searchAuthor) {
  if (!book) return -100;
  const bookTitle = book.title || book.name || book.search_title || '';
  const normQueryTitle = normalizeString(searchTitle);
  const normBookTitle = normalizeString(bookTitle);
  const normQueryCore = normalizeString(extractCoreTitle(searchTitle, { author: searchAuthor }));
  const normBookCore = normalizeString(extractCoreTitle(bookTitle, { author: searchAuthor }));

  // Immediate heavy penalty for noise derivatives, summaries, study guides, trivia, or box sets
  // when the search is for an individual book
  const reqHasCompilation = hasCompilationIndicator(searchTitle) || /\b(?:complete|collection|set|omnibus|stories|anthology|adventures)\b/i.test(searchTitle);
  const isSlashBilingual = /\s+\/\s+/.test(bookTitle) &&
    bookTitle.split(/\s+\/\s+/).some((p) => {
      const pNorm = normalizeString(p);
      return pNorm === normQueryTitle || pNorm === normQueryCore || stripLeadingArticle(pNorm) === stripLeadingArticle(normQueryTitle) || stripLeadingArticle(pNorm) === stripLeadingArticle(normQueryCore);
    });
  if (isNoiseDerivative(bookTitle, searchTitle) || (hasCompilationIndicator(bookTitle) && !reqHasCompilation && !isSlashBilingual)) {
    return -60;
  }

  // Check if candidate title is just the author's name or a generic 1-word series/character name
  if (searchAuthor && isAuthorMatch(bookTitle, searchAuthor)) {
    return -40;
  }
  const decompReq = decomposeTitleStructure(searchTitle, { author: searchAuthor });
  if (decompReq.hasExplicitPrefix && decompReq.seriesPrefix) {
    const genericPrefixNorm = normalizeString(decompReq.seriesPrefix);
    const specificCoreNorm = normalizeString(decompReq.canonicalTitle || '');
    if (genericPrefixNorm && normBookTitle !== specificCoreNorm && (normBookTitle === genericPrefixNorm || stripLeadingArticle(normBookTitle) === stripLeadingArticle(genericPrefixNorm))) {
      // The candidate is just the generic series/franchise prefix (e.g. "Sherlock Holmes" or "Discworld")
      return -40;
    }
  }

  let titleScore = 0;
  if (normBookTitle && normQueryTitle && normBookTitle === normQueryTitle) {
    titleScore = 60;
  } else if (normQueryCore && normBookCore && (
    normBookCore === normQueryCore ||
    stripLeadingArticle(normBookCore) === stripLeadingArticle(normQueryCore) ||
    sameCanonicalWorkPhrase(normBookCore, normQueryCore)
  )) {
    titleScore = 55;
  } else if (isTitleMatch(bookTitle, searchTitle, { reqAuthor: searchAuthor })) {
    titleScore = 45;
  } else if (normQueryCore && getTokens(normQueryCore).length >= 2 && normBookTitle.includes(normQueryCore)) {
    titleScore = 45;
  } else if (normBookCore && getTokens(normBookCore).length >= 2 && normQueryTitle.includes(normBookCore)) {
    if (decompReq.seriesPrefix) {
      const normSeries = normalizeString(decompReq.seriesPrefix);
      const isOnlySeries = normBookCore === normSeries || stripLeadingArticle(normBookCore) === stripLeadingArticle(normSeries);
      const workTitleNorm = normalizeString(decompReq.canonicalTitle || '');
      if (isOnlySeries && workTitleNorm && !normBookTitle.includes(workTitleNorm)) {
        titleScore = 0;
      } else {
        titleScore = 45;
      }
    } else {
      titleScore = 45;
    }
  } else if (safePrefix(normBookTitle, normQueryTitle) || safePrefix(normQueryTitle, normBookTitle)) {
    titleScore = 30;
  } else {
    // Check known equivalents / translations
    const queryEqs = KNOWN_TITLE_EQUIVALENTS.get(normQueryCore || normQueryTitle);
    if (queryEqs && queryEqs.some((eq) => normalizeString(eq) === normBookCore || normalizeString(eq) === normBookTitle)) {
      titleScore = 50;
    } else {
      const bookEqs = KNOWN_TITLE_EQUIVALENTS.get(normBookCore || normBookTitle);
      if (bookEqs && bookEqs.some((eq) => normalizeString(eq) === normQueryCore || normalizeString(eq) === normQueryTitle)) {
        titleScore = 50;
      }
    }
  }

  // Token containment fallback (only if > 1 token and boundaries ok)
  if (titleScore === 0) {
    const qTokens = getTokens(normQueryTitle);
    const bTokens = getTokens(normBookTitle);
    if (qTokens.length > 1 && qTokens.every((t) => bTokens.includes(t))) {
      titleScore = 20;
    }
  }

  // Parenthetical alias inside search title (e.g. "The Stranger (L'Etranger)")
  const parenMatch = searchTitle.match(/\(([^)]+)\)/);
  if (parenMatch && titleScore === 0) {
    const parenNorm = normalizeString(parenMatch[1]);
    if (parenNorm && getTokens(parenNorm).length >= 1 && (normBookTitle === parenNorm || safePrefix(normBookTitle, parenNorm) || safePrefix(parenNorm, normBookTitle))) {
      titleScore = 55;
    }
  }

  // CRUCIAL: Title compatibility is a strict prerequisite for author points!
  // If titleScore is 0, this candidate represents an unrelated title. Author points must NEVER elevate it.
  if (titleScore === 0) {
    return 0;
  }

  let authorScore = 0;
  if (searchAuthor) {
    const isGenericAuthor = /\b(?:traditional|anonymous|unknown|various|uncredited)\b/i.test(searchAuthor);
    const normQueryAuthor = normalizeString(toNaturalAuthor(searchAuthor));
    const authors = Array.isArray(book.authors) ? book.authors : (book.author ? [book.author] : []);
    if (authors.length === 0 || isGenericAuthor) {
      // Author missing in metadata (neutral, e.g. Count of Monte Cristo OpenLibrary record)
      // or generic/traditional author placeholder where candidate author is translator/compiler
      authorScore = isGenericAuthor ? 10 : 5;
    } else {
      let matchedAuthor = false;
      for (const a of authors) {
        if (!a) continue;
        if (isAuthorMatch(a, searchAuthor)) {
          matchedAuthor = true;
          authorScore = 50;
          break;
        }
        const normA = normalizeString(toNaturalAuthor(a));
        if (normA === normQueryAuthor) {
          matchedAuthor = true;
          authorScore = 50;
          break;
        }
        const aTokens = getTokens(normA);
        const qTokens = getTokens(normQueryAuthor);
        if (qTokens.length > 0 && qTokens.every((t) => aTokens.includes(t)) && aTokens.length <= qTokens.length + 2) {
          matchedAuthor = true;
          authorScore = 30;
          break;
        }
      }
      if (!matchedAuthor) {
        // If candidate author is non-Latin script (Han, Cyrillic, Arabic, etc.) and searchAuthor is Latin,
        // do not treat as conflicting author when title match is high confidence (>= 45)
        const hasNonLatinAuthor = authors.some((a) => /[\p{Script=Han}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(a));
        if (hasNonLatinAuthor && titleScore >= 45) {
          authorScore = 20;
        } else {
          // Known conflicting author: penalize heavily
          authorScore = -30;
        }
      }
    }
  }

  // A book with a known conflicting author should never have a positive score
  if (authorScore < 0) {
    return -20;
  }

  return titleScore + authorScore;
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

  // Work-identity guard: do not adopt a task for a different author (ISBN and year never block).
  if (task.author && payload.author && !isAuthorMatch(task.author, payload.author)) return false;

  return true;
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

  // Work-identity guard: do not adopt a task for a different author (ISBN and year never block).
  if (task.author && payload.author && !isAuthorMatch(task.author, payload.author)) return false;

  return true;
}

export {
  normalizeString,
  getTokens,
  toNaturalAuthor,
  extractCoreTitle,
  extractSearchTitleCandidates,
  extractSeriesVolumeNumber,
  decomposeTitleStructure,
  stripEditionDescriptors,
  hasMultiVolumeIndicator,
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
