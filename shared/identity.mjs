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

export function numberToWords(n) {
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

export function parseNumberWords(str) {
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

export function getNumericTitleEquivalents(title) {
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
export const KNOWN_TITLE_EQUIVALENTS = {
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

export function normalizeString(str) {
  if (str == null) return '';
  return String(str)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[şŞ]/g, 'sh')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]/g, '')
    .replace(/(\d),(\d)/g, '$1$2')
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\b([a-z]{2,})our([a-z]*)\b/g, '$1or$2')
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

export function hasMultiVolumeIndicator(title) {
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

export const hasCompilationIndicator = hasMultiVolumeIndicator;

const EXPLICIT_VOLUME_KEYWORD_RE = new RegExp(
  `\\b(?:book|bk\\.?|vol\\.?|volume|part|tome|no\\.?|nr\\.?|number)\\s+#?0*(${VOLUME_NUM_PATTERN})\\b`,
  'i'
);
const ORDINAL_BEFORE_VOLUME_RE = /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d{1,2}(?:st|nd|rd|th))\s+(?:book|volume|part|tome)\b/i;
const COMPANION_VOLUME_RE = /\b(?:companion\s+books?|episode|installment)\s+#?0*(\d{1,2})\b/i;
const HASH_SINGLE_VOLUME_RE = /(?:^|[\s([,-])#\s*0*([1-9]\d?)\b/;

export function extractSeriesVolumeNumber(title, options = {}) {
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

export function stripEditionDescriptors(str) {
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
  if (/^(?:a|an|the)?\s*(?:(?:new|graphic|historical|short|selected|illustrated|classic|authorized|unauthorized|official|definitive|concise|practical|essential|brief|complete|true)\s+)?(?:novel|novella|memoir|biography|autobiography|thriller|romance|play|poems|poetry|essays|stories|story|guide|handbook|manual|account|chronicle|edition|version|classics?)$/i.test(norm)) {
    return true;
  }
  if (/^(?:a|an|the)\s+(?:brief|short|complete|new|secret|untold|true|intimate|definitive|concise|illustrated|real|official|unauthorized|authorized|practical|essential|ultimate|insiders?)\s+(?:history|biography|memoir|guide|handbook|account|portrait|chronicle|journey)\s+of\b/i.test(norm)) {
    return true;
  }
  if (/^(?:sequel|prequel|companion|continuation|follow-?up)\s+to\b/i.test(norm)) return true;
  return false;
}

const PURE_VOLUME_SEGMENT_RE = new RegExp(
  `^(?:(?:book|bk\\.?|vol\\.?|volume|part|tome|no\\.?|nr\\.?|number)\\s+#?0*(${VOLUME_NUM_PATTERN})|#?0*([1-9]|[12]\\d|30))$`,
  'i'
);
const SERIES_WITH_EXPLICIT_VOLUME_SEGMENT_RE = new RegExp(
  `^(.+?)(?:[,\\s]+(?:book|bk\\.?|vol\\.?|volume|part|tome|no\\.?|nr\\.?|number)\\s+#?0*(${VOLUME_NUM_PATTERN})|[,\\s]+#\\s*0*([1-9]\\d?)|\\s+companion\\s+books?\\s+#?0*(\\d{1,2}))$`,
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
    if (toks.length >= 2 && toks.length <= 4 && toks.filter((t) => t.length > 1).every((t) => !NON_PERSON_TITLE_WORDS.has(t))) return true;
  }
  const rawParts = s.split(/\s+/).filter(Boolean);
  if (rawParts.length < 2 || rawParts.length > 6) return false;
  // Require initials (e.g. "J K Rowling", "J.K. Rowling", "A. J. Finn")
  const hasInitial = rawParts.slice(0, -1).some((p) => /^(?:[\p{Lu}]\.?){1,2}$/u.test(p));
  if (hasInitial) {
    const toks = getTokens(s);
    return toks.length >= 2 && toks.filter((t) => t.length > 1).every((t) => !NON_PERSON_TITLE_WORDS.has(t));
  }
  // Standard capitalized 2-4 word person name (e.g. "Agatha Christie", "Arthur Conan Doyle", "Silvia Moreno-Garcia", "Ta-Nehisi Coates")
  if (rawParts.length >= 2 && rawParts.length <= 4 && rawParts.every((p) => /^[\p{Lu}][\p{Ll}'’]+(?:-[\p{Lu}][\p{Ll}'’]+)?\.?$/u.test(p))) {
    const toks = getTokens(s);
    return toks.length >= 2 && toks.filter((t) => t.length > 1).every((t) => !NON_PERSON_TITLE_WORDS.has(t));
  }
  return false;
}

function looksLikeAuthorPrefix(seg, optAuthor, s) {
  if (!seg) return false;
  if (optAuthor && isAuthorMatch(seg, optAuthor)) return true;
  if (!optAuthor && (/\s+[-–—]\s+/.test(s) || /:\s+/.test(s))) {
    if (looksLikePersonNamePrefix(seg)) return true;
    const subAuthors = seg.split(/\s*(?:,|and|&)\s+/).filter(Boolean);
    if (subAuthors.length >= 2 && subAuthors.every((p) => looksLikePersonNamePrefix(p))) return true;
  }
  return false;
}

export function decomposeTitleStructure(title, options = {}) {
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

  const optAuthor = options?.author || '';
  const byIdx = s.toLowerCase().lastIndexOf(' by ');
  if (byIdx > 0) {
    const prefix = s.slice(0, byIdx).trim();
    const suffix = s.slice(byIdx + 4).trim();
    if (prefix.length >= 2 && !/[:;\-–—|]$/.test(prefix) && !/(?:\s+[-–—]\s+|[:;|–—])/.test(suffix)) {
      const suffixTokens = getTokens(suffix);
      const startsWithArticle = /^(?:the|an)\s+|^a\s+(?![A-Z]\b)/i.test(suffix);
      const subAuthors = suffix.split(/\s*(?:,|and|&)\s+/).filter(Boolean);
      const isKnownAuthor = Boolean(optAuthor && (isAuthorMatch(suffix, optAuthor) || subAuthors.some((a) => isAuthorMatch(a, optAuthor))));
      const isPersonName = looksLikePersonNamePrefix(suffix) || (subAuthors.length >= 2 && subAuthors.every((a) => looksLikePersonNamePrefix(a)));
      const isTokenAuthor = !optAuthor && suffixTokens.length >= 2 && suffixTokens.length <= 4 && suffixTokens.filter((t) => t.length > 1).every((t) => !NON_PERSON_TITLE_WORDS.has(t));
      const looksAuthor = !startsWithArticle && (isKnownAuthor || isPersonName || isTokenAuthor);
      if (looksAuthor) s = prefix;
    }
  }

  // Note: '/' is intentionally NOT a core-truncation delimiter so "Title A / Title B" omnibuses never collapse to "Title A".
  const rawSegments = s.split(/(?:\s+[-–—]\s+|[:;|]|\s*[–—]\s*|(?:\s*,\s*)?\s+or\s+(?=[A-Z\p{Lu}]))/iu).map((p) => p.trim()).filter(Boolean);
  const unpunctSegments = [];
  for (const seg of rawSegments) {
    const m = seg.match(UNPUNCTUATED_SERIES_VOLUME_RE);
    const isBareNum = Boolean(m && m[4]);
    const m1Norm = m ? normalizeString(m[1]) : '';
    const badBarePrefix = isBareNum && (/^(?:the|a|an|of|in|on|at|to|for|with|from|by|into|about)$/i.test(m1Norm) || NON_PERSON_TITLE_WORDS.has(m1Norm));
    if (m && m[1].length >= 2 && m[5].length >= 2 && !badBarePrefix && !/\b(?:edition|anniversary|version|no|nr)\.?$/i.test(m[1].trim())) {
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

  if (cleanedSegments.length > 1) {
    const lastSeg = cleanedSegments[cleanedSegments.length - 1];
    if ((optAuthor && isAuthorMatch(lastSeg, optAuthor)) || (!optAuthor && /\s+[-–—]\s+/.test(s) && looksLikePersonNamePrefix(lastSeg))) {
      cleanedSegments.pop();
    }
  } else if (cleanedSegments.length === 1 && optAuthor && cleanedSegments[0].includes(',')) {
    const commaParts = cleanedSegments[0].split(/\s*,\s*/);
    if (commaParts.length >= 2) {
      const lastPart = commaParts[commaParts.length - 1];
      if (isAuthorMatch(lastPart, optAuthor)) {
        commaParts.pop();
        cleanedSegments[0] = commaParts.join(', ').trim();
      }
    }
  }

  const rawCore = cleanedSegments[0];
  let idx = 0;
  let hasExplicitPrefix = false;
  let seriesPrefix = null;
  const normOptSeries = normalizeString(options?.seriesName || '');

  const isVolumeOrSeriesSeg = (seg) => {
    if (!seg) return false;
    return /#\s*\d+/i.test(seg) ||
      PURE_VOLUME_SEGMENT_RE.test(seg) ||
      SERIES_WITH_EXPLICIT_VOLUME_SEGMENT_RE.test(seg) ||
      SERIES_WITH_BARE_NUMBER_SEGMENT_RE.test(seg) ||
      /\b(?:series|book|bk\.?|vol\.?|volume|part|tome|no\.?|nr\.?|number)\s+\d+/i.test(seg);
  };

  // Peel up to 3 leading series/volume/franchise/author prefix segments when followed by a real work title segment
  let hops = 0;
  while (idx < cleanedSegments.length - 1 && hops < 3) {
    hops++;
    const seg = cleanedSegments[idx];
    const nextSeg = cleanedSegments[idx + 1];
    if (!nextSeg || (nextSeg.match(/[\p{L}\p{N}]/gu) || []).length < 2) break;

    // 0. Author prefix before dash/colon ("J. K. Rowling - Harry Potter...", "Dan Simmons: ...", or matching known author)
    if (looksLikeAuthorPrefix(seg, optAuthor, s)) {
      hasExplicitPrefix = true;
      idx++;
      continue;
    }

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

    // 4. Series prefix ending in bare 1..30 volume number (e.g. "Percy Jackson 5 - The Last Olympian" or "Incorrigible Children 4: The Interrupted Tale")
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

    // 5. Overarching franchise/series prefix followed by sub-series, attribution, or series-with-volume segment
    if (idx + 2 < cleanedSegments.length) {
      const afterMid = cleanedSegments[idx + 2];
      const nextIsAttribution = ATTRIBUTION_PREFIX_SEGMENT_RE.test(nextSeg);
      const nextIsVolOrSeries = isVolumeOrSeriesSeg(nextSeg);
      const afterMidIsWork = !isGenericOrDescriptiveSubtitle(afterMid) && !isVolumeOrSeriesSeg(afterMid);

      if (afterMidIsWork && (nextIsAttribution || nextIsVolOrSeries)) {
        if (!seriesPrefix) seriesPrefix = seg;
        hasExplicitPrefix = true;
        idx++;
        continue;
      }
      if (afterMidIsWork && !isGenericOrDescriptiveSubtitle(nextSeg) && !isVolumeOrSeriesSeg(nextSeg)) {
        if (!seriesPrefix) seriesPrefix = seg;
        hasExplicitPrefix = true;
        idx++;
        continue;
      }
    }

    // Remaining prefix rules require nextSeg not to be a generic/descriptive subtitle (preserves "From Russia with Love: A Novel")
    if (isGenericOrDescriptiveSubtitle(nextSeg)) break;

    // 6. Universe/attribution prefix ("From Percy Jackson: Camp Half-Blood Confidential")
    if (ATTRIBUTION_PREFIX_SEGMENT_RE.test(seg)) {
      if (!seriesPrefix) seriesPrefix = seg.replace(/^from\s+(?:the\s+(?:files|world|pages|journals?|chronicles|universe|desk|archives)\s+of\s+)?/i, '').trim();
      hasExplicitPrefix = true;
      idx++;
      continue;
    }

    // 7. Explicit seriesName match from structured request/metadata
    const normSeg = normalizeString(seg);
    if (normOptSeries && (normSeg === normOptSeries || stripLeadingArticle(normSeg) === stripLeadingArticle(normOptSeries))) {
      if (!seriesPrefix) seriesPrefix = seg;
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

  if (tailSeg && !isGenericOrDescriptiveSubtitle(tailSeg)) {
    const tailTokens = getTokens(tailSeg).filter((t) => !['the', 'a', 'an'].includes(t));
    if (tailTokens.length >= 1) {
      substantiveTail = tailSeg;
      if (getTokens(workSeg).length >= 1 && getTokens(tailSeg).length >= 1 && !isVolumeOrSeriesSeg(tailSeg)) {
        colonRhsWorkCandidate = tailSeg;
      }
    }
  }

  let canonicalTitle = (workSeg && workSeg.length >= 2) ? workSeg : (rawCore && rawCore.length >= 2 ? rawCore : s);
  if (idx === 0 && substantiveTail && volumeNumber !== null) {
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

export function extractCoreTitle(title, options = {}) {
  if (!title) return '';
  return decomposeTitleStructure(title, options).canonicalTitle;
}

export function extractSearchTitleCandidates(title, options = {}) {
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
      if (decomp.canonicalTitle && decomp.canonicalTitle !== parenContent) {
        pushCandidate(`${parenContent} ${decomp.canonicalTitle}`);
      }
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

export function isNoiseDerivative(candidateTitle, requestedTitle) {
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

function sameCanonicalWorkPhrase(a, b) {
  const na = normalizeString(a);
  const nb = normalizeString(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const naNoArt = stripLeadingArticle(na);
  const nbNoArt = stripLeadingArticle(nb);
  if (naNoArt && nbNoArt && naNoArt === nbNoArt) return true;
  if (na.replace(/\s+/g, '') === nb.replace(/\s+/g, '')) return true;
  if (naNoArt && nbNoArt && naNoArt.replace(/\s+/g, '') === nbNoArt.replace(/\s+/g, '')) return true;
  const sigA = getTokens(na).filter((t) => !['and', 'the', 'a', 'an', 'of', 'or', '&'].includes(t)).join(' ');
  const sigB = getTokens(nb).filter((t) => !['and', 'the', 'a', 'an', 'of', 'or', '&'].includes(t)).join(' ');
  if (sigA && sigB && getTokens(sigA).length >= 2) {
    if (sigA === sigB) return true;
    if (sigA.replace(/\b([a-z]{3,})s\b/g, '$1') === sigB.replace(/\b([a-z]{3,})s\b/g, '$1')) return true;
  }
  const eqA = KNOWN_TITLE_EQUIVALENTS.get(na);
  if (eqA && eqA.some((eq) => normalizeString(eq) === nb || stripLeadingArticle(normalizeString(eq)) === nbNoArt)) return true;
  const eqB = KNOWN_TITLE_EQUIVALENTS.get(nb);
  if (eqB && eqB.some((eq) => normalizeString(eq) === na || stripLeadingArticle(normalizeString(eq)) === naNoArt)) return true;
  return false;
}

export function titleMatchDecision(candidateTitle, requestedTitle, options = {}) {
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
  const artCandTokens = candTokens.filter((t) => !['the', 'a', 'an', 'of'].includes(t));
  const artReqTokens = reqTokens.filter((t) => !['the', 'a', 'an', 'of'].includes(t));
  if (artReqTokens.length > 0 && artCandTokens.length === artReqTokens.length) {
    if (artReqTokens.every((t) => artCandTokens.includes(t))) {
      evidence.push({ field: 'title', value: coreCand || normCand, level: 'work', status: 'verified' });
      return { outcome: 'match', workConfidence: 'high', editionConfidence: 'medium', evidence, conflicts, reasonCodes };
    }
  }
  if (!candDecomp.hasExplicitPrefix && !reqDecomp.hasExplicitPrefix && candDecomp.volumeNumber === null && reqDecomp.volumeNumber === null) {
    const minTokens = artCandTokens.length <= artReqTokens.length ? artCandTokens : artReqTokens;
    const maxTokens = artCandTokens.length <= artReqTokens.length ? artReqTokens : artCandTokens;
    if (minTokens.length >= 2 && maxTokens.length === minTokens.length + 1) {
      const hasConnectors = /\b(?:and|with|\&|historias|stories|collection)\b/i.test(candidateTitle);
      if (!hasConnectors && minTokens.every((t) => maxTokens.includes(t))) {
        evidence.push({ field: 'title', value: normCand, level: 'work', status: 'verified' });
        return { outcome: 'match', workConfidence: 'high', editionConfidence: 'medium', evidence, conflicts, reasonCodes };
      }
    }
  }
  conflicts.push('title_mismatch');
  return { outcome: 'reject', workConfidence: 'none', editionConfidence: 'none', evidence, conflicts, reasonCodes };
}

export function isTitleMatch(candidateTitle, requestedTitle, options = {}) {
  if (!requestedTitle) return true;
  if (!candidateTitle) return false;
  const d = titleMatchDecision(candidateTitle, requestedTitle, options);
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

export function isAuthorMatch(candidateAuthors, requestedAuthor) {
  if (!requestedAuthor) return true;
  const d = authorMatchDecision(candidateAuthors, requestedAuthor);
  return d.outcome === 'match';
}

// ---------- Work + language compatibility (ISBN positive-only, year ignored) ----------

export function editionCompatibility(a, b, options = {}) {
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

export function candidateCompatibility(request, candidate) {
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
export const collectMetadataIsbnPairs = collectIsbnPairs;
export function collectMetadataIsbns(obj, out = new Set()) {
  for (const [a, b] of collectIsbnPairs(obj)) {
    const na = normalizeIsbn(a); const nb = normalizeIsbn(b);
    if (na.length === 10 || na.length === 13) out.add(na);
    if (nb.length === 10 || nb.length === 13) out.add(nb);
  }
  return out;
}

export function scoreBookMatch(book, searchTitle, searchAuthor) {
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
