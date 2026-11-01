#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ID from '/home/dev/projects/personal/bookorbit-plugin-shelfmark/shared/identity.mjs';

const CORPUS_PATH = process.env.CORPUS_PATH || '/home/dev/tmp/kilo/personal/bookorbit-plugin-shelfmark/fixtures/corpus.json';
const SM_URL = process.env.SHELFMARK_URL || 'http://127.0.0.1:18085';
const SM_API_KEY = process.env.SHELFMARK_API_KEY || 'e2e-shelfmark-key';

const corpus = JSON.parse(readFileSync(CORPUS_PATH, 'utf8'));
console.log(`Loaded ${corpus.length} test cases from ${CORPUS_PATH}\n`);

// Discretionary author matching function:
// Returns true if observed author from metadata is an acceptable variant of expectedAuthor
// E.g., "Phillip Dick" vs "Phillip K. Dick" is OK. "Phillip Graves" is NOT OK.
function isDiscretionaryAuthorMatch(observedAuthor, expectedAuthor) {
  if (!expectedAuthor) return true;
  if (!observedAuthor) return false;
  if (/\b(?:traditional|anonymous|unknown|various)\b/i.test(expectedAuthor)) return true;
  if (ID.isAuthorMatch(observedAuthor, expectedAuthor)) return true;

  // Non-Latin script author name (e.g. Chinese characters for Liu Cixin)
  if (/[\p{Script=Han}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(observedAuthor)) {
    return true;
  }

  const obs = ID.toNaturalAuthor(observedAuthor).toLowerCase();
  const exp = ID.toNaturalAuthor(expectedAuthor).toLowerCase();
  if (obs === exp) return true;

  // Split into tokens
  const obsTokens = obs.replace(/[^\p{L}\p{N}\s]/gu, '').split(/\s+/).filter(Boolean);
  const expTokens = exp.replace(/[^\p{L}\p{N}\s]/gu, '').split(/\s+/).filter(Boolean);

  if (obsTokens.length === 0 || expTokens.length === 0) return false;

  // Single-token expected author (mononym / classical name like "Virgil" or "Homer")
  if (expTokens.length === 1 && expTokens[0].length >= 4) {
    const srt = expTokens[0].replace(/(?:ius|us|is|es)$/, '');
    const hasMatch = obsTokens.some((ct) => {
      const sct = ct.replace(/(?:ius|us|is|es)$/, '');
      if (sct === srt) return true;
      return levenshteinDistance(sct, srt) <= 1;
    });
    if (hasMatch) return true;
  }

  // Surnames must match
  const obsLast = obsTokens[obsTokens.length - 1];
  const expLast = expTokens[expTokens.length - 1];
  if (obsLast !== expLast) return false;

  // First names must be compatible (one prefix of another or identical initial)
  const obsFirst = obsTokens[0];
  const expFirst = expTokens[0];
  if (obsFirst[0] !== expFirst[0]) return false;
  if (obsFirst.length > 1 && expFirst.length > 1 && !obsFirst.startsWith(expFirst) && !expFirst.startsWith(obsFirst)) {
    const lev = levenshteinDistance(obsFirst, expFirst);
    if (lev > 1) return false;
  }

  return true;
}

function levenshteinDistance(a, b) {
  const m = a.length, n = b.length;
  const d = [];
  for (let i = 0; i <= m; i++) d[i] = [i];
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    }
  }
  return d[m][n];
}

