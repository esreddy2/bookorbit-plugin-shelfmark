/**
 * Shared identity model for BookOrbit–Shelfmark.
 *
 * Authoritative implementation of normalization, identity evidence, and matching
 * decisions. Used by both the native plugin (index.mjs, inlined at build time)
 * and the companion bridge (bridge/bridge.mjs) so there is exactly one policy.
 *
 * Dependency-free. ESM.
 */

export const KNOWN_TITLE_EQUIVALENTS = new Map([
  ['1984', ['nineteen eighty four', 'nineteen eighty-four']],
  ['nineteen eighty four', ['1984']],
  ['nineteen eighty-four', ['1984']],
  ['2001', ['two thousand and one']],
  ['two thousand and one', ['2001']],
]);

export function normalizeString(str) {
  if (str == null) return '';
  return String(str)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function getTokens(str) {
  return normalizeString(str).split(' ').filter((t) => t.length > 0);
}

export function toNaturalAuthor(author) {
  if (!author) return '';
  let s = String(author).trim();
  s = s.replace(/\s*\(?\b\d{4}\s*[-–—]\s*\d{0,4}\b\)?/g, ' ').trim();
  s = s.replace(/\s*\([^)]*\)/g, ' ').trim();
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

export function extractCoreTitle(title) {
  if (!title) return '';
  let s = String(title).trim();
  s = s.replace(/\s*\[[^\]]*\]\s*/g, ' ').replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  s = s.replace(/\s+download\b/gi, '').trim();
  const byMatch = s.split(/\s+by\s+/i);
  if (byMatch.length > 1 && byMatch[0].trim().length >= 2) {
    const suffix = byMatch[1].trim();
    const suffixTokens = suffix.split(/\s+/).filter(Boolean);
    const looksLikeAuthor = suffix.includes(',') || suffixTokens.length >= 2;
    if (looksLikeAuthor) s = byMatch[0].trim();
  }
  const parts = s.split(/(?:\s+[-–—]\s+|[:;/|]|\s*[–—]\s*)/);
  const core = parts[0]?.trim();
  return core && core.length >= 2 ? core : s;
}

export function isNoiseDerivative(candidateTitle, requestedTitle) {
  const normCand = normalizeString(candidateTitle);
  const normReq = normalizeString(requestedTitle);
  const noiseMarkers = [
    'summary of', 'study guide', 'cliffsnotes', 'sparknotes', 'analysis of',
    'workbook for', 'book summary', 'companion to', 'teacher guide', 'teachers guide',
    'lesson plans', 'activity guide', 'adapted by', 'retold by', 'simplified edition',
    'simplified retelling', 'retelling', 'abridged', 'graded reader', 'oxford bookworms',
    'penguin active reading', 'penguin readers', 'macmillan readers', 'graphic novel',
    'comic book', 'illustrated novel', 'complete works', 'box set', 'boxed set',
    'omnibus', 'anthology',
  ];
  for (const marker of noiseMarkers) {
    if (normCand.includes(marker) && !normReq.includes(marker)) return true;
  }
  if (/\b(?:stage|level)\s*[1-6]\b/i.test(candidateTitle) && !/\b(?:stage|level)\s*[1-6]\b/i.test(requestedTitle)) return true;
  const hasAnimalFarm = normCand.includes('animal farm');
  const has1984 = normCand.includes('1984') || normCand.includes('nineteen eighty four');
  if (hasAnimalFarm && has1984) {
    const reqHasBoth = normReq.includes('animal farm') && (normReq.includes('1984') || normReq.includes('nineteen eighty four'));
    if (!reqHasBoth) return true;
  }
  return false;
}

// ---------- ISBN handling ----------

export function normalizeIsbn(value) {
  if (value == null) return '';
  return String(value).replace(/[^0-9Xx]/g, '').trim().toUpperCase();
}

