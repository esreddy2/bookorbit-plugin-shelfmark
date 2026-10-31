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
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeLanguageCode(lang) {
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

export function stripLeadingArticle(str) {
  if (!str) return '';
  return String(str).replace(/^(?:the|a|an)\s+/i, '').trim();
}
export function getTokens(str) {
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

export function toNaturalAuthor(author) {
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

export function extractCoreTitle(title) {
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
  const c = normalizeString(candidate);
  const r = normalizeString(requested);
  if (!c || !r) return c === r;
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

export function editionCompatibility(a, b, options = {}) {
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

export function candidateCompatibility(request, candidate) {
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

export function areEditionsCompatible(a, b) {
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