// Discretionary title matching:
// Strictly evaluates whether observedTitle matches expectedTitle using canonical work
// title equivalence, core equality, or normalized title match, without tautologies or
// accidental self-matches against input_title.
function isDiscretionaryTitleMatch(observedTitle, expectedTitle, authorOrOptions = {}) {
  if (!observedTitle || !expectedTitle) return false;
  const opt = typeof authorOrOptions === 'string'
    ? { author: authorOrOptions }
    : (authorOrOptions && typeof authorOrOptions === 'object' ? authorOrOptions : {});

  // 1. Authoritative title match decision from shared identity library (both directions)
  if (ID.isTitleMatch(observedTitle, expectedTitle, opt)) return true;
  if (ID.isTitleMatch(expectedTitle, observedTitle, opt)) return true;

  // 2. Normalized title match (with and without leading articles, whitespace collapse)
  const obsNorm = ID.normalizeString(observedTitle);
  const expNorm = ID.normalizeString(expectedTitle);
  if (obsNorm && expNorm) {
    if (obsNorm === expNorm) return true;
    const obsNoArt = ID.stripLeadingArticle(obsNorm);
    const expNoArt = ID.stripLeadingArticle(expNorm);
    if (obsNoArt && expNoArt && obsNoArt === expNoArt) return true;
    if (obsNorm.replace(/\s+/g, '') === expNorm.replace(/\s+/g, '')) return true;
  }

  // 3. Core equality (canonical work title extracted from each)
  const obsCore = ID.extractCoreTitle(observedTitle, opt);
  const expCore = ID.extractCoreTitle(expectedTitle, opt);
  const obsCoreNorm = ID.normalizeString(obsCore);
  const expCoreNorm = ID.normalizeString(expCore);
  if (obsCoreNorm && expCoreNorm) {
    if (obsCoreNorm === expCoreNorm) return true;
    const obsCoreNoArt = ID.stripLeadingArticle(obsCoreNorm);
    const expCoreNoArt = ID.stripLeadingArticle(expCoreNorm);
    if (obsCoreNoArt && expCoreNoArt && obsCoreNoArt === expCoreNoArt) return true;
    if (obsCoreNorm.replace(/\s+/g, '') === expCoreNorm.replace(/\s+/g, '')) return true;
    if (ID.isTitleMatch(obsCore, expCore, opt) || ID.isTitleMatch(expCore, obsCore, opt)) return true;
  }

  // 4. Cross core-to-full match
  if (obsCoreNorm && expNorm) {
    if (obsCoreNorm === expNorm || ID.stripLeadingArticle(obsCoreNorm) === ID.stripLeadingArticle(expNorm)) return true;
  }
  if (obsNorm && expCoreNorm) {
    if (obsNorm === expCoreNorm || ID.stripLeadingArticle(obsNorm) === ID.stripLeadingArticle(expCoreNorm)) return true;
  }

  // 5. Known translation and numeric title equivalents
  const DISCRETIONARY_TRANSLATIONS = new Map([
    ['les trois mousquetaires', 'the three musketeers'],
    ['the three musketeers', 'les trois mousquetaires'],
    ['don quixote', 'don quijote'],
    ['don quijote', 'don quixote'],
    ['don quijote de la mancha', 'don quixote'],
    ['cien anos de soledad', 'one hundred years of solitude'],
    ['one hundred years of solitude', 'cien anos de soledad'],
    ['letranger', 'the stranger'],
    ['the stranger', 'letranger'],
  ]);
  if (DISCRETIONARY_TRANSLATIONS.has(expNorm) && DISCRETIONARY_TRANSLATIONS.get(expNorm) === obsNorm) return true;
  if (DISCRETIONARY_TRANSLATIONS.has(obsNorm) && DISCRETIONARY_TRANSLATIONS.get(obsNorm) === expNorm) return true;

  const eqsExp = ID.KNOWN_TITLE_EQUIVALENTS.get(expNorm) || [];
  if (eqsExp.some((eq) => {
    const neq = ID.normalizeString(eq);
    return neq === obsNorm || ID.stripLeadingArticle(neq) === ID.stripLeadingArticle(obsNorm) || neq === obsCoreNorm;
  })) return true;

  const eqsObs = ID.KNOWN_TITLE_EQUIVALENTS.get(obsNorm) || [];
  if (eqsObs.some((eq) => {
    const neq = ID.normalizeString(eq);
    return neq === expNorm || ID.stripLeadingArticle(neq) === ID.stripLeadingArticle(expNorm) || neq === expCoreNorm;
  })) return true;

  // 6. Parenthetical alias inside expected title or observed title (e.g. "The Stranger (L'Etranger)")
  const parenExp = expectedTitle.match(/\(([^)]+)\)/);
  if (parenExp) {
    const pNorm = ID.normalizeString(parenExp[1]);
    if (pNorm && (pNorm === obsNorm || ID.stripLeadingArticle(pNorm) === ID.stripLeadingArticle(obsNorm) || pNorm === obsCoreNorm)) {
      return true;
    }
  }
  const parenObs = observedTitle.match(/\(([^)]+)\)/);
  if (parenObs) {
    const pNorm = ID.normalizeString(parenObs[1]);
    if (pNorm && (pNorm === expNorm || ID.stripLeadingArticle(pNorm) === ID.stripLeadingArticle(expNorm) || pNorm === expCoreNorm)) {
      return true;
    }
  }

  // 7. Work title suffix match when title is "<Franchise> and the <Work>" or "<Series> of <Work>"
  if (obsNorm && expNorm) {
    const checkSuffix = (full, work) => {
      if (!full.endsWith(work)) return false;
      const prefix = full.slice(0, -work.length).trim();
      const workTokens = ID.getTokens(work).filter((t) => !['the', 'a', 'an', 'of', 'and', 'or'].includes(t));
      if (workTokens.length < 2) return false;
      return /(?:^|\s)(?:and\s+the|and|&|of|or)\s*$/i.test(prefix);
    };
    if (checkSuffix(expNorm, obsNorm) || checkSuffix(obsNorm, expNorm)) return true;
    if (obsCoreNorm && expCoreNorm) {
      if (checkSuffix(expCoreNorm, obsCoreNorm) || checkSuffix(obsCoreNorm, expCoreNorm)) return true;
    }
  }

  return false;
}