export function validateIsbn(value) {
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

export function isbn10To13(isbn10) {
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

export function isbn13To10(isbn13) {
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
export function sameIsbn(a, b) {
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

export function collectIsbnPairs(obj) {
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
      for (const c of counterpartIsbns) for (const o of ownIsbns) pairs.push([c, o]);
    } else if (counterpartIsbns.length >= 2) {
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

export function collectIsbns(obj, out = new Set()) {
  for (const [a, b] of collectIsbnPairs(obj)) {
    const na = normalizeIsbn(a); const nb = normalizeIsbn(b);
    if (na.length === 10 || na.length === 13) out.add(na);
    if (nb.length === 10 || nb.length === 13) out.add(nb);
  }
  return out;
}

export function areVerifiedCounterparts(isbnA, isbnB, ...contexts) {
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
      if (ctx.trustedIsbns) {
        // trustedIsbns may be array of pairs or isbns; only treat as pairs if nested
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

export function isNoiseDerivativeWrapper(candidateTitle, requestedTitle) {
  return isNoiseDerivative(candidateTitle, requestedTitle);
}

function safePrefix(candidate, requested) {
  const c = String(candidate).trim().toLowerCase();
  const r = String(requested).trim().toLowerCase();
  if (!c.startsWith(r) || c === r) return c === r;
  const rest = c.slice(r.length);
  return /^[\s]*[:;\-–—(\[]/.test(rest);
}

export function titleMatchDecision(candidateTitle, requestedTitle) {
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
  if (safePrefix(candidateTitle, requestedTitle) || safePrefix(requestedTitle, candidateTitle)) {
    evidence.push({ field: 'title', value: normCand, level: 'work', status: 'verified' });
    return { outcome: 'match', workConfidence: 'high', editionConfidence: 'medium', evidence, conflicts, reasonCodes };
  }
  if (normCand.includes(normReq) || normReq.includes(normCand)) {
    const cTokens = getTokens(candidateTitle);
    const rTokens = getTokens(requestedTitle);
    if (rTokens.length > 1 && rTokens.every((t) => cTokens.includes(t))) {
      evidence.push({ field: 'title', value: normCand, level: 'work', status: 'verified' });
      return { outcome: 'match', workConfidence: 'high', editionConfidence: 'medium', evidence, conflicts, reasonCodes };
    }
  }
  const equivalents = KNOWN_TITLE_EQUIVALENTS.get(normReq);
  if (equivalents) {
    for (const eq of equivalents) {
      const normEq = normalizeString(eq);
      if (normCand === normEq || normCand.startsWith(normEq) || normCand.includes(normEq)) {
        evidence.push({ field: 'title', value: normCand, level: 'work', status: 'verified' });
        return { outcome: 'match', workConfidence: 'high', editionConfidence: 'medium', evidence, conflicts, reasonCodes };
      }
    }
  }
  const candEquivalents = KNOWN_TITLE_EQUIVALENTS.get(normCand);
  if (candEquivalents) {
    for (const eq of candEquivalents) {
      const normEq = normalizeString(eq);
      if (normReq === normEq || normReq.startsWith(normEq) || normReq.includes(normEq)) {
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
  const candTokens = getTokens(candidateTitle);
  const reqTokens = getTokens(requestedTitle);
  if (reqTokens.length === 0) {
    return { outcome: 'unknown', workConfidence: 'low', editionConfidence: 'none', evidence, conflicts, reasonCodes };
  }
  if (reqTokens.length === 1) {
    reasonCodes.push('single_token_title_conservative');
    return { outcome: 'unknown', workConfidence: 'low', editionConfidence: 'none', evidence, conflicts, reasonCodes };
  }
  const matchingTokens = reqTokens.filter((t) => candTokens.includes(t));
  if (matchingTokens.length === reqTokens.length && reqTokens.length > 1) {
    evidence.push({ field: 'title', value: normCand, level: 'work', status: 'verified' });
    return { outcome: 'match', workConfidence: 'high', editionConfidence: 'medium', evidence, conflicts, reasonCodes };
  }
  conflicts.push('title_mismatch');
  return { outcome: 'reject', workConfidence: 'none', editionConfidence: 'none', evidence, conflicts, reasonCodes };
}

export function isTitleMatch(candidateTitle, requestedTitle) {
  if (!requestedTitle) return true;
  if (!candidateTitle) return false;
  const d = titleMatchDecision(candidateTitle, requestedTitle);
  return d.outcome === 'match' || d.outcome === 'provisional';
}

export function authorMatchDecision(candidateAuthors, requestedAuthor) {
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

export function isAuthorMatch(candidateAuthors, requestedAuthor) {
  if (!requestedAuthor) return true;
  const d = authorMatchDecision(candidateAuthors, requestedAuthor);
  return d.outcome === 'match';
}

// ---------- Edition compatibility ----------

export function editionCompatibility(a, b) {
  const evidence = [];
  const conflicts = [];
  const reasonCodes = [];
  if (!a || !b) {
    return { outcome: 'unknown', workConfidence: 'none', editionConfidence: 'none', evidence, conflicts, reasonCodes: ['missing_input'] };
  }
  // title
  const titleA = (a.bookTitle || a.title || '').trim();
  const titleB = (b.bookTitle || b.title || '').trim();
  let titleOk = true;
  if (titleA && titleB) {
    const td = titleMatchDecision(titleA, titleB);
    if (td.outcome !== 'match') { titleOk = false; conflicts.push('incompatible_title'); }
  }
  // author
  const authorA = (a.author || (Array.isArray(a.authors) ? a.authors[0] : '') || '').trim();
  const authorB = (b.author || (Array.isArray(b.authors) ? b.authors[0] : '') || '').trim();
  let authorOk = true;
  if (authorA && authorB) {
    const ad = authorMatchDecision(authorA, authorB);
    if (ad.outcome !== 'match') { authorOk = false; conflicts.push('incompatible_author'); }
  }
  // format
  const fmtA = (a.format || '').trim().toLowerCase();
  const fmtB = (b.format || '').trim().toLowerCase();
  let formatOk = true;
  if (fmtA && fmtB && fmtA !== fmtB) { formatOk = false; conflicts.push('incompatible_format'); }
  // language
  const langA = (a.language || '').trim().toLowerCase();
  const langB = (b.language || '').trim().toLowerCase();
  let langOk = true;
  if (langA && langB && langA !== langB) { langOk = false; conflicts.push('language_mismatch'); }

  // ISBN
  const isbnAraw = a.isbn13 || a.isbn || a.extra?.isbn;
  const isbnBraw = b.isbn13 || b.isbn || b.extra?.isbn;
  let isbnA = normalizeIsbn(isbnAraw);
  let isbnB = normalizeIsbn(isbnBraw);
  // epub metadata
  // (caller may provide epubMetadata)
  if (a.epubMetadata?.isbn) isbnA = isbnA || normalizeIsbn(a.epubMetadata.isbn);
  if (b.epubMetadata?.isbn) isbnB = isbnB || normalizeIsbn(b.epubMetadata.isbn);
  let isbnOk = true;
  let isbnVerified = false;
  if (isbnA && isbnB) {
    if (sameIsbn(isbnA, isbnB)) {
      isbnVerified = true;
    } else {
      const counterpart = areVerifiedCounterparts(isbnA, isbnB, a?.trustedIsbns, a?.bookMetadata, a?.extra?.bookMetadata, b?.trustedIsbns, b?.bookMetadata, b?.extra?.bookMetadata, a, b);
      if (!counterpart) { isbnOk = false; conflicts.push('conflicting_isbn'); }
      else { isbnVerified = true; } // counterpart counts as verified equivalence
    }
  }

  // year
  const yearA = parsePositiveIntLocal(a.year || a.publicationYear || a.publishedYear || a.epubMetadata?.year);
  const yearB = parsePositiveIntLocal(b.year || b.publicationYear || b.publishedYear || b.epubMetadata?.year);
  let yearOk = true;
  let yearVerified = false;
  if (yearA && yearB) {
    if (yearA !== yearB) { yearOk = false; conflicts.push('incompatible_year'); }
    else { yearVerified = true; }
  } else if ((yearA && !yearB) || (!yearA && yearB)) {
    if (!isbnVerified) {
      // Known requested year with unknown release year must not be treated as verified.
      yearOk = false;
      conflicts.push('unknown_release_year');
      reasonCodes.push('unknown_release_year');
    }
  }

  const allOk = titleOk && authorOk && formatOk && langOk && isbnOk && yearOk;
  // Determine edition confidence
  let editionConfidence = 'none';
  if (allOk) {
    if (isbnVerified || yearVerified) editionConfidence = 'high';
    else editionConfidence = 'medium';
  }
  const outcome = allOk ? (editionConfidence === 'high' ? 'match' : 'provisional') : 'reject';
  // work confidence based on title+author
  const workConfidence = (titleOk && authorOk) ? 'high' : 'none';

  evidence.push({ field: 'title', value: titleA, level: 'work', status: titleOk ? 'verified' : 'contradictory' });
  evidence.push({ field: 'author', value: authorA, level: 'work', status: authorOk ? 'verified' : 'contradictory' });
  if (fmtA || fmtB) evidence.push({ field: 'format', value: fmtA || fmtB, level: 'edition', status: formatOk ? 'verified' : 'contradictory' });
  if (isbnA || isbnB) evidence.push({ field: 'isbn', value: isbnA || isbnB, level: 'edition', status: (isbnA && isbnB && !isbnOk) ? 'contradictory' : (isbnVerified ? 'verified' : 'inferred') });
  if (yearA || yearB) evidence.push({ field: 'year', value: yearA || yearB, level: 'edition', status: (yearA && yearB && yearA !== yearB) ? 'contradictory' : (yearVerified ? 'verified' : 'inferred') });
  if (langA || langB) evidence.push({ field: 'language', value: langA || langB, level: 'expression', status: langOk ? 'verified' : 'contradictory' });

  return { outcome, workConfidence, editionConfidence, evidence, conflicts, reasonCodes };
}

function parsePositiveIntLocal(val) {
  if (typeof val === 'number') return Number.isInteger(val) && val > 0 ? val : null;
  if (typeof val === 'string' && /^\d+$/.test(val.trim())) {
    const p = parseInt(val.trim(), 10);
    return p > 0 ? p : null;
  }
  return null;
}

export function areEditionsCompatible(a, b) {
  const d = editionCompatibility(a, b);
  return d.outcome === 'match' || d.outcome === 'provisional';
}

// ---------- extractIsbn ----------

export function extractIsbn(book, query) {
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

export function matchDecision(request, candidate) {
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
export const collectMetadataIsbnPairs = collectIsbnPairs;
export function collectMetadataIsbns(obj, out = new Set()) {
  for (const [a, b] of collectIsbnPairs(obj)) {
    const na = normalizeIsbn(a); const nb = normalizeIsbn(b);
    if (na.length === 10 || na.length === 13) out.add(na);
    if (nb.length === 10 || nb.length === 13) out.add(nb);
  }
  return out;
}