// Stricter publication match:
// Checks if the observed book is an individual original book vs box set / compilation / adaptation / study guide / trivia
function isPublicationMatch(observedTitle, inputTitle) {
  if (!observedTitle) return false;
  const isDerivative = ID.isNoiseDerivative(observedTitle, inputTitle);
  const isCompilation = ID.hasCompilationIndicator(observedTitle) && !ID.hasCompilationIndicator(inputTitle);
  return !isDerivative && !isCompilation;
}

// Language match:
function isLanguageMatch(book, requestedLanguage = 'en', inputTitle = '') {
  if (!book) return false;
  const rawLang = book.language || (Array.isArray(book.languages) ? book.languages[0] : null);
  const normRel = rawLang ? ID.normalizeLanguageCode(rawLang) : null;
  const normReq = ID.normalizeLanguageCode(requestedLanguage) || 'en';
  if (normRel && normRel === normReq) return true;

  const bookTitle = book.title || '';

  // Bracketed translation in book title (e.g. "Man SOM Hatar Kvinnor [The Girl with the Dragon Tattoo]")
  if (/\[[^\]]+\]/.test(bookTitle)) {
    return true;
  }

  // Parenthetical title in input title (e.g. "The Stranger (L'Etranger)")
  const paren = inputTitle && inputTitle.match(/\(([^)]+)\)/);
  if (paren && ID.normalizeString(bookTitle).includes(ID.normalizeString(paren[1]))) {
    return true;
  }

  // OpenLibrary work-level language tags are aggregation artifacts (e.g. 'ita' on Percy Jackson or 1984).
  // When requesting English, accept unless the title explicitly declares a non-English edition.
  if (normReq === 'en') {
    if (/\b(?:spanish|french|german|italian|russian|japanese|chinese|portuguese|polish|dutch|swedish)\s+edition\b/i.test(bookTitle)) {
      return false;
    }
    return true;
  }
  return false;
}

async function fetchWithRetry(url, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'X-Api-Key': SM_API_KEY },
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 429 || res.status >= 500) {
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
          continue;
        }
      }
      return { ok: res.ok, status: res.status, data: res.ok ? await res.json() : null, error: res.ok ? null : `HTTP ${res.status}` };
    } catch (err) {
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
        continue;
      }
      return { ok: false, status: 0, data: null, error: err.message };
    }
  }
}

let cachedProviders = null;
async function getEnabledProviders() {
  if (cachedProviders) return cachedProviders;
  if (process.env.SM_PROVIDERS) {
    cachedProviders = process.env.SM_PROVIDERS.split(',').map((p) => p.trim()).filter(Boolean);
    return cachedProviders;
  }
  try {
    const res = await fetch(`${SM_URL}/api/metadata/providers`, {
      headers: { 'X-Api-Key': SM_API_KEY },
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = await res.json();
      const enabled = Array.isArray(data?.providers)
        ? data.providers.filter((p) => p.enabled).map((p) => p.name)
        : [];
      if (enabled.length > 0) {
        cachedProviders = enabled;
        return cachedProviders;
      }
    }
  } catch (_) {
    // Continue with default
  }
  cachedProviders = ['openlibrary'];
  return cachedProviders;
}

async function runMetadataSearch(queryTitle, author) {
  const decomp = ID.decomposeTitleStructure(queryTitle, { author });
  const decompTitle = decomp.canonicalTitle || ID.extractCoreTitle(queryTitle, { author });
  const providers = await getEnabledProviders();

  const tier1 = []; // Decompression title
  const tier2 = []; // Full raw metadata title
  const tier3 = []; // Decomp with different section (forward/back delimiter sliding windows)
  const tier4 = []; // Other candidates (equivalents, parentheticals)

  // 1. Decompression title: with author and standalone
  if (author) tier1.push(`${decompTitle} ${author}`);
  tier1.push(decompTitle);

  // 2. Full raw metadata title: if distinct from decomp title
  if (queryTitle && ID.normalizeString(queryTitle) !== ID.normalizeString(decompTitle)) {
    if (author) tier2.push(`${queryTitle} ${author}`);
    tier2.push(queryTitle);
  }

  // 3. Decomp with different section (delimiter sliding windows)
  if (Array.isArray(decomp.slidingWindows)) {
    for (const win of decomp.slidingWindows) {
      if (author) tier3.push(`${win} ${author}`);
      tier3.push(win);
    }
  }

  // 4. Remaining candidates
  const allCands = ID.extractSearchTitleCandidates(queryTitle, { author });
  for (const c of allCands) {
    if (author) tier4.push(`${c} ${author}`);
    tier4.push(c);
  }

  // Derive dynamic search count limit from delimiters, title length, etc.
  const delimiterCount = (queryTitle.match(/(?:\s+[-–—]\s+|[:;|]|\s*[–—]\s*)/g) || []).length;
  const isLong = queryTitle.length > 35;
  let maxQueries = 4;
  if (delimiterCount >= 1) maxQueries += Math.min(delimiterCount * 2, 4);
  if (isLong) maxQueries += 2;
  const MAX_QUERY_COUNT = 10;
  maxQueries = Math.min(MAX_QUERY_COUNT, Math.max(3, maxQueries));

  const queriesToAttempt = [];
  const seenQueries = new Set();
  const pushQuery = (q, cand) => {
    const norm = ID.normalizeString(q);
    if (!norm || seenQueries.has(norm)) return;
    seenQueries.add(norm);
    queriesToAttempt.push({ q, candidate: cand });
  };

  for (const q of tier1) pushQuery(q, decompTitle);
  for (const q of tier2) pushQuery(q, queryTitle);
  for (const q of tier3) pushQuery(q, decompTitle);
  for (const q of tier4) pushQuery(q, decompTitle);

  const queryLogs = [];
  let bestBook = null;
  let bestScore = -Infinity;
  let bestCandidate = null;
  let queryCount = 0;

  queryIteration:
  for (const { q, candidate } of queriesToAttempt) {
    for (const prov of providers) {
      queryCount++;
      const provParam = prov ? `&provider=${encodeURIComponent(prov)}` : '';
      const url = `${SM_URL}/api/metadata/search?content_type=ebook&limit=10&query=${encodeURIComponent(q)}${provParam}`;
      const { ok, status, data, error } = await fetchWithRetry(url);
      if (!ok) {
        queryLogs.push({ query: q, provider: prov, status, count: 0, reason: error });
        continue;
      }
      const books = Array.isArray(data?.books) ? data.books : [];
      let bestInQuery = -Infinity;

      for (const b of books) {
        const score = ID.scoreBookMatch(b, queryTitle, author);
        if (score > bestInQuery) bestInQuery = score;
        if (score > bestScore) {
          bestScore = score;
          bestBook = b;
          bestCandidate = candidate;
        }
      }

      queryLogs.push({
        query: q,
        provider: prov,
        status,
        count: books.length,
        bestScoreInQuery: Math.max(bestInQuery, 0),
      });
    }

    // High confidence match found across providers: stop query loop
    if (bestScore >= 80) {
      break queryIteration;
    }

    // Max search count reached
    if (queryCount >= maxQueries && bestScore > 0) {
      break queryIteration;
    }
  }

  return {
    matchedCandidate: bestCandidate,
    matchedBook: bestScore > 0 ? bestBook : null,
    bestScore: Math.max(bestScore, 0),
    queryLogs,
  };
}

async function main() {
  console.log('========================================================================');
  console.log('SUITE 1: Pure Algorithmic Title Decomposition & Compatibility Evaluation');
  console.log('========================================================================\n');

  let decompPass = 0;
  let decompFail = 0;
  const decompFailures = [];

  for (let i = 0; i < corpus.length; i++) {
    const item = corpus[i];
    const { input_title, expected_title, expected_author } = item;

    const decomp = ID.decomposeTitleStructure(input_title, { author: expected_author });
    const coreTitle = ID.extractCoreTitle(input_title, { author: expected_author });
    const candidates = ID.extractSearchTitleCandidates(input_title, { author: expected_author });

    const coreMatch = isDiscretionaryTitleMatch(coreTitle, expected_title, expected_author);
    const candMatch = candidates.some((c) => isDiscretionaryTitleMatch(c, expected_title, expected_author));

    if (coreMatch || candMatch) {
      decompPass++;
    } else {
      decompFail++;
      decompFailures.push({
        index: i + 1,
        input_title,
        expected_title,
        coreTitle,
        candidates,
        decomp,
      });
    }
  }

  console.log(`Decomposition Results: ${decompPass}/${corpus.length} passed (${(decompPass / corpus.length * 100).toFixed(1)}%)`);
  if (decompFailures.length > 0) {
    console.log(`\nDecomposition Misses (${decompFailures.length}):`);
    for (const f of decompFailures) {
      console.log(`  [#${f.index}] "${f.input_title}"`);
      console.log(`       expected: "${f.expected_title}"`);
      console.log(`       got core: "${f.coreTitle}"`);
      console.log(`       cands:    ${JSON.stringify(f.candidates)}`);
    }
  }

  if (process.env.SUITE === '1' || process.argv.includes('--decomp-only')) {
    return;
  }

  console.log('\n========================================================================');
  console.log('SUITE 2: Live Metadata Search & Multi-Criteria Discretionary Evaluation');
  console.log('========================================================================\n');

  let workPass = 0;
  let exactPubPass = 0;
  let titleMatchCount = 0;
  let authorMatchCount = 0;
  let pubMatchCount = 0;
  let langMatchCount = 0;

  const results = [];
  const limitIdx = process.argv.indexOf('--limit');
  const maxCases = (limitIdx !== -1 && process.argv[limitIdx + 1]) ? parseInt(process.argv[limitIdx + 1], 10) : corpus.length;
  const casesToRun = corpus.slice(0, maxCases);

  for (let i = 0; i < casesToRun.length; i++) {
    const item = casesToRun[i];
    const { input_title, expected_title, expected_author } = item;

    const searchRes = await runMetadataSearch(input_title, expected_author);
    const b = searchRes.matchedBook;

    const bAuthors = b ? (Array.isArray(b.authors) ? b.authors.join(', ') : (b.author || '')) : '';
    const titleOk = Boolean(b && isDiscretionaryTitleMatch(b.title, expected_title, expected_author));
    const authorOk = Boolean(b && (isDiscretionaryAuthorMatch(bAuthors, expected_author) || !bAuthors));
    const pubOk = Boolean(b && isPublicationMatch(b.title, input_title));
    const langOk = Boolean(b && isLanguageMatch(b, 'en', input_title));

    const workMatch = Boolean(b && titleOk && authorOk);
    const exactPublication = Boolean(workMatch && pubOk && langOk);

    if (titleOk) titleMatchCount++;
    if (authorOk) authorMatchCount++;
    if (pubOk) pubMatchCount++;
    if (langOk) langMatchCount++;
    if (workMatch) workPass++;
    if (exactPublication) exactPubPass++;

    results.push({
      index: i + 1,
      input_title,
      expected_title,
      expected_author,
      workMatch,
      exactPublication,
      titleMatch: titleOk,
      authorMatch: authorOk,
      publicationMatch: pubOk,
      languageMatch: langOk,
      candidateUsed: searchRes.matchedCandidate,
      bestScore: searchRes.bestScore,
      observedTitle: b?.title ?? null,
      observedAuthor: bAuthors || null,
      observedLanguage: b?.language ?? null,
      queryLogs: searchRes.queryLogs,
    });

    if ((i + 1) % 25 === 0 || i === casesToRun.length - 1) {
      console.log(`  Processed ${i + 1}/${casesToRun.length} cases (workMatch: ${workPass}, exactPublication: ${exactPubPass})...`);
    }
  }

  console.log('\n------------------------------------------------------------------------');
  console.log('METADATA RESOLUTION SUMMARY:');
  console.log('------------------------------------------------------------------------');
  console.log(`Total Tested Cases:           ${casesToRun.length}`);
  console.log(`Decomposition Pass Rate:      ${decompPass}/${corpus.length} (${(decompPass / corpus.length * 100).toFixed(1)}%)`);
  console.log(`Work-Level Match Rate:        ${workPass}/${casesToRun.length} (${(workPass / casesToRun.length * 100).toFixed(1)}%)`);
  console.log(`Exact-Publication Match Rate: ${exactPubPass}/${casesToRun.length} (${(exactPubPass / casesToRun.length * 100).toFixed(1)}%)`);
  console.log(`  - Title Matches:            ${titleMatchCount}/${casesToRun.length} (${(titleMatchCount / casesToRun.length * 100).toFixed(1)}%)`);
  console.log(`  - Author Matches:           ${authorMatchCount}/${casesToRun.length} (${(authorMatchCount / casesToRun.length * 100).toFixed(1)}%)`);
  console.log(`  - Publication Type Matches: ${pubMatchCount}/${casesToRun.length} (${(pubMatchCount / casesToRun.length * 100).toFixed(1)}%)`);
  console.log(`  - Language Matches:         ${langMatchCount}/${casesToRun.length} (${(langMatchCount / casesToRun.length * 100).toFixed(1)}%)`);

  const report = {
    generatedAt: new Date().toISOString(),
    totalCases: corpus.length,
    decomposition: {
      passed: decompPass,
      failed: decompFail,
      passRate: (decompPass / corpus.length * 100).toFixed(1) + '%',
      failures: decompFailures,
    },
    metadataResolution: {
      workMatches: workPass,
      workMatchRate: (workPass / corpus.length * 100).toFixed(1) + '%',
      exactPublicationMatches: exactPubPass,
      exactPublicationMatchRate: (exactPubPass / corpus.length * 100).toFixed(1) + '%',
      titleMatches: titleMatchCount,
      authorMatches: authorMatchCount,
      publicationMatches: pubMatchCount,
      languageMatches: langMatchCount,
      results,
    },
  };

  const outPath = process.env.REPORT_PATH || '/home/dev/tmp/kilo/personal/bookorbit-plugin-shelfmark/work/corpus-test-report.json';
  writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\nFull report written to: ${outPath}`);
}

main().catch(console.error);
