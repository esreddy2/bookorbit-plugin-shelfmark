// v158-recovery-hotfix-v3 (companion-only; BookOrbit v3.5.0 API contract)
/**
 * BookOrbit ↔ Shelfmark Asynchronous Companion Bridge
 *
 * Fully event-driven integration between BookOrbit v3.5.0 and Shelfmark v1.5.1
 * without modifying BookOrbit core:
 *
 * 1. First-Run Backlog Safety:
 *    - On first startup, enumerates all existing requests across paginated admin API.
 *    - Persists durable baseline timestamp and request IDs before starting processing.
 *    - Only processes requests created after this baseline; never floods historical backlog.
 *
 * 2. Real BookOrbit Session Authentication:
 *    - Authenticates via BookOrbit session APIs (POST /api/v1/auth/login, /api/v1/auth/refresh).
 *    - Proactively renews session JWT prior to expiration and handles reconnects.
 *    - Prevents using static API keys as Socket.IO session JWTs.
 *
 * 3. BookOrbit Socket.IO Trigger:
 *    - Authenticates to `/book-requests` gateway with verified session JWT.
 *    - Listens for `book-requests:changed` broadcast events.
 *    - Debounces bursts (500ms) and serializes execution pass with an async mutex lock.
 *
 * 4. Candidate Search & Ranking Reuse:
 *    - Directly reuses corrected plugin search and ranking from index.mjs.
 *    - Queues top candidate release once, persisting durable mappings.
 *
 * 5. No Fabricated Task IDs & Uncertain Queue State:
 *    - If Shelfmark returns 200 without task ID, immediately queries /api/status.
 *    - If unconfirmed, tracks in durable `uncertain_queue` state using strong release identity.
 *    - Never blindly POSTs duplicate jobs after uncertain results; resolves via reconciliation.
 *
 * 6. Correct Shelfmark v1.5.1 Status Parsing:
 *    - Handles keyed status groups: `complete`, `downloading`, `queued`, `error`.
 *    - Frees release locks on failed/error tasks and adopts active/completed tasks.
 *
 * 7. Secure HTTP Server & Hook Safety:
 *    - Enforces timing-safe comparison (crypto.timingSafeEqual) on all secret validation.
 *    - Authenticates /webhook/shelfmark, /api/queue, and /api/reconcile.
 *    - Caps request body size at 1MB (413 Payload Too Large) and binds to local/private network.
 *    - Zero-exit protection in shelfmark-hook.sh preserves completed downloads in Shelfmark.
 *
 * 8. Real BookOrbit v3.5.0 Book Dock & Fulfillment:
 *    - Ingests file via BookDockController (`POST /api/v1/book-dock/upload`).
 *    - Awaits genuine finalizable state (`ready`) or adopts already-`filed` files.
 *    - Finalizes into library requiring both library and destination folder.
 *    - Strictly checks `results[].success === true` and valid positive `bookId`.
 *    - Fulfills via BookRequestAdminController (`POST /api/v1/admin/book-requests/:id/fulfill`).
 *    - Survives mid-flight crashes without duplicate uploads or duplicate fulfillment.
 *
 * Zero external dependencies — pure Node.js ECMAScript module.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import plugin from '../index.mjs';
import * as ID from '../shared/identity.mjs';

/** Magic byte signatures for supported book formats. */
export const MAGIC_BYTES = {
  epub: [0x50, 0x4b, 0x03, 0x04], // PK.. (ZIP archive)
  pdf: [0x25, 0x50, 0x44, 0x46],   // %PDF
};

function decodeXmlEntities(str) {
  if (!str) return '';
  return String(str)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _;
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _;
    })
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .trim();
}

function parseOpfMetadataXml(opfText) {
  if (!opfText || typeof opfText !== 'string') return null;
  const titleMatches = [...opfText.matchAll(/<dc:title([^>]*)>([\s\S]*?)<\/dc:title>/gi)];
  const titleEntries = titleMatches.map((m) => {
    const attrs = m[1] || '';
    const idMatch = attrs.match(/\bid\s*=\s*["']([^"']+)["']/i);
    const id = idMatch ? idMatch[1] : null;
    const text = decodeXmlEntities(m[2].replace(/<[^>]+>/g, '')).trim();
    return { id, text };
  }).filter((e) => Boolean(e.text));

  const titleTypes = new Map();
  for (const m of opfText.matchAll(/<meta[^>]*refines=["']#?([^"']+)["'][^>]*property=["']title-type["'][^>]*>([\s\S]*?)<\/meta>/gi)) {
    titleTypes.set(m[1].trim(), m[2].replace(/<[^>]+>/g, '').trim().toLowerCase());
  }
  for (const m of opfText.matchAll(/<meta[^>]*property=["']title-type["'][^>]*refines=["']#?([^"']+)["'][^>]*>([\s\S]*?)<\/meta>/gi)) {
    titleTypes.set(m[1].trim(), m[2].replace(/<[^>]+>/g, '').trim().toLowerCase());
  }

  let mainTitle = null;
  let subtitle = null;
  const titles = [];
  const subtitles = [];

  for (const entry of titleEntries) {
    if (!titles.includes(entry.text)) titles.push(entry.text);
    const tType = entry.id ? titleTypes.get(entry.id) : null;
    if (tType === 'main' && !mainTitle) {
      mainTitle = entry.text;
    } else if (tType === 'subtitle') {
      subtitles.push(entry.text);
      if (!subtitle) subtitle = entry.text;
    }
  }
  if (!mainTitle && titles.length > 0) mainTitle = titles[0];
  if (!subtitle && titles.length > 1) subtitle = titles[1];

  let compositeTitle = null;
  if (mainTitle && subtitle && ID.normalizeString(mainTitle) !== ID.normalizeString(subtitle)) {
    compositeTitle = `${mainTitle}: ${subtitle}`;
  } else if (titles.length > 1) {
    compositeTitle = titles.join(': ');
  }

  // Extract Calibre or EPUB3 collection series
  let series = null;
  const calSeries = opfText.match(/<meta[^>]*name=["']calibre:series["'][^>]*content=["']([^"']+)["']/i);
  if (calSeries) series = decodeXmlEntities(calSeries[1]).trim();
  if (!series) {
    const collMatch = opfText.match(/<meta[^>]*property=["']belongs-to-collection["'][^>]*>([\s\S]*?)<\/meta>/i);
    if (collMatch) series = decodeXmlEntities(collMatch[1].replace(/<[^>]+>/g, '')).trim();
  }
  let seriesIndex = null;
  const calIdx = opfText.match(/<meta[^>]*name=["']calibre:series_index["'][^>]*content=["']([^"']+)["']/i);
  if (calIdx) seriesIndex = parseFloat(calIdx[1]);
  if (seriesIndex === null) {
    const grpMatch = opfText.match(/<meta[^>]*property=["']group-position["'][^>]*>([\s\S]*?)<\/meta>/i);
    if (grpMatch) seriesIndex = parseFloat(grpMatch[1].replace(/<[^>]+>/g, '').trim());
  }

  const creatorMatches = [...opfText.matchAll(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/gi)];
  const authors = creatorMatches
    .map((m) => decodeXmlEntities(m[1].replace(/<[^>]+>/g, '')))
    .filter(Boolean);

  // Extract authentic publication years, ignoring file modification/conversion timestamps.
  // Never use dcterms:modified (required EPUB3 packaging timestamp) as publication year.
  const pubYears = [];
  const otherYears = [];
  for (const dm of opfText.matchAll(/<dc:date([^>]*)>([\s\S]*?)<\/dc:date>/gi)) {
    const attrs = dm[1] || '';
    const content = dm[2] || '';
    if (/\bevent\s*=\s*["'](?:modification|modified|conversion|creation|ops-publication)["']/i.test(attrs)) {
      if (/\bevent\s*=\s*["'](?:modification|modified|conversion)["']/i.test(attrs)) continue;
    }
    const ym = content.match(/\b(\d{4})\b/) || content.match(/(\d{4})/);
    if (!ym) continue;
    const y = parseInt(ym[1], 10);
    if (!Number.isFinite(y) || y < 1000 || y > 2100) continue;
    if (/\bevent\s*=\s*["']publication["']/i.test(attrs)) {
      if (!pubYears.includes(y)) pubYears.push(y);
    } else {
      if (!otherYears.includes(y)) otherYears.push(y);
    }
  }
  for (const im of opfText.matchAll(/<meta[^>]*property=["']dcterms:issued["'][^>]*>([\s\S]*?)<\/meta>/gi)) {
    const ym = (im[1] || '').match(/(\d{4})/);
    if (ym) {
      const y = parseInt(ym[1], 10);
      if (Number.isFinite(y) && y >= 1000 && y <= 2100 && !otherYears.includes(y) && !pubYears.includes(y)) {
        otherYears.push(y);
      }
    }
  }
  const years = [...pubYears, ...otherYears.filter((y) => !pubYears.includes(y))];

  // Extract authentic 10/13-char ISBNs without matching UUIDs, ASINs, URLs, or timestamps.
  const validIsbns = [];
  const explicitIsbns = [];
  const addCandidateIsbn = (rawToken, isExplicitScheme) => {
    const cleaned = ID.normalizeIsbn(rawToken);
    if (cleaned.length !== 10 && cleaned.length !== 13) return;
    if (ID.validateIsbn(cleaned).valid) {
      if (!validIsbns.includes(cleaned)) validIsbns.push(cleaned);
    } else if (isExplicitScheme) {
      if (!explicitIsbns.includes(cleaned)) explicitIsbns.push(cleaned);
    }
  };

  for (const urnMatch of opfText.matchAll(/urn:isbn:([0-9Xx-\s]{10,20})/gi)) {
    addCandidateIsbn(urnMatch[1], true);
  }
  for (const tagMatch of opfText.matchAll(/<dc:(?:identifier|source)([^>]*)>([\s\S]*?)<\/dc:(?:identifier|source)>/gi)) {
    const attrs = tagMatch[1] || '';
    const rawVal = decodeXmlEntities((tagMatch[2] || '').replace(/<[^>]+>/g, '')).trim();
    if (!rawVal) continue;
    if (/\bscheme\s*=\s*["'](?:uuid|uri|url|http|asin|mobi-asin|calibre|goodreads|google|amazon|doi|oclc|lccn)["']/i.test(attrs)) {
      continue;
    }
    if (/^(?:urn:uuid:|uuid:|https?:\/\/|calibre:|asin:|mobi-asin:|goodreads:|google:|doi:)/i.test(rawVal)) {
      continue;
    }
    const isExplicitIsbn = /\bscheme\s*=\s*["']isbn["']/i.test(attrs) || /^urn:isbn:/i.test(rawVal) || /^isbn\b/i.test(rawVal);
    const strippedPrefix = rawVal.replace(/^(?:urn:isbn:|isbn\s*:?\s*)/i, '').trim();
    const tokenMatches = strippedPrefix.match(/(?:97[89][-\s]?)?[0-9][0-9-\s]{8,15}[0-9Xx]/g) || [];
    for (const tok of tokenMatches) {
      // Reject hex UUID fragments by ensuring surrounding characters in strippedPrefix aren't hex letters
      const idx = strippedPrefix.indexOf(tok);
      const before = idx > 0 ? strippedPrefix[idx - 1] : '';
      const after = idx + tok.length < strippedPrefix.length ? strippedPrefix[idx + tok.length] : '';
      if (/[0-9A-Za-z]/.test(before) || /[0-9A-Za-z]/.test(after)) continue;
      addCandidateIsbn(tok, isExplicitIsbn);
    }
  }
  const isbns = [...validIsbns, ...explicitIsbns.filter((x) => !validIsbns.includes(x))];

  const languageMatch = opfText.match(/<dc:language[^>]*>([\s\S]*?)<\/dc:language>/i);
  const rawTitle = mainTitle || (titles[0] || null);
  const rawLanguage = languageMatch ? decodeXmlEntities(languageMatch[1].replace(/<[^>]+>/g, '')) : '';

  return {
    title: rawTitle || compositeTitle || null,
    subtitle: subtitles[0] || null,
    rawTitle,
    titles,
    subtitles,
    compositeTitle,
    series: series || null,
    seriesIndex: Number.isFinite(seriesIndex) ? seriesIndex : null,
    author: authors[0] || null,
    authors,
    year: years[0] || null,
    years,
    isbn: isbns[0] || null,
    isbns,
    language: rawLanguage || null,
  };
}

/**
 * Extracts publication metadata (title, author, year, ISBN, language) directly from an EPUB ZIP buffer.
 * Supports Central Directory ZIP lookup (handling streaming data descriptors / flag bit 3)
 * as well as fallback local-header scanning for synthetic test archives.
 * Returns null if the buffer is invalid or contains no readable OPF package.
 */
export function extractEpubMetadata(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 30) return null;
  try {
    // 1. Prefer ZIP Central Directory so archives with bit-3 data descriptors (compressedSize=0 in local header) succeed.
    const maxCommentSearch = Math.max(0, buffer.length - 65558);
    let eocdOffset = -1;
    for (let i = buffer.length - 22; i >= maxCommentSearch; i--) {
      if (buffer.readUInt32LE(i) === 0x06054b50) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset !== -1) {
      const cdEntries = buffer.readUInt16LE(eocdOffset + 10);
      const cdOffset = buffer.readUInt32LE(eocdOffset + 16);
      let pos = cdOffset;
      for (let i = 0; i < cdEntries && pos + 46 <= buffer.length; i++) {
        if (buffer.readUInt32LE(pos) !== 0x02014b50) break;
        const method = buffer.readUInt16LE(pos + 10);
        const compressedSize = buffer.readUInt32LE(pos + 20);
        const nameLen = buffer.readUInt16LE(pos + 28);
        const extraLen = buffer.readUInt16LE(pos + 30);
        const commentLen = buffer.readUInt16LE(pos + 32);
        const localOffset = buffer.readUInt32LE(pos + 42);
        const name = buffer.toString('utf8', pos + 46, pos + 46 + nameLen);
        pos += 46 + nameLen + extraLen + commentLen;

        if (name.toLowerCase().endsWith('.opf') && localOffset + 30 <= buffer.length) {
          if (buffer.readUInt32LE(localOffset) !== 0x04034b50) continue;
          const localNameLen = buffer.readUInt16LE(localOffset + 26);
          const localExtraLen = buffer.readUInt16LE(localOffset + 28);
          const dataStart = localOffset + 30 + localNameLen + localExtraLen;
          const dataEnd = dataStart + compressedSize;
          if (dataEnd > buffer.length) continue;
          let opfText = '';
          if (method === 0) {
            opfText = buffer.toString('utf8', dataStart, dataEnd);
          } else if (method === 8) {
            opfText = zlib.inflateRawSync(buffer.subarray(dataStart, dataEnd)).toString('utf8');
          }
          const parsed = parseOpfMetadataXml(opfText);
          if (parsed) return parsed;
        }
      }
    }

    // 2. Fallback: scan local file headers (supports header-only synthetic test buffers).
    let offset = 0;
    while (offset <= buffer.length - 30) {
      const sig = buffer.readUInt32LE(offset);
      if (sig !== 0x04034b50) break;

      const method = buffer.readUInt16LE(offset + 8);
      const compressedSize = buffer.readUInt32LE(offset + 18);
      const nameLen = buffer.readUInt16LE(offset + 26);
      const extraLen = buffer.readUInt16LE(offset + 28);
      const name = buffer.toString('utf8', offset + 30, offset + 30 + nameLen);
      const dataStart = offset + 30 + nameLen + extraLen;
      const dataEnd = dataStart + compressedSize;

      if (dataEnd > buffer.length) break;

      if (name.toLowerCase().endsWith('.opf')) {
        let opfText = '';
        if (method === 0) {
          opfText = buffer.toString('utf8', dataStart, dataEnd);
        } else if (method === 8) {
          opfText = zlib.inflateRawSync(buffer.subarray(dataStart, dataEnd)).toString('utf8');
        }
        const parsed = parseOpfMetadataXml(opfText);
        if (parsed) return parsed;
      }

      if (compressedSize === 0 && dataEnd === offset) break;
      offset = dataEnd;
    }
  } catch {}
  return null;
}

/**
 * Extracts EPUB metadata from a filesystem path if available.
 */
export function extractEpubMetadataFromFile(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const buf = fs.readFileSync(filePath);
    return extractEpubMetadata(buf);
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EPUB Spine Reading-Text Extraction & Unicode-Aware Language Identification
// ─────────────────────────────────────────────────────────────────────────────

const HTML_NAMED_ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
   sbquo: '‚', bdquo: '„', laquo: '«', raquo: '»', hellip: '…', shy: '',
  iexcl: '¡', iquest: '¿',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', yacute: 'ý',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Yacute: 'Ý',
  agrave: 'à', egrave: 'è', igrave: 'ì', ograve: 'ò', ugrave: 'ù',
  Agrave: 'À', Egrave: 'È', Igrave: 'Ì', Ograve: 'Ò', Ugrave: 'Ù',
  acirc: 'â', ecirc: 'ê', icirc: 'î', ocirc: 'ô', ucirc: 'û',
  Acirc: 'Â', Ecirc: 'Ê', Icirc: 'Î', Ocirc: 'Ô', Ucirc: 'Û',
  atilde: 'ã', ntilde: 'ñ', otilde: 'õ',
  Atilde: 'Ã', Ntilde: 'Ñ', Otilde: 'Õ',
  auml: 'ä', euml: 'ë', iuml: 'ï', ouml: 'ö', uuml: 'ü', yuml: 'ÿ',
  Auml: 'Ä', Euml: 'Ë', Iuml: 'Ï', Ouml: 'Ö', Uuml: 'Ü', Yuml: 'Ÿ',
  aring: 'å', Aring: 'Å', aelig: 'æ', AElig: 'Æ', oslash: 'ø', Oslash: 'Ø',
  oelig: 'œ', OElig: 'Œ', ccedil: 'ç', Ccedil: 'Ç', szlig: 'ß', eth: 'ð', thorn: 'þ',
};

function decodeHtmlEntities(str) {
  if (!str) return '';
  return String(str).replace(/&(?:#x([0-9a-fA-F]{1,6})|#(\d{1,7})|([a-zA-Z]{2,10}));/g, (full, hex, dec, named) => {
    if (hex) {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : full;
    }
    if (dec) {
      const code = parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : full;
    }
    if (named && Object.prototype.hasOwnProperty.call(HTML_NAMED_ENTITIES, named)) {
      return HTML_NAMED_ENTITIES[named];
    }
    return full;
  });
}

function decodeTextBuffer(buf) {
  if (!buf || buf.length === 0) return '';
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString('utf16le');
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.allocUnsafe(buf.length - 2);
    for (let i = 2; i + 1 < buf.length; i += 2) {
      swapped[i - 2] = buf[i + 1];
      swapped[i - 1] = buf[i];
    }
    return swapped.toString('utf16le');
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf8');
  }
  return buf.toString('utf8');
}

function normalizeZipPath(p) {
  const raw = String(p || '').replace(/\\/g, '/').split('#')[0].split('?')[0];
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch {}
  const parts = [];
  for (const seg of decoded.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.join('/');
}

function resolveRelativeZipPath(baseDir, href) {
  const cleanHref = String(href || '').replace(/\\/g, '/').split('#')[0].split('?')[0];
  if (!cleanHref) return '';
  if (cleanHref.startsWith('/')) return normalizeZipPath(cleanHref);
  return normalizeZipPath(baseDir ? `${baseDir}/${cleanHref}` : cleanHref);
}

function extractXmlAttr(tagAttrs, attrName) {
  if (!tagAttrs) return '';
  const re = new RegExp(`(?:^|\\s)${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const m = tagAttrs.match(re);
  return m ? decodeHtmlEntities(m[1] ?? m[2] ?? '').trim() : '';
}

function readZipArchiveEntries(buffer) {
  const entries = new Map();
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 30) return entries;

  const makeLazyEntry = (name, method, dataStart, dataEnd) => {
    const norm = normalizeZipPath(name);
    if (!norm || dataStart < 0 || dataEnd > buffer.length || dataEnd < dataStart) return;
    let cached = undefined;
    entries.set(norm, {
      name: norm,
      readText() {
        if (cached !== undefined) return cached;
        try {
          let raw = null;
          if (method === 0) {
            raw = buffer.subarray(dataStart, dataEnd);
          } else if (method === 8) {
            raw = zlib.inflateRawSync(buffer.subarray(dataStart, dataEnd));
          }
          cached = raw ? decodeTextBuffer(raw) : null;
        } catch {
          cached = null;
        }
        return cached;
      },
    });
  };

  // 1. Prefer ZIP Central Directory (handles bit-3 streaming data descriptors accurately)
  const maxCommentSearch = Math.max(0, buffer.length - 65558);
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= maxCommentSearch; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset !== -1) {
    const cdEntries = buffer.readUInt16LE(eocdOffset + 10);
    const cdOffset = buffer.readUInt32LE(eocdOffset + 16);
    let pos = cdOffset;
    for (let i = 0; i < cdEntries && pos + 46 <= buffer.length; i++) {
      if (buffer.readUInt32LE(pos) !== 0x02014b50) break;
      const method = buffer.readUInt16LE(pos + 10);
      const compressedSize = buffer.readUInt32LE(pos + 20);
      const nameLen = buffer.readUInt16LE(pos + 28);
      const extraLen = buffer.readUInt16LE(pos + 30);
      const commentLen = buffer.readUInt16LE(pos + 32);
      const localOffset = buffer.readUInt32LE(pos + 42);
      const name = buffer.toString('utf8', pos + 46, pos + 46 + nameLen);
      pos += 46 + nameLen + extraLen + commentLen;

      if (localOffset + 30 <= buffer.length && buffer.readUInt32LE(localOffset) === 0x04034b50) {
        const localNameLen = buffer.readUInt16LE(localOffset + 26);
        const localExtraLen = buffer.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + localNameLen + localExtraLen;
        const dataEnd = dataStart + compressedSize;
        makeLazyEntry(name, method, dataStart, dataEnd);
      }
    }
    if (entries.size > 0) return entries;
  }

  // 2. Fallback: local file headers for synthetic local-header-only buffers
  let offset = 0;
  while (offset <= buffer.length - 30) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) break;
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);
    const name = buffer.toString('utf8', offset + 30, offset + 30 + nameLen);
    const dataStart = offset + 30 + nameLen + extraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) break;
    makeLazyEntry(name, method, dataStart, dataEnd);
    if (compressedSize === 0 && dataEnd === offset) break;
    offset = dataEnd;
  }
  return entries;
}

const NON_READING_FILE_STEM_RE = /^(?:cover(?:[-_]?page)?|title(?:[-_]?page)?|half[-_]?title|toc|nav(?:igation)?|contents|copyright(?:[-_]?page)?|colophon|imprint|front[-_]?matter|back[-_]?matter|about[-_]?the[-_]?author|also[-_]?by|acknowledge?ments?|dedication|ads?|promo|license|pg[-_]?(?:header|footer)|footnotes?|endnotes?|glossary|index|bibliography)(?:[-_]?\d+)?$/i;

const BOILERPLATE_LINE_RE = /(?:project gutenberg|all rights reserved|library of congress cataloging|printed in the united states|isbn[\s:-]*[0-9x-]{10,}|https?:\/\/|www\.[a-z0-9.-]+\.[a-z]{2,}|this ebook is for the use of anyone|terms of use|creative commons)/i;

const STRUCTURAL_HEADING_RE = /^(?:chapter|part|book|section|volume|act|scene|prologue|epilogue|cap[ií]tulo|chapitre|kapitel|parte|livre|teil)\s*(?:[ivxlcdm]+|\d+|one|two|three|four|five|six|seven|eight|nine|ten)?[.:\-—\s]*$/i;

function cleanXhtmlToParagraphs(xhtml) {
  if (!xhtml || typeof xhtml !== 'string') return [];
  let s = xhtml;
  // Remove comments, head, scripts, styles, svg, math, nav blocks, and images
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, ' ');
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ');
  s = s.replace(/<math\b[^>]*>[\s\S]*?<\/math>/gi, ' ');
  s = s.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ');
  // Strip <nav> blocks (including nested TOCs / landmarks) iteratively without catastrophic backtracking
  for (let i = 0; i < 6 && /<nav\b/i.test(s); i++) {
    const next = s.replace(/<nav\b[^>]*>(?:(?!<nav\b)[\s\S])*?<\/nav>/gi, ' ');
    if (next === s) break;
    s = next;
  }
  // Strip explicit cover / toc / copyright / landmarks sections when marked via epub:type or role
  s = s.replace(/<(section|div|aside|header|footer)\b[^>]*(?:epub:type|role)\s*=\s*["'][^"']*\b(?:toc|landmarks|page-list|cover|titlepage|copyright-page|colophon|imprint)\b[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi, ' ');
  // Strip self-closing/inline image tags completely so alt attributes never masquerade as reading prose
  s = s.replace(/<img\b[^>]*>/gi, ' ');

  // Convert block-level boundaries to newlines, strip remaining tags, decode entities
  s = s.replace(/<\/?(?:p|div|section|article|blockquote|li|h[1-6]|tr|br|hr)\b[^>]*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeHtmlEntities(s);

  const paragraphs = [];
  for (const rawLine of s.split(/\r?\n+/)) {
    const line = rawLine.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    if (BOILERPLATE_LINE_RE.test(line)) continue;
    if (STRUCTURAL_HEADING_RE.test(line)) continue;
    // Drop TOC dot-leader or page-number lines
    if (/\.{3,}\s*\d+$/.test(line)) continue;
    const letters = line.match(/\p{L}/gu);
    const letterCount = letters ? letters.length : 0;
    if (letterCount < 4) continue;
    const digits = line.match(/\p{N}/gu);
    const digitCount = digits ? digits.length : 0;
    if (digitCount > letterCount) continue;
    paragraphs.push(line);
  }
  return paragraphs;
}

function countEffectiveWordsInText(text) {
  if (!text) return 0;
  const wordTokens = text.match(/\p{L}+(?:['’\-]\p{L}+)*/gu) || [];
  const cjkChars = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu) || [];
  return wordTokens.length + Math.floor(cjkChars.length / 2);
}

function buildDistributedPassagesFromDocs(docs, maxPassages = 16) {
  // Partition reading paragraphs across spine documents into substantive passages (~70-180 words)
  const rawPassages = [];
  for (const doc of docs) {
    let curLines = [];
    let curWords = 0;
    for (const para of doc.paragraphs) {
      const w = countEffectiveWordsInText(para);
      if (w === 0) continue;
      // Split unusually huge single paragraphs (>260 words) into sentence chunks
      if (w > 260 && curWords === 0) {
        const sentences = para.split(/(?<=[.!?。！？])\s+/u);
        for (const sent of sentences) {
          const sw = countEffectiveWordsInText(sent);
          if (sw === 0) continue;
          curLines.push(sent);
          curWords += sw;
          if (curWords >= 100) {
            rawPassages.push({ source: doc.path, text: curLines.join(' '), words: curWords });
            curLines = [];
            curWords = 0;
          }
        }
        continue;
      }
      curLines.push(para);
      curWords += w;
      if (curWords >= 90) {
        rawPassages.push({ source: doc.path, text: curLines.join(' '), words: curWords });
        curLines = [];
        curWords = 0;
      }
    }
    if (curWords > 0) {
      if (rawPassages.length > 0 && curWords < 25 && rawPassages[rawPassages.length - 1].source === doc.path) {
        rawPassages[rawPassages.length - 1].text += ' ' + curLines.join(' ');
        rawPassages[rawPassages.length - 1].words += curWords;
      } else {
        rawPassages.push({ source: doc.path, text: curLines.join(' '), words: curWords });
      }
    }
  }

  // If a compact book produced only 1 passage with >= 36 words, split into two balanced halves
  // so language identification always evaluates multiple non-identical passages.
  if (rawPassages.length === 1 && rawPassages[0].words >= 36) {
    const tokens = rawPassages[0].text.split(/\s+/);
    if (tokens.length >= 10) {
      const mid = Math.floor(tokens.length / 2);
      const firstHalf = tokens.slice(0, mid).join(' ');
      const secondHalf = tokens.slice(mid).join(' ');
      return [
        { source: rawPassages[0].source, text: firstHalf, words: countEffectiveWordsInText(firstHalf) },
        { source: rawPassages[0].source, text: secondHalf, words: countEffectiveWordsInText(secondHalf) },
      ];
    }
    const chars = [...rawPassages[0].text];
    if (chars.length >= 80) {
      const mid = Math.floor(chars.length / 2);
      const firstHalf = chars.slice(0, mid).join('');
      const secondHalf = chars.slice(mid).join('');
      return [
        { source: rawPassages[0].source, text: firstHalf, words: countEffectiveWordsInText(firstHalf) },
        { source: rawPassages[0].source, text: secondHalf, words: countEffectiveWordsInText(secondHalf) },
      ];
    }
  }

  if (rawPassages.length <= maxPassages) {
    return rawPassages;
  }

  // Evenly sample across the entire interior/body of the book
  const sampled = [];
  const used = new Set();
  for (let k = 0; k < maxPassages; k++) {
    const idx = Math.min(rawPassages.length - 1, Math.floor(((k + 0.5) * rawPassages.length) / maxPassages));
    if (!used.has(idx)) {
      used.add(idx);
      sampled.push(rawPassages[idx]);
    }
  }
  return sampled;
}

/**
 * Extracts multi-passage actual reading text samples across an EPUB buffer,
 * following OPF spine order and excluding cover pages, navigation/TOC, copyright,
 * scripts, styles, and image tags.
 */
export function extractEpubReadingSamples(buffer) {
  const entries = readZipArchiveEntries(buffer);
  if (entries.size === 0) {
    return { ok: false, passages: [], spineCount: 0, sampledDocs: 0, totalWords: 0 };
  }

  // Locate OPF via META-INF/container.xml or fallback *.opf
  let opfPath = '';
  const containerEntry = entries.get('META-INF/container.xml') ||
    [...entries.values()].find((e) => e.name.toLowerCase() === 'meta-inf/container.xml');
  if (containerEntry) {
    const containerXml = containerEntry.readText() || '';
    const rfMatch = containerXml.match(/<rootfile\b[^>]*full-path\s*=\s*["']([^"']+)["']/i);
    if (rfMatch && rfMatch[1]) {
      opfPath = normalizeZipPath(rfMatch[1]);
    }
  }
  let opfEntry = opfPath ? entries.get(opfPath) : null;
  if (!opfEntry) {
    opfEntry = [...entries.values()].find((e) => e.name.toLowerCase().endsWith('.opf')) || null;
    if (opfEntry) opfPath = opfEntry.name;
  }

  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';
  const opfXml = opfEntry ? (opfEntry.readText() || '') : '';

  const excludedPaths = new Set();
  const manifest = new Map();
  const spinePaths = [];

  if (opfXml) {
    // Parse <guide> references to exclude cover / toc / title-page / copyright / colophon
    for (const gm of opfXml.matchAll(/<reference\b([^>]*)\/?>/gi)) {
      const attrs = gm[1] || '';
      const gType = extractXmlAttr(attrs, 'type').toLowerCase();
      const gHref = extractXmlAttr(attrs, 'href');
      if (gHref && /^(?:cover|title-page|titlepage|toc|copyright-page|copyright|colophon|acknowledgements?|dedication|glossary|index|bibliography)/i.test(gType)) {
        excludedPaths.add(resolveRelativeZipPath(opfDir, gHref));
      }
    }

    // Parse <manifest> items
    for (const im of opfXml.matchAll(/<item\b([^>]*)\/?>/gi)) {
      const attrs = im[1] || '';
      const id = extractXmlAttr(attrs, 'id');
      const href = extractXmlAttr(attrs, 'href');
      const mediaType = extractXmlAttr(attrs, 'media-type').toLowerCase();
      const props = extractXmlAttr(attrs, 'properties').toLowerCase();
      if (!id || !href) continue;
      const resolved = resolveRelativeZipPath(opfDir, href);
      manifest.set(id, { id, href, resolved, mediaType, props });
      if (/\b(?:nav|cover-image)\b/.test(props)) {
        excludedPaths.add(resolved);
      }
    }

    // Parse <spine> reading order
    for (const sm of opfXml.matchAll(/<itemref\b([^>]*)\/?>/gi)) {
      const attrs = sm[1] || '';
      const idref = extractXmlAttr(attrs, 'idref');
      const linear = extractXmlAttr(attrs, 'linear').toLowerCase();
      if (!idref || linear === 'no') continue;
      const item = manifest.get(idref);
      if (!item) continue;
      const isHtml = !item.mediaType ||
        item.mediaType.includes('xhtml') ||
        item.mediaType.includes('html') ||
        /\.(?:xhtml|html|htm|xml)$/i.test(item.resolved);
      if (!isHtml) continue;
      if (excludedPaths.has(item.resolved)) continue;
      const stem = path.basename(item.resolved).replace(/\.[^.]+$/, '');
      if (NON_READING_FILE_STEM_RE.test(item.id) || NON_READING_FILE_STEM_RE.test(stem)) continue;
      if (!spinePaths.includes(item.resolved)) {
        spinePaths.push(item.resolved);
      }
    }
  }

  // Fallback if OPF lacked <spine> items: inspect HTML/XHTML archive entries in order
  if (spinePaths.length === 0) {
    for (const entry of entries.values()) {
      if (!/\.(?:xhtml|html|htm)$/i.test(entry.name)) continue;
      if (excludedPaths.has(entry.name)) continue;
      const stem = path.basename(entry.name).replace(/\.[^.]+$/, '');
      if (NON_READING_FILE_STEM_RE.test(stem)) continue;
      spinePaths.push(entry.name);
    }
  }

  // Evenly select up to 24 spine documents if the EPUB has hundreds of tiny chapter files
  let docsToRead = spinePaths;
  if (spinePaths.length > 24) {
    docsToRead = [];
    const seenIdx = new Set();
    for (let k = 0; k < 24; k++) {
      const idx = Math.min(spinePaths.length - 1, Math.floor(((k + 0.5) * spinePaths.length) / 24));
      if (!seenIdx.has(idx)) {
        seenIdx.add(idx);
        docsToRead.push(spinePaths[idx]);
      }
    }
  }

  const parsedDocs = [];
  for (const docPath of docsToRead) {
    const entry = entries.get(docPath) ||
      [...entries.values()].find((e) => e.name.toLowerCase() === docPath.toLowerCase());
    if (!entry) continue;
    const rawHtml = entry.readText();
    if (!rawHtml) continue;
    const paragraphs = cleanXhtmlToParagraphs(rawHtml);
    if (paragraphs.length > 0) {
      parsedDocs.push({ path: docPath, paragraphs });
    }
  }

  const passages = buildDistributedPassagesFromDocs(parsedDocs, 16);
  const totalWords = passages.reduce((sum, p) => sum + p.words, 0);
  return {
    ok: true,
    passages,
    spineCount: spinePaths.length,
    sampledDocs: parsedDocs.length,
    totalWords,
  };
}

export function extractEpubReadingSamplesFromFile(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return { ok: false, passages: [], spineCount: 0, sampledDocs: 0, totalWords: 0 };
    }
    const buf = fs.readFileSync(filePath);
    return extractEpubReadingSamples(buf);
  } catch {
    return { ok: false, passages: [], spineCount: 0, sampledDocs: 0, totalWords: 0 };
  }
}

/**
 * Extracts readable text passages from PDF content streams (uncompressed and /FlateDecode).
 */
export function extractPdfReadingSamples(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 16) {
    return { ok: false, passages: [], totalWords: 0 };
  }
  const paragraphs = [];
  const latin1 = buffer.toString('latin1');
  let searchPos = 0;
  let streamCount = 0;
  while (searchPos < latin1.length && streamCount < 60) {
    const sIdx = latin1.indexOf('stream', searchPos);
    if (sIdx === -1) break;
    // Confirm 'stream' is followed by \n or \r\n
    let dataStart = -1;
    if (latin1[sIdx + 6] === '\n') dataStart = sIdx + 7;
    else if (latin1[sIdx + 6] === '\r' && latin1[sIdx + 7] === '\n') dataStart = sIdx + 8;
    if (dataStart === -1) {
      searchPos = sIdx + 6;
      continue;
    }
    const eIdx = latin1.indexOf('endstream', dataStart);
    if (eIdx === -1) break;
    searchPos = eIdx + 9;
    streamCount++;

    const dictSlice = latin1.slice(Math.max(0, sIdx - 250), sIdx);
    const rawSlice = buffer.subarray(dataStart, eIdx).subarray(0, 512 * 1024);
    let content = '';
    try {
      if (/\/FlateDecode\b/.test(dictSlice)) {
        // Trim trailing CR/LF before inflating if needed
        let endTrim = rawSlice.length;
        while (endTrim > 0 && (rawSlice[endTrim - 1] === 0x0a || rawSlice[endTrim - 1] === 0x0d)) endTrim--;
        const inflated = zlib.inflateSync(rawSlice.subarray(0, endTrim));
        content = inflated.toString('utf8');
      } else if (!/\/(?:DCTDecode|JPXDecode|JBIG2Decode|CCITTFaxDecode)\b/.test(dictSlice)) {
        content = rawSlice.toString('utf8');
      }
    } catch {
      continue;
    }
    if (!content || !content.includes('BT')) continue;
    const chunks = [];
    for (const btMatch of content.matchAll(/\bBT\b([\s\S]*?)\bET\b/g)) {
      const block = btMatch[1] || '';
      for (const lit of block.matchAll(/\((?:\\.|[^\\()])*\)/g)) {
        const inner = lit[0].slice(1, -1)
          .replace(/\\([nrtbf()\\])/g, (_, c) => (c === 'n' || c === 'r' ? ' ' : c))
          .replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
        chunks.push(inner);
      }
    }
    const joined = chunks.join(' ').replace(/\s+/g, ' ').trim();
    if (countEffectiveWordsInText(joined) >= 6) {
      paragraphs.push(joined);
    }
  }
  const passages = buildDistributedPassagesFromDocs([{ path: 'pdf', paragraphs }], 16);
  const totalWords = passages.reduce((sum, p) => sum + p.words, 0);
  return { ok: true, passages, totalWords };
}

// Closed-class function-word lexicons for Unicode-aware Latin & Cyrillic language identification.
// Note: Diacritics or non-ASCII ratios are NEVER used against English, so accented loanwords,
// names, curly typography, and brief foreign phrases in English prose are handled cleanly.
const LANGUAGE_STOPWORDS = {
  en: new Set([
    'the', 'and', 'that', 'with', 'from', 'have', 'this', 'they', 'were', 'would',
    'which', 'their', 'there', 'been', 'through', 'into', 'before', 'after', 'about', 'could',
    'when', 'what', 'while', 'under', 'between', 'without', 'because', 'against', 'himself', 'herself',
    'nothing', 'something', 'though', 'should', 'where', 'those', 'these', 'other', 'every', 'again',
    'never', 'always', 'still', 'upon', 'only', 'over', 'some', 'such', 'than', 'them',
    'then', 'very', 'was', 'had', 'his', 'her', 'she', 'you', 'your', 'not', 'but', 'for', 'are', 'who',
  ]),
  es: new Set([
    'el', 'la', 'los', 'las', 'del', 'al', 'una', 'unos', 'unas', 'que',
    'por', 'para', 'con', 'como', 'más', 'pero', 'sus', 'les', 'está', 'estaba',
    'había', 'fueron', 'hacia', 'desde', 'hasta', 'entre', 'sobre', 'también', 'cuando', 'donde',
    'quien', 'todo', 'todos', 'esta', 'este', 'estos', 'estas', 'tiene', 'tenía', 'puede',
    'mismo', 'tiempo', 'después', 'siempre', 'nunca', 'aunque', 'sino', 'porque', 'durante', 'contra',
    'era', 'eran', 'fue', 'muy', 'sin', 'ella', 'ellos', 'ellas', 'nosotros', 'usted',
  ]),
  pt: new Set([
    'os', 'as', 'um', 'uma', 'uns', 'umas', 'dos', 'das', 'nos', 'nas',
    'pelo', 'pela', 'pelos', 'pelas', 'não', 'nao', 'são', 'sao', 'está', 'estava',
    'tinha', 'foram', 'muito', 'mais', 'mas', 'como', 'para', 'com', 'seu', 'sua',
    'seus', 'suas', 'dele', 'dela', 'isso', 'isto', 'aquele', 'aquela', 'quando', 'onde',
    'também', 'tambem', 'ainda', 'depois', 'então', 'entao', 'mesmo', 'sobre', 'entre', 'até',
    'você', 'voce', 'eles', 'elas', 'porque', 'sem', 'pelos', 'num', 'numa',
  ]),
  fr: new Set([
    'le', 'la', 'les', 'des', 'du', 'au', 'aux', 'une', 'dans', 'pour',
    'pas', 'plus', 'par', 'sur', 'avec', 'tout', 'tous', 'mais', 'donc', 'comme',
    'était', 'etait', 'avait', 'sont', 'être', 'etre', 'avoir', 'cette', 'cet', 'ces',
    'leurs', 'leur', 'même', 'meme', 'aussi', 'bien', 'sans', 'sous', 'après', 'apres',
    'avant', 'encore', 'toujours', 'jamais', 'depuis', 'pendant', 'contre', 'chez', 'très', 'tres',
    'dont', 'quand', 'qui', 'elle', 'ils', 'elles', 'nous', 'vous', 'était', 'fait',
  ]),
  de: new Set([
    'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einer', 'einem',
    'einen', 'eines', 'und', 'nicht', 'mit', 'sich', 'auf', 'für', 'fur', 'ist',
    'war', 'sind', 'waren', 'hatte', 'haben', 'wird', 'wurde', 'werden', 'auch', 'als',
    'nach', 'wie', 'über', 'uber', 'aus', 'bei', 'nur', 'noch', 'dann', 'wenn',
    'aber', 'oder', 'doch', 'schon', 'durch', 'gegen', 'unter', 'zwischen', 'während', 'ohne',
    'seine', 'seiner', 'seinem', 'ihre', 'ihrer', 'einem', 'dieser', 'diese', 'dieses',
  ]),
  it: new Set([
    'il', 'lo', 'gli', 'della', 'dello', 'delle', 'degli', 'dei', 'nel', 'nella',
    'nello', 'nelle', 'negli', 'nei', 'sul', 'sulla', 'che', 'non', 'per', 'con',
    'una', 'uno', 'sono', 'era', 'erano', 'aveva', 'hanno', 'stato', 'più', 'piu',
    'come', 'anche', 'questo', 'questa', 'questi', 'queste', 'quello', 'quella', 'suo', 'sua',
    'suoi', 'sue', 'loro', 'dopo', 'prima', 'ancora', 'sempre', 'molto', 'tutto', 'tutti',
    'perché', 'perche', 'quando', 'dove', 'senza', 'contro', 'dalla', 'dalle',
  ]),
  nl: new Set([
    'de', 'het', 'een', 'van', 'dat', 'zijn', 'voor', 'met', 'niet', 'aan',
    'ook', 'als', 'dan', 'maar', 'bij', 'nog', 'uit', 'naar', 'haar', 'hun',
    'hem', 'werd', 'werden', 'hadden', 'heeft', 'hebben', 'zou', 'zouden', 'deze', 'dit',
    'geen', 'veel', 'meer', 'door', 'tegen', 'onder', 'tussen', 'zonder', 'omdat', 'wanneer',
  ]),
  pl: new Set([
    'nie', 'się', 'sie', 'jest', 'jak', 'ale', 'czy', 'już', 'juz', 'tylko',
    'jego', 'jej', 'ich', 'był', 'byl', 'była', 'byla', 'było', 'bylo', 'byli',
    'będzie', 'bedzie', 'przez', 'przy', 'przed', 'między', 'miedzy', 'bardzo', 'kiedy', 'gdzie',
    'który', 'ktory', 'która', 'ktora', 'które', 'ktore', 'tego', 'tej', 'tym', 'tych', 'więc', 'jeszcze',
  ]),
  lt: new Set([
    'kad', 'jis', 'jie', 'jos', 'tai', 'bet', 'jau', 'tik', 'buvo', 'yra',
    'bus', 'kaip', 'kai', 'kur', 'kas', 'jog', 'nes', 'tačiau', 'taciau', 'todėl',
    'todel', 'apie', 'prie', 'tarp', 'už', 'iš', 'ją', 'jų', 'jam', 'jai',
    'save', 'savo', 'šis', 'ši', 'labai', 'dabar', 'dar', 'nebuvo', 'kuris', 'kuri',
  ]),
  sv: new Set([
    'och', 'det', 'att', 'som', 'en', 'på', 'är', 'för', 'med', 'till',
    'den', 'har', 'inte', 'om', 'ett', 'han', 'hon', 'men', 'var', 'jag',
    'sig', 'från', 'vi', 'så', 'kan', 'man', 'när', 'hade', 'skulle', 'också',
  ]),
  id: new Set([
    'yang', 'dan', 'itu', 'dengan', 'untuk', 'tidak', 'ini', 'dari', 'dalam', 'akan',
    'pada', 'juga', 'saya', 'karena', 'tersebut', 'bisa', 'ada', 'mereka', 'lebih', 'sudah',
    'atau', 'saat', 'oleh', 'sebagai', 'hanya', 'namun', 'ketika', 'bahwa', 'belum', 'kita',
  ]),
  tr: new Set([
    'bir', 've', 'bu', 'için', 'icin', 'ile', 'olan', 'gibi', 'daha', 'çok',
    'cok', 'ama', 'fakat', 'sonra', 'kadar', 'olarak', 'onun', 'bunu', 'öyle', 'oyle',
    'kendi', 'ancak', 'değil', 'degil', 'her', 'hiç', 'hic', 'zaman', 'nasıl', 'nasil',
  ]),
  ru: new Set([
    'и', 'в', 'не', 'на', 'что', 'он', 'она', 'они', 'как', 'это',
    'по', 'но', 'из', 'за', 'то', 'же', 'от', 'было', 'был', 'была',
    'для', 'его', 'ее', 'их', 'когда', 'только', 'уже', 'если', 'все', 'так',
    'при', 'еще', 'ещё', 'нет', 'даже', 'через', 'между', 'после', 'чтобы', 'себя',
  ]),
  uk: new Set([
    'і', 'та', 'що', 'не', 'на', 'він', 'вона', 'вони', 'як', 'це',
    'від', 'але', 'за', 'до', 'був', 'була', 'було', 'для', 'його', 'її',
    'їх', 'коли', 'тільки', 'вже', 'якщо', 'все', 'так', 'при', 'ще', 'між', 'після', 'щоб',
  ]),
};

function scorePassageLanguages(text) {
  const scores = {};
  const letters = text.match(/\p{L}/gu) || [];
  const totalLetters = letters.length;
  if (totalLetters === 0) return { scores, topLang: null, topScore: 0, secondScore: 0, effectiveWords: 0, totalLetters: 0 };

  const hangulCount = (text.match(/\p{Script=Hangul}/gu) || []).length;
  const kanaCount = (text.match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu) || []).length;
  const hanCount = (text.match(/\p{Script=Han}/gu) || []).length;
  const cyrillicCount = (text.match(/\p{Script=Cyrillic}/gu) || []).length;
  const arabicCount = (text.match(/\p{Script=Arabic}/gu) || []).length;
  const hebrewCount = (text.match(/\p{Script=Hebrew}/gu) || []).length;
  const greekCount = (text.match(/\p{Script=Greek}/gu) || []).length;
  const devanagariCount = (text.match(/\p{Script=Devanagari}/gu) || []).length;
  const thaiCount = (text.match(/\p{Script=Thai}/gu) || []).length;

  const rawWords = text.match(/\p{L}+(?:['’]\p{L}+)*/gu) || [];
  const effectiveWords = rawWords.length + Math.floor((hanCount + kanaCount) / 2);
  const denom = Math.max(1, effectiveWords);

  // Script-distinct non-Latin language scoring on comparable density scale (~0.0 - 0.50)
  if (hangulCount > 0) scores.ko = 0.48 * (hangulCount / totalLetters);
  if (kanaCount > 0) scores.ja = 0.48 * ((kanaCount + hanCount) / totalLetters);
  if (hanCount > 0 && kanaCount === 0) scores.zh = 0.48 * (hanCount / totalLetters);
  if (arabicCount > 0) scores.ar = 0.48 * (arabicCount / totalLetters);
  if (hebrewCount > 0) scores.he = 0.48 * (hebrewCount / totalLetters);
  if (greekCount > 0) scores.el = 0.48 * (greekCount / totalLetters);
  if (devanagariCount > 0) scores.hi = 0.48 * (devanagariCount / totalLetters);
  if (thaiCount > 0) scores.th = 0.48 * (thaiCount / totalLetters);

  // Word-level closed-class lexicon scoring (preserves Unicode letters & case-folds cleanly)
  for (const [lang, lex] of Object.entries(LANGUAGE_STOPWORDS)) {
    let hits = 0;
    for (const rawTok of rawWords) {
      const lower = rawTok.toLowerCase();
      if (lex.has(lower)) {
        hits += 1;
        continue;
      }
      // Handle apostrophe clitics and contractions (e.g. French l'homme / d'un, English wasn't / they'd)
      const aposIdx = Math.max(lower.indexOf("'"), lower.indexOf('’'));
      if (aposIdx > 0) {
        const prefix = lower.slice(0, aposIdx);
        const suffix = lower.slice(aposIdx + 1);
        if (lang === 'fr' && ['l', 'd', 'qu', 'n', 'j', 's', 'c', 'm', 't'].includes(prefix) && suffix.length >= 2) {
          hits += 0.85;
        } else if (lang === 'it' && ['l', 'dell', 'nell', 'all', 'sull', 'un', 'quest'].includes(prefix) && suffix.length >= 2) {
          hits += 0.75;
        } else if (lang === 'en' && (['t', 've', 're', 'll', 'd', 's', 'm'].includes(suffix) && lex.has(prefix.replace(/n$/, '')))) {
          hits += 0.85;
        } else if (lex.has(suffix)) {
          hits += 0.5;
        }
      }
    }
    if (lang === 'ru' && cyrillicCount > 0) {
      const ruLetters = (text.match(/[ыъэЫЪЭ]/g) || []).length;
      hits += ruLetters * 0.4;
      scores.ru = Math.max(scores.ru || 0, Math.min(0.55, hits / denom) || (0.28 * (cyrillicCount / totalLetters)));
    } else if (lang === 'uk' && cyrillicCount > 0) {
      const ukLetters = (text.match(/[іїєґІЇЄҐ]/g) || []).length;
      hits += ukLetters * 0.5;
      if (hits > 0) scores.uk = Math.min(0.55, hits / denom);
    } else if (hits > 0) {
      scores[lang] = hits / denom;
    }
  }

  let topLang = null;
  let topScore = 0;
  let secondScore = 0;
  for (const [lang, sc] of Object.entries(scores)) {
    if (sc > topScore) {
      secondScore = topScore;
      topScore = sc;
      topLang = lang;
    } else if (sc > secondScore) {
      secondScore = sc;
    }
  }

  return { scores, topLang, topScore, secondScore, effectiveWords, totalLetters };
}

/**
 * Identifies the actual reading language across sampled book passages.
 * Returns:
 *   - status: 'verified'     (actual reading text across passages matches requestedLang)
 *   - status: 'mismatch'     (actual reading text across passages is confidently another language)
 *   - status: 'insufficient' (insufficient or ambiguous readable prose -> requires manual review)
 */
export function identifyReadingLanguage(sampleBundle, requestedLang = 'en') {
  const targetLang = ID.normalizeLanguageCode(requestedLang) || 'en';
  const passages = Array.isArray(sampleBundle?.passages) ? sampleBundle.passages : [];
  let totalWords = 0;
  let totalLetters = 0;
  let totalCjkChars = 0;

  for (const p of passages) {
    const txt = String(p?.text || '');
    totalLetters += (txt.match(/\p{L}/gu) || []).length;
    totalCjkChars += (txt.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu) || []).length;
    totalWords += countEffectiveWordsInText(txt);
  }

  const baseStats = {
    passageCount: passages.length,
    effectiveWords: totalWords,
    totalLetters,
    passageWinners: {},
  };

  // Require multiple passages and substantive readable prose (prevents cover/TOC/stub false positives)
  const enoughLetters = totalLetters >= 140 || totalCjkChars >= 80;
  if (passages.length < 2 || totalWords < 35 || !enoughLetters) {
    return {
      status: 'insufficient',
      detected: null,
      expected: targetLang,
      confidence: 'low',
      reason: 'insufficient_language_evidence',
      stats: baseStats,
    };
  }

  const aggregateWeighted = {};
  let totalWeight = 0;
  let confidentPassages = 0;

  for (const p of passages) {
    const res = scorePassageLanguages(String(p?.text || ''));
    const weight = Math.max(1, res.effectiveWords);
    totalWeight += weight;
    for (const [lang, sc] of Object.entries(res.scores)) {
      aggregateWeighted[lang] = (aggregateWeighted[lang] || 0) + sc * weight;
    }
    if (res.topLang && res.topScore >= 0.10 && res.topScore >= res.secondScore * 1.2) {
      baseStats.passageWinners[res.topLang] = (baseStats.passageWinners[res.topLang] || 0) + 1;
      confidentPassages++;
    }
  }

  const avgScores = {};
  let bestLang = null;
  let bestScore = 0;
  let runnerUpLang = null;
  let runnerUpScore = 0;
  for (const [lang, sum] of Object.entries(aggregateWeighted)) {
    const avg = sum / Math.max(1, totalWeight);
    avgScores[lang] = Number(avg.toFixed(4));
    if (avg > bestScore) {
      runnerUpScore = bestScore;
      runnerUpLang = bestLang;
      bestScore = avg;
      bestLang = lang;
    } else if (avg > runnerUpScore) {
      runnerUpScore = avg;
      runnerUpLang = lang;
    }
  }
  baseStats.scores = avgScores;
  baseStats.runnerUp = runnerUpLang;

  // Unrecognizable / OCR-garbled / non-prose text with negligible linguistic signal -> review required
  if (!bestLang || bestScore < 0.10 || confidentPassages === 0) {
    return {
      status: 'insufficient',
      detected: null,
      expected: targetLang,
      confidence: 'low',
      reason: 'insufficient_language_evidence',
      stats: baseStats,
    };
  }

  const targetScore = avgScores[targetLang] || 0;
  const targetWins = baseStats.passageWinners[targetLang] || 0;
  const bestWins = baseStats.passageWinners[bestLang] || 0;
  const passageCount = passages.length;

  // Confidently matches requested language across the book (tolerating isolated foreign quotes/epigraphs)
  if (
    bestLang === targetLang &&
    targetWins / passageCount >= 0.65 &&
    bestScore >= 0.12 &&
    (runnerUpScore === 0 || bestScore / runnerUpScore >= 1.45)
  ) {
    return {
      status: 'verified',
      detected: targetLang,
      expected: targetLang,
      confidence: bestScore >= 0.20 ? 'high' : 'medium',
      reason: null,
      stats: baseStats,
    };
  }

  // Confidently wrong language across the book
  if (
    bestLang !== targetLang &&
    bestWins / passageCount >= 0.55 &&
    bestScore >= 0.12 &&
    (targetScore === 0 || bestScore / targetScore >= 1.45)
  ) {
    return {
      status: 'mismatch',
      detected: bestLang,
      expected: targetLang,
      confidence: bestScore >= 0.20 ? 'high' : 'medium',
      reason: 'language_mismatch',
      stats: baseStats,
    };
  }

  // Borderline / split bilingual / inconclusive text -> require human review rather than guessing
  return {
    status: 'insufficient',
    detected: bestLang,
    expected: targetLang,
    confidence: 'low',
    reason: 'insufficient_language_evidence',
    stats: baseStats,
  };
}

const SENSITIVE_KEYS = /^(token|secret|password|passwd|pwd|api[_-]?key|authorization|auth|cookie|credential|credentials|private[_-]?key|refresh[_-]?token|access[_-]?token|jwt|session[_-]?id|client[_-]?secret|apikey)$/i;

/** Deep, key-aware redaction shared by logs and diagnostics. */
export function redactSensitive(value, seen = new WeakSet()) {
  if (value == null) return value;
  if (typeof value === 'string') {
    let s = value;
    s = s.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]');
    s = s.replace(/(apiKey|api_key|token|secret|password|auth|authorization)=([^&\s]+)/gi, '$1=[REDACTED]');
    s = s.replace(/([?&](?:token|secret|key|password|auth|api_key|apiKey)=)([^&\s]+)/gi, '$1[REDACTED]');
    s = s.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]:[REDACTED]@');
    s = s.replace(/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED]');
    return s;
  }
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    const out = value.map((v) => redactSensitive(v, seen));
    seen.delete(value);
    return out;
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEYS.test(k)) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = redactSensitive(v, seen);
    }
  }
  seen.delete(value);
  return out;
}

export const redact = redactSensitive;

/** Redacts sensitive tokens and secrets from diagnostic logs. */
export function sanitizeLog(msg) {
  if (typeof msg !== 'string') return String(msg);
  return redactSensitive(msg);
}

/** Timing-safe string comparison to prevent timing attacks on secrets. */
export function timingSafeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  // Compare fixed-length digests to avoid leaking input length.
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Checks whether a string conforms to JSON Web Token format (header.payload.signature). */
export function isJwt(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => !p)) return false;
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return !!header && typeof payload === 'object' && payload !== null;
  } catch {
    return false;
  }
}

/** Decodes the expiration timestamp (ms) from a JWT without external libraries. */
export function decodeJwtExp(token) {
  if (!isJwt(token)) return null;
  const parts = token.split('.');
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (typeof payload.exp === 'number') {
      return payload.exp * 1000;
    }
  } catch {}
  return null;
}

/**
 * Normalizes a Shelfmark task group (which is an object keyed by task ID in v1.5.1
 * or an array in legacy/mock fixtures) into an array of task records.
 * Retains each original task ID from the object key or element.
 */
export function normalizeTaskGroup(group) {
  if (group === null || group === undefined) {
    return [];
  }
  if (Array.isArray(group)) {
    return group.map((item) => {
      if (!item || typeof item !== 'object') return item;
      const id = item.id ?? item.taskId ?? item.task_id ?? item.taskID;
      return {
        ...item,
        id,
        taskId: item.taskId ?? id,
        task_id: item.task_id ?? id,
      };
    });
  }
  if (typeof group !== 'object') {
    return [];
  }
  // Support wrappers such as { tasks: [...] } or { items: [...] }.
  if (Array.isArray(group.tasks)) return normalizeTaskGroup(group.tasks);
  if (Array.isArray(group.items)) return normalizeTaskGroup(group.items);
  if (Array.isArray(group.results)) return normalizeTaskGroup(group.results);
  // Support a single task object passed directly.
  if (group.id !== undefined || group.task_id !== undefined || group.taskId !== undefined || group.title !== undefined) {
    const id = group.id ?? group.taskId ?? group.task_id;
    return [{
      ...group,
      id,
      taskId: group.taskId ?? id,
      task_id: group.task_id ?? id,
    }];
  }
  return Object.entries(group).map(([key, val]) => {
    if (!val || typeof val !== 'object') {
      return { id: key, taskId: key, task_id: key };
    }
    const id = val.id ?? val.taskId ?? val.task_id ?? key;
    return {
      ...val,
      id,
      taskId: val.taskId ?? id,
      task_id: val.task_id ?? id,
    };
  });
}

/**
 * Parses Shelfmark v1.5.1 /api/status response, supporting keyed groups
 * (`complete`, `downloading`, `queued`, `error`) and legacy arrays.
 * Always returns normalized arrays of task records.
 */
export function parseShelfmarkStatus(statusJson) {
  if (!statusJson || typeof statusJson !== 'object') {
    return { complete: [], downloading: [], queued: [], error: [] };
  }
  const resolving = normalizeTaskGroup(statusJson.resolving || statusJson.resolvingTasks || statusJson.resolving_tasks);
  const locating = normalizeTaskGroup(statusJson.locating || statusJson.locatingTasks || statusJson.locating_tasks);
  const cancelled = normalizeTaskGroup(statusJson.cancelled || statusJson.canceled || statusJson.cancelledTasks || statusJson.cancelled_tasks);
  const active = normalizeTaskGroup(statusJson.active || statusJson.activeTasks || statusJson.active_tasks);
  const completed = normalizeTaskGroup(statusJson.completed || statusJson.completedTasks || statusJson.completed_tasks);
  const failed = normalizeTaskGroup(statusJson.failed || statusJson.failedTasks || statusJson.failed_tasks);
  const pending = normalizeTaskGroup(statusJson.pending || statusJson.pendingTasks || statusJson.pending_tasks);
  return {
    complete: [...normalizeTaskGroup(statusJson.complete || statusJson.completeTasks || statusJson.completed_tasks), ...completed],
    downloading: [...normalizeTaskGroup(statusJson.downloading || statusJson.downloadingTasks || statusJson.active_tasks), ...active, ...resolving, ...locating],
    queued: [...normalizeTaskGroup(statusJson.queued || statusJson.queuedTasks || statusJson.queued_tasks), ...pending],
    error: [...normalizeTaskGroup(statusJson.error || statusJson.errorTasks || statusJson.failed_tasks), ...failed],
    resolving,
    locating,
    cancelled,
    active,
    completed,
    failed,
    pending,
  };
}

/**
 * Validates and parses positive integers (e.g. library and folder IDs).
 */
export const KNOWN_TITLE_EQUIVALENTS = ID.KNOWN_TITLE_EQUIVALENTS;

export function normalizeString(str) { return ID.normalizeString(str); }
export function normalizeLanguageCode(lang) { return ID.normalizeLanguageCode(lang); }
export function stripLeadingArticle(str) { return ID.stripLeadingArticle(str); }
export function getTokens(str) { return ID.getTokens(str); }
export function toNaturalAuthor(author) { return ID.toNaturalAuthor(author); }
export function extractCoreTitle(title, options) { return ID.extractCoreTitle(title, options); }
export function isNoiseDerivative(candidateTitle, requestedTitle) { return ID.isNoiseDerivative(candidateTitle, requestedTitle); }
export function isTitleMatch(candidateTitle, requestedTitle, options) { return ID.isTitleMatch(candidateTitle, requestedTitle, options); }
export function isAuthorMatch(candidateAuthors, requestedAuthor) { return ID.isAuthorMatch(candidateAuthors, requestedAuthor); }

export function parsePositiveInt(val) {
  if (typeof val === 'number') {
    return Number.isInteger(val) && val > 0 ? val : null;
  }
  if (typeof val === 'string' && /^\d+$/.test(val.trim())) {
    const parsed = parseInt(val.trim(), 10);
    return parsed > 0 ? parsed : null;
  }
  return null;
}

export function normalizeIsbnBridge(value) {
  return ID.normalizeIsbn(value);
}

export function collectMetadataIsbnsBridge(obj, out = new Set()) {
  if (!obj || typeof obj !== 'object') return out;
  for (const [key, value] of Object.entries(obj)) {
    if (/isbn/i.test(key)) {
      const vals = Array.isArray(value) ? value : [value];
      for (const v of vals) {
        if (v == null) continue;
        if (typeof v === 'object') collectMetadataIsbnsBridge(v, out);
        else {
          const cleaned = normalizeIsbnBridge(v);
          if (cleaned.length === 10 || cleaned.length === 13) out.add(cleaned);
        }
      }
    } else if (typeof value === 'object') {
      collectMetadataIsbnsBridge(value, out);
    }
  }
  return out;
}

export function gatherTrustedIsbnsBridge(...sources) {
  const out = new Set();
  for (const src of sources) {
    if (!src) continue;
    if (Array.isArray(src)) {
      for (const v of src) {
        const n = normalizeIsbnBridge(v);
        if (n.length === 10 || n.length === 13) out.add(n);
      }
      continue;
    }
    if (typeof src === 'string') {
      const n = normalizeIsbnBridge(src);
      if (n.length === 10 || n.length === 13) out.add(n);
      continue;
    }
    collectMetadataIsbnsBridge(src, out);
  }
  return [...out];
}

export function collectEditionSpecificIsbnPairsBridge(obj) {
  return ID.collectIsbnPairs(obj);
}

export function collectEditionSpecificIsbnsBridge(obj, out = new Set()) {
  return ID.collectMetadataIsbns(obj, out);
}

export function areVerifiedIsbnCounterpartsBridge(isbnA, isbnB, ...contexts) {
  return ID.areVerifiedCounterparts(isbnA, isbnB, ...contexts);
}

/**
 * Authoritatively verifies whether two release or edition descriptors are compatible.
 * Enforces strict matching on normalized title, author, publication year, format, and ISBN.
 * Distinct publication years or conflicting authors/ISBNs are rejected as distinct editions.
 * A known requested year with an unknown release year must not be treated as a verified edition match
 * unless verified by a matching ISBN or EPUB metadata.
 */
export function withEpubMetadata(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const copy = { ...obj };
  const base = (copy.epubMetadata && typeof copy.epubMetadata === 'object') ? { ...copy.epubMetadata } : {};
  const merged = { ...base };
  const rawTitle = (copy.bookTitle || copy.title || '').trim();
  if (copy.filePath && (copy.format === 'epub' || String(copy.filePath).toLowerCase().endsWith('.epub'))) {
    const meta = extractEpubMetadataFromFile(copy.filePath);
    if (meta && (!meta.title || !rawTitle || isTitleMatch(meta.title, rawTitle))) {
      if (meta.year != null && merged.year == null) merged.year = meta.year;
      if (Array.isArray(meta.years) && meta.years.length && !Array.isArray(merged.years)) merged.years = meta.years;
      if (meta.isbn != null && merged.isbn == null) merged.isbn = meta.isbn;
      if (Array.isArray(meta.isbns) && meta.isbns.length && !Array.isArray(merged.isbns)) merged.isbns = meta.isbns;
      if (meta.language != null && merged.language == null) merged.language = meta.language;
    }
  }
  if (Object.keys(merged).length) copy.epubMetadata = merged;
  return copy;
}

export function areEditionsCompatible(a, b) {
  if (!a || !b) return false;
  return ID.areEditionsCompatible(withEpubMetadata(a), withEpubMetadata(b));
}

export function candidateCompatibility(req, rel) {
  if (!req || !rel) return { outcome: 'reject', conflicts: ['missing_input'], reasonCodes: ['missing_input'], evidence: [] };
  return ID.candidateCompatibility(withEpubMetadata(req), withEpubMetadata(rel));
}

export function getEditionIncompatibilityReason(req, rel) {
  if (!req || !rel) return 'incompatible_edition';
  const d = ID.candidateCompatibility(withEpubMetadata(req), withEpubMetadata(rel));
  if (d.outcome === 'match' || d.outcome === 'provisional') return null;
  if (Array.isArray(d.conflicts) && d.conflicts.length) return d.conflicts[0];
  if (Array.isArray(d.reasonCodes) && d.reasonCodes.length) return d.reasonCodes[0];
  return 'incompatible_edition';
}

/**
 * Post-download work & actual reading-language verification.
 * Evaluates a downloaded task artifact against the original request specification
 * before importing into BookOrbit or fulfilling the request:
 *   - Enforces strong title & author matching (rejecting unrelated books, summaries, anthologies, abridgments).
 *   - Treats release and EPUB <dc:language> metadata as hints, not authoritative truth;
 *     always inspects actual reading text across the book via Unicode-aware language identification.
 *   - Rejects confidently wrong-language content ('finalization_failed') and routes insufficient
 *     readable evidence to 'review_required' ('language_review_required').
 *   - Treats ISBN as positive informational evidence only (different or absent ISBN never blocks).
 *   - Never uses publication year to block or penalize, and never fabricates ISBN/year metadata.
 */
export function verifyDownloadedEdition(task, reqSpec = {}) {
  const rid = reqSpec.requestId ?? null;
  const expectedTitle = String(
    reqSpec.title ??
    (rid && task?.requestTitles?.[rid]) ??
    task?.requestTitle ??
    task?.bookTitle ??
    task?.title ??
    ''
  ).trim();
  const expectedAuthor = String(
    reqSpec.author ??
    (rid && task?.requestAuthorsMap?.[rid]) ??
    task?.requestAuthor ??
    task?.bookAuthor ??
    task?.author ??
    ''
  ).trim();
  const expectedSeriesName = String(
    reqSpec.seriesName ??
    (rid && task?.requestSeriesNames?.[rid]) ??
    task?.requestSeriesName ??
    task?.seriesName ??
    ''
  ).trim();
  const expectedSeriesIndex =
    reqSpec.seriesIndex ??
    (rid && task?.requestSeriesIndices ? task.requestSeriesIndices[rid] : undefined) ??
    task?.requestSeriesIndex ??
    task?.seriesIndex;
  const expectedLanguage = String(
    reqSpec.language ??
    (rid && task?.requestLanguages?.[rid]) ??
    task?.requestLanguage ??
    'en'
  ).trim();
  const normExpectedLang = ID.normalizeLanguageCode(expectedLanguage) || 'en';
  const reqIsbn = normalizeIsbnBridge(
    reqSpec.isbn ??
    (rid && task?.requestIsbns ? task.requestIsbns[rid] : undefined) ??
    task?.requestIsbn ??
    ''
  );
  const validReqIsbn = (reqIsbn.length === 10 || reqIsbn.length === 13) ? reqIsbn : '';

  const fmtLower = String(task?.format || '').toLowerCase();
  const pathLower = String(task?.filePath || '').toLowerCase();
  const isEpub = Boolean(fmtLower === 'epub' || pathLower.endsWith('.epub'));
  const isPdf = Boolean(!isEpub && (fmtLower === 'pdf' || pathLower.endsWith('.pdf')));

  const evidence = [];
  const conflicts = [];
  let error = null;
  let opf = null;
  let languageAnalysis = null;

  if (isEpub && task?.filePath) {
    opf = extractEpubMetadataFromFile(task.filePath);
    if (!opf) {
      conflicts.push('unverified_epub_metadata');
      evidence.push({ field: 'opf', level: 'container', status: 'missing', value: null });
      error = 'EPUB metadata could not be extracted from downloaded container';
      return {
        ok: false,
        outcome: 'review',
        errorType: 'review_required',
        primaryConflict: 'unverified_epub_metadata',
        conflicts,
        evidence,
        error,
        isbnFailure: false,
        workOrLanguageFailure: false,
        languageReviewRequired: true,
        opf: null,
        languageAnalysis: null,
      };
    }

    // 1. Work title & series-volume verification
    if (!opf.title && expectedTitle) {
      conflicts.push('missing_title');
      evidence.push({ field: 'title', level: 'work', status: 'missing', expected: expectedTitle, observed: null });
      error = error || `EPUB title mismatch: expected "${expectedTitle}", got missing title`;
    } else if (opf.title && expectedTitle) {
      const candidateTitles = [];
      if (opf.compositeTitle) candidateTitles.push(opf.compositeTitle);
      if (Array.isArray(opf.titles)) {
        for (const t of opf.titles) {
          if (t && !candidateTitles.includes(t)) candidateTitles.push(t);
        }
      }
      if (opf.title && !candidateTitles.includes(opf.title)) candidateTitles.push(opf.title);
      if (opf.subtitle && !candidateTitles.includes(opf.subtitle)) candidateTitles.push(opf.subtitle);
      if (Array.isArray(opf.subtitles)) {
        for (const s of opf.subtitles) {
          if (s && !candidateTitles.includes(s)) candidateTitles.push(s);
        }
      }
      if (opf.series && opf.rawTitle && !candidateTitles.includes(`${opf.series}: ${opf.rawTitle}`)) {
        candidateTitles.push(`${opf.series}: ${opf.rawTitle}`);
      }
      if (opf.series && opf.subtitle && !candidateTitles.includes(`${opf.series}: ${opf.subtitle}`)) {
        candidateTitles.push(`${opf.series}: ${opf.subtitle}`);
      }
      if (opf.rawTitle && opf.subtitle && !candidateTitles.includes(`${opf.rawTitle}: ${opf.subtitle}`)) {
        candidateTitles.push(`${opf.rawTitle}: ${opf.subtitle}`);
      }

      const matchOpts = {
        candAuthor: opf.author || '',
        reqAuthor: expectedAuthor || '',
        reqSeriesName: expectedSeriesName || opf.series,
        reqSeriesIndex: expectedSeriesIndex ?? opf.seriesIndex,
      };

      let bestDecision = null;
      let matchedObserved = null;

      for (const candTitle of candidateTitles) {
        const td = ID.titleMatchDecision(candTitle, expectedTitle, matchOpts);
        if (td.outcome === 'match' || td.outcome === 'provisional') {
          bestDecision = td;
          matchedObserved = candTitle;
          break;
        }
        if (!bestDecision) {
          bestDecision = td;
          matchedObserved = candTitle;
        }
      }

      // Filename-backed rescue for minor title mismatches: if the EPUB's dc:title is an
      // abbreviation/subset of the expected title but the downloaded file's own name
      // carries the full expected title, treat the edition as verified.
      const fileBaseNoExt = String(task?.filePath || '').split(/[\\\\/]/).pop().replace(/\\.[^.]+$/, '');
      const normFileBase = ID.normalizeString(fileBaseNoExt);
      const normObservedTitle = ID.normalizeString(matchedObserved || opf.rawTitle || opf.title || '');
      const normExpectedTitle = ID.normalizeString(expectedTitle || '');
      const minorTitleMismatch = Boolean(
        normExpectedTitle && normObservedTitle &&
        (normExpectedTitle.includes(normObservedTitle) || normObservedTitle.includes(normExpectedTitle))
      );
      const filenameSupportsTitle = Boolean(
        normFileBase && normExpectedTitle &&
        (normFileBase.includes(normExpectedTitle) || normExpectedTitle.includes(normFileBase))
      );

      if (bestDecision && (bestDecision.outcome === 'match' || bestDecision.outcome === 'provisional')) {
        evidence.push({ field: 'title', level: 'work', status: 'verified', expected: expectedTitle, observed: matchedObserved });
      } else if (minorTitleMismatch && filenameSupportsTitle) {
        evidence.push({ field: 'title', level: 'work', status: 'verified', expected: expectedTitle, observed: `${matchedObserved || opf.rawTitle || opf.title} (filename: ${fileBaseNoExt})` });
      } else {
        if (bestDecision?.conflicts.includes('incompatible_series_volume')) {
          conflicts.push('incompatible_series_volume');
        }
        conflicts.push('incompatible_title');
        evidence.push({ field: 'title', level: 'work', status: 'contradictory', expected: expectedTitle, observed: opf.rawTitle || opf.title });
        error = error || `EPUB title mismatch: expected "${expectedTitle}", got "${opf.rawTitle || opf.title}"`;
      }
    } else if (opf.title) {
      evidence.push({ field: 'title', level: 'work', status: 'verified', expected: expectedTitle, observed: opf.title });
    }

    // 2. Work author verification
    const opfAuthors = Array.isArray(opf.authors) && opf.authors.length ? opf.authors : (opf.author ? [opf.author] : []);
    if (opfAuthors.length > 0 && expectedAuthor && !ID.isAuthorMatch(opfAuthors, expectedAuthor)) {
      conflicts.push('incompatible_author');
      evidence.push({ field: 'author', level: 'work', status: 'contradictory', expected: expectedAuthor, observed: opf.author });
      error = error || `EPUB author mismatch: expected "${expectedAuthor}", got "${opf.author}"`;
    } else if (opfAuthors.length === 0 && expectedAuthor) {
      conflicts.push('missing_author');
      evidence.push({ field: 'author', level: 'work', status: 'unverified', expected: expectedAuthor, observed: null });
      error = error || `EPUB author metadata missing: could not verify "${expectedAuthor}"`;
    } else if (opfAuthors.length > 0) {
      evidence.push({ field: 'author', level: 'work', status: 'verified', expected: expectedAuthor, observed: opf.author });
    }

    // 3. Expression language verification via actual reading text across the EPUB spine
    const opfLangHint = ID.normalizeLanguageCode(opf.language);
    const releaseLangHint = ID.normalizeLanguageCode(task?.language);
    const samples = extractEpubReadingSamplesFromFile(task.filePath);
    languageAnalysis = identifyReadingLanguage(samples, normExpectedLang);

    if (languageAnalysis.status === 'verified') {
      evidence.push({
        field: 'language',
        level: 'expression',
        status: 'verified',
        expected: normExpectedLang,
        observed: languageAnalysis.detected,
        metadataHint: opfLangHint || releaseLangHint || null,
        passageCount: languageAnalysis.stats?.passageCount || 0,
        readableWords: languageAnalysis.stats?.effectiveWords || 0,
      });
    } else if (languageAnalysis.status === 'mismatch') {
      conflicts.push('language_mismatch');
      evidence.push({
        field: 'language',
        level: 'expression',
        status: 'contradictory',
        expected: normExpectedLang,
        observed: languageAnalysis.detected,
        metadataHint: opfLangHint || releaseLangHint || null,
        passageCount: languageAnalysis.stats?.passageCount || 0,
        readableWords: languageAnalysis.stats?.effectiveWords || 0,
      });
      error = error || `EPUB language mismatch: expected "${normExpectedLang}", detected "${languageAnalysis.detected}" in actual reading text (metadata hint: "${opf.language || task?.language || 'absent'}")`;
    } else {
      conflicts.push('insufficient_language_evidence');
      evidence.push({
        field: 'language',
        level: 'expression',
        status: 'insufficient_evidence',
        expected: normExpectedLang,
        observed: languageAnalysis.detected || null,
        metadataHint: opfLangHint || releaseLangHint || null,
        passageCount: languageAnalysis.stats?.passageCount || 0,
        readableWords: languageAnalysis.stats?.effectiveWords || 0,
      });
      error = error || `Insufficient readable text evidence in EPUB to verify language "${normExpectedLang}" (${languageAnalysis.stats?.effectiveWords || 0} readable words across ${languageAnalysis.stats?.passageCount || 0} passages; metadata hint "${opf.language || task?.language || 'absent'}" is not authoritative)`;
    }

    // 4. Positive-only ISBN observation (exact/counterpart match recorded as positive evidence; different/absent ISBN never blocks)
    const opfIsbns = Array.isArray(opf.isbns) ? opf.isbns : (opf.isbn ? [normalizeIsbnBridge(opf.isbn)].filter(Boolean) : []);
    if (validReqIsbn) {
      const matchedIsbn = opfIsbns.find((fi) =>
        ID.sameIsbn(validReqIsbn, fi) ||
        areVerifiedIsbnCounterpartsBridge(validReqIsbn, fi, task?.trustedIsbns, task?.bookMetadata, task?.extra?.bookMetadata)
      );
      if (matchedIsbn) {
        evidence.push({ field: 'isbn', level: 'edition', status: 'verified', expected: validReqIsbn, observed: matchedIsbn });
      } else if (opfIsbns.length > 0) {
        evidence.push({ field: 'isbn', level: 'edition', status: 'informational', expected: validReqIsbn, observed: opfIsbns[0] });
      } else {
        evidence.push({ field: 'isbn', level: 'edition', status: 'absent', expected: validReqIsbn, observed: null });
      }
    } else if (opfIsbns.length > 0) {
      evidence.push({ field: 'isbn', level: 'edition', status: 'informational', expected: null, observed: opfIsbns[0] });
    }

    // 5. Passive year observation only (never blocks or penalizes)
    const opfYears = Array.isArray(opf.years) ? opf.years : (opf.year ? [opf.year] : []);
    if (opfYears.length > 0) {
      evidence.push({ field: 'year', level: 'edition', status: 'informational', expected: null, observed: opf.year });
    }
  } else if (isPdf && task?.filePath && fs.existsSync(task.filePath)) {
    const pdfBuf = fs.readFileSync(task.filePath);
    const samples = extractPdfReadingSamples(pdfBuf);
    languageAnalysis = identifyReadingLanguage(samples, normExpectedLang);
    const releaseLangHint = ID.normalizeLanguageCode(task?.language);
    if (languageAnalysis.status === 'verified') {
      evidence.push({
        field: 'language',
        level: 'expression',
        status: 'verified',
        expected: normExpectedLang,
        observed: languageAnalysis.detected,
        metadataHint: releaseLangHint || null,
        passageCount: languageAnalysis.stats?.passageCount || 0,
        readableWords: languageAnalysis.stats?.effectiveWords || 0,
      });
    } else if (languageAnalysis.status === 'mismatch') {
      conflicts.push('language_mismatch');
      evidence.push({
        field: 'language',
        level: 'expression',
        status: 'contradictory',
        expected: normExpectedLang,
        observed: languageAnalysis.detected,
        metadataHint: releaseLangHint || null,
      });
      error = error || `PDF language mismatch: expected "${normExpectedLang}", detected "${languageAnalysis.detected}" in reading text`;
    } else {
      conflicts.push('insufficient_language_evidence');
      evidence.push({
        field: 'language',
        level: 'expression',
        status: 'insufficient_evidence',
        expected: normExpectedLang,
        observed: languageAnalysis.detected || null,
        metadataHint: releaseLangHint || null,
      });
      error = error || `Insufficient readable text evidence in PDF to verify language "${normExpectedLang}"`;
    }
  }

  const ok = conflicts.length === 0;
  const hardFailureSet = new Set(['incompatible_series_volume', 'incompatible_title', 'missing_title', 'incompatible_author', 'language_mismatch']);
  const hardConflict = conflicts.find((c) => hardFailureSet.has(c)) || null;
  const primaryConflict = hardConflict || conflicts[0] || null;
  const workOrLanguageFailure = Boolean(hardConflict);
  const languageReviewRequired = !ok && !workOrLanguageFailure && conflicts.includes('insufficient_language_evidence');

  let errorType = null;
  if (!ok) {
    if (workOrLanguageFailure) {
      errorType = 'finalization_failed';
    } else if (languageReviewRequired) {
      errorType = 'language_review_required';
    } else {
      errorType = 'review_required';
    }
  }
  return {
    ok,
    outcome: ok ? 'match' : (workOrLanguageFailure ? 'reject' : 'review'),
    errorType,
    primaryConflict,
    conflicts,
    evidence,
    error,
    isbnFailure: false,
    workOrLanguageFailure,
    languageReviewRequired,
    opf,
    languageAnalysis,
  };
}

export const verifyDownloadedBook = verifyDownloadedEdition;

function isHttpUrlBridge(value) {
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

function isOceanofPdfBridge(source, extraSource, url) {
  const blob = `${source || ''} ${extraSource || ''} ${url || ''}`.toLowerCase();
  return blob.includes('oceanofpdf');
}

function isValidOceanofPdfPageUrlBridge(url) {
  return isHttpUrlBridge(url) && String(url).toLowerCase().includes('oceanofpdf');
}

function resolveDefaultTokenCachePath() {
  if (process.env.BOOKORBIT_TOKEN_CACHE_PATH) return process.env.BOOKORBIT_TOKEN_CACHE_PATH;
  if (process.env.STATE_FILE_PATH) {
    return path.join(path.dirname(process.env.STATE_FILE_PATH), '.bookorbit-auth-token.json');
  }
  if (fs.existsSync('/data') && fs.statSync('/data').isDirectory()) {
    try {
      fs.accessSync('/data', fs.constants.W_OK);
      return '/data/.bookorbit-auth-token.json';
    } catch {}
  }
  const localCache = path.resolve(process.cwd(), '.bookorbit-auth-token.json');
  if (fs.existsSync(localCache)) {
    return localCache;
  }
  return null;
}

/**
 * Manages BookOrbit v3.5.0 authentication sessions, handling login,
 * proactive token renewal, session refresh, and JWT validation.
 */
export class BookOrbitAuthManager {
  constructor(options = {}) {
    this.baseUrl = (options.url || process.env.BOOKORBIT_URL || 'http://localhost:8080').replace(/\/$/, '');
    this.username = options.username || process.env.BOOKORBIT_USERNAME || '';
    this.password = options.password || process.env.BOOKORBIT_PASSWORD || '';
    this.token = options.token || process.env.BOOKORBIT_TOKEN || '';
    this.refreshToken = options.refreshToken || process.env.BOOKORBIT_REFRESH_TOKEN || '';
    this.apiKey = options.apiKey || process.env.BOOKORBIT_API_KEY || '';
    this.tokenCachePath = options.tokenCachePath !== undefined
      ? options.tokenCachePath
      : (options.cachePath !== undefined ? options.cachePath : resolveDefaultTokenCachePath());
    this.expiresAt = options.expiresAt || (this.token ? decodeJwtExp(this.token) : null);
    this.refreshBufferMs = options.refreshBufferMs || 5 * 60 * 1000; // Refresh 5m before expiry
    this.fetchFn = options.fetchFn || globalThis.fetch;
    this._authLock = null;
    this._loadCachedToken();
  }

  _loadCachedToken() {
    if (!this.tokenCachePath || typeof this.tokenCachePath !== 'string') return;
    try {
      if (fs.existsSync(this.tokenCachePath)) {
        const raw = fs.readFileSync(this.tokenCachePath, 'utf8');
        const data = JSON.parse(raw);
        if (data && data.token && isJwt(data.token)) {
          const exp = data.expiresAt || decodeJwtExp(data.token);
          if (exp && Date.now() < (exp - this.refreshBufferMs)) {
            const urlMatch = !data.baseUrl || (data.baseUrl.replace(/\/$/, '') === this.baseUrl);
            const userMatch = !this.username || !data.username || (data.username === this.username);
            if (urlMatch && userMatch) {
              if (!this.token || this.isTokenExpired()) {
                this.token = data.token;
                this.refreshToken = data.refreshToken || this.refreshToken;
                this.expiresAt = exp;
              }
            }
          }
        }
      }
    } catch {}
  }

  _saveCachedToken() {
    if (!this.tokenCachePath || typeof this.tokenCachePath !== 'string' || !this.token) return;
    try {
      const dir = path.dirname(this.tokenCachePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = {
        token: this.token,
        refreshToken: this.refreshToken,
        expiresAt: this.expiresAt,
        baseUrl: this.baseUrl,
        username: this.username,
        updatedAt: new Date().toISOString(),
      };
      const tmpPath = `${this.tokenCachePath}.tmp.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmpPath, this.tokenCachePath);
    } catch {}
  }

  isTokenExpired() {
    if (!this.token) return true;
    if (!this.expiresAt) {
      this.expiresAt = decodeJwtExp(this.token);
    }
    if (!this.expiresAt) return true;
    return Date.now() >= (this.expiresAt - this.refreshBufferMs);
  }

  async login() {
    while (this._authLock) await this._authLock;
    let __resolveLock;
    this._authLock = new Promise((r) => { __resolveLock = r; });
    try {
    if (!this.username || !this.password) {
      if (this.token) {
        return this.token;
      }
      if (this.apiKey) {
        this.token = this.apiKey;
        return this.token;
      }
      throw new Error('BookOrbit credentials missing: provide BOOKORBIT_USERNAME and BOOKORBIT_PASSWORD or BOOKORBIT_TOKEN or BOOKORBIT_API_KEY');
    }

    const payload = {
      username: this.username,
      password: this.password,
      clientKind: 'native',
    };

    const res = await this.fetchFn(`${this.baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      if (res.status === 429) {
        this._loadCachedToken();
        if (this.token && !this.isTokenExpired()) {
          console.warn('[BookOrbitAuthManager] BookOrbit login rate-limited (HTTP 429); reusing valid cached session.');
          return this.token;
        }
      }
      const errText = await res.text().catch(() => '');
      throw new Error(`BookOrbit login failed (HTTP ${res.status})`);
    }

    const data = await res.json().catch(() => ({}));
    const newToken = data.token || data.accessToken || data.jwt;
    if (!newToken) {
      throw new Error('BookOrbit login succeeded but no token was returned');
    }

    this.token = newToken;
    this.refreshToken = data.refreshToken || this.refreshToken;
    this.expiresAt = (data.accessTokenExpiresAt || data.expiresAt) ? new Date(data.accessTokenExpiresAt || data.expiresAt).getTime() : decodeJwtExp(newToken);
    this._saveCachedToken();
    return this.token;
    } finally {
      this._authLock = null;
      if (__resolveLock) __resolveLock();
    }
  }

  async refreshSession() {
    while (this._authLock) await this._authLock;
    let __resolveLock;
    this._authLock = new Promise((r) => { __resolveLock = r; });
    try {
    if (this.refreshToken) {
      try {
        const res = await this.fetchFn(`${this.baseUrl}/api/v1/auth/refresh`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ refreshToken: this.refreshToken }),
        });

        if (res.ok) {
          const data = await res.json().catch(() => ({}));
          const newToken = data.token || data.accessToken || data.jwt;
          if (newToken) {
            this.token = newToken;
            this.refreshToken = data.refreshToken || this.refreshToken;
            this.expiresAt = (data.accessTokenExpiresAt || data.expiresAt) ? new Date(data.accessTokenExpiresAt || data.expiresAt).getTime() : decodeJwtExp(newToken);
            this._saveCachedToken();
            return this.token;
          }
        }
      } catch (err) {
        console.warn(`[AuthManager] Token refresh request error: ${sanitizeLog(err.message)}`);
      }
    }

    if (this.username && this.password) {
      return this.login();
    }

    return this.token;
    } finally {
      this._authLock = null;
      if (__resolveLock) __resolveLock();
    }
  }

  async getValidToken() {
    if (this.isTokenExpired()) {
      this._loadCachedToken();
    }
    if (this.isTokenExpired()) {
      if (this.refreshToken) {
        try {
          return await this.refreshSession();
        } catch {}
      }
      if (this.username && this.password) {
        return await this.login();
      }
    }
    return this.token;
  }
}

const MIN_PING_INTERVAL_MS = 1000;
const MAX_PING_INTERVAL_MS = 300000;
const MIN_PING_TIMEOUT_MS = 1000;
const MAX_PING_TIMEOUT_MS = 300000;
const DEFAULT_PING_INTERVAL_MS = 25000;
const DEFAULT_PING_TIMEOUT_MS = 20000;
const MIN_ALLOWED_SILENCE_MS = 2000;
const MAX_ALLOWED_SILENCE_MS = 600000;

/**
 * Lightweight, zero-dependency Socket.IO v4 client connecting to BookOrbit's
 * `/book-requests` WebSocket gateway using native Node.js WebSocket.
 */
export class BookOrbitSocketClient {
  constructor(options = {}) {
    this.baseUrl = (options.url || 'http://localhost:8080').replace(/\/$/, '');
    this.token = options.token || '';
    this.getTokenFn = options.getTokenFn || null;
    this.authManager = options.authManager || null;
    this.ws = null;
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.reconnectDelayMs = 1000;
    this.maxReconnectDelayMs = 30000;
    this.isClosed = false;
    this.isConnected = false;
    this.changeListeners = new Set();
    this.connectListeners = new Set();
    this.disconnectListeners = new Set();
  }

  onChange(fn) { this.changeListeners.add(fn); }
  onConnect(fn) { this.connectListeners.add(fn); }
  onDisconnect(fn) { this.disconnectListeners.add(fn); }

  async connect() {
    this.isClosed = false;
    if (this.authManager) {
      try {
        const refreshed = await this.authManager.getValidToken();
        if (refreshed) this.token = refreshed;
      } catch (err) {
        console.warn(`[SocketClient] Auth manager token acquisition failed: ${sanitizeLog(err.message)}`);
      }
    } else if (this.getTokenFn) {
      try {
        const refreshed = await this.getTokenFn();
        if (refreshed) this.token = refreshed;
      } catch (err) {
        console.warn(`[SocketClient] Token refresh failed: ${sanitizeLog(err.message)}`);
      }
    }

    if (this.token && !isJwt(this.token)) {
      console.warn('[SocketClient] Notice: Configured token is not in JWT format. BookOrbit gateway requires a session JWT.');
    }

    let wsProto = this.baseUrl.startsWith('https') ? 'wss' : 'ws';
    let wsHost = this.baseUrl;
    let wsPathPrefix = '';
    try {
      const u = new URL(this.baseUrl);
      wsProto = u.protocol === 'https:' ? 'wss' : 'ws';
      wsHost = u.host;
      wsPathPrefix = u.pathname.replace(/\/+$/, '');
    } catch {
      wsProto = this.baseUrl.startsWith('https') ? 'wss' : 'ws';
      wsHost = this.baseUrl.replace(/^https?:\/\//, '').replace(/\/.*/, '');
    }
    const wsUrl = `${wsProto}://${wsHost}${wsPathPrefix}/socket.io/?EIO=4&transport=websocket`;

    try {
      this.ws = new WebSocket(wsUrl);
    } catch (err) {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {};

    this.ws.onmessage = (event) => {
      const data = typeof event.data === 'string' ? event.data : event.data.toString();
      this.handlePacket(data);
    };

    this.ws.onerror = (err) => {
      console.warn(`[SocketClient] WebSocket error: ${sanitizeLog(err.message || 'connection failed')}`);
    };

    this.ws.onclose = () => {
      this.isConnected = false;
      this.clearPingTimer();
      for (const fn of this.disconnectListeners) {
        try { fn(); } catch {}
      }
      if (!this.isClosed) {
        this.scheduleReconnect();
      }
    };
  }

  handlePacket(data) {
    if (!data) return;

    // Engine.IO packet 0: Handshake open
    if (data.startsWith('0')) {
      try {
        const handshake = JSON.parse(data.slice(1));
        const pingInterval = handshake.pingInterval || 25000;
        const pingTimeout = handshake.pingTimeout || 20000;
        this.resetHeartbeatWatchdog(pingInterval, pingTimeout);

        // Send Socket.IO connect packet for /book-requests namespace with auth token
        const connectPacket = `40/book-requests,${JSON.stringify({ token: this.token })}`;
        this.ws.send(connectPacket);
      } catch {}
      return;
    }

    // Engine.IO packet 2: Ping from server -> reply with Pong ('3') and reset watchdog
    if (data === '2') {
      try { this.ws.send('3'); } catch {}
      this.resetHeartbeatWatchdog();
      return;
    }

    // Engine.IO packet 3: Pong from server
    if (data === '3') {
      this.resetHeartbeatWatchdog();
      return;
    }

    // Socket.IO packet 40/book-requests: Connected to namespace
    if (data.startsWith('40/book-requests')) {
      this.isConnected = true;
      this.reconnectDelayMs = 1000; // Reset backoff
      for (const fn of this.connectListeners) {
        try { fn(); } catch {}
      }
      return;
    }

    // Socket.IO packet 44/book-requests: Connect error (e.g. Unauthorized / expired token)
    if (data.startsWith('44/book-requests')) {
      console.warn(`[SocketClient] Gateway auth refused: ${sanitizeLog(data)}`);
      try { this.ws.close(); } catch {}
      this.isConnected = false;
      this.clearPingTimer();
      if (this.authManager) {
        this.authManager.refreshSession().catch(() => {});
      }
      this.scheduleReconnect();
      return;
    }

    // Socket.IO packet 42/book-requests: Event broadcast
    if (data.startsWith('42/book-requests')) {
      try {
        const commaIdx = data.indexOf('[');
        if (commaIdx !== -1) {
          const payload = JSON.parse(data.slice(commaIdx));
          const eventName = payload[0];
          if (eventName === 'book-requests:changed') {
            for (const fn of this.changeListeners) {
              try { fn(); } catch {}
            }
          }
        }
      } catch {}
      return;
    }
  }

  /**
   * Engine.IO v4 heartbeat watchdog:
   * The server sends PING ('2') every pingInterval ms.
   * Client replies with PONG ('3').
   * If no server PING is received within (pingInterval + pingTimeout) ms,
   * the client marks the connection dead and schedules reconnect.
   * The client NEVER sends unsolicited PING ('2') packets in Engine.IO v4.
   */
  resetHeartbeatWatchdog(interval = this.pingInterval, timeout = this.pingTimeout) {
    const rawInterval = Number(interval);
    const rawTimeout = Number(timeout);

    const sanitizedInterval = Number.isFinite(rawInterval)
      ? Math.min(MAX_PING_INTERVAL_MS, Math.max(MIN_PING_INTERVAL_MS, Math.trunc(rawInterval)))
      : DEFAULT_PING_INTERVAL_MS;
    const sanitizedTimeout = Number.isFinite(rawTimeout)
      ? Math.min(MAX_PING_TIMEOUT_MS, Math.max(MIN_PING_TIMEOUT_MS, Math.trunc(rawTimeout)))
      : DEFAULT_PING_TIMEOUT_MS;

    this.pingInterval = sanitizedInterval;
    this.pingTimeout = sanitizedTimeout;

    this.clearPingTimer();

    this._allowedSilenceMs = (Number.isFinite(rawInterval) && Number.isFinite(rawTimeout))
      ? Math.min(MAX_ALLOWED_SILENCE_MS, Math.max(MIN_ALLOWED_SILENCE_MS, sanitizedInterval + sanitizedTimeout))
      : Math.min(MAX_ALLOWED_SILENCE_MS, Math.max(MIN_ALLOWED_SILENCE_MS, DEFAULT_PING_INTERVAL_MS + DEFAULT_PING_TIMEOUT_MS));

    this.pingTimer = setTimeout(() => {
      console.warn('[SocketClient] Server heartbeat timeout (no ping received). Reconnecting...');
      this.isConnected = false;
      if (this.ws) {
        try { this.ws.close(); } catch {}
      }
    }, this._allowedSilenceMs);
    if (this.pingTimer.unref) this.pingTimer.unref();
  }

  setupPing(interval) {
    // Engine.IO v4 compatibility: monitor server heartbeat without sending unsolicited pings
    this.resetHeartbeatWatchdog(interval);
  }

  clearPingTimer() {
    if (this.pingTimer) {
      clearTimeout(this.pingTimer);
      this.pingTimer = null;
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.isClosed) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 1.5, this.maxReconnectDelayMs);
      this.connect();
    }, this.reconnectDelayMs);
    if (this.reconnectTimer.unref) this.reconnectTimer.unref();
  }

  close() {
    this.isClosed = true;
    this.clearPingTimer();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
  }
}

export class BridgeService {
  constructor(options = {}) {
    this.stateFilePath = options.stateFilePath || path.resolve(process.cwd(), '.bridge-state.json');
    this.secret = options.secret || process.env.BRIDGE_SECRET || 'bookorbit-shelfmark-secret';
    this.host = options.host || process.env.BRIDGE_HOST || '127.0.0.1';
    this.bookorbitUrl = (options.bookorbitUrl || process.env.BOOKORBIT_URL || 'http://localhost:8080').replace(/\/$/, '');
    this.bookorbitApiKey = options.bookorbitApiKey || process.env.BOOKORBIT_API_KEY || '';
    this.bookorbitToken = options.bookorbitToken || process.env.BOOKORBIT_TOKEN || '';
    this.shelfmarkUrl = (options.shelfmarkUrl || process.env.SHELFMARK_URL || 'http://localhost:8084').replace(/\/$/, '');
    this.shelfmarkApiKey = options.shelfmarkApiKey || process.env.SHELFMARK_API_KEY || '';
    this.defaultLibraryId = options.defaultLibraryId !== undefined ? options.defaultLibraryId : parsePositiveInt(process.env.BOOKORBIT_DEFAULT_LIBRARY_ID);
    this.defaultFolderId = options.defaultFolderId !== undefined ? options.defaultFolderId : parsePositiveInt(process.env.BOOKORBIT_DEFAULT_FOLDER_ID);
    this.dockReadinessAttempts = options.dockReadinessAttempts || 25;
    this.dockReadinessIntervalMs = options.dockReadinessIntervalMs || 100;
    const envInterval = parsePositiveInt(process.env.RECONCILE_INTERVAL_MS);
    this.reconcileIntervalMs = options.reconcileIntervalMs || envInterval || 15 * 60 * 1000; // 15 minutes
    this.fileVisibilityAttempts = options.fileVisibilityAttempts ?? 10;
    this.fileVisibilityDelayMs = options.fileVisibilityDelayMs ?? 200;
    this.fileVisibilityBackoff = options.fileVisibilityBackoff ?? 1.5;
    this.releaseFailureCooldownMs = options.releaseFailureCooldownMs ?? (60 * 60 * 1000); // 1 hour cooldown
    this.maxSourceAttempts = options.maxSourceAttempts ?? 3; // Maximum bounded attempts per request
    this._fulfillLocks = new Map();
    this._workLock = Promise.resolve();
    this._finalizationPromises = new Map();

    // Path translation & containment
    this.shelfmarkPathPrefix = options.shelfmarkPathPrefix || process.env.SHELFMARK_PATH_PREFIX || '';
    this.localPathPrefix = options.localPathPrefix || process.env.LOCAL_PATH_PREFIX || '';
    this.allowedBaseDirs = options.allowedBaseDirs || [
      process.cwd(),
      '/staging',
      '/downloads',
      '/tmp',
      '/books',
      '/data',
    ];

    // BookOrbit Authentication Session Manager
    const defaultTokenCachePath = this.stateFilePath
      ? path.join(path.dirname(this.stateFilePath), '.bookorbit-auth-token.json')
      : resolveDefaultTokenCachePath();
    this.authManager = options.authManager || new BookOrbitAuthManager({
      url: this.bookorbitUrl,
      username: options.bookorbitUsername || process.env.BOOKORBIT_USERNAME || '',
      password: options.bookorbitPassword || process.env.BOOKORBIT_PASSWORD || '',
      token: options.bookorbitToken || process.env.BOOKORBIT_TOKEN || '',
      refreshToken: options.bookorbitRefreshToken || process.env.BOOKORBIT_REFRESH_TOKEN || '',
      apiKey: options.bookorbitApiKey || process.env.BOOKORBIT_API_KEY || '',
      tokenCachePath: options.tokenCachePath || defaultTokenCachePath,
      fetchFn: options.fetchFn,
    });

    // In-memory state cache
    this.state = {
      tasks: {},              // taskId -> TaskRecord
      requests: {},           // requestId -> taskId
      releases: {},           // releaseKey -> taskId
      baselineRequestIds: {}, // requestId -> true
      baselineEstablishedAt: null,
      uncertainQueues: {},    // releaseKey -> UncertainRecord
      failedReleases: {},     // releaseKey -> { releaseKey, source, sourceId, failedAt, error }
      requestSourceAttempts: {}, // requestId -> count
      requestAttempts: {},    // requestId -> [ { attemptId, taskId, releaseKey, ... } ]
      requestErrors: {},      // requestId -> { error, errorType, lastAttemptAt, attempts }
      requestProgress: {},    // requestId -> { stage, status, updatedAt, ... }
      requestStages: {},      // alias for requestProgress
      requestStatus: {},      // alias for requestProgress
       requestFailureReasons: {}, // requestId -> reason
       requestCandidateCounts: {}, // requestId -> { metadataCandidateCount, releaseCandidateCount }
       requestMetadataCandidateCounts: {}, // requestId -> number
       requestReleaseCandidateCounts: {}, // requestId -> number
       requestCandidateRejectionReasons: {}, // requestId -> { reason: count }
       requestVerification: {}, // requestId -> { ok, taskId, releaseKey, stage, errorType, primaryConflict, conflicts, evidence, error, verifiedAt }
       requestTasks: {},        // requestId -> taskId (historical task association preserved across failures)
       rejectedRequests: {},    // requestId -> { rejectedAt, decisionNote, reason }
     };

    this.reconcileTimer = null;
    this.debounceTimer = null;
    this.isProcessingRequests = false;
    this.isReconciling = false;
    this.isInitializingBaseline = false;
    this.isQueueingRelease = false;
    this.socketClient = null;

    this.loadState();
  }

  /**
   * Loads state from disk safely.
   */
  loadState() {
    try {
      if (fs.existsSync(this.stateFilePath)) {
        const raw = fs.readFileSync(this.stateFilePath, 'utf8');
        const parsed = JSON.parse(raw);
        const loadedTasks = parsed.tasks || {};
        for (const task of Object.values(loadedTasks)) {
          if (!Array.isArray(task.requestIds)) task.requestIds = [];
          if (!Array.isArray(task.userIds)) task.userIds = [];
          if (!task.requestFulfillments || typeof task.requestFulfillments !== 'object' || Array.isArray(task.requestFulfillments)) task.requestFulfillments = {};
          if (!task.progress || typeof task.progress !== 'object' || Array.isArray(task.progress)) task.progress = {};
        }
        this.state = {
          tasks: loadedTasks,
          requests: parsed.requests || {},
          releases: parsed.releases || {},
          baselineRequestIds: parsed.baselineRequestIds || {},
          baselineEstablishedAt: parsed.baselineEstablishedAt || null,
          uncertainQueues: (function () {
            const uq = parsed.uncertainQueues || {};
            for (const rec of Object.values(uq)) {
              if (rec && !Array.isArray(rec.requestIds)) {
                rec.requestIds = rec.requestId ? [rec.requestId] : [];
              }
              if (rec && !Array.isArray(rec.userIds) && rec.userId) {
                rec.userIds = [rec.userId];
              }
            }
            return uq;
          })(),
          failedReleases: parsed.failedReleases || {},
          requestSourceAttempts: parsed.requestSourceAttempts || {},
          requestAttempts: parsed.requestAttempts || {},
          requestErrors: parsed.requestErrors || {},
          requestProgress: { ...(parsed.requestProgress || {}), ...(parsed.requestStages || {}), ...(parsed.requestStatus || {}) },
          requestStages: { ...(parsed.requestStages || {}), ...(parsed.requestProgress || {}), ...(parsed.requestStatus || {}) },
          requestStatus: { ...(parsed.requestStatus || {}), ...(parsed.requestProgress || {}), ...(parsed.requestStages || {}) },
           requestFailureReasons: parsed.requestFailureReasons || {},
           requestCandidateCounts: parsed.requestCandidateCounts || {},
           requestMetadataCandidateCounts: parsed.requestMetadataCandidateCounts || {},
           requestReleaseCandidateCounts: parsed.requestReleaseCandidateCounts || {},
           requestCandidateRejectionReasons: parsed.requestCandidateRejectionReasons || {},
           requestVerification: parsed.requestVerification || {},
           requestTasks: parsed.requestTasks || {},
           rejectedRequests: parsed.rejectedRequests || {},
         };
      }
    } catch (err) {
      console.warn(`[Bridge] Warning: Failed to read state file: ${sanitizeLog(err.message)}. Starting fresh.`);
    }
  }

  /**
   * Persists state to disk atomically using a temporary file.
   * Returns true on success, false on failure.
   */
  saveState() {
    try {
      const dir = path.dirname(this.stateFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const tmpPath = `${this.stateFilePath}.tmp.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
      fs.writeFileSync(tmpPath, JSON.stringify(this.state, null, 2), 'utf8');
      fs.renameSync(tmpPath, this.stateFilePath);
      return true;
    } catch (err) {
      console.error(`[Bridge] Error: Failed to save state to ${this.stateFilePath}: ${sanitizeLog(err.message)}`);
      return false;
    }
  }

  /**
   * On first startup, enumerates all pre-existing BookOrbit requests across all
   * pages to establish a baseline. Historical requests in this baseline are never queued.
   * Fails closed: never marks the baseline established unless all pages have been
   * fetched successfully and durable state persistence succeeds.
   */
  async initializeBaseline({ fetchFn = globalThis.fetch } = {}) {
    if (this.state.baselineEstablishedAt) {
      return { established: true, count: Object.keys(this.state.baselineRequestIds || {}).length };
    }
    if (this.isInitializingBaseline) {
      return { established: false, count: 0 };
    }
    this.isInitializingBaseline = true;
    try {

    console.log('[Bridge] First-run: Establishing baseline of existing historical BookOrbit requests...');
    let token = '';
    try {
      token = await this.authManager.getValidToken();
    } catch {}
    token = token || this.bookorbitToken || this.bookorbitApiKey;

    const headers = {
      ...(token && isJwt(token) ? { 'Authorization': `Bearer ${token}` } : {}),
      ...(this.bookorbitApiKey ? { 'X-Api-Key': this.bookorbitApiKey } : {}),
    };

    let page = 1;
    const limit = 50;
    let total = Infinity;
    let count = 0;
    const collectedIds = [];

    while (count < total) {
      const url = `${this.bookorbitUrl}/api/v1/admin/book-requests?page=${page}&limit=${limit}`;
      let res;
      try {
        res = await fetchFn(url, { headers });
      } catch (err) {
        console.warn(`[Bridge] Failed to fetch baseline page ${page}: ${sanitizeLog(err.message)}`);
        return { established: false, count, error: `Network error on page ${page}: ${err.message}` };
      }

      if (!res.ok) {
        console.warn(`[Bridge] Baseline enumeration returned HTTP ${res.status} on page ${page}`);
        return { established: false, count, error: `HTTP ${res.status} on page ${page}` };
      }

      let data;
      try {
        data = await res.json();
      } catch (err) {
        console.warn(`[Bridge] Failed to parse baseline JSON page ${page}: ${sanitizeLog(err.message)}`);
        return { established: false, count, error: `Malformed JSON on page ${page}: ${err.message}` };
      }

      const items = Array.isArray(data) ? data : data.items || [];
      if (typeof data.total === 'number') {
        total = data.total;
      }

      if (items.length === 0) {
        if (total !== Infinity && count < total) {
          console.warn(`[Bridge] Baseline enumeration partial: expected ${total}, received 0 items on page ${page} (collected ${count})`);
          return { established: false, count, error: `Partial pagination: expected total ${total}, got ${count}` };
        }
        break;
      }

      for (const item of items) {
        const itemId = item?.id ?? item?.requestId ?? item?.request_id ?? item?.taskId ?? item?.task_id;
        if (itemId !== undefined && itemId !== null) {
          collectedIds.push(itemId);
          count++;
        }
      }

      if (count >= total) break;
      if (Array.isArray(data) && items.length < limit) break;

      page++;
    }

    if (total !== Infinity && count < total) {
      console.warn(`[Bridge] Baseline enumeration partial: collected ${count} of ${total} requests`);
      return { established: false, count, error: `Partial pagination: expected total ${total}, got ${count}` };
    }

    // Populate baseline IDs only after complete successful pagination
    for (const id of collectedIds) {
      this.state.baselineRequestIds[id] = true;
    }

    const baselineTimestamp = new Date().toISOString();
    this.state.baselineEstablishedAt = baselineTimestamp;

    const saved = this.saveState();
    if (!saved) {
      // Revert in-memory baseline state on persistence failure!
      this.state.baselineEstablishedAt = null;
      for (const id of collectedIds) {
        delete this.state.baselineRequestIds[id];
      }
      console.error('[Bridge] Failed to persist baseline state to disk');
      return { established: false, count, error: 'Persistence failure' };
    }

    console.log(`[Bridge] First-run baseline established with ${count} existing requests. Historical backlog will not be processed.`);
    return { established: true, count };
    } finally {
      this.isInitializingBaseline = false;
    }
  }

  /**
   * Translates Shelfmark container path to local filesystem path with
   * symlink-safe canonical path containment.
   */
  resolvePath(rawPath) {
    if (!rawPath || typeof rawPath !== 'string') return null;
    if (rawPath.includes('\0')) return null;

    let candidate = rawPath;
    // Only translate absolute Shelfmark container paths; relative inputs are not allowed
    // because resolving them against the process cwd weakens containment guarantees.
    if (this.shelfmarkPathPrefix && this.localPathPrefix && path.isAbsolute(candidate)) {
      const prefix = this.shelfmarkPathPrefix.replace(/\/+$/, '');
      if (candidate === prefix || candidate.startsWith(prefix + '/') || candidate.startsWith(prefix + path.sep)) {
        candidate = path.join(this.localPathPrefix, candidate.slice(prefix.length).replace(/^[/\\]/, ''));
      }
    }

    if (!path.isAbsolute(candidate)) {
      return null;
    }

    const resolved = path.resolve(candidate);
    if (!fs.existsSync(resolved)) return null;

    let real;
    try {
      real = fs.realpathSync(resolved);
    } catch {
      return null;
    }

    if (this.allowedBaseDirs && this.allowedBaseDirs.length > 0) {
      const isAllowed = this.allowedBaseDirs.some((base) => {
        let canonicalBase;
        try {
          canonicalBase = fs.realpathSync(path.resolve(base));
        } catch {
          return false;
        }
        return real === canonicalBase || real.startsWith(canonicalBase + path.sep);
      });

      if (!isAllowed) {
        console.warn(`[Bridge] Access denied: Path ${real} escapes allowed base directories.`);
        return null;
      }
    }

    return real;
  }

  /**
   * Derives a canonical deduplication key for a release candidate.
   */
  getReleaseKey(release) {
    if (!release) return null;
    if (release.guid) {
      try {
        const parsed = typeof release.guid === 'string' ? JSON.parse(release.guid) : release.guid;
        if (parsed.source && parsed.source_id) {
          return `${parsed.source}:${parsed.source_id}`;
        }
      } catch {}
    }
    const source = release.source || release.extra?.source;
    const sourceId = release.sourceId || release.source_id || release.extra?.sourceId || release.extra?.source_id || release.id;
    if (source && sourceId) {
      return `${source}:${sourceId}`;
    }
    const title = (release.title || '').trim().toLowerCase();
    const format = (release.format || '').trim().toLowerCase();
    const year = release.year || release.publicationYear || release.publishedYear || '';
    const isbn = (release.isbn13 || release.isbn || '').replace(/[^0-9X]/gi, '');
    const parts = [title];
    if (year) parts.push(year);
    if (isbn) parts.push(isbn);
    parts.push(format);
    return parts.join('::');
  }

  /**
   * Verifies file existence, size, and magic bytes.
   */
  verifyFile(rawFilePath, expectedFormat) {
    const safePath = this.resolvePath(rawFilePath);
    if (!safePath) {
      return { ok: false, notFound: true, error: `Invalid or disallowed file path: ${rawFilePath}` };
    }
    let stats;
    try {
      stats = fs.statSync(safePath);
    } catch (err) {
      return { ok: false, notFound: true, error: `Failed to stat file: ${err.message}` };
    }

    if (stats.isDirectory()) {
      return { ok: false, notFound: true, error: `Path is a directory, not a file: ${safePath}` };
    }

    if (stats.size === 0) {
      return { ok: false, notFound: true, error: `File is 0 bytes: ${safePath}` };
    }

    const fmt = (expectedFormat || path.extname(safePath).replace('.', '')).toLowerCase();
    const expectedMagic = MAGIC_BYTES[fmt];
    if (expectedMagic) {
      let fd;
      try {
        fd = fs.openSync(safePath, 'r');
        const buffer = Buffer.alloc(expectedMagic.length);
        const bytesRead = fs.readSync(fd, buffer, 0, expectedMagic.length, 0);
        fs.closeSync(fd);

        if (bytesRead < expectedMagic.length) {
          return { ok: false, error: `File header too short (${bytesRead} bytes)` };
        }
        for (let i = 0; i < expectedMagic.length; i++) {
          if (buffer[i] !== expectedMagic[i]) {
            return {
              ok: false,
              error: `Invalid file signature for ${fmt}. Expected [${expectedMagic.join(',')}], got [${buffer.join(',')}]`,
            };
          }
        }
      } catch (err) {
        if (fd) {
          try { fs.closeSync(fd); } catch {}
        }
        return { ok: false, error: `Failed to verify magic bytes: ${err.message}` };
      }
    }

    let epubMeta = null;
    if (fmt === 'epub') {
      epubMeta = extractEpubMetadataFromFile(safePath);
    }

    return { ok: true, safePath, sizeBytes: stats.size, epubMeta };
  }

  /**
   * Verifies file with bounded retries and exponential backoff.
   * Handles transient missing-file or filesystem-visibility delays across container mounts
   * without loosening canonical path containment or magic byte checks.
   */
  async verifyFileWithRetry(rawFilePath, expectedFormat, {
    attempts = this.fileVisibilityAttempts,
    delayMs = this.fileVisibilityDelayMs,
    backoff = this.fileVisibilityBackoff,
  } = {}) {
    let lastResult = null;
    let currentDelay = delayMs;
    for (let attempt = 0; attempt < attempts; attempt++) {
      lastResult = this.verifyFile(rawFilePath, expectedFormat);
      if (lastResult.ok) {
        return lastResult;
      }
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, currentDelay));
        currentDelay = Math.round(currentDelay * backoff);
      }
    }
    return lastResult;
  }

  /**
   * Connects to BookOrbit Socket.IO gateway and hooks into book-requests:changed.
   */
  startSocketListener() {
    this.socketClient = new BookOrbitSocketClient({
      url: this.bookorbitUrl,
      token: this.bookorbitToken || this.bookorbitApiKey,
      authManager: this.authManager,
      getTokenFn: async () => {
        return this.authManager.getValidToken();
      },
    });

    this.socketClient.onConnect(() => {
      console.log('[Bridge] Connected to BookOrbit /book-requests Socket.IO gateway.');
      this.triggerProcessPendingRequests(0);
    });

    this.socketClient.onChange(() => {
      console.log('[Bridge] Received book-requests:changed broadcast from BookOrbit.');
      this.triggerProcessPendingRequests(500);
    });

    this.socketClient.connect();
  }

  /**
   * Debounces pending request processing.
   */
  triggerProcessPendingRequests(delayMs = 500) {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.processPendingRequests().catch((err) => {
        console.warn(`[Bridge] Request processing error: ${sanitizeLog(err.message)}`);
      });
    }, delayMs);
    if (this.debounceTimer.unref) this.debounceTimer.unref();
  }

   setRequestProgress(reqId, stage, details = {}) {
     if (!reqId) return;
     const prev = this.state.requestProgress?.[reqId] || {};
     const counts = {
       metadataCandidateCount: details.metadataCandidateCount ?? prev.metadataCandidateCount ?? this.state.requestMetadataCandidateCounts?.[reqId],
       releaseCandidateCount: details.releaseCandidateCount ?? prev.releaseCandidateCount ?? this.state.requestReleaseCandidateCounts?.[reqId],
       candidateRejectionReasonCounts: details.candidateRejectionReasonCounts ?? prev.candidateRejectionReasonCounts ?? this.state.requestCandidateRejectionReasons?.[reqId],
     };
     const mergedDetails = { ...counts, ...details };
     // drop undefined count fields
     for (const k of ['metadataCandidateCount','releaseCandidateCount','candidateRejectionReasonCounts']) {
       if (mergedDetails[k] === undefined) delete mergedDetails[k];
     }
     const entry = {
       stage,
       status: stage,
       updatedAt: new Date().toISOString(),
       ...mergedDetails,
     };
     this.state.requestProgress = this.state.requestProgress || {};
     this.state.requestStages = this.state.requestStages || {};
     this.state.requestStatus = this.state.requestStatus || {};
     this.state.requestProgress[reqId] = entry;
     this.state.requestStages[reqId] = entry;
     this.state.requestStatus[reqId] = entry;
     const transitionReason = (details && (details.error || details.reason)) ? (details.error || details.reason) : stage;
    this.state.requestFailureReasons = this.state.requestFailureReasons || {};
    this.state.requestFailureReasons[reqId] = transitionReason;
    this.saveState();
  }

  async getRequestStatus(reqId, fetchFn = globalThis.fetch) {
    if (!reqId) return 'unknown';
    let token = '';
    try { token = await this.authManager.getValidToken(); } catch {}
    token = token || this.bookorbitToken || this.bookorbitApiKey;
    const headers = {
      ...(token && isJwt(token) ? { 'Authorization': `Bearer ${token}` } : {}),
      ...(this.bookorbitApiKey ? { 'X-Api-Key': this.bookorbitApiKey } : (token && !isJwt(token) ? { 'X-Api-Key': token } : {})),
    };

    // 1. Try BookOrbit v3.5.0's valid individual request endpoint when authorized.
    try {
      const res = await fetchFn(`${this.bookorbitUrl}/api/v1/book-requests/${encodeURIComponent(reqId)}`, { headers });
      if (res && res.ok) {
        const data = await res.json().catch(() => ({}));
        const status = String(data.status || data.state || data.requestStatus || data.request_status || '').toLowerCase();
        if (status === 'cancelled' || status === 'canceled' || status === 'rejected') return 'cancelled';
        if (!status) return 'unknown';
        if (['approved', 'active', 'pending', 'searching', 'queued', 'downloading', 'resolving', 'locating', 'grabbed', 'importing', 'needs_review'].includes(status)) return 'active';
        if (['completed', 'fulfilled', 'available', 'done', 'success'].includes(status)) return 'fulfilled';
        return status;
      }
    } catch (e) {
      console.warn(`[Bridge] Individual request lookup failed: ${sanitizeLog(e?.message || e)}`);
      // Fall through to administrative list fallback
    }

    // 2. Reliable fallback to the administrative list (requires ManageBookRequests).
    try {
      let page = 1;
      const limit = 100;
      while (page <= 10) {
        const res = await fetchFn(`${this.bookorbitUrl}/api/v1/admin/book-requests?page=${page}&limit=${limit}`, { headers });
        if (!res || !res.ok) return 'unknown';
        const data = await res.json().catch(() => ({}));
        const items = Array.isArray(data) ? data : (data.items || data.results || data.books || []);
        const found = items.find((r) => String(r?.id ?? r?.requestId ?? r?.request_id ?? r?.taskId ?? r?.task_id) === String(reqId));
        if (found) {
          const status = String(found.status || found.state || found.requestStatus || found.request_status || '').toLowerCase();
          if (status === 'cancelled' || status === 'canceled' || status === 'rejected') return 'cancelled';
          if (!status) return 'unknown';
          if (['approved', 'active', 'pending', 'searching', 'queued', 'downloading', 'resolving', 'locating', 'grabbed', 'importing', 'needs_review'].includes(status)) return 'active';
          if (['completed', 'fulfilled', 'available', 'done', 'success'].includes(status)) return 'fulfilled';
          return status;
        }
        if (items.length < limit) break;
        page++;
      }
    } catch (e) {
      console.warn(`[Bridge] Administrative request lookup failed: ${sanitizeLog(e?.message || e)}`);
      // Lookup failed; never treat as active
    }
    return 'unknown';
  }

  async isRequestCancelled(reqId, fetchFn = globalThis.fetch) {
    const status = await this.getRequestStatus(reqId, fetchFn);
    return status === 'cancelled' || status === 'canceled';
  }

  async getRequestState(reqId, fetchFn = globalThis.fetch) {
    return this.getRequestStatus(reqId, fetchFn);
  }

  async classifyRequestStatus(reqId, fetchFn = globalThis.fetch) {
    return this.getRequestStatus(reqId, fetchFn);
  }

  /**
   * Terminal rejection in BookOrbit when a request completely exhausts all attempts.
   * Calls POST /api/v1/admin/book-requests/:id/reject with diagnostic decisionNote.
   */
  async rejectBookOrbitRequest(requestId, details = {}, fetchFn = globalThis.fetch) {
    const reqIdStr = String(requestId);
    if (!reqIdStr || this.state.rejectedRequests?.[reqIdStr]) return false;
    let token = '';
    try { token = await this.authManager.getValidToken(); } catch {}
    token = token || this.bookorbitToken || this.bookorbitApiKey;

    const headers = {
      'Content-Type': 'application/json',
      ...(token && isJwt(token) ? { 'Authorization': `Bearer ${token}` } : {}),
      ...(this.bookorbitApiKey ? { 'X-Api-Key': this.bookorbitApiKey } : (token && !isJwt(token) ? { 'X-Api-Key': token } : {})),
    };

    const attempts = this.state.requestSourceAttempts[reqIdStr] || details.attempts || this.maxSourceAttempts;
    const stage = details.stage || this.state.requestProgress[reqIdStr]?.stage || 'failed';
    const reason = details.reason || this.state.requestErrors[reqIdStr]?.error || 'max_attempts_exhausted';
    const reqTitle = details.req?.title || details.requestTitle || 'Unknown';
    const reqAuthor = details.req?.author || details.requestAuthor || 'Unknown';
    const searchTitle = details.searchTitle || reqTitle;
    const observedTitle = details.observedTitle || details.task?.title || null;
    const observedAuthor = details.observedAuthor || details.task?.author || null;
    const conflicts = Array.isArray(details.conflicts) ? details.conflicts : (this.state.requestVerification?.[reqIdStr]?.conflicts || []);

    let note = `[Shelfmark] Automated request failed after ${attempts}/${this.maxSourceAttempts} attempts.\n`;
    note += `Stage: ${stage}\n`;
    note += `Reason: ${reason}\n`;
    note += `Requested: "${reqTitle}" by "${reqAuthor}"\n`;
    if (searchTitle !== reqTitle) {
      note += `Search Title: "${searchTitle}"\n`;
    }
    if (observedTitle || observedAuthor) {
      note += `Observed Download: "${observedTitle || 'Unknown'}" by "${observedAuthor || 'Unknown'}"\n`;
    }
    if (conflicts.length > 0) {
      note += `Verification Conflicts: ${conflicts.join(', ')}\n`;
    }
    if (details.exhaustionReason) {
      note += `Exhaustion Reason: ${details.exhaustionReason}\n`;
    }
    if (note.length > 2000) {
      note = note.slice(0, 1997) + '...';
    }

    const url = `${this.bookorbitUrl}/api/v1/admin/book-requests/${encodeURIComponent(reqIdStr)}/reject`;
    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ decisionNote: note }),
      });
      if (res && res.ok) {
        this.state.rejectedRequests = this.state.rejectedRequests || {};
        this.state.rejectedRequests[reqIdStr] = {
          rejectedAt: new Date().toISOString(),
          decisionNote: note,
          reason,
        };
        delete this.state.requests[reqIdStr];
        this.setRequestProgress(reqIdStr, 'rejected', { reason: 'rejected_in_bookorbit', decisionNote: note });
        this.saveState();
        console.log(`[Bridge] Successfully rejected BookOrbit request ${reqIdStr} with diagnostic note.`);
        return true;
      } else if (res && (res.status === 404 || res.status === 409)) {
        this.state.rejectedRequests = this.state.rejectedRequests || {};
        this.state.rejectedRequests[reqIdStr] = {
          rejectedAt: new Date().toISOString(),
          decisionNote: note,
          reason,
        };
        delete this.state.requests[reqIdStr];
        this.setRequestProgress(reqIdStr, 'rejected', { reason: 'already_settled_in_bookorbit', decisionNote: note });
        this.saveState();
        return true;
      } else {
        console.warn(`[Bridge] BookOrbit reject request returned HTTP ${res?.status} for request ${reqIdStr}`);
        // If HTTP 400 (or non-success), BookOrbit refuses rejection because the request is approved.
        // Fall back to POST /api/v1/book-requests/:id/cancel to settle and mark as cancelled/failed in BookOrbit.
        const cancelUrl = `${this.bookorbitUrl}/api/v1/book-requests/${encodeURIComponent(reqIdStr)}/cancel`;
        try {
          const cancelRes = await fetchFn(cancelUrl, {
            method: 'POST',
            headers,
          });
          let settle = !!(cancelRes && (cancelRes.ok || cancelRes.status === 404));
          if (cancelRes && cancelRes.status === 409) {
            const boStatus = await this.getRequestStatus(reqIdStr, fetchFn);
            const uncancellable = ['cancelled', 'canceled', 'rejected', 'fulfilled', 'completed', 'available', 'done', 'success'].includes(boStatus);
            if (uncancellable) {
              settle = true;
            } else if (boStatus === 'approved' || boStatus === 'active' || boStatus === 'pending') {
              // Still cancellable: retry cancel once.
              try {
                const retryRes = await fetchFn(cancelUrl, { method: 'POST', headers });
                if (retryRes && (retryRes.ok || retryRes.status === 404)) {
                  settle = true;
                } else if (retryRes && retryRes.status === 409) {
                  const retryStatus = await this.getRequestStatus(reqIdStr, fetchFn);
                  if (['cancelled', 'canceled', 'rejected', 'fulfilled', 'completed', 'available', 'done', 'success'].includes(retryStatus)) {
                    settle = true;
                  }
                }
              } catch (rErr) {
                console.warn(`[Bridge] Retry cancel failed for request ${reqIdStr}: ${sanitizeLog(rErr?.message || rErr)}`);
              }
            }
            if (!settle) {
              const prev = this.state.requestProgress?.[reqIdStr] || {};
              const retries = (prev.cancelConflictRetries || 0) + 1;
              if (retries >= 3) {
                this.state.rejectedRequests = this.state.rejectedRequests || {};
                this.state.rejectedRequests[reqIdStr] = {
                  rejectedAt: new Date().toISOString(),
                  decisionNote: note,
                  reason,
                };
                delete this.state.requests[reqIdStr];
                this.setRequestProgress(reqIdStr, 'rejected', { reason: 'bookorbit_cancel_conflict_exhausted', decisionNote: note, cancelConflictRetries: retries });
                console.warn(`[Bridge] Cancel conflict retries exhausted for request ${reqIdStr}; settled.`);
                return true;
              }
              this.setRequestProgress(reqIdStr, 'rejected', { reason: 'bookorbit_cancel_conflict', decisionNote: note, cooldownUntil: new Date(Date.now() + 300000).toISOString(), cancelConflictRetries: retries });
              console.warn(`[Bridge] Cancel conflict for request ${reqIdStr}; BookOrbit status=${boStatus}; not settled (retry ${retries}/3).`);
              return false;
            }
          }
          if (settle) {
            this.state.rejectedRequests = this.state.rejectedRequests || {};
            this.state.rejectedRequests[reqIdStr] = {
              rejectedAt: new Date().toISOString(),
              decisionNote: note,
              reason,
            };
            delete this.state.requests[reqIdStr];
            this.setRequestProgress(reqIdStr, 'rejected', { reason: 'cancelled_in_bookorbit', decisionNote: note });
            this.saveState();
            console.log(`[Bridge] Successfully settled/cancelled BookOrbit request ${reqIdStr} after exhaustion.`);
            return true;
          }
        } catch (cErr) {
          console.warn(`[Bridge] Failed to cancel request ${reqIdStr} in BookOrbit: ${sanitizeLog(cErr.message)}`);
        }
      }
    } catch (err) {
      console.warn(`[Bridge] Failed to send rejection to BookOrbit for request ${reqIdStr}: ${sanitizeLog(err.message)}`);
    }
    return false;
  }

  /**
   * Fetches approved ebook requests from BookOrbit admin API and processes them.
   * Serialized with an async mutex lock to prevent duplicate runs.
   */
  async processPendingRequests({ fetchFn = globalThis.fetch } = {}) {
    if (this.isProcessingRequests) return;
    this.isProcessingRequests = true;

    try {
      if (!this.state.baselineEstablishedAt) {
        const baselineResult = await this.initializeBaseline({ fetchFn });
        if (!baselineResult.established || !this.state.baselineEstablishedAt) {
          console.warn('[Bridge] Baseline not established. Halting request processing until baseline succeeds.');
          return;
        }
      }

      let token = '';
      try {
        token = await this.authManager.getValidToken();
      } catch {}
      token = token || this.bookorbitToken || this.bookorbitApiKey;

      const boHeaders = {
        ...(token && isJwt(token) ? { 'Authorization': `Bearer ${token}` } : {}),
        ...(this.bookorbitApiKey ? { 'X-Api-Key': this.bookorbitApiKey } : {}),
      };

      let page = 1;
      const limit = 50;
      let total = Infinity;

      while ((page - 1) * limit < total) {
        const url = `${this.bookorbitUrl}/api/v1/admin/book-requests?status=approved&page=${page}&limit=${limit}`;
        let res;
        try {
          res = await fetchFn(url, { headers: boHeaders });
        } catch (err) {
          console.warn(`[Bridge] Failed to fetch approved requests page ${page}: ${sanitizeLog(err.message)}`);
          break;
        }

        if (!res.ok) {
          if (res.status === 401 || res.status === 403) {
            console.warn('[Bridge] Admin API unauthorized. Check service account token/permissions.');
          }
          break;
        }

        const data = await res.json().catch(() => ({}));
        const requests = Array.isArray(data) ? data : data.items || [];
        if (typeof data.total === 'number') {
          total = data.total;
        } else if (Array.isArray(data)) {
          total = requests.length < limit ? (page - 1) * limit + requests.length : Infinity;
        }

        if (requests.length === 0) break;

        for (const req of requests) {
          // 1. Skip if part of historical baseline
          const reqId = req?.id ?? req?.requestId ?? req?.request_id ?? req?.taskId ?? req?.task_id;
          if (reqId === undefined || reqId === null || String(reqId).trim() === '' || String(reqId) === 'undefined') {
            console.warn('[Bridge] Skipping request with missing id');
            continue;
          }
          if (this.state.baselineRequestIds && this.state.baselineRequestIds[reqId]) {
            continue;
          }
          if (req.createdAt && this.state.baselineEstablishedAt) {
            if (new Date(req.createdAt).getTime() <= new Date(this.state.baselineEstablishedAt).getTime()) {
              continue;
            }
          }

          // 2. Only process approved ebook requests; ignore settled (available, cancelled, rejected)
          if (req.status !== 'approved') continue;
          if (req.mediaKind && req.mediaKind !== 'ebook') continue;
          if (!req.language && !req.lang) req.language = 'English';

          // 3. Stop retry if request reached max attempts (reject in BookOrbit and halt)
          if ((this.state.requestSourceAttempts[reqId] || 0) >= this.maxSourceAttempts) {
            const curProg = this.state.requestProgress?.[reqId];
            if (curProg?.reason === 'bookorbit_cancel_conflict' && curProg?.cooldownUntil && new Date(curProg.cooldownUntil) > new Date()) {
              continue;
            }
            delete this.state.requests[reqId];
            await this.rejectBookOrbitRequest(reqId, {
              stage: this.state.requestProgress[reqId]?.stage || 'exhausted',
              reason: this.state.requestErrors[reqId]?.error || 'max_attempts_exhausted',
              req,
            }, fetchFn);
            continue;
          }

          // 3a. Skip if already tracked (never blindly requeue on Socket.IO broadcasts)
          if (this.state.requests[reqId]) {
            continue;
          }

          // 3b. Skip if currently holding in cooldown_wait and cooldown has not expired
          const curProgress = this.state.requestProgress[reqId];
          if (curProgress?.stage === 'cooldown_wait' && curProgress.cooldownUntil) {
            if (Date.now() < new Date(curProgress.cooldownUntil).getTime()) {
              continue;
            }
          }

          // Cancellation-aware: check request status before queueing/searching
          const requestState = await this.getRequestStatus(reqId, fetchFn);
          if (requestState === 'cancelled' || requestState === 'rejected') {
            this.setRequestProgress(reqId, requestState === 'rejected' ? 'rejected' : 'cancelled', { reason: requestState });
            continue;
          }
          if (requestState === 'fulfilled') {
            this.setRequestProgress(reqId, 'fulfilled', { reason: 'fulfilled' });
            continue;
          }
          if (requestState !== 'active' && req.status !== 'approved') {
            this.setRequestProgress(reqId, 'status_unknown', { reason: 'status_unknown' });
            continue;
          }

          this.setRequestProgress(reqId, 'searching', { reason: 'searching' });

          // 4. Search releases using corrected plugin logic (bounded per request)
          const query = {
            title: req.title,
            subtitle: req.subtitle || undefined,
            seriesName: req.seriesName || req.series || undefined,
            seriesIndex: req.seriesIndex ?? req.seriesPosition ?? req.series_position ?? undefined,
            author: req.author || (Array.isArray(req.authors) ? req.authors[0] : ''),
            year: req.year || req.publicationYear || req.publishedYear || undefined,
            isbn13: req.isbn13 || (Array.isArray(req.isbn13s) ? req.isbn13s[0] : undefined),
            mediaKind: 'ebook',
            language: req.language || req.lang || 'English',
          };

          const config = {
            baseUrl: this.shelfmarkUrl,
            settings: {
              apiKey: this.shelfmarkApiKey,
              preferFormat: process.env.PREFER_FORMAT || 'epub',
              releaseSource: process.env.RELEASE_SOURCE || 'all',
              providers: [null, 'googlebooks', 'hardcover'],
            },
          };

          const host = {
            fetch: async (fetchUrl, opts = {}) => {
              const smHeaders = { ...(opts.headers || {}) };
              if (this.shelfmarkApiKey) {
                smHeaders['Authorization'] = `Bearer ${this.shelfmarkApiKey}`;
                smHeaders['X-Api-Key'] = this.shelfmarkApiKey;
              }
              return fetchFn(fetchUrl, { ...opts, headers: smHeaders });
            },
            logger: { log: () => {}, warn: () => {}, error: () => {} },
            buildSearchText: (q) => [q.title, q.author].filter(Boolean).join(' ').trim(),
            fail: (code, message) => {
              const validCodes = ['unauthorized', 'throttled', 'timeout', 'unreachable', 'unsupportedMedium', 'error'];
              if (!validCodes.includes(code)) {
                throw new Error(`INVALID_BOOKORBIT_FAILURE_CODE: "${code}" is not supported by BookOrbit!`);
              }
              const err = new Error(message);
              err.code = code;
              return err;
            },
          };

          let searchResults = [];
          const searchController = new AbortController();
          const searchTimeout = setTimeout(() => {
            const timeoutErr = new Error('Shelfmark search timed out before completion.');
            timeoutErr.name = 'TimeoutError';
            searchController.abort(timeoutErr);
          }, 80000);
          let initialSearchError = null;
          try {
            searchResults = await plugin.search(query, config, host, searchController.signal);
          } catch (err) {
            initialSearchError = err instanceof Error ? err.message : String(err ?? 'unknown error');
            console.warn(`[Bridge] Upstream search error for request ${reqId} ("${query.title}"): ${sanitizeLog(initialSearchError)}. Trying other upstreams...`);
            searchResults = [];
          } finally {
            clearTimeout(searchTimeout);
          }

           // 5. Filter releases for Stage 1 candidate compatibility and filter out recently failed releases
           const reqForCompatibility = {
             ...req,
             year: req.publishedYear || req.publicationYear || req.year || null,
             isbn: req.isbn13 || req.isbn || (Array.isArray(req.isbn13s) ? req.isbn13s[0] : null) || null,
             language: req.language || req.lang || 'English',
           };
           let ineligibilityReason = null;
           const candidateRejectionReasonCounts = {};
           const eligibleReleases = searchResults.filter((rel) => {
             const reason = getEditionIncompatibilityReason(reqForCompatibility, rel);
             if (reason) {
               candidateRejectionReasonCounts[reason] = (candidateRejectionReasonCounts[reason] || 0) + 1;
               if (!ineligibilityReason) ineligibilityReason = reason;
               return false;
             }
             const rKey = this.getReleaseKey(rel);
             if (rKey && this.state.failedReleases && this.state.failedReleases[rKey]) {
               const failedRecord = this.state.failedReleases[rKey];
               const timeSinceFail = Date.now() - new Date(failedRecord.failedAt).getTime();
               if (timeSinceFail < this.releaseFailureCooldownMs) {
                 candidateRejectionReasonCounts.cooldown = (candidateRejectionReasonCounts.cooldown || 0) + 1;
                 if (!ineligibilityReason) ineligibilityReason = 'cooldown';
                 return false;
               }
             }
             return true;
           });
           // Rank candidates:
           // 1. Non-conflicting language hint ahead of conflicting language hint
           // 2. Exact/counterpart ISBN match boost (different ISBN and absent ISBN tie with zero penalty)
           // 3. Positive language hint ('match' ahead of 'unknown')
           // Publication year never affects ranking.
           eligibleReleases.sort((a, b) => {
             const ca = candidateCompatibility(reqForCompatibility, a);
             const cb = candidateCompatibility(reqForCompatibility, b);
             const langConflictA = ca.languageHint === 'mismatch' ? 1 : 0;
             const langConflictB = cb.languageHint === 'mismatch' ? 1 : 0;
             if (langConflictA !== langConflictB) return langConflictA - langConflictB;
             const isbnBoostA = ca.isbnVerified ? 0 : 1;
             const isbnBoostB = cb.isbnVerified ? 0 : 1;
             if (isbnBoostA !== isbnBoostB) return isbnBoostA - isbnBoostB;
             const langTierA = ca.languageHint === 'match' ? 0 : (ca.languageHint === 'unknown' ? 1 : 2);
             const langTierB = cb.languageHint === 'match' ? 0 : (cb.languageHint === 'unknown' ? 1 : 2);
             return langTierA - langTierB;
           });
           const metadataCandidateCount = Array.isArray(searchResults) ? searchResults.length : 0;
           const releaseCandidateCount = eligibleReleases.length;
           const candidateCounts = { metadataCandidateCount, releaseCandidateCount, candidateRejectionReasonCounts };
           this.state.requestCandidateCounts[reqId] = { metadataCandidateCount, releaseCandidateCount };
           this.state.requestMetadataCandidateCounts[reqId] = metadataCandidateCount;
           this.state.requestReleaseCandidateCounts[reqId] = releaseCandidateCount;
           this.state.requestCandidateRejectionReasons[reqId] = candidateRejectionReasonCounts;
           const progressEntry = { ...(this.state.requestProgress[reqId] || {}), ...candidateCounts, updatedAt: new Date().toISOString() };
           this.state.requestProgress[reqId] = progressEntry;
           this.state.requestStages[reqId] = progressEntry;
           this.state.requestStatus[reqId] = progressEntry;

          // If no eligible releases found in initial search,
          // actively search alternative release sources before evaluating failure
          if (eligibleReleases.length === 0) {
            const priorVerInit = this.state.requestVerification?.[reqId];
            const failedSources = new Set(
              (searchResults || [])
                .filter((rel) => {
                  const rKey = this.getReleaseKey(rel);
                  return rKey && this.state.failedReleases?.[rKey];
                })
                .map((rel) => (rel.extra?.source || rel.source || '').toLowerCase())
                .filter(Boolean)
            );
            if (priorVerInit?.releaseKey) {
              const src = priorVerInit.releaseKey.split(':')[0]?.toLowerCase();
              if (src) failedSources.add(src);
            }
            if (priorVerInit?.taskId && this.state.tasks?.[priorVerInit.taskId]?.source) {
              failedSources.add(this.state.tasks[priorVerInit.taskId].source.toLowerCase());
            }
            const normalizeUpstream = (s) => {
              const lower = String(s || '').toLowerCase();
              if (lower.includes('oceanofpdf') || lower.includes('direct_download')) return 'direct_download';
              if (lower.includes('anna') || lower.includes('aa-')) return 'annas';
              if (lower.includes('libgen')) return 'libgen';
              return lower;
            };
            const failedFamilies = new Set([...failedSources].map(normalizeUpstream));
            const allUpstreams = ['annas', 'libgen', 'direct_download', 'oceanofpdf'];
            const altSources = allUpstreams.filter((s) => !failedFamilies.has(normalizeUpstream(s)));

            for (const altSource of altSources) {
              if (eligibleReleases.length > 0) break;
              try {
                console.log(`[Bridge] Upstream query: searching provider "${altSource}" for request ${reqId} ("${query.title}")`);
                const altConfig = {
                  ...config,
                  settings: {
                    ...config.settings,
                    releaseSource: altSource,
                  },
                };
                const altResults = await plugin.search(query, altConfig, host, searchController.signal);
                for (const rel of (altResults || [])) {
                  const reason = getEditionIncompatibilityReason(reqForCompatibility, rel);
                  const rKey = this.getReleaseKey(rel);
                  const inCooldown = rKey && this.state.failedReleases?.[rKey] &&
                    (Date.now() - new Date(this.state.failedReleases[rKey].failedAt).getTime() < this.releaseFailureCooldownMs);
                  if (!reason && !inCooldown) {
                    eligibleReleases.push(rel);
                  } else if (inCooldown) {
                    candidateRejectionReasonCounts.cooldown = (candidateRejectionReasonCounts.cooldown || 0) + 1;
                  }
                }
              } catch (altErr) {
                console.warn(`[Bridge] Upstream provider "${altSource}" error for request ${reqId}: ${sanitizeLog(altErr?.message || altErr)}. Trying next upstream...`);
              }
            }

            if (eligibleReleases.length > 0) {
              eligibleReleases.sort((a, b) => {
                const ca = candidateCompatibility(reqForCompatibility, a);
                const cb = candidateCompatibility(reqForCompatibility, b);
                const langConflictA = ca.languageHint === 'mismatch' ? 1 : 0;
                const langConflictB = cb.languageHint === 'mismatch' ? 1 : 0;
                if (langConflictA !== langConflictB) return langConflictA - langConflictB;
                const isbnBoostA = ca.isbnVerified ? 0 : 1;
                const isbnBoostB = cb.isbnVerified ? 0 : 1;
                if (isbnBoostA !== isbnBoostB) return isbnBoostA - isbnBoostB;
                const langTierA = ca.languageHint === 'match' ? 0 : (ca.languageHint === 'unknown' ? 1 : 2);
                const langTierB = cb.languageHint === 'match' ? 0 : (cb.languageHint === 'unknown' ? 1 : 2);
                return langTierA - langTierB;
              });
              console.log(`[Bridge] Discovered ${eligibleReleases.length} eligible release(s) via alternative release source fallback for request ${reqId}`);
            }
          }

          if (eligibleReleases.length === 0) {
            const hasCooldown = (candidateRejectionReasonCounts.cooldown || 0) > 0;
            const priorVer = this.state.requestVerification?.[reqId];
            const hasUnrecoverableConflict = priorVer && priorVer.ok === false && (
              priorVer.conflicts?.includes('incompatible_title') ||
              priorVer.conflicts?.includes('incompatible_author')
            );
            const currentAttempts = this.state.requestSourceAttempts[reqId] || 0;

            // Terminal rejection: either maxSourceAttempts reached OR all candidates failed with unrecoverable conflict
            if (currentAttempts >= this.maxSourceAttempts || (hasUnrecoverableConflict && (searchResults?.length || 0) <= (candidateRejectionReasonCounts.cooldown || 0))) {
              const stage = priorVer?.stage || (hasUnrecoverableConflict ? 'finalization_failed' : 'exhausted');
              const reason = priorVer?.error || (hasUnrecoverableConflict ? `Unrecoverable verification conflict: ${priorVer.primaryConflict || priorVer.conflicts?.join(', ')}` : (ineligibilityReason || 'no_eligible_edition'));
              console.warn(`[Bridge] Terminally rejecting BookOrbit request ${reqId} ("${query.title}"): ${reason}`);
              this.setRequestProgress(reqId, 'rejected', {
                reason,
                exhaustionReason: hasUnrecoverableConflict ? 'unrecoverable_conflict' : 'max_attempts_exhausted',
                conflicts: priorVer?.conflicts,
                ...candidateCounts,
              });
              await this.rejectBookOrbitRequest(reqId, {
                stage,
                reason,
                req,
                searchTitle: query.title,
                exhaustionReason: hasUnrecoverableConflict ? 'unrecoverable_conflict' : 'max_attempts_exhausted',
                conflicts: priorVer?.conflicts,
                observedTitle: priorVer?.observedTitle || undefined,
                observedAuthor: priorVer?.observedAuthor || undefined,
              }, fetchFn);
              this.saveState();
              continue;
            }

            if (hasCooldown) {
              let earliestExpiry = Date.now() + this.releaseFailureCooldownMs;
              for (const rel of (searchResults || [])) {
                const rKey = this.getReleaseKey(rel);
                const failedRecord = rKey && this.state.failedReleases?.[rKey];
                if (failedRecord && failedRecord.failedAt) {
                  const expiry = new Date(failedRecord.failedAt).getTime() + this.releaseFailureCooldownMs;
                  if (expiry > Date.now() && expiry < earliestExpiry) {
                    earliestExpiry = expiry;
                  }
                }
              }
              const cooldownUntil = new Date(earliestExpiry).toISOString();
              console.log(`[Bridge] All candidates in cooldown for request ${reqId}; holding in cooldown_wait until ${cooldownUntil}`);
              this.setRequestProgress(reqId, 'cooldown_wait', {
                reason: 'cooldown_wait',
                cooldownUntil,
                ...candidateCounts,
              });
              this.saveState();
              continue;
            }

            const reason = ineligibilityReason || 'no_eligible_edition';
            if (priorVer && priorVer.ok === false) {
              const priorStage = priorVer.stage || 'review_required';
              const priorReason = priorVer.errorType || reason;
              console.log(`[Bridge] All remaining candidates exhausted (${reason}) after edition verification failure for request ${reqId} ("${query.title}"); keeping ${priorStage}`);
              this.setRequestProgress(reqId, priorStage, {
                reason: priorReason,
                exhaustionReason: reason,
                conflict: priorVer.primaryConflict || undefined,
                ...candidateCounts,
              });
              if (this.state.requestErrors[reqId]) {
                this.state.requestErrors[reqId].exhaustionReason = reason;
                this.state.requestErrors[reqId].lastAttemptAt = new Date().toISOString();
              }
              if ((this.state.requestSourceAttempts[reqId] || 0) >= this.maxSourceAttempts) {
                await this.rejectBookOrbitRequest(reqId, {
                  stage: priorStage,
                  reason: priorReason,
                  req,
                  searchTitle: query.title,
                  exhaustionReason: reason,
                  conflicts: priorVer.conflicts,
                }, fetchFn);
              }
              this.saveState();
              continue;
            }
            const isNoReleases = (searchResults?.length || 0) === 0;
            const stage = initialSearchError ? 'search_failed' : (isNoReleases ? 'no_releases' : 'no_eligible_edition');
            const finalReason = initialSearchError || ineligibilityReason || (isNoReleases ? 'No releases found' : 'no_eligible_edition');
            console.log(`[Bridge] No valid releases found for approved request ${reqId} ("${query.title}"): ${finalReason}`);
            this.setRequestProgress(reqId, stage, { reason: finalReason, ...candidateCounts });
            const nextAttempt = (this.state.requestSourceAttempts[reqId] || 0) + 1;
            const attemptId = `${stage}:${reqId}:${nextAttempt}`;
            this.state.requestAttempts[reqId] = this.state.requestAttempts[reqId] || [];
            if (!this.state.requestAttempts[reqId].some((a) => a.attemptId === attemptId)) {
              this.state.requestAttempts[reqId].push({ attemptId, timestamp: new Date().toISOString(), error: finalReason });
              this.state.requestSourceAttempts[reqId] = nextAttempt;
            }
            this.state.requestErrors[reqId] = {
              error: finalReason,
              errorType: stage,
              reason: stage,
              lastAttemptAt: new Date().toISOString(),
              attempts: this.state.requestSourceAttempts[reqId] || 0,
            };
            if (this.state.requestSourceAttempts[reqId] >= this.maxSourceAttempts) {
              await this.rejectBookOrbitRequest(reqId, {
                stage,
                reason: finalReason,
                req,
                searchTitle: query.title,
                exhaustionReason: finalReason,
              }, fetchFn);
            }
            this.saveState();
            continue;
          }

          // 6. Select eligible candidate and queue to Shelfmark.
          // When the first candidate conflicts with an incompatible existing task, try another independently
          // identified eligible release rather than repeatedly selecting or blacklisting the same candidate.
          let queuedSuccessfully = false;
          for (const candidateRelease of eligibleReleases) {
            const candKey = this.getReleaseKey(candidateRelease);
            const mappedTaskId = candKey ? this.state.releases[candKey] : null;
            if (mappedTaskId && mappedTaskId !== 'uncertain' && this.state.tasks[mappedTaskId]) {
              const existingTask = this.state.tasks[mappedTaskId];
              if (existingTask.isbnVerificationFailed || existingTask.editionVerificationFailed) {
                continue;
              }
              if (candidateCompatibility(existingTask, candidateRelease).outcome === 'reject' ||
                  !areEditionsCompatible(reqForCompatibility, existingTask)) {
                // Incompatible edition already assigned to this release candidate task; try next candidate
                continue;
              }
            }

            // Cancellation-aware before queueing
            const candidateRequestState = await this.getRequestStatus(reqId, fetchFn);
            if (candidateRequestState === 'cancelled') {
              this.setRequestProgress(reqId, 'cancelled', { reason: 'cancelled' });
              queuedSuccessfully = true; // stop trying candidates
              break;
            }
            if (candidateRequestState !== 'active') {
              this.setRequestProgress(reqId, 'status_unknown', { reason: 'status_unknown' });
              queuedSuccessfully = true;
              break;
            }

            const candidateLink = candidateRelease.downloadUrl || candidateRelease.extra?.releasePayload?.download_url || candidateRelease.extra?.releasePayload?.source_url || candidateRelease.extra?.releasePayload?.info_url || 'N/A';
            const candidateUpstream = candidateRelease.source || candidateRelease.extra?.source || candidateRelease.extra?.releasePayload?.source || 'unknown';
            console.log(`[Bridge] Initiating download for request ${reqId} ("${candidateRelease.title}") from upstream "${candidateUpstream}" (link: ${candidateLink})`);

            try {
              const queueRes = await this.queueRelease({
                requestId: reqId,
                userId: req.userId || req.requesterUserId || req.requester_user_id || req.user_id,
                release: candidateRelease,
                libraryId: req.targetLibraryId || this.defaultLibraryId,
                folderId: req.targetFolderId || this.defaultFolderId,
                requestTitle: req.title,
                requestAuthor: req.author || (Array.isArray(req.authors) ? req.authors[0] : null),
                requestAuthors: Array.isArray(req.authors) ? req.authors : (req.author ? [req.author] : []),
                requestSeriesName: req.seriesName || req.series || undefined,
                requestSeriesIndex: req.seriesIndex ?? req.seriesPosition ?? req.series_position ?? undefined,
                requestYear: parsePositiveInt(req.publishedYear || req.year),
                requestLanguage: req.language || req.lang || 'English',
                requestIsbn: req.isbn13 || req.isbn || (Array.isArray(req.isbn13s) ? req.isbn13s[0] : undefined),
                fetchFn,
              });
              if (queueRes.adopted || queueRes.reused) {
                console.log(`[Bridge] Adopted existing task ${queueRes.taskId} for request ${reqId} ("${candidateRelease.title}") [upstream: ${candidateUpstream}, link: ${candidateLink}]`);
              } else {
                console.log(`[Bridge] Queued release for request ${reqId} ("${candidateRelease.title}") from upstream "${candidateUpstream}" (link: ${candidateLink})`);
              }
              queuedSuccessfully = true;
              this.setRequestProgress(reqId, 'queued', { reason: 'queued', upstream: candidateUpstream, downloadUrl: candidateLink !== 'N/A' ? candidateLink : null });
              break;
            } catch (err) {
              const isEditionConflict = err.message && (err.message.toLowerCase().includes('incompatible edition') || err.message.toLowerCase().includes('incompatible'));
              if (isEditionConflict) {
                console.warn(`[Bridge] Candidate release "${candidateRelease.title}" from upstream "${candidateUpstream}" conflicted with existing task edition: ${sanitizeLog(err.message)}. Trying next candidate release...`);
                // DO NOT blacklist candidate in failedReleases! Try next candidate release.
                continue;
              }

              console.error(`[Bridge] Failed to queue release for request ${reqId} from upstream "${candidateUpstream}" (link: ${candidateLink}): ${sanitizeLog(err.message)}. Trying other upstreams...`);
              const rKey = this.getReleaseKey(candidateRelease);
              if (rKey) {
                this.state.failedReleases[rKey] = {
                  releaseKey: rKey,
                  source: candidateRelease.source,
                  sourceId: candidateRelease.sourceId,
                  failedAt: new Date().toISOString(),
                  error: err.message,
                };
              }
              const attemptId = `queue:${rKey || candidateRelease.sourceId || Date.now()}`;
              this.state.requestAttempts[reqId] = this.state.requestAttempts[reqId] || [];
              if (!this.state.requestAttempts[reqId].some((a) => a.attemptId === attemptId)) {
                this.state.requestAttempts[reqId].push({
                  attemptId,
                  releaseKey: rKey,
                  source: candidateRelease.source,
                  sourceId: candidateRelease.sourceId,
                  timestamp: new Date().toISOString(),
                  error: err.message,
                });
                const attempts = this.state.requestAttempts[reqId].length;
                this.state.requestSourceAttempts[reqId] = attempts;
                this.state.requestErrors[reqId] = {
                  error: err.message,
                  errorType: 'queue_failed',
                  lastAttemptAt: new Date().toISOString(),
                  attempts,
                };
              }
              this.saveState();
            }
          }

          if (!queuedSuccessfully && !this.state.requests[reqId]) {
            console.warn(`[Bridge] Could not queue any compatible release candidate for request ${reqId} ("${query.title}")`);
          }
        }

        page++;
        if (requests.length < limit) break;
      }
    } finally {
      this.isProcessingRequests = false;
    }
  }

  /**
   * Queues a release exactly once. If already queued or completed, adopts existing task.
   * If Shelfmark returns an uncertain response without a task ID, tracks in uncertain_queue state.
   */
  async queueRelease({ requestId, userId, release, libraryId, folderId, requestTitle, requestAuthor, requestAuthors, requestSeriesName, requestSeriesIndex, requestYear, requestLanguage, shelfmarkUrl, apiKey, requestIsbn, fetchFn = globalThis.fetch }) {
    if (this.isQueueingRelease) throw new Error('Queue operation already in progress');
    this.isQueueingRelease = true;
    try {
    if (!requestId) throw new Error('requestId is required');
    if (!release) throw new Error('release is required');

    const smUrl = (shelfmarkUrl || this.shelfmarkUrl).replace(/\/$/, '');
    const smKey = apiKey || this.shelfmarkApiKey;
    const releaseKey = this.getReleaseKey(release);


    // 1. Check if release already tracked or in uncertain queue
    const parsedReqYear = parsePositiveInt(requestYear) || null;
    const normalizedReqLang = ID.normalizeLanguageCode(requestLanguage) || 'en';
    const existingTaskId = this.state.releases[releaseKey];
    if (existingTaskId === 'uncertain') {
      const rec = this.state.uncertainQueues[releaseKey];
      if (rec) {
        // Work + requested-language compatibility check (ISBN and year never block sharing)
        const incomingIsbn = normalizeIsbnBridge(requestIsbn || '');
        const recLang = ID.normalizeLanguageCode(rec.requestLanguage || 'en') || 'en';
        if (normalizedReqLang !== recLang) {
          throw new Error(`Incompatible requested language for uncertain queue ${releaseKey}: requested ${normalizedReqLang} vs ${recLang}`);
        }
        if (requestTitle && rec.requestTitle && !ID.isTitleMatch(requestTitle, rec.requestTitle)) {
          throw new Error(`Incompatible work title for uncertain queue ${releaseKey}: requested "${requestTitle}" vs "${rec.requestTitle}"`);
        }
        if (requestAuthor && rec.requestAuthor && !ID.isAuthorMatch(requestAuthor, rec.requestAuthor)) {
          throw new Error(`Incompatible author for uncertain queue ${releaseKey}: requested "${requestAuthor}" vs "${rec.requestAuthor}"`);
        }
        if (!Array.isArray(rec.requestIds)) rec.requestIds = rec.requestId ? [rec.requestId] : [];
        if (requestId && !rec.requestIds.includes(requestId)) rec.requestIds.push(requestId);
        if (requestId && !rec.requestId) rec.requestId = requestId;
        if (userId && !Array.isArray(rec.userIds)) rec.userIds = rec.userId ? [rec.userId] : [];
        if (userId && Array.isArray(rec.userIds) && !rec.userIds.includes(userId)) rec.userIds.push(userId);
        if (requestTitle && !rec.requestTitle) rec.requestTitle = requestTitle;
        if (requestTitle && requestId) {
          rec.requestTitles = rec.requestTitles || {};
          if (!rec.requestTitles[requestId]) rec.requestTitles[requestId] = requestTitle;
        }
        if (requestAuthor && !rec.requestAuthor) rec.requestAuthor = requestAuthor;
        if (requestAuthor && requestId) {
          rec.requestAuthorsMap = rec.requestAuthorsMap || {};
          if (!rec.requestAuthorsMap[requestId]) rec.requestAuthorsMap[requestId] = requestAuthor;
        }
        if (parsedReqYear && !rec.requestYear) rec.requestYear = parsedReqYear;
        if (parsedReqYear && requestId) {
          rec.requestYears = rec.requestYears || {};
          if (!rec.requestYears[requestId]) rec.requestYears[requestId] = parsedReqYear;
        }
        if (incomingIsbn && !rec.requestIsbn) rec.requestIsbn = incomingIsbn;
        if (incomingIsbn && requestId) {
          rec.requestIsbns = rec.requestIsbns || {};
          if (!rec.requestIsbns[requestId]) rec.requestIsbns[requestId] = incomingIsbn;
        }
        if (requestId) {
          rec.requestLanguages = rec.requestLanguages || {};
          if (!rec.requestLanguages[requestId]) rec.requestLanguages[requestId] = normalizedReqLang;
        }
      }
      if (requestId) this.state.requests[requestId] = 'uncertain';
      this.saveState();
      return {
        status: 'uncertain_queue',
        taskId: null,
        adopted: true,
      };
    }

    const verifyExistingTaskAdoption = (existing, idForErr, sameReleaseKey = false) => {
      if (existing.verificationFailed || existing.isbnVerificationFailed || existing.editionVerificationFailed) {
        throw new Error(`Incompatible task ${idForErr}: task failed post-download verification`);
      }
      if (!sameReleaseKey) {
        const incomingSrcId = String(release?.sourceId ?? release?.source_id ?? release?.extra?.sourceId ?? '').trim();
        if (existing.sourceId && incomingSrcId && String(existing.sourceId) !== incomingSrcId) {
          throw new Error(`Conflicting source identity for existing task ${idForErr}: incoming ${incomingSrcId} vs task ${existing.sourceId}`);
        }
      }
      if (candidateCompatibility(existing, release).outcome === 'reject') {
        throw new Error(`Incompatible work for existing task ${idForErr}: requested "${release.title}" vs task "${existing.title}"`);
      }
      const existingReqLang = ID.normalizeLanguageCode(existing.requestLanguage || existing.language || 'en') || 'en';
      if (existingReqLang !== normalizedReqLang) {
        throw new Error(`Incompatible requested language for existing task ${idForErr}: requested ${normalizedReqLang} vs task ${existingReqLang}`);
      }
    };

    const mergeRequestIntoExistingTask = (existing) => {
      // Merge gate: terminal states never merge.
      if (!existing) return false;
      const terminalStatuses = new Set(['cancelled', 'rejected', 'exhausted']);
      if (terminalStatuses.has(existing.status)) return false;
      // Exhausted retries (cancel already sent to BookOrbit) blocks merge.
      const rids = Array.isArray(existing.requestIds) ? existing.requestIds : [];
      const exhausted = rids.length > 0 && rids.every((r) =>
        (this.state.requestSourceAttempts?.[r] || 0) >= this.maxSourceAttempts
      );
      if (exhausted) return false;
      const cancelSent = rids.length > 0 && rids.every((r) => this.state.rejectedRequests?.[r]);
      if (cancelSent) return false;
      // Edition verification failure alone does NOT block (allows recycling).
      // Merge gate: in-flight tasks never merge.
      const inFlightStatuses = new Set(['grabbed', 'downloading', 'importing']);
      if (inFlightStatuses.has(existing.status)) return false;
      const activeShelfmarkTask = (this.state.releases?.[existing.releaseKey] === existing.taskId) &&
        !['completed', 'fulfilled', 'available'].includes(
          (this.state.tasks?.[existing.taskId]?.status) ?? existing.status
        );
      if (activeShelfmarkTask) return false;
      // Edition compatibility is enforced by callers (verifyExistingTaskAdoption);
      // do not re-gate here so failed-task recycling still works.
      // Available/fulfilled: mark request fulfilled, no download.
      if (existing.status === 'available' || existing.status === 'fulfilled') {
        existing.requestFulfillments = existing.requestFulfillments || {};
        const now = new Date().toISOString();
        existing.requestFulfillments[requestId] = { fulfilled: true, fulfilledAt: now, status: 200 };
        return true;
      }
      // Normal merge (existing logic):
      if (requestTitle && !existing.requestTitle) existing.requestTitle = requestTitle;
      if (requestTitle) {
        existing.requestTitles = existing.requestTitles || {};
        if (!existing.requestTitles[requestId]) existing.requestTitles[requestId] = requestTitle;
      }
      if (requestAuthor && !existing.requestAuthor) existing.requestAuthor = requestAuthor;
      if (requestAuthor) {
        existing.requestAuthorsMap = existing.requestAuthorsMap || {};
        if (!existing.requestAuthorsMap[requestId]) existing.requestAuthorsMap[requestId] = requestAuthor;
      }
      if (parsedReqYear && !existing.requestYear) existing.requestYear = parsedReqYear;
      if (parsedReqYear) {
        existing.requestYears = existing.requestYears || {};
        if (!existing.requestYears[requestId]) existing.requestYears[requestId] = parsedReqYear;
      }
      if (requestLanguage && !existing.requestLanguage) existing.requestLanguage = normalizedReqLang;
      if (requestId) {
        existing.requestLanguages = existing.requestLanguages || {};
        if (!existing.requestLanguages[requestId]) existing.requestLanguages[requestId] = normalizedReqLang;
      }
      if (requestIsbn && !existing.requestIsbn) existing.requestIsbn = requestIsbn;
      if (requestIsbn) {
        existing.requestIsbns = existing.requestIsbns || {};
        if (!existing.requestIsbns[requestId]) existing.requestIsbns[requestId] = requestIsbn;
      }
      if (requestSeriesName && !existing.requestSeriesName) existing.requestSeriesName = requestSeriesName;
      if (requestSeriesName && requestId) {
        existing.requestSeriesNames = existing.requestSeriesNames || {};
        if (!existing.requestSeriesNames[requestId]) existing.requestSeriesNames[requestId] = requestSeriesName;
      }
      if (requestSeriesIndex != null && existing.requestSeriesIndex == null) existing.requestSeriesIndex = requestSeriesIndex;
      if (requestSeriesIndex != null && requestId) {
        existing.requestSeriesIndices = existing.requestSeriesIndices || {};
        if (existing.requestSeriesIndices[requestId] == null) existing.requestSeriesIndices[requestId] = requestSeriesIndex;
      }
      existing.trustedIsbns = gatherTrustedIsbnsBridge(existing.trustedIsbns, existing.bookMetadata, existing.extra, release?.extra?.bookMetadata, release?.extra, release);
      existing.bookMetadata = existing.bookMetadata || release?.extra?.bookMetadata || null;
      // Reset logic:
      const rKey = existing.releaseKey || releaseKey;
      this.state.failedReleases = this.state.failedReleases || {};
      if (rKey && this.state.failedReleases[rKey]) delete this.state.failedReleases[rKey];
      if (releaseKey && this.state.failedReleases[releaseKey]) delete this.state.failedReleases[releaseKey];
      this.state.requestSourceAttempts = this.state.requestSourceAttempts || {};
      if (requestId) this.state.requestSourceAttempts[requestId] = 0;
      if (requestId && this.state.requestProgress?.[requestId]) {
        delete this.state.requestProgress[requestId].cooldownUntil;
      }
      return true;
    };

    if (existingTaskId && this.state.tasks[existingTaskId]) {
      const existing = this.state.tasks[existingTaskId];
      const isFailedTask = Boolean(
        existing.verificationFailed ||
        existing.isbnVerificationFailed ||
        existing.editionVerificationFailed ||
        existing.status === 'finalization_failed' ||
        existing.status === 'failed'
      );
      if (isFailedTask) {
        // A previously failed task must not prevent the release/book from being requested again.
        delete this.state.releases[releaseKey];
      } else {
        verifyExistingTaskAdoption(existing, existingTaskId, true);

        const relUrl = release.downloadUrl || release.sourceUrl || release.infoUrl || null;
        existing.downloadUrl = existing.downloadUrl || relUrl;
        existing.sourceUrl = existing.sourceUrl || release.sourceUrl || relUrl;
        existing.infoUrl = existing.infoUrl || release.infoUrl || null;

        this.state.requests[requestId] = existingTaskId;
        if (!existing.requestIds.includes(requestId)) {
          existing.requestIds.push(requestId);
        }
        if (userId && !existing.userIds.includes(userId)) {
          existing.userIds.push(userId);
        }
        existing.updatedAt = new Date().toISOString();
        const merged = mergeRequestIntoExistingTask(existing);
        if (!merged) {
          // Terminal/in-flight/incompatible: do not adopt; queue as new
          delete this.state.releases[releaseKey];
        } else {
          this.saveState();
        }

        if (merged && (existing.status === 'completed' || existing.status === 'fulfilled') && existing.filePath) {
          const verify = this.verifyFile(existing.filePath, existing.format);
          if (verify.ok) {
            const targetLibId = parsePositiveInt(existing.libraryId ?? this.defaultLibraryId);
            if (existing.matchedBookId && targetLibId && this.bookorbitUrl) {
              const authHeaders = await this.getAuthHeaders();
              const bookStatus = await this.verifyBookInLibrary(existing, targetLibId, existing.matchedBookId, authHeaders, fetchFn);
              if (bookStatus === 'deleted') {
                console.warn(`[Bridge] Book ${existing.matchedBookId} on adopted task ${existingTaskId} was definitively deleted; invalidating stale mapping.`);
                existing.matchedBookId = null;
                existing.dockFileId = null;
                delete existing.uploadBaselineChecked;
                delete existing.uploadBaselineIds;
                delete existing.uncertainUpload;
                if (existing.status === 'fulfilled' || existing.status === 'imported') {
                  existing.status = 'completed';
                }
                this.saveState();
              }
            }
            if (this.bookorbitUrl) {
              this.fulfillBookOrbitRequests(existing, fetchFn).catch((err) => {
                console.warn(`[Bridge] Fulfillment error on adopted task ${existingTaskId}: ${sanitizeLog(err.message)}`);
              });
            }
            return {
              status: 'completed',
              taskId: existingTaskId,
              filePath: existing.filePath,
              reused: Boolean(existing.matchedBookId),
            };
          }
        }

        if (existing.status === 'queued' || existing.status === 'downloading' || existing.status === 'awaiting_file') {
          return {
            status: 'in_progress',
            taskId: existingTaskId,
            adopted: true,
          };
        }
      }
    }

    // 2. Prepare payload for Shelfmark POST /api/releases/download
    let downloadPayload = {};
    if (release.guid) {
      try {
        downloadPayload = typeof release.guid === 'string' ? JSON.parse(release.guid) : release.guid;
      } catch {}
    }
    if (!downloadPayload.source) {
      downloadPayload.source = release.source || release.extra?.source;
      downloadPayload.source_id = release.sourceId || release.extra?.sourceId || release.id;
      downloadPayload.title = release.title;
      downloadPayload.format = release.format || 'epub';
      downloadPayload.author = release.author;
    }

    // Normalize numeric size to string (or null) to prevent Shelfmark parse_size_string() .strip() crash on numbers.
    // Preserve size_bytes as numeric.
    if (typeof downloadPayload.size === 'number') {
      if (downloadPayload.size_bytes === undefined || downloadPayload.size_bytes === null) {
        downloadPayload.size_bytes = downloadPayload.size;
      }
      downloadPayload.size = String(downloadPayload.size);
    } else if (downloadPayload.size != null && typeof downloadPayload.size !== 'string') {
      downloadPayload.size = String(downloadPayload.size);
    }
    if (downloadPayload.size === undefined && release.size !== undefined) {
      downloadPayload.size = release.size != null ? String(release.size) : null;
    }
    if (downloadPayload.size_bytes === undefined && release.sizeBytes !== undefined) {
      downloadPayload.size_bytes = typeof release.sizeBytes === 'number' ? release.sizeBytes : Number(release.sizeBytes) || null;
    } else if (downloadPayload.size_bytes !== undefined && downloadPayload.size_bytes !== null && typeof downloadPayload.size_bytes !== 'number') {
      const parsedBytes = Number(downloadPayload.size_bytes);
      if (Number.isFinite(parsedBytes)) {
        downloadPayload.size_bytes = parsedBytes;
      }
    }

    // Preserve/forward the verified source-page URL using Shelfmark's accepted field names.
    const releasePageUrl =
      release.infoUrl || release.info_url ||
      release.downloadUrl || release.download_url ||
      downloadPayload.info_url || downloadPayload.download_url || downloadPayload.source_url || null;
    if (releasePageUrl) {
      if (!downloadPayload.download_url) downloadPayload.download_url = releasePageUrl;
      if (!downloadPayload.info_url) downloadPayload.info_url = releasePageUrl;
      if (!downloadPayload.source_url) downloadPayload.source_url = releasePageUrl;
    }
    if (release.language && !downloadPayload.language) {
      downloadPayload.language = release.language;
    }

    // OceanofPDF requires a real book page URL; never invent one from the hashed source_id.
    const oceanSource = downloadPayload.source || release.source || release.extra?.source || '';
    const oceanExtra = release.extra?.source || '';
    const oceanUrl =
      downloadPayload.source_url || downloadPayload.download_url || downloadPayload.info_url || releasePageUrl;
    if (isOceanofPdfBridge(oceanSource, oceanExtra, oceanUrl)) {
      if (!isValidOceanofPdfPageUrlBridge(oceanUrl)) {
        throw new Error(`OceanofPDF release "${release.title || downloadPayload.title || ''}" has no book page URL`);
      }
      downloadPayload.source_url = oceanUrl;
      if (!downloadPayload.download_url) downloadPayload.download_url = oceanUrl;
      if (!downloadPayload.info_url) downloadPayload.info_url = oceanUrl;
    }

    const headers = { 'Content-Type': 'application/json' };
    if (smKey) {
      headers['Authorization'] = `Bearer ${smKey}`;
      headers['X-Api-Key'] = smKey;
    }

    let res;
    try {
      res = await fetchFn(`${smUrl}/api/releases/download`, {
        method: 'POST',
        headers,
        body: JSON.stringify(downloadPayload),
      });
    } catch (netErr) {
      // Lost response / network failure after request may have been sent:
      // treat as uncertain, never requeue blindly.
      const now = new Date().toISOString();
      this.state.uncertainQueues[releaseKey] = {
        releaseKey,
        requestId,
        requestIds: requestId ? [requestId] : [],
        userId,
        userIds: userId ? [userId] : [],
        release: downloadPayload,
        requestTitle: requestTitle || null,
        requestAuthor: requestAuthor || (Array.isArray(requestAuthors) ? requestAuthors[0] : null) || null,
        requestYear: parsedReqYear,
        requestYears: requestId && parsedReqYear ? { [requestId]: parsedReqYear } : {},
        requestIsbn: requestIsbn || null,
        requestIsbns: requestId && requestIsbn ? { [requestId]: requestIsbn } : {},
        requestTitles: requestId && requestTitle ? { [requestId]: requestTitle } : {},
        requestAuthorsMap: requestId && (requestAuthor || (Array.isArray(requestAuthors) && requestAuthors[0])) ? { [requestId]: requestAuthor || requestAuthors[0] } : {},
        requestLanguage: normalizedReqLang,
        requestLanguages: requestId ? { [requestId]: normalizedReqLang } : {},
        trustedIsbns: gatherTrustedIsbnsBridge(release?.extra?.bookMetadata, release?.extra, release),
        bookMetadata: release?.extra?.bookMetadata || null,
        libraryId: libraryId ?? this.defaultLibraryId,
        folderId: folderId ?? this.defaultFolderId,
        queuedAt: now,
        status: 'uncertain_queue',
      };
      this.state.releases[releaseKey] = 'uncertain';
      this.state.requests[requestId] = 'uncertain';
      this.saveState();
      return {
        status: 'uncertain_queue',
        taskId: null,
        adopted: false,
      };
    }

    let taskId = null;
    if (res.ok) {
      const json = await res.json().catch(() => ({}));
      taskId = json.task_id || json.taskId || json.id || json.task?.id || json.task?.task_id || json.download_task_id || null;

      if (!taskId) {
        // Shelfmark returned 200 without task ID. Correlate with /api/status.
        const statusRes = await fetchFn(`${smUrl}/api/status`, { headers });
        if (statusRes.ok) {
          const statusJson = await statusRes.json().catch(() => ({}));
          const parsed = parseShelfmarkStatus(statusJson);
          const candidates = [...parsed.downloading, ...parsed.queued, ...parsed.complete];
           const matched = candidates.find((t) => {
             const titleMatch = (t.title || '').trim().toLowerCase() === (downloadPayload.title || '').trim().toLowerCase();
             const formatMatch = (t.format || '').toLowerCase() === (downloadPayload.format || '').toLowerCase();
             const sourceMatch = !downloadPayload.source || !(t.source) || String(t.source).toLowerCase() === String(downloadPayload.source).toLowerCase();
             const sourceIdMatch = !downloadPayload.source_id || !(t.source_id) || String(t.source_id) === String(downloadPayload.source_id);
             return titleMatch && formatMatch && sourceMatch && sourceIdMatch;
           });
          if (matched) {
            taskId = matched.id || matched.task_id;
          }
        }

        if (!taskId) {
          // Record durable uncertain-queue state. Never fabricate an ID!
          const now = new Date().toISOString();
          this.state.uncertainQueues[releaseKey] = {
            releaseKey,
            requestId,
            requestIds: requestId ? [requestId] : [],
            userId,
            userIds: userId ? [userId] : [],
            release: downloadPayload,
            requestTitle: requestTitle || null,
            requestAuthor: requestAuthor || (Array.isArray(requestAuthors) ? requestAuthors[0] : null) || null,
            requestYear: parsedReqYear,
            requestYears: requestId && parsedReqYear ? { [requestId]: parsedReqYear } : {},
            requestIsbn: requestIsbn || null,
            requestIsbns: requestId && requestIsbn ? { [requestId]: requestIsbn } : {},
            requestTitles: requestId && requestTitle ? { [requestId]: requestTitle } : {},
            requestAuthorsMap: requestId && (requestAuthor || (Array.isArray(requestAuthors) && requestAuthors[0])) ? { [requestId]: requestAuthor || requestAuthors[0] } : {},
            requestLanguage: normalizedReqLang,
            requestLanguages: requestId ? { [requestId]: normalizedReqLang } : {},
            trustedIsbns: gatherTrustedIsbnsBridge(release?.extra?.bookMetadata, release?.extra, release),
            bookMetadata: release?.extra?.bookMetadata || null,
            libraryId: libraryId ?? this.defaultLibraryId,
            folderId: folderId ?? this.defaultFolderId,
            queuedAt: now,
            status: 'uncertain_queue',
          };
          this.state.releases[releaseKey] = 'uncertain';
          this.state.requests[requestId] = 'uncertain';
          this.saveState();

          return {
            status: 'uncertain_queue',
            taskId: null,
            adopted: false,
          };
        }
      }
    } else if (res.status === 500) {
      const text = await res.text().catch(() => '');
      const lowerText = text.toLowerCase();
      if (lowerText.includes('already') && lowerText.includes('queue')) {
        const statusRes = await fetchFn(`${smUrl}/api/status`, { headers });
        if (statusRes.ok) {
          const statusJson = await statusRes.json().catch(() => ({}));
          const parsed = parseShelfmarkStatus(statusJson);
          const candidates = [...parsed.downloading, ...parsed.queued, ...parsed.complete];
           const matched = candidates.find((t) => {
             const titleMatch = (t.title || '').trim().toLowerCase() === (downloadPayload.title || '').trim().toLowerCase();
             const formatMatch = (t.format || '').toLowerCase() === (downloadPayload.format || '').toLowerCase();
             const sourceMatch = !downloadPayload.source || !(t.source) || String(t.source).toLowerCase() === String(downloadPayload.source).toLowerCase();
             const sourceIdMatch = !downloadPayload.source_id || !(t.source_id) || String(t.source_id) === String(downloadPayload.source_id);
             return titleMatch && formatMatch && sourceMatch && sourceIdMatch;
           });
          if (matched) {
            taskId = matched.id || matched.task_id;
          }
        }
      }
      if (!taskId) {
        throw new Error(`Shelfmark duplicate queue error but existing task could not be resolved: ${text}`);
      }
    } else {
      const text = await res.text().catch(() => '');
      throw new Error(`Shelfmark download failed (HTTP ${res.status}): ${text}`);
    }

    // 3. Check if taskId already exists (safe adoption and merging instead of overwriting)
    const now = new Date().toISOString();
    if (this.state.tasks[taskId]) {
      const existing = this.state.tasks[taskId];
      const isFailedTask = Boolean(
        existing.verificationFailed ||
        existing.isbnVerificationFailed ||
        existing.editionVerificationFailed ||
        existing.status === 'finalization_failed' ||
        existing.status === 'failed'
      );
      if (isFailedTask) {
        existing.status = 'queued';
        existing.verificationFailed = false;
        existing.isbnVerificationFailed = false;
        existing.editionVerificationFailed = false;
        existing.error = null;
        existing.filePath = null;
        existing.progress = 0;
        existing.downloadPercent = 0;
        existing.requestIds = Array.isArray(existing.requestIds) ? existing.requestIds : [];
        if (requestId && !existing.requestIds.includes(requestId)) {
          existing.requestIds.push(requestId);
        }
        existing.userIds = Array.isArray(existing.userIds) ? existing.userIds : [];
        if (userId && !existing.userIds.includes(userId)) {
          existing.userIds.push(userId);
        }
        existing.downloadUrl = downloadPayload.download_url || release.downloadUrl || null;
        existing.sourceUrl = downloadPayload.source_url || release.sourceUrl || null;
        existing.infoUrl = downloadPayload.info_url || release.infoUrl || null;
        const merged1 = mergeRequestIntoExistingTask(existing);
        if (!merged1) {
          throw new Error(`Cannot adopt existing task ${taskId}: terminal or in-flight`);
        }
      } else {
        const sameSrc = Boolean(existing.sourceId && downloadPayload.source_id && String(existing.sourceId) === String(downloadPayload.source_id));
        verifyExistingTaskAdoption(existing, taskId, sameSrc);
        const merged2 = mergeRequestIntoExistingTask(existing);
        if (!merged2) {
          throw new Error(`Cannot adopt existing task ${taskId}: terminal or in-flight`);
        }
      }

      this.state.requests[requestId] = taskId;
      this.state.requestTasks = this.state.requestTasks || {};
      this.state.requestTasks[requestId] = taskId;
      if (!existing.requestIds.includes(requestId)) {
        existing.requestIds.push(requestId);
      }
      if (userId && !existing.userIds.includes(userId)) {
        existing.userIds.push(userId);
      }
      if (releaseKey && !this.state.releases[releaseKey]) {
        this.state.releases[releaseKey] = taskId;
      }
      existing.updatedAt = now;
      this.saveState();
      this.scheduleActiveReconciliation(10000);

      if (existing.matchedBookId && this.bookorbitUrl) {
        const targetLibId = parsePositiveInt(existing.libraryId ?? this.defaultLibraryId);
        if (targetLibId) {
          const authHeaders = await this.getAuthHeaders();
          const bookStatus = await this.verifyBookInLibrary(existing, targetLibId, existing.matchedBookId, authHeaders, fetchFn);
          if (bookStatus === 'deleted') {
            console.warn(`[Bridge] Book ${existing.matchedBookId} on adopted task ${taskId} was definitively deleted; invalidating stale mapping.`);
            existing.matchedBookId = null;
            existing.dockFileId = null;
            delete existing.uploadBaselineChecked;
            delete existing.uploadBaselineIds;
            delete existing.uncertainUpload;
            if (existing.status === 'fulfilled' || existing.status === 'imported') {
              existing.status = 'completed';
            }
            this.saveState();
          }
        }
      }

      if (this.bookorbitUrl && (existing.status === 'completed' || existing.status === 'fulfilled' || existing.status === 'imported') && existing.filePath) {
        this.fulfillBookOrbitRequests(existing, fetchFn).catch((err) => {
          console.warn(`[Bridge] Fulfillment error on adopted task ${taskId}: ${sanitizeLog(err.message)}`);
        });
      }

      return {
        status: existing.status,
        taskId,
        adopted: true,
        filePath: existing.filePath,
        reused: Boolean(existing.matchedBookId),
      };
    }

    // 4. Persist new task record
    const taskRecord = {
      taskId,
      releaseKey,
      title: downloadPayload.title || release.title,
      author: downloadPayload.author || release.author,
      year: parsePositiveInt(release.year || release.publicationYear || downloadPayload.year) || null,
      isbn: release.isbn13 || release.isbn || downloadPayload.isbn || null,
      requestTitle: requestTitle || null,
      requestAuthor: requestAuthor || (Array.isArray(requestAuthors) ? requestAuthors[0] : null) || null,
      requestAuthors: Array.isArray(requestAuthors) ? requestAuthors : (requestAuthor ? [requestAuthor] : []),
      requestYear: parsedReqYear,
      requestYears: requestId && parsedReqYear ? { [requestId]: parsedReqYear } : {},
      requestIsbn: requestIsbn || null,
      requestIsbns: requestId && requestIsbn ? { [requestId]: requestIsbn } : {},
      requestTitles: requestId && requestTitle ? { [requestId]: requestTitle } : {},
      requestAuthorsMap: requestId && (requestAuthor || (Array.isArray(requestAuthors) && requestAuthors[0])) ? { [requestId]: requestAuthor || requestAuthors[0] } : {},
      requestSeriesName: requestSeriesName || null,
      requestSeriesNames: requestId && requestSeriesName ? { [requestId]: requestSeriesName } : {},
      requestSeriesIndex: requestSeriesIndex ?? null,
      requestSeriesIndices: requestId && requestSeriesIndex != null ? { [requestId]: requestSeriesIndex } : {},
      trustedIsbns: gatherTrustedIsbnsBridge(release?.extra?.bookMetadata, release?.extra, release),
      bookMetadata: release?.extra?.bookMetadata || null,
      language: ID.normalizeLanguageCode(release.language || downloadPayload.language) || null,
      requestLanguage: normalizedReqLang,
      requestLanguages: requestId ? { [requestId]: normalizedReqLang } : {},
      format: (downloadPayload.format || release.format || 'epub').toLowerCase(),
      source: downloadPayload.source,
      sourceId: downloadPayload.source_id,
      downloadUrl: downloadPayload.download_url || release.downloadUrl || null,
      sourceUrl: downloadPayload.source_url || release.sourceUrl || null,
      infoUrl: downloadPayload.info_url || release.infoUrl || null,
      progress: 0,
      downloadPercent: 0,
      libraryId: libraryId ?? this.defaultLibraryId,
      folderId: folderId ?? this.defaultFolderId,
      shelfmarkUrl: smUrl,
      status: 'queued',
      filePath: null,
      dockFileId: null,
      matchedBookId: null,
      requestIds: [requestId],
      userIds: userId ? [userId] : [],
      requestFulfillments: {},
      fulfilledRequestIds: [],
      unfulfilledRequestIds: [requestId],
      createdAt: now,
      updatedAt: now,
    };

    this.state.tasks[taskId] = taskRecord;
    this.state.requests[requestId] = taskId;
    this.state.requestTasks = this.state.requestTasks || {};
    this.state.requestTasks[requestId] = taskId;
    if (releaseKey) {
      this.state.releases[releaseKey] = taskId;
    }
    this.saveState();
    this.scheduleActiveReconciliation(10000);

    return {
      status: 'queued',
      taskId,
      adopted: false,
    };
    } finally {
      this.isQueueingRelease = false;
    }
  }

  /**
   * Processes post-download webhook notifications from Shelfmark's CUSTOM_SCRIPT hook.
   */
  runExclusive(fn) {
    const next = this._workLock.then(() => fn(), () => fn());
    this._workLock = next.then(() => {}, () => {});
    return next;
  }

  async handleWebhook(payload, authHeader, fetchFn = globalThis.fetch) {
    const incomingSecret = (authHeader || '').replace(/^Bearer\s+/i, '').trim();
    if (!timingSafeCompare(incomingSecret, this.secret)) {
      return { ok: false, statusCode: 401, error: 'Unauthorized: Invalid bridge secret' };
    }

    if (!payload || typeof payload !== 'object') {
      return { ok: false, statusCode: 400, error: 'Bad Request: JSON payload required' };
    }

    const taskObj = payload.task || {};
    const pathsObj = payload.paths || {};

    const taskId = taskObj.task_id ?? taskObj.taskId ?? taskObj.id ?? payload.task_id ?? payload.taskId ?? payload.id;
    const rawTarget = pathsObj.target || pathsObj.target_path || pathsObj.final_path ||
      (Array.isArray(pathsObj.final_paths) && pathsObj.final_paths[0]) ||
      (Array.isArray(payload.final_paths) && payload.final_paths[0]) ||
      payload.target_path || payload.download_path || payload.file_path || payload.final_path;
    const allFinalPaths = Array.isArray(pathsObj.final_paths) ? pathsObj.final_paths :
      (Array.isArray(payload.final_paths) ? payload.final_paths :
      (Array.isArray(pathsObj.final_paths_list) ? pathsObj.final_paths_list :
      (pathsObj.final_path ? [pathsObj.final_path] : (rawTarget ? [rawTarget] : []))));
    const title = taskObj.title || payload.title;
    const format = taskObj.format || payload.format || (rawTarget ? path.extname(rawTarget).replace('.', '') : 'epub');

    let task = taskId ? (this.state.tasks[taskId] || this.state.tasks[String(taskId)]) : null;
    if (task && taskObj.id && String(taskObj.id) !== String(task.taskId || task.id)) {
      return { ok: false, statusCode: 409, error: 'Task ID mismatch' };
    }
    if (task && allFinalPaths.length) task.finalPaths = allFinalPaths;

    if (!task && (title || rawTarget)) {
      const rawBase = path.basename(rawTarget || '').replace(/\.[^/.]+$/, '').trim().toLowerCase();
      const candTitle = (title || rawBase).trim().toLowerCase();
      const matchingTasks = [];
      for (const t of Object.values(this.state.tasks)) {
        if (t.status === 'queued' || t.status === 'downloading' || t.status === 'awaiting_file') {
          const tTitle = (t.title || '').trim().toLowerCase();
          const fmtMatch = !format || (t.format || '').toLowerCase() === format.toLowerCase();
          const titleMatch = tTitle === candTitle || rawBase === tTitle || rawBase.startsWith(tTitle + '_') || rawBase.startsWith(tTitle + ' ');
          // Require additional work identity evidence when available to avoid wrong-task attachment.
          let extraMatch = true;
          if (title && t.title && ID.normalizeString(t.title) !== ID.normalizeString(title)) extraMatch = false;
          if (payload.author && t.author && !ID.isAuthorMatch(t.author, payload.author)) extraMatch = false;
          if (fmtMatch && titleMatch && extraMatch) {
            matchingTasks.push(t);
          }
        }
      }
      if (matchingTasks.length === 1) {
        task = matchingTasks[0];
      } else if (matchingTasks.length > 1) {
        console.warn(`[Bridge] Ambiguous task match for "${candTitle}": multiple candidate tasks found. Refusing to guess.`);
      }
    }

    if (!task && (taskObj.requestIds || taskObj.requestId || payload.requestIds || payload.requestId)) {
      const rids = Array.isArray(taskObj.requestIds) ? taskObj.requestIds :
        (taskObj.requestId ? [taskObj.requestId] :
        (Array.isArray(payload.requestIds) ? payload.requestIds : (payload.requestId ? [payload.requestId] : [])));
      const now = new Date().toISOString();
      task = {
        taskId: taskId || `task-${Date.now()}`,
        id: taskId || `task-${Date.now()}`,
        title: taskObj.title || title || 'Unknown',
        author: taskObj.author || payload.author || 'Unknown',
        format: format || 'epub',
        status: 'queued',
        requestTitle: taskObj.requestTitle || title || null,
        requestAuthor: taskObj.requestAuthor || taskObj.author || payload.author || null,
        requestAuthors: taskObj.requestAuthors || (taskObj.author ? [taskObj.author] : []),
        requestLanguage: ID.normalizeLanguageCode(taskObj.requestLanguage || payload.requestLanguage) || 'en',
        requestIds: rids,
        userIds: taskObj.userIds || [],
        requestFulfillments: {},
        fulfilledRequestIds: [],
        unfulfilledRequestIds: [...rids],
        createdAt: now,
        updatedAt: now,
      };
      if (taskId) {
        this.state.tasks[taskId] = task;
        for (const rid of rids) {
          this.state.requests[rid] = taskId;
        }
        this.saveState();
      }
    }

    if (!task) {
      console.warn(`[Bridge] Webhook received for unassociated task: ${taskId || rawTarget}`);
      return { ok: true, statusCode: 200, message: 'Webhook received for unassociated task' };
    }

    // Strict file verification & containment with bounded visibility retries
    const candidatePaths = [...new Set([...(allFinalPaths || []), rawTarget, task?.filePath].filter(Boolean))];
    if (candidatePaths.length === 0) candidatePaths.push(rawTarget || task?.filePath);
    let targetFile = candidatePaths[0];
    let verification = null;
    for (const cp of candidatePaths) {
      if (!cp) continue;
      const v = await this.verifyFileWithRetry(cp, task.format);
      if (v.ok) {
        verification = v;
        targetFile = cp;
        break;
      }
      verification = v;
    }
    if (!verification) {
      verification = await this.verifyFileWithRetry(targetFile, task.format);
    }
    if (!verification.ok) {
      if (verification.notFound) {
        console.warn(`[Bridge] File not visible for task ${task.taskId}: ${verification.error}. Preserving recoverable awaiting_file state.`);
        task.status = 'awaiting_file';
        task.filePath = targetFile;
        task.error = verification.error;
        task.errorSource = 'companion_verification';
        task.updatedAt = new Date().toISOString();
        this.saveState();
        return {
          ok: true,
          statusCode: 200,
          status: 'awaiting_file',
          taskId: task.taskId,
          filePath: targetFile,
          requestIds: task.requestIds,
          message: `File not yet visible: ${verification.error}. Preserved as awaiting_file for subsequent reconciliation.`,
        };
      }

      console.error(`[Bridge] File verification failed for task ${task.taskId}: ${verification.error}`);
      task.status = 'failed';
      task.error = verification.error;
      task.errorSource = 'companion_verification';
      task.updatedAt = new Date().toISOString();
      this.saveState();
      return {
        ok: false,
        statusCode: 422,
        error: `File verification failed: ${verification.error}`,
      };
    }

    task.filePath = verification.safePath;
    task.sizeBytes = verification.sizeBytes;
    if (task.status !== 'fulfilled' && task.status !== 'imported') {
      task.status = 'completed';
    }
    task.error = null;
    task.errorSource = null;
    task.updatedAt = new Date().toISOString();
    this.saveState();

    // Schedule BookOrbit import/fulfillment in the background so the webhook
    // responds within Shelfmark's timeout. Finalization is deduplicated per task.
    let finalization = null;
    if (this.bookorbitUrl && task.status !== 'fulfilled') {
      const key = String(task.taskId || task.id || '');
      let promise = this._finalizationPromises.get(key);
      if (!promise) {
        promise = this.runExclusive(() => this.fulfillBookOrbitRequests(task, fetchFn))
          .catch((err) => {
            console.warn(`[Bridge] Background finalization failed for ${key}: ${sanitizeLog(err?.message || err)}`);
          })
          .finally(() => this._finalizationPromises.delete(key));
        this._finalizationPromises.set(key, promise);
      }
      finalization = promise;
    }

    return {
      ok: true,
      statusCode: 200,
      taskId: task.taskId,
      filePath: task.filePath,
      requestIds: task.requestIds,
      bookId: task.matchedBookId || null,
      fulfilled: task.status === 'fulfilled',
      finalization: task.status === 'fulfilled' ? 'already_fulfilled' : 'scheduled',
      error: null,
    };
  }

  async getAuthHeaders() {
    let token = '';
    try { token = await this.authManager.getValidToken(); } catch {}
    token = token || this.bookorbitToken || this.bookorbitApiKey;
    return {
      ...(token && isJwt(token) ? { 'Authorization': `Bearer ${token}` } : {}),
      ...(this.bookorbitApiKey ? { 'X-Api-Key': this.bookorbitApiKey } : {}),
    };
  }

  /**
   * Verifies that a specific bookId still exists in the target BookOrbit library
   * and that its edition remains compatible.
   *
   * Returns:
   *   'exists'        - Authoritatively found in library and edition is compatible
   *   'deleted'       - Authoritative query succeeded but bookId is missing from library
   *   'incompatible' - Book exists in library but edition is incompatible
   *   'unknown'       - Outage / auth failure / network error / ambiguous query (fail closed)
   */
  async listAuthoritativeLibraryBooks(targetLibraryId, headers, fetchFn = globalThis.fetch) {
    const libraryId = parsePositiveInt(targetLibraryId);
    if (!libraryId) return null;
    const url = `${this.bookorbitUrl}/api/v1/libraries/${libraryId}/books`;
    const size = 100;
    const all = [];
    try {
      for (let page = 0; page < 5; page++) {
        const result = await fetchFn(url, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: '', sort: [], pagination: { page, size } }),
        });
        if (!result?.ok) return null;
        const data = await result.json();
        if (!data || !Array.isArray(data.items)) return null;
        all.push(...data.items);
        const total = Number(data.total);
        if (Number.isFinite(total) && total >= 0) {
          if (all.length >= total) return all;
          if (data.items.length < size) return null;
        } else if (data.items.length < size) {
          return all;
        }
      }
    } catch (err) {
      console.warn(`[Bridge] Library membership lookup unavailable: ${sanitizeLog(err?.message || err)}`);
    }
    return null;
  }

  async verifyBookInLibrary(task, targetLibraryId, bookId, headers, fetchFn = globalThis.fetch) {
    const bId = parsePositiveInt(bookId);
    if (!bId) return 'deleted';
    const libId = parsePositiveInt(targetLibraryId);
    if (!libId) return 'unknown';

    const authHeaders = headers || await this.getAuthHeaders();
    const boUrl = this.bookorbitUrl;

    const evaluateCard = (card, ignoreTitleMismatch = false) => {
      const authors = Array.isArray(card?.authors) ? card.authors : [];
      const author = typeof card?.author === 'string' && card.author.trim()
        ? card.author : (typeof authors[0] === 'string' ? authors[0] : authors[0]?.name || '');
      const formats = Array.isArray(card?.formats)
        ? card.formats.map((f) => typeof f === 'string' ? f.toLowerCase() : String(f?.format || '').toLowerCase()) : [];
      const wantedFormat = String(task?.format || '').toLowerCase();
      const primaryFormat = String(card?.primaryFormat || card?.format || '').toLowerCase();
      const book = {
        ...card,
        id: bId,
        author: String(author).trim(),
        year: card?.year || card?.publishedYear || card?.publicationYear || card?.publishedDate || null,
        isbn: card?.isbn13 || card?.isbn || null,
        format: wantedFormat && formats.includes(wantedFormat) ? wantedFormat : primaryFormat,
      };
      const expectedAuthor = String(task?.author || (Array.isArray(task?.authors) ? task.authors[0] : '') || '').trim();
      const compatTask = { ...task, author: expectedAuthor, authors: expectedAuthor ? [expectedAuthor] : [] };
      const compatBook = { ...book, authors: book.author ? [book.author] : [] };
      if (!expectedAuthor || !book.author) {
        compatTask.author = '';
        compatTask.authors = [];
        compatBook.author = '';
        compatBook.authors = [];
      }
      if (ignoreTitleMismatch) {
        compatTask.title = book.title || compatTask.title;
        compatTask.bookTitle = book.title || compatTask.bookTitle;
        compatBook.title = book.title || compatBook.title;
        compatBook.bookTitle = book.title || compatBook.bookTitle;
      }

      // Always evaluate known edition fields, even when author metadata is missing.
      if (!areEditionsCompatible(compatTask, compatBook)) {
        return 'incompatible';
      }

      // Fail closed when no durable work/book identity can be established (title or year alone is insufficient).
      const taskIsbn = ID.normalizeIsbn(task?.isbn13 || task?.isbn || task?.extra?.isbn || '');
      const bookIsbn = ID.normalizeIsbn(book?.isbn13 || book?.isbn || '');
      const identityEstablished = Boolean(
        (expectedAuthor && book.author) ||
        (taskIsbn && bookIsbn && ID.sameIsbn(taskIsbn, bookIsbn))
      );
      if (!identityEstablished) {
        return 'unknown';
      }
      return 'exists';
    };

    // Library-scoped membership is authoritative for deletion in this library.
    const libraryBooks = await this.listAuthoritativeLibraryBooks(libId, authHeaders, fetchFn);
    if (libraryBooks === null) {
      return 'unknown';
    }
    const foundCard = libraryBooks.find((c) => parsePositiveInt(c?.id ?? c?.bookId) === bId);

    // Exact-ID route can refine edition/membership but is not trusted alone for deletion.
    let exactBook = null;
    let exactLibraryMismatch = false;
    if (boUrl) {
      try {
        const res = await fetchFn(`${boUrl}/api/v1/books/${bId}`, { headers: authHeaders });
        if (res?.ok) {
          const data = await res.json().catch(() => null);
          if (data) {
            const dataId = parsePositiveInt(data.id ?? data.bookId);
            if (!dataId || dataId === bId) {
              exactBook = data;
              const bookLibId = parsePositiveInt(data.libraryId ?? data.library?.id ?? data.library_id);
              if (bookLibId && bookLibId !== libId) {
                exactLibraryMismatch = true;
              }
            }
          }
        }
        // 404 and other failures are treated conservatively: do not declare deletion.
      } catch (err) {
        console.warn(`[Bridge] Exact book lookup unavailable: ${sanitizeLog(err?.message || err)}`);
      }
    }

    if (exactLibraryMismatch) {
      // The book exists in another library; that is not deletion.
      return 'unknown';
    }

    if (!foundCard) {
      // Authoritative library listing for this library does not contain this ID.
      return 'deleted';
    }

    if (exactBook) {
      return evaluateCard({ ...foundCard, ...exactBook }, true);
    }
    return evaluateCard(foundCard, true);
  }

  /**
   * Authoritatively searches BookOrbit library and books API to locate an existing book
   * for edition verification, handling 409 destination conflicts and uncertain upload reconciliation.
   */
  /**
   * Read actual BookOrbit v3.5.0 library book cards without inventing GET routes.
   * A failed, truncated or unauthorized query is UNKNOWN, never an empty library.
   */
  async listAuthoritativeBookOrbitBooks(task, targetLibraryId, headers, fetchFn = globalThis.fetch) {
    const libraryId = parsePositiveInt(targetLibraryId);
    const title = String(task?.bookTitle || task?.title || '').trim();
    if (!libraryId || !title || title.length > 200) return null;
    const url = `${this.bookorbitUrl}/api/v1/libraries/${libraryId}/books`;
    const size = 100;
    const queryPages = async (qStr) => {
      const items = [];
      for (let page = 0; page < 5; page++) {
        const result = await fetchFn(url, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: qStr, sort: [], pagination: { page, size } }),
        });
        if (!result?.ok) return null;
        const data = await result.json();
        if (!data || !Array.isArray(data.items)) return null;
        items.push(...data.items);
        const total = Number(data.total);
        // A shortened page when total says more results remain is not full evidence.
        if (Number.isFinite(total) && total >= 0) {
          if (items.length >= total) return items;
          if (data.items.length < size) return null;
        } else if (data.items.length < size) {
          return items;
        }
      }
      // A >500-match query is not complete evidence. Fail closed rather than guess.
      return null;
    };
    try {
      const primary = await queryPages(title);
      if (primary === null) return null;
      if (primary.length > 0) return primary;
      const canonical = ID.extractCoreTitle(task?.requestTitle || title, { author: task?.requestAuthor || task?.author || '' });
      if (canonical && canonical.length <= 200 && ID.normalizeString(canonical) !== ID.normalizeString(title)) {
        const fallback = await queryPages(canonical);
        if (fallback === null) return null;
        return fallback;
      }
      return primary;
    } catch (err) {
      console.warn(`[Bridge] Library lookup unavailable: ${sanitizeLog(err?.message || err)}`);
      return null;
    }
  }

  /**
   * Only adopt one uniquely identified, edition-compatible BookOrbit library book.
   * For an uncertain upload, prefer a NEW id absent from the pre-upload snapshot.
   * Without a snapshot, require a matching publication year or ISBN; title alone
   * is not proof of the correct edition (especially for multiple Frankenstein editions).
   */
  async findAuthoritativeBookOrbitBook(task, targetLibraryId, headers, fetchFn = globalThis.fetch, mode = 'conflict') {
    const cards = await this.listAuthoritativeBookOrbitBooks(task, targetLibraryId, headers, fetchFn);
    if (!cards) return null;
    const baselineKnown = task?.uploadBaselineChecked === true && Array.isArray(task.uploadBaselineIds);
    const beforeIds = new Set(baselineKnown ? task.uploadBaselineIds.map(Number) : []);
    const opf = String(task?.filePath || '').toLowerCase().endsWith('.epub')
      ? extractEpubMetadataFromFile(task.filePath) : null;
    const expectedYear = parsePositiveInt(task?.year || task?.publishedYear || task?.publicationYear || opf?.year);
    const expectedIsbn = String(task?.isbn13 || task?.isbn || task?.extra?.isbn || opf?.isbn || '')
      .replace(/[^0-9X]/gi, '');
    const expectedAuthor = String(task?.author || (Array.isArray(task?.authors) ? task.authors[0] : '') || opf?.author || '').trim();
    const matched = new Map();
    for (const card of cards) {
      const id = parsePositiveInt(card?.id ?? card?.bookId);
      if (!id) continue;
      const authors = Array.isArray(card.authors) ? card.authors : [];
      const author = typeof card.author === 'string' && card.author.trim()
        ? card.author : (typeof authors[0] === 'string' ? authors[0] : authors[0]?.name || '');
      const formats = Array.isArray(card.formats)
        ? card.formats.map((f) => typeof f === 'string' ? f.toLowerCase() : String(f?.format || '').toLowerCase()) : [];
      const wantedFormat = String(task?.format || '').toLowerCase();
      const primaryFormat = String(card.primaryFormat || card.format || '').toLowerCase();
      if (wantedFormat && ((formats.length && !formats.includes(wantedFormat)) ||
          (!formats.length && primaryFormat && primaryFormat !== wantedFormat))) continue;
      const book = {
        ...card, id, author: String(author).trim(),
        year: card.year || card.publishedYear || card.publicationYear || null,
        isbn: card.isbn13 || card.isbn || null,
        format: wantedFormat && formats.includes(wantedFormat) ? wantedFormat : primaryFormat,
      };
      // Both explicit title and author are required: missing metadata is not identity.
      if (!String(book.title || '').trim() || !expectedAuthor || !book.author) continue;
      if (!areEditionsCompatible({ ...task, author: expectedAuthor }, book)) continue;
      const newlyImported = baselineKnown && !beforeIds.has(id);
      if (mode === 'uncertain' && baselineKnown && !newlyImported) continue;
      matched.set(id, book);
    }
    if (matched.size === 1) return [...matched.values()][0];
    if (matched.size > 1) {
      const candidates = [...matched.values()];
      if (task?.matchedBookId && matched.has(task.matchedBookId)) {
        return matched.get(task.matchedBookId);
      }
      try {
        if (task?.filePath && fs.existsSync(task.filePath)) {
          const fileBuf = fs.readFileSync(task.filePath);
          const hash = crypto.createHash('md5').update(fileBuf).digest('hex');
          const hashMatch = candidates.find((b) => Array.isArray(b.files) && b.files.some((f) => f.fileHash === hash));
          if (hashMatch) return hashMatch;
        }
      } catch {}
      if (expectedIsbn) {
        const isbnMatches = candidates.filter((b) => {
          const obs = ID.normalizeIsbn(b.isbn || '');
          return obs && ID.sameIsbn(expectedIsbn, obs);
        });
        if (isbnMatches.length === 1) return isbnMatches[0];
      }
      if (mode === 'conflict') {
        const baseName = path.basename(task.filePath || '');
        const destMatch = candidates.find((b) => {
          const files = Array.isArray(b.files) ? b.files : [];
          return files.some((f) => f.filename === baseName || f.filename === `${b.title}.${b.format}`);
        });
        if (destMatch) return destMatch;
        return candidates[candidates.length - 1];
      }
    }
    return null;
  }
  /**
   * Uploads file directly into BookOrbit Library:
   * POST /api/v1/libraries/:id/upload?folderId=:folderId
   * Accepts multipart/form-data with file field "file".
   */
  async uploadDirectToLibrary(task, targetLibraryId, targetFolderId, headers, fetchFn = globalThis.fetch) {
    const boUrl = this.bookorbitUrl;
    let uploadUrl = `${boUrl}/api/v1/libraries/${encodeURIComponent(targetLibraryId)}/upload`;
    if (targetFolderId) {
      uploadUrl += `?folderId=${encodeURIComponent(targetFolderId)}`;
    }

    const fileName = path.basename(task.filePath);
    const fileData = fs.readFileSync(task.filePath);

    const boundary = `----BookOrbitDirectBoundary${Date.now()}`;
    const multipartBody = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      fileData,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const uploadHeaders = {
      ...headers,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    };

    let uploadRes;
    try {
      uploadRes = await fetchFn(uploadUrl, {
        method: 'POST',
        headers: uploadHeaders,
        body: multipartBody,
      });
    } catch (err) {
      return { error: `Network error during direct library upload: ${sanitizeLog(err.message)}`, networkError: true };
    }

    if (uploadRes.status === 404) {
      return { notFound: true };
    }

    if (uploadRes.ok) {
      const data = await uploadRes.json().catch(() => ({}));
      const bookId = parsePositiveInt(data.bookId || data.id || data.book?.id);
      if (!bookId) {
        // A 2xx response without book ID is an uncertain upload, not a missing route.
        return { networkError: true, error: 'Upload succeeded but returned no usable book ID' };
      }
      return { success: true, bookId };
    }

    if (uploadRes.status === 409) {
      // Conflict: Book already exists. Inspect whether it is genuinely the same edition.
      const conflictData = await uploadRes.json().catch(() => ({}));
      const existingBook = conflictData.existingBook || conflictData.book || (conflictData.title || conflictData.name ? conflictData : null);
      let existingBookId = parsePositiveInt(conflictData.id || conflictData.bookId || existingBook?.id);

      if (existingBook && (existingBook.title || existingBook.name)) {
        if (areEditionsCompatible(task, existingBook)) {
          if (existingBookId) {
            return { success: true, bookId: existingBookId, adoptedFromConflict: true };
          }
        } else {
          return {
            conflict: true,
            error: `Direct upload conflict (409): existing book "${existingBook.title || existingBook.name}" (${existingBook.year || 'unknown year'}) is an incompatible edition with requested "${task.title}" (${task.year || 'unknown year'})`,
          };
        }
      }

      if (existingBookId) {
        try {
          const bookRes = await fetchFn(`${boUrl}/api/v1/books/${existingBookId}`, { headers });
          if (bookRes.ok) {
            const fetchedBook = await bookRes.json().catch(() => ({}));
            if (areEditionsCompatible(task, fetchedBook)) {
              return { success: true, bookId: existingBookId, adoptedFromConflict: true };
            } else {
              return {
                conflict: true,
                error: `Direct upload conflict (409): verified existing book ${existingBookId} is an incompatible edition`,
              };
            }
          }
        } catch {}
      }

      // If 409 response did NOT contain a usable existing book ID:
      // Authoritatively inspect BookOrbit library books!
      const authoritativeBook = await this.findAuthoritativeBookOrbitBook(task, targetLibraryId, headers, fetchFn, 'conflict');
      if (authoritativeBook) {
        if (areEditionsCompatible(task, authoritativeBook)) {
          return { success: true, bookId: authoritativeBook.id, adoptedFromConflict: true };
        } else {
          return {
            conflict: true,
            error: `Direct upload conflict (409): destination file belongs to existing book "${authoritativeBook.title || authoritativeBook.name}" (${authoritativeBook.year || 'unknown year'}) which is an incompatible edition with requested "${task.title}" (${task.year || 'unknown year'})`,
          };
        }
      }

      return {
        conflict: true,
        error: `Direct upload conflict (409): could not authoritatively verify edition compatibility of existing book at destination`,
      };
    }

    const errText = await uploadRes.text().catch(() => '');
    return { error: `Direct upload failed (HTTP ${uploadRes.status}): ${sanitizeLog(errText)}` };
  }

  /**
   * Uploads file via Book Dock fallback:
   * POST /api/v1/book-dock/upload -> wait ready -> POST /api/v1/book-dock/finalize
   */
  async uploadViaBookDock(task, targetLibraryId, targetFolderId, headers, fetchFn = globalThis.fetch) {
    const boUrl = this.bookorbitUrl;
    let bookDockFileId = task.dockFileId || null;
    let readyToFinalize = false;
    let isAlreadyFinalized = false;
    let matchedBookId = null;

    if (!bookDockFileId) {
      try {
        const fileName = path.basename(task.filePath);
        const fileData = fs.readFileSync(task.filePath);

        const boundary = `----BookOrbitBoundary${Date.now()}`;
        const multipartBody = Buffer.concat([
          Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
          fileData,
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]);

        const uploadHeaders = {
          ...headers,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        };

        const uploadRes = await fetchFn(`${boUrl}/api/v1/book-dock/upload`, {
          method: 'POST',
          headers: uploadHeaders,
          body: multipartBody,
        });

        if (uploadRes.ok) {
          const uploadJson = await uploadRes.json().catch(() => ({}));
          bookDockFileId = uploadJson.id ?? uploadJson.fileId ?? uploadJson.file_id;
          task.dockFileId = bookDockFileId;
          if ((uploadJson.status || '').toLowerCase() === 'ready') {
            readyToFinalize = true;
          }
          this.saveState();
        } else {
          const errText = await uploadRes.text().catch(() => '');
          return { success: false, error: `Book Dock upload failed (HTTP ${uploadRes.status}): ${errText}` };
        }
      } catch (err) {
        return { success: false, error: `Book Dock upload error: ${err.message}` };
      }
    }

    if (!bookDockFileId) {
      return { success: false, error: 'Book Dock file ID could not be obtained' };
    }

    // Wait for upload to reach ready
    if (!readyToFinalize) {
      try {
        for (let attempt = 0; attempt < this.dockReadinessAttempts; attempt++) {
          const checkRes = await fetchFn(`${boUrl}/api/v1/book-dock/files/${encodeURIComponent(bookDockFileId)}`, { headers });
          if (checkRes.ok) {
            const fileInfo = await checkRes.json().catch(() => ({}));
            const fileStatus = (fileInfo.status || '').toLowerCase();
            if (fileStatus === 'filed' || fileStatus === 'finalized') {
              const bId = parsePositiveInt(fileInfo.bookId || fileInfo.book_id || fileInfo.book?.id);
              if (bId) {
                isAlreadyFinalized = true;
                matchedBookId = bId;
                break;
              } else {
                return { success: false, finalizationFailed: true, error: 'Book Dock file reported filed but missing valid bookId' };
              }
            }
            if (fileStatus === 'ready') {
              readyToFinalize = true;
              break;
            }
            if (fileStatus === 'error' || fileStatus === 'failed') {
              return { success: false, finalizationFailed: true, error: fileInfo.errorMessage || fileInfo.error || fileInfo.message || 'Book Dock file reported error state' };
            }
          }
          await new Promise((r) => setTimeout(r, this.dockReadinessIntervalMs));
        }
      } catch (err) {
        console.warn(`[Bridge] Book Dock check exception: ${sanitizeLog(err.message)}`);
      }
    }

    if (!readyToFinalize && !isAlreadyFinalized && !matchedBookId) {
      return { success: false, finalizationFailed: true, error: `Book Dock file ${bookDockFileId} timed out waiting for ready state (still processing)` };
    }

    // Finalize into Library
    if (!matchedBookId && !isAlreadyFinalized) {
      if (!targetLibraryId || !targetFolderId) {
        return {
          success: false,
          finalizationFailed: true,
          error: `Finalization requires a library and a folder: destination library or folder ID is unconfigured or invalid (library: ${targetLibraryId}, folder: ${targetFolderId})`,
        };
      }

      try {
        const finalizePayload = {
          fileIds: [bookDockFileId],
          defaultLibraryId: targetLibraryId,
          defaultFolderId: targetFolderId,
        };

        const finalizeRes = await fetchFn(`${boUrl}/api/v1/book-dock/finalize`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(finalizePayload),
        });

        if (!finalizeRes.ok) {
          const errText = await finalizeRes.text().catch(() => '');
          return { success: false, finalizationFailed: true, error: `Book Dock finalize HTTP ${finalizeRes.status}: ${errText}` };
        }

        const finalizeJson = await finalizeRes.json().catch(() => ({}));
        const resultItem = finalizeJson.results?.find((r) => String(r?.fileId ?? r?.file_id ?? r?.id) === String(bookDockFileId)) || finalizeJson.results?.[0];

        const duplicateBookId = resultItem?.isDuplicate ? parsePositiveInt(resultItem?.existingBookId) : null;
        const resultBookId = duplicateBookId || parsePositiveInt(resultItem?.bookId || resultItem?.book_id);
        const isSuccess = Boolean(resultItem) && (resultItem.success === true || resultItem.isDuplicate === true) && Boolean(resultBookId);
        if (!resultItem || !isSuccess) {
          return { success: false, finalizationFailed: true, error: resultItem?.message || 'Finalization returned failed or needs review' };
        }

        matchedBookId = resultBookId;
      } catch (err) {
        return { success: false, finalizationFailed: true, error: `Book Dock finalize error: ${err.message}` };
      }
    }

    if (!matchedBookId) {
      return { success: false, finalizationFailed: true, error: 'Finalization did not yield a valid BookOrbit book ID' };
    }

    return { success: true, bookId: matchedBookId, dockFileId: bookDockFileId };
  }

  /**
   * Imports completed file into BookOrbit and fulfills matching requests using
   * real BookOrbit v3.5.0 controllers and DTOs:
   * 1. Direct library upload (POST /api/v1/libraries/:id/upload?folderId=:folderId),
   *    falling back to Book Dock staging if direct upload is 404
   * 2. Persists matchedBookId before attempting fulfillment so uploads are never repeated
   * 3. Fulfills Book Requests independently per request ID (POST /api/v1/admin/book-requests/:id/fulfill)
   */
  /**
   * Account a failed task attempt for all its requests and unmap them so another
   * source/candidate can be tried, subject to maxSourceAttempts.
   */
  recordTaskFailureAttempts(task, errorType = 'finalization_failed', fetchFn = globalThis.fetch) {
    const now = new Date().toISOString();
    const attemptId = `${errorType}:${task.taskId}`;
    if (task.releaseKey) {
      if (this.state.releases && this.state.releases[task.releaseKey] === (task.taskId || task.id)) {
        delete this.state.releases[task.releaseKey];
      }
      this.state.failedReleases = this.state.failedReleases || {};
      this.state.failedReleases[task.releaseKey] = {
        releaseKey: task.releaseKey,
        source: task.source,
        sourceId: task.sourceId,
        failedAt: now,
        error: task.error || errorType,
      };
    }
    for (const rid of (task.requestIds || [])) {
      if (task.requestFulfillments?.[rid]?.fulfilled) continue;
      this.state.requestTasks = this.state.requestTasks || {};
      this.state.requestTasks[rid] = task.taskId || task.id;
      this.state.requestAttempts[rid] = this.state.requestAttempts[rid] || [];
      if (!this.state.requestAttempts[rid].some((a) => a.attemptId === attemptId)) {
        this.state.requestAttempts[rid].push({ attemptId, taskId: task.taskId, releaseKey: task.releaseKey, timestamp: now, error: task.error });
      }
      const attempts = Math.max(this.state.requestAttempts[rid].length, (this.state.requestSourceAttempts[rid] || 0) + 1);
      this.state.requestSourceAttempts[rid] = attempts;
      this.state.requestErrors[rid] = { error: task.error, errorType, lastAttemptAt: now, attempts: this.state.requestSourceAttempts[rid] };
      delete this.state.requests[rid];
      if ((this.state.requestSourceAttempts[rid] || 0) < this.maxSourceAttempts) {
        this.setRequestProgress(rid, errorType, { reason: errorType, error: task.error });
      } else {
        console.warn(`[Bridge] Request ${rid} reached max source attempts (${attempts}/${this.maxSourceAttempts}) on ${errorType}. Terminally rejecting in BookOrbit.`);
        this.setRequestProgress(rid, 'exhausted', { reason: errorType, error: task.error });
        this.rejectBookOrbitRequest(rid, {
          stage: errorType,
          reason: task.error || errorType,
          task,
        }, fetchFn).catch((err) => {
          console.warn(`[Bridge] Terminal reject error for request ${rid}: ${sanitizeLog(err.message)}`);
        });
      }
    }
  }

  async fulfillBookOrbitRequests(task, fetchFn = globalThis.fetch) {
    const key = String(task?.taskId || task?.id || '');
    const prev = this._fulfillLocks.get(key) || Promise.resolve();
    let resolveLock;
    const lock = new Promise((r) => { resolveLock = r; });
    this._fulfillLocks.set(key, lock);
    await prev;
    try {
      return await this._fulfillBookOrbitRequestsImpl(task, fetchFn);
    } finally {
      resolveLock();
      if (this._fulfillLocks.get(key) === lock) this._fulfillLocks.delete(key);
    }
  }

  async _fulfillBookOrbitRequestsImpl(task, fetchFn = globalThis.fetch) {
    const boUrl = this.bookorbitUrl;
    let token = '';
    try {
      token = await this.authManager.getValidToken();
    } catch {}
    token = token || this.bookorbitToken || this.bookorbitApiKey;

    const headers = {
      ...(token && isJwt(token) ? { 'Authorization': `Bearer ${token}` } : {}),
      ...(this.bookorbitApiKey ? { 'X-Api-Key': this.bookorbitApiKey } : {}),
    };
    let matchedBookId = parsePositiveInt(task.matchedBookId) || null;
    // A transient 401/403/network error is UNKNOWN, not evidence of cancellation.
    // Never let a status outage mark a completed Shelfmark task permanently cancelled.
    const activeRequestIds = [];
    const unknownRequestIds = [];
    let explicitlyCancelled = 0;
    let alreadyAvailable = 0;
    if (!task.requestFulfillments) task.requestFulfillments = {};
    for (const rid of (task.requestIds || [])) {
      // A prior successful fulfillment is durable proof; a later API outage must
      // not overwrite it or cause a duplicate POST.
      if (task.requestFulfillments[rid]?.fulfilled) {
        alreadyAvailable++;
        continue;
      }
      const ridState = await this.getRequestStatus(rid, fetchFn);
      if (ridState === 'fulfilled') {
        task.requestFulfillments[rid] = {
          fulfilled: true, alreadyAvailable: true, fulfilledAt: new Date().toISOString(),
        };
        alreadyAvailable++;
        this.setRequestProgress(rid, 'available', { reason: 'already_available' });
      } else if (ridState === 'cancelled') {
        explicitlyCancelled++;
        task.requestFulfillments[rid] = {
          fulfilled: false, errorType: 'cancelled', error: 'Request cancelled',
          updatedAt: new Date().toISOString(),
        };
        this.setRequestProgress(rid, 'cancelled', { reason: 'cancelled' });
      } else if (ridState === 'active') {
        activeRequestIds.push(rid);
      } else {
        unknownRequestIds.push(rid);
        task.requestFulfillments[rid] = {
          fulfilled: false, errorType: 'status_unknown', error: 'Request status unknown',
          updatedAt: new Date().toISOString(),
        };
        this.setRequestProgress(rid, 'status_unknown', { reason: 'status_unknown' });
      }
    }
    this.saveState();
    if ((task.requestIds || []).length > 0 && activeRequestIds.length === 0) {
      if (unknownRequestIds.length > 0) {
        // Keep completed/imported/uncertain_upload recoverable for reconciliation.
        task.error = `BookOrbit request status temporarily unknown for ${unknownRequestIds.length} request(s)`;
        this.saveState();
        return { fulfilled: false, error: task.error };
      }
      task.fulfilledRequestIds = task.requestIds.filter((id) => task.requestFulfillments[id]?.fulfilled);
      task.unfulfilledRequestIds = task.requestIds.filter((id) => !task.requestFulfillments[id]?.fulfilled);
      task.status = explicitlyCancelled === task.requestIds.length ? 'cancelled'
        : task.unfulfilledRequestIds.length ? 'partially_fulfilled' : 'fulfilled';
      task.updatedAt = new Date().toISOString();
      this.saveState();
      return { fulfilled: task.status === 'fulfilled', count: alreadyAvailable,
        bookId: matchedBookId, error: task.status === 'cancelled' ? 'All requests cancelled' : undefined };
    }
    for (const rid of activeRequestIds) {
      this.setRequestProgress(rid, 'importing', { reason: 'importing' });
    }

    const rawLibraryId = task.libraryId ?? this.defaultLibraryId;
    const rawFolderId = task.folderId ?? this.defaultFolderId;
    const targetLibraryId = parsePositiveInt(rawLibraryId);
    const targetFolderId = parsePositiveInt(rawFolderId);

    // Verify existing matchedBookId is still in the correct BookOrbit library
    if (matchedBookId && targetLibraryId && boUrl) {
      const bookStatus = await this.verifyBookInLibrary(task, targetLibraryId, matchedBookId, headers, fetchFn);
      if (bookStatus === 'deleted') {
        console.warn(`[Bridge] Book ${matchedBookId} was definitively deleted from BookOrbit library ${targetLibraryId}; invalidating stale mapping.`);
        matchedBookId = null;
        task.matchedBookId = null;
        task.dockFileId = null;
        delete task.uploadBaselineChecked;
        delete task.uploadBaselineIds;
        delete task.uncertainUpload;
        if (task.status === 'fulfilled' || task.status === 'imported') {
          task.status = 'completed';
        }
        this.saveState();
      } else if (bookStatus === 'unknown' || bookStatus === 'incompatible') {
        console.warn(`[Bridge] BookOrbit library check ${bookStatus} for book ${matchedBookId}; failing closed without re-uploading or invalidating.`);
        task.error = bookStatus === 'incompatible'
          ? 'BookOrbit library book is an incompatible edition'
          : 'BookOrbit library verification unavailable';
        this.saveState();
        return { fulfilled: false, bookId: matchedBookId, error: task.error };
      }
    }

    // Step 1: Import file into Library if not already uploaded/matched
    if (!matchedBookId) {
      if (!task.filePath) {
        task.status = 'finalization_failed';
        task.error = 'Task filePath is missing';
        this.recordTaskFailureAttempts(task, 'finalization_failed', fetchFn);
        this.saveState();
        if ((task.requestIds || []).some((rid) => (this.state.requestSourceAttempts[rid] || 0) < this.maxSourceAttempts)) {
          this.triggerProcessPendingRequests(100);
        }
        return { fulfilled: false, error: task.error };
      }

      // Stage 2: Authoritatively verify downloaded file metadata against each active request's
      // title, author, language, ISBN/counterparts, and publication year BEFORE any upload.
      const nowVer = new Date().toISOString();
      const requestsToVerify = activeRequestIds.length > 0 ? activeRequestIds : (task.requestIds?.length ? task.requestIds : ['']);
      const verifiedActiveIds = [];
      let firstFailedVer = null;

      for (const rid of requestsToVerify) {
        if (rid && task.requestFulfillments?.[rid]?.fulfilled) continue;
        const ver = verifyDownloadedEdition(task, { requestId: rid || undefined });
        const verStage = ver.ok
          ? 'verified'
          : (ver.errorType === 'finalization_failed' ? 'finalization_failed' : 'review_required');

        task.verificationEvidence = ver.evidence;
        task.verificationConflicts = ver.conflicts;

        if (rid) {
          this.state.requestVerification = this.state.requestVerification || {};
          this.state.requestVerification[rid] = {
            ok: ver.ok,
            taskId: task.taskId || task.id || null,
            releaseKey: task.releaseKey || null,
            stage: verStage,
            errorType: ver.errorType || null,
            primaryConflict: ver.primaryConflict || null,
            conflicts: ver.conflicts || [],
            evidence: ver.evidence || [],
            error: ver.error || null,
            observedTitle: ver.opf?.rawTitle || ver.opf?.title || task.title || null,
            observedAuthor: ver.opf?.author || task.author || null,
            verifiedAt: nowVer,
          };
        }

        if (ver.ok) {
          verifiedActiveIds.push(rid);
          if (ver.opf) {
            if (!task.year && ver.opf.year) task.year = ver.opf.year;
            if (!task.isbn && ver.opf.isbn) task.isbn = ver.opf.isbn;
          }
        } else {
          if (!firstFailedVer) firstFailedVer = ver;
          if (rid) {
            task.requestFulfillments[rid] = {
              fulfilled: false,
              errorType: ver.primaryConflict || ver.errorType || 'edition_verification_failed',
              error: ver.error,
              updatedAt: nowVer,
            };
            const attemptId = `edition:${task.taskId || task.id}:${rid}`;
            this.state.requestAttempts[rid] = this.state.requestAttempts[rid] || [];
            if (!this.state.requestAttempts[rid].some((a) => a.attemptId === attemptId)) {
              this.state.requestAttempts[rid].push({
                attemptId,
                taskId: task.taskId,
                releaseKey: task.releaseKey,
                timestamp: nowVer,
                error: ver.error,
              });
            }
            const attempts = Math.max(this.state.requestAttempts[rid].length, (this.state.requestSourceAttempts[rid] || 0) + 1);
            this.state.requestSourceAttempts[rid] = attempts;
            this.state.requestErrors[rid] = {
              error: ver.error,
              errorType: ver.errorType || 'edition_verification_failed',
              conflict: ver.primaryConflict || null,
              lastAttemptAt: nowVer,
              attempts: this.state.requestSourceAttempts[rid],
            };
            this.state.requestTasks = this.state.requestTasks || {};
            this.state.requestTasks[rid] = task.taskId || task.id;
            delete this.state.requests[rid];
            if ((this.state.requestSourceAttempts[rid] || 0) < this.maxSourceAttempts) {
              this.setRequestProgress(rid, verStage, {
                reason: ver.errorType || 'edition_verification_failed',
                conflict: ver.primaryConflict || undefined,
              });
            } else {
              console.warn(`[Bridge] Request ${rid} reached max source attempts (${attempts}/${this.maxSourceAttempts}) on edition verification. Terminally rejecting in BookOrbit.`);
              this.setRequestProgress(rid, 'exhausted', {
                reason: ver.errorType || 'edition_verification_failed',
                conflict: ver.primaryConflict || undefined,
              });
              await this.rejectBookOrbitRequest(rid, {
                stage: verStage,
                reason: ver.error,
                conflicts: ver.conflicts,
                task,
              }, fetchFn);
            }
          }
        }
      }

      if (verifiedActiveIds.length === 0 && firstFailedVer) {
        task.error = firstFailedVer.error;
        task.verificationFailed = true;
        task.editionVerificationFailed = true;
        if (firstFailedVer.errorType === 'finalization_failed') {
          task.status = 'finalization_failed';
          delete task.errorSource;

          // Dismiss completed download task from Shelfmark activity so it does not report complete: 1
          if (this.shelfmarkUrl && (task.taskId || task.id)) {
            const smDismissId = task.taskId || task.id;
            try {
              const dismissHeaders = {
                'Content-Type': 'application/json',
                ...(this.shelfmarkApiKey ? { 'X-Api-Key': this.shelfmarkApiKey, 'Authorization': `Bearer ${this.shelfmarkApiKey}` } : {}),
              };
              await fetchFn(`${this.shelfmarkUrl}/api/activity/dismiss`, {
                method: 'POST',
                headers: dismissHeaders,
                body: JSON.stringify({ item_type: 'download', item_key: `download:${smDismissId}` }),
              }).catch(() => {});
            } catch (_) {}
          }
        } else {
          task.status = 'review_required';
          task.errorSource = firstFailedVer.languageReviewRequired
            ? 'companion_language_review'
            : 'companion_verification_review';
        }
        if (task.releaseKey && this.state.releases[task.releaseKey] === (task.taskId || task.id)) {
          delete this.state.releases[task.releaseKey];
        }
        if (task.releaseKey) {
          this.state.failedReleases[task.releaseKey] = {
            releaseKey: task.releaseKey,
            source: task.source,
            sourceId: task.sourceId,
            failedAt: nowVer,
            error: task.error,
          };
        }
        this.saveState();
        if ((task.requestIds || []).some((rid) => (this.state.requestSourceAttempts[rid] || 0) < this.maxSourceAttempts)) {
          this.triggerProcessPendingRequests(100);
        }
        return { fulfilled: false, error: task.error };
      }

      // Reconcile uncertain upload state: check authoritative BookOrbit library before re-uploading
      if (task.status === 'uncertain_upload' || task.uncertainUpload) {
        const resolved = await this.findAuthoritativeBookOrbitBook(task, targetLibraryId, headers, fetchFn, 'uncertain');
        if (resolved && areEditionsCompatible(task, resolved)) {
          matchedBookId = resolved.id;
          task.matchedBookId = matchedBookId;
          task.status = 'imported';
          delete task.uncertainUpload;
          task.updatedAt = new Date().toISOString();
          this.saveState();
        } else {
          task.status = 'uncertain_upload';
          task.error = 'Upload outcome remains uncertain; not reuploading';
          this.saveState();
          return { fulfilled: false, error: task.error };
        }
      }

      if (!matchedBookId) {
        // If dockFileId already exists on task, continue Book Dock staging directly
        if (false) {
        } else {
          // Try direct library upload first if library and folder are configured
          let directResult = { notFound: true };
          if (targetLibraryId) {
            // Capture a read-only baseline before any potentially non-idempotent POST.
            if (task.uploadBaselineChecked !== true) {
              const before = await this.listAuthoritativeBookOrbitBooks(task, targetLibraryId, headers, fetchFn);
              if (before !== null) {
                task.uploadBaselineChecked = true;
                task.uploadBaselineIds = before.map((b) => parsePositiveInt(b?.id ?? b?.bookId)).filter(Boolean);
                this.saveState();
              }
            }
            directResult = await this.uploadDirectToLibrary(task, targetLibraryId, targetFolderId, headers, fetchFn);
          }
          if (directResult.success && directResult.bookId) {
            matchedBookId = directResult.bookId;
            task.matchedBookId = matchedBookId;
            task.uploadMethod = 'direct';
            task.status = 'imported';
            delete task.uncertainUpload;
            task.updatedAt = new Date().toISOString();
            this.saveState(); // PERSISTED IMMEDIATELY BEFORE FULFILLMENT!
          } else if (directResult.conflict) {
            task.status = 'finalization_failed';
            task.error = directResult.error;
            this.recordTaskFailureAttempts(task, 'finalization_failed', fetchFn);
            this.saveState();
            if ((task.requestIds || []).some((rid) => (this.state.requestSourceAttempts[rid] || 0) < this.maxSourceAttempts)) {
              this.triggerProcessPendingRequests(100);
            }
            return { fulfilled: false, error: task.error };
          } else if (directResult.notFound) {
            task.status = 'finalization_failed';
            task.error = directResult.error || 'Direct library upload endpoint not available';
            this.recordTaskFailureAttempts(task, 'finalization_failed', fetchFn);
            this.saveState();
            if ((task.requestIds || []).some((rid) => (this.state.requestSourceAttempts[rid] || 0) < this.maxSourceAttempts)) {
              this.triggerProcessPendingRequests(100);
            }
            return { fulfilled: false, error: task.error };
          } else if (directResult.networkError) {
            task.status = 'uncertain_upload';
            task.uncertainUpload = {
              libraryId: targetLibraryId,
              folderId: targetFolderId,
              fileName: path.basename(task.filePath),
              attemptedAt: new Date().toISOString(),
            };
            task.error = directResult.error;
            this.saveState();
            return { fulfilled: false, error: task.error };
          } else {
            task.status = 'finalization_failed';
            task.error = directResult.error;
            this.recordTaskFailureAttempts(task, 'finalization_failed', fetchFn);
            this.saveState();
            if ((task.requestIds || []).some((rid) => (this.state.requestSourceAttempts[rid] || 0) < this.maxSourceAttempts)) {
              this.triggerProcessPendingRequests(100);
            }
            return { fulfilled: false, error: task.error };
          }
        }
      }
    }

    if (!matchedBookId) {
      task.status = 'finalization_failed';
      task.error = 'Finalization did not yield a valid BookOrbit book ID';
      this.recordTaskFailureAttempts(task, 'finalization_failed', fetchFn);
      this.saveState();
      if ((task.requestIds || []).some((rid) => (this.state.requestSourceAttempts[rid] || 0) < this.maxSourceAttempts)) {
        this.triggerProcessPendingRequests(100);
      }
      return { fulfilled: false, error: task.error };
    }

    // Step 2: Fulfill Book Requests independently per request ID
    // CRITICAL: Preserve successful requestFulfillments across reconciliation runs!
    // Do not reset successful per-request results merely because a task re-enters completed state.
    if (!task.requestFulfillments) {
      task.requestFulfillments = {};
    } else if ((task.status === 'completed' || task.status === 'imported') && Object.values(task.requestFulfillments).some((r) => r?.fulfilled) && Object.values(task.requestFulfillments).some((r) => !r?.fulfilled)) {
      // Partially fulfilled task in completed state: preserve successful results, retry only unfulfilled
      for (const [id, r] of Object.entries(task.requestFulfillments)) {
        if (!r?.fulfilled) {
          delete task.requestFulfillments[id];
        }
      }
    }

    let fulfilledCount = 0;
    for (const reqId of task.requestIds) {
      if (task.requestFulfillments[reqId]?.fulfilled) {
        fulfilledCount++;
        continue;
      }
      const step2State = await this.getRequestStatus(reqId, fetchFn);
      if (step2State === 'fulfilled') {
        task.requestFulfillments[reqId] = {
          fulfilled: true, alreadyAvailable: true, fulfilledAt: new Date().toISOString(),
        };
        fulfilledCount++;
        this.saveState();
        continue;
      }
      if (step2State === 'cancelled') {
        task.requestFulfillments[reqId] = {
          fulfilled: false,
          errorType: 'cancelled',
          error: 'Request cancelled',
          updatedAt: new Date().toISOString(),
        };
        this.setRequestProgress(reqId, 'cancelled', { reason: 'cancelled' });
        this.saveState();
        continue;
      }
      if (step2State !== 'active') {
        task.requestFulfillments[reqId] = {
          fulfilled: false,
          errorType: 'status_unknown',
          error: 'Request status unknown',
          updatedAt: new Date().toISOString(),
        };
        this.setRequestProgress(reqId, 'status_unknown', { reason: 'status_unknown' });
        this.saveState();
        continue;
      }
      const hasExplicitReqConstraint = Boolean(
        task.requestIsbns?.[reqId] ||
        task.requestYears?.[reqId] ||
        task.requestTitles?.[reqId] ||
        task.requestAuthorsMap?.[reqId] ||
        task.requestLanguages?.[reqId] ||
        task.requestIsbn ||
        task.requestYear
      );
      if (hasExplicitReqConstraint) {
        const ver2 = verifyDownloadedEdition(task, { requestId: reqId });
        const nowVer2 = new Date().toISOString();
        const verStage2 = ver2.ok
          ? 'verified'
          : (ver2.errorType === 'finalization_failed' ? 'finalization_failed' : 'review_required');
        this.state.requestVerification = this.state.requestVerification || {};
        this.state.requestVerification[reqId] = {
          ok: ver2.ok,
          taskId: task.taskId || task.id || null,
          releaseKey: task.releaseKey || null,
          stage: verStage2,
          errorType: ver2.errorType || null,
          primaryConflict: ver2.primaryConflict || null,
          conflicts: ver2.conflicts || [],
          evidence: ver2.evidence || [],
          error: ver2.error || null,
          verifiedAt: nowVer2,
        };
        if (!ver2.ok) {
          const errType2 = ver2.primaryConflict || ver2.errorType || 'edition_verification_failed';
          task.requestFulfillments[reqId] = {
            fulfilled: false,
            errorType: errType2,
            error: ver2.error,
            updatedAt: nowVer2,
          };
          this.setRequestProgress(reqId, verStage2, {
            reason: ver2.errorType || errType2,
            conflict: ver2.primaryConflict || undefined,
          });
          const attemptId = `edition:${task.taskId || task.id}:${reqId}`;
          this.state.requestAttempts[reqId] = this.state.requestAttempts[reqId] || [];
          if (!this.state.requestAttempts[reqId].some((a) => a.attemptId === attemptId)) {
            this.state.requestAttempts[reqId].push({
              attemptId,
              taskId: task.taskId,
              releaseKey: task.releaseKey,
              timestamp: nowVer2,
              error: ver2.error,
            });
          }
          const attempts = this.state.requestAttempts[reqId].length;
          this.state.requestSourceAttempts[reqId] = Math.max(this.state.requestSourceAttempts[reqId] || 0, attempts);
          this.state.requestErrors[reqId] = {
            error: ver2.error,
            errorType: ver2.errorType || errType2,
            conflict: ver2.primaryConflict || null,
            lastAttemptAt: nowVer2,
            attempts: this.state.requestSourceAttempts[reqId],
          };
          if ((this.state.requestSourceAttempts[reqId] || 0) < this.maxSourceAttempts) {
            delete this.state.requests[reqId];
          }
          if (ver2.isbnFailure) task.isbnVerificationFailed = true;
          this.saveState();
          if ((this.state.requestSourceAttempts[reqId] || 0) < this.maxSourceAttempts) {
            this.triggerProcessPendingRequests(100);
          }
          continue;
        }
      }

      try {
        const fulfillDto = {
          matchedBookId,
          ...(task.dockFileId ? { bookDockFileId: task.dockFileId } : {}),
          note: `Automatically fulfilled via Shelfmark task ${task.taskId}`,
        };

        const fulfillRes = await fetchFn(`${boUrl}/api/v1/admin/book-requests/${encodeURIComponent(reqId)}/fulfill`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(fulfillDto),
        });

        if (fulfillRes.ok) {
          const fulfillData = await fulfillRes.json().catch(() => ({}));
          const fulfillStatus = String(fulfillData.status || fulfillData.state || fulfillData.requestStatus || fulfillData.request_status || '').toUpperCase();
          if (fulfillStatus === 'AVAILABLE' || fulfillStatus === 'FULFILLED' || fulfillStatus === 'SUCCESS' || fulfillStatus === 'DONE') {
            task.requestFulfillments[reqId] = {
              fulfilled: true,
              status: fulfillRes.status,
              fulfilledAt: new Date().toISOString(),
            };
            fulfilledCount++;
          } else {
            task.requestFulfillments[reqId] = {
              fulfilled: false,
              status: fulfillRes.status,
              errorType: 'not_available',
              error: `Fulfillment response was not Available: ${fulfillStatus || 'unknown'}`,
            };
          }
        } else if (fulfillRes.status === 400) {
          const errText = await fulfillRes.text().catch(() => '');
          const sanitizedErr = sanitizeLog(errText);
          let parsedMsg = '';
          try {
            const parsed = JSON.parse(errText);
            parsedMsg = String(parsed.message || parsed.error || '').toLowerCase();
          } catch {}
          const lowerErr = errText.toLowerCase();
          const isBookMissing = lowerErr.includes('no longer exists') ||
            lowerErr.includes('book does not exist') ||
            lowerErr.includes('book not found') ||
            parsedMsg.includes('no longer exists') ||
            parsedMsg.includes('book does not exist');

          if (errText.includes('already fulfilled') || errText.includes('already AVAILABLE')) {
            task.requestFulfillments[reqId] = {
              fulfilled: true,
              status: 400,
              alreadyFulfilled: true,
              fulfilledAt: new Date().toISOString(),
            };
            fulfilledCount++;
          } else if (isBookMissing) {
            task.requestFulfillments[reqId] = {
              fulfilled: false,
              status: 400,
              errorType: 'inaccessible_book',
              error: sanitizedErr,
            };
            task.matchedBookId = null;
            task.dockFileId = null;
            delete task.uploadBaselineChecked;
            delete task.uploadBaselineIds;
            delete task.uncertainUpload;
            if (task.status === 'fulfilled' || task.status === 'imported') {
              task.status = 'completed';
            }
            console.warn(`[Bridge] Request ${reqId} fulfillment rejected (book no longer exists): ${sanitizedErr}`);
          } else if (
            lowerErr.includes('request status') ||
            lowerErr.includes('invalid state') ||
            lowerErr.includes('not in approved state') ||
            lowerErr.includes('not approved') ||
            lowerErr.includes('invalid request state')
          ) {
            task.requestFulfillments[reqId] = {
              fulfilled: false,
              status: 400,
              errorType: 'invalid_request_state',
              error: sanitizedErr,
            };
            console.warn(`[Bridge] Request ${reqId} fulfillment rejected (invalid state): ${sanitizedErr}`);
          } else {
            task.requestFulfillments[reqId] = {
              fulfilled: false,
              status: 400,
              errorType: 'bad_request',
              error: sanitizedErr,
            };
            console.error(`[Bridge] Failed to fulfill request ${reqId} (HTTP 400): ${sanitizedErr}`);
          }
        } else if (fulfillRes.status === 403 || fulfillRes.status === 404) {
          const errText = await fulfillRes.text().catch(() => '');
          const sanitizedErr = sanitizeLog(errText);
          const isInaccessible = errText.toLowerCase().includes('inaccessible') || errText.toLowerCase().includes('not found');
          task.requestFulfillments[reqId] = {
            fulfilled: false,
            status: fulfillRes.status,
            errorType: isInaccessible ? 'inaccessible_book' : 'unauthorized_or_not_found',
            error: sanitizedErr,
          };
          console.error(`[Bridge] Request ${reqId} fulfillment error (HTTP ${fulfillRes.status}): ${sanitizedErr}`);
        } else {
          const errText = await fulfillRes.text().catch(() => '');
          task.requestFulfillments[reqId] = {
            fulfilled: false,
            status: fulfillRes.status,
            errorType: 'transient_server_error',
            error: sanitizeLog(errText),
          };
          console.error(`[Bridge] Request ${reqId} fulfillment server error (HTTP ${fulfillRes.status})`);
        }
      } catch (err) {
        task.requestFulfillments[reqId] = {
          fulfilled: false,
          status: 0,
          errorType: 'network_error',
          error: sanitizeLog(err.message),
        };
        console.error(`[Bridge] Failed to fulfill BookOrbit request ${reqId}: ${sanitizeLog(err.message)}`);
      }
    }

    task.fulfilledRequestIds = task.requestIds.filter((id) => task.requestFulfillments[id]?.fulfilled);
    task.unfulfilledRequestIds = task.requestIds.filter((id) => !task.requestFulfillments[id]?.fulfilled);
    for (const fId of task.fulfilledRequestIds) {
      this.setRequestProgress(fId, 'fulfilled', { reason: 'fulfilled', bookId: matchedBookId });
    }

    const allFulfilled = task.requestIds.length > 0 && task.unfulfilledRequestIds.length === 0;
    if (allFulfilled) {
      task.status = 'fulfilled';
    } else if (task.fulfilledRequestIds.length > 0) {
      task.status = 'partially_fulfilled';
    }
    task.updatedAt = new Date().toISOString();
    this.saveState();

    return {
      fulfilled: allFulfilled,
      count: fulfilledCount,
      bookId: matchedBookId,
      dockFileId: task.dockFileId || null,
      fulfilledRequestIds: task.fulfilledRequestIds,
      unfulfilledRequestIds: task.unfulfilledRequestIds,
    };
  }

  /**
   * Bounded reconciliation strategy to catch missed webhook events and resolve uncertain queues.
   * Runs periodically (e.g. every 15m) without continuous 5s polling.
   */
  async reconcile({ fetchFn = globalThis.fetch } = {}) {
    if (this.isReconciling) {
      return { ok: false, error: 'Reconciliation already in progress' };
    }
    this.isReconciling = true;
    try {
    // 1. Reconcile pending BookOrbit requests
    if (this.bookorbitUrl) {
      if (!this.state.baselineEstablishedAt) {
        const baselineResult = await this.initializeBaseline({ fetchFn });
        if (!baselineResult.established || !this.state.baselineEstablishedAt) {
          console.warn('[Bridge] Baseline not established. Halting reconciliation until baseline succeeds.');
          return { ok: false, error: 'Baseline not established' };
        }
      }
      await this.processPendingRequests({ fetchFn }).catch((err) => {
        console.warn(`[Bridge] Reconciliation request scan error: ${sanitizeLog(err.message)}`);
      });
    }

    // 2. Reconcile Shelfmark downloads via /api/status
    const smUrl = this.shelfmarkUrl;
    const headers = {};
    if (this.shelfmarkApiKey) {
      headers['Authorization'] = `Bearer ${this.shelfmarkApiKey}`;
      headers['X-Api-Key'] = this.shelfmarkApiKey;
    }

    let statusData;
    try {
      const res = await fetchFn(`${smUrl}/api/status`, { headers });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      statusData = await res.json();
    } catch (err) {
      return { ok: false, error: err.message };
    }

    const parsedStatus = parseShelfmarkStatus(statusData);
    let updatedCount = 0;
    const now = new Date().toISOString();

    // 3. Resolve uncertain queues using parsed status groups
    if (this.state.uncertainQueues && Object.keys(this.state.uncertainQueues).length > 0) {
      const candidates = [...parsedStatus.downloading, ...parsedStatus.queued, ...parsedStatus.complete];
      for (const [rKey, unrec] of Object.entries(this.state.uncertainQueues)) {
        const cancelledCandidates = (parsedStatus.cancelled || []).filter((t) => {
          const titleMatch = (t.title || '').trim().toLowerCase() === (unrec.release?.title || '').trim().toLowerCase();
          const formatMatch = !(t.format || unrec.release?.format) || (t.format || '').toLowerCase() === (unrec.release?.format || '').toLowerCase();
          return titleMatch && formatMatch;
        });
        if (cancelledCandidates.length > 0) {
          const unrecRequestIds = Array.isArray(unrec.requestIds) && unrec.requestIds.length ? unrec.requestIds : (unrec.requestId ? [unrec.requestId] : []);
          for (const rid of unrecRequestIds) {
            this.setRequestProgress(rid, 'cancelled', { reason: 'cancelled' });
            delete this.state.requests[rid];
          }
          delete this.state.uncertainQueues[rKey];
          updatedCount++;
          continue;
        }
        const matchedCandidates = candidates.filter((t) => {
          const titleMatch = (t.title || '').trim().toLowerCase() === (unrec.release?.title || '').trim().toLowerCase();
          const formatMatch = !(t.format || unrec.release?.format) || (t.format || '').toLowerCase() === (unrec.release?.format || '').toLowerCase();
          const authorMatch = !unrec.release?.author || !t.author || ID.isAuthorMatch(t.author, unrec.release.author);
          // Also require source identity when available.
          const sourceIdMatch = !unrec.release?.source_id || !t.source_id || String(t.source_id) === String(unrec.release.source_id);
          return titleMatch && formatMatch && authorMatch && sourceIdMatch;
        });

        if (matchedCandidates.length === 1) {
          const matched = matchedCandidates[0];
          const realTaskId = matched.id || matched.task_id;
          const isComplete = parsedStatus.complete.some((c) => String(c.id || c.task_id) === String(realTaskId));

          if (this.state.tasks[realTaskId]) {
            // Task already exists: apply collision-safe merging rules without erasing existing state!
            const existing = this.state.tasks[realTaskId];
            if (existing.isbnVerificationFailed || existing.editionVerificationFailed || candidateCompatibility(existing, unrec.release).outcome === 'reject') {
              console.warn(`[Bridge] Uncertain queue resolution collided with incompatible existing task ${realTaskId}`);
              continue;
            }

            const unrecRequestIds = Array.isArray(unrec.requestIds) && unrec.requestIds.length
              ? unrec.requestIds
              : (unrec.requestId ? [unrec.requestId] : []);
            for (const rid of unrecRequestIds) {
              this.state.requests[rid] = realTaskId;
              if (!existing.requestIds.includes(rid)) existing.requestIds.push(rid);
              if (existing.unfulfilledRequestIds && !existing.requestFulfillments?.[rid]?.fulfilled && !existing.unfulfilledRequestIds.includes(rid)) {
                existing.unfulfilledRequestIds.push(rid);
              }
            }
            if (unrec.requestTitle && !existing.requestTitle) existing.requestTitle = unrec.requestTitle;
            if (unrec.requestTitles) existing.requestTitles = { ...(unrec.requestTitles || {}), ...(existing.requestTitles || {}) };
            if (unrec.requestAuthor && !existing.requestAuthor) existing.requestAuthor = unrec.requestAuthor;
            if (unrec.requestAuthorsMap) existing.requestAuthorsMap = { ...(unrec.requestAuthorsMap || {}), ...(existing.requestAuthorsMap || {}) };
            if (unrec.requestYear && !existing.requestYear) existing.requestYear = unrec.requestYear;
            if (unrec.requestYears) existing.requestYears = { ...(unrec.requestYears || {}), ...(existing.requestYears || {}) };
            if (unrec.requestIsbn && !existing.requestIsbn) existing.requestIsbn = unrec.requestIsbn;
            if (unrec.requestIsbns) existing.requestIsbns = { ...(unrec.requestIsbns || {}), ...(existing.requestIsbns || {}) };
            if (unrec.requestLanguage && !existing.requestLanguage) existing.requestLanguage = unrec.requestLanguage;
            if (unrec.requestLanguages) existing.requestLanguages = { ...(unrec.requestLanguages || {}), ...(existing.requestLanguages || {}) };
            const unrecUserIds = Array.isArray(unrec.userIds) && unrec.userIds.length ? unrec.userIds : (unrec.userId ? [unrec.userId] : []);
            for (const uid of unrecUserIds) {
              if (!existing.userIds.includes(uid)) existing.userIds.push(uid);
            }
            if (rKey && !this.state.releases[rKey]) {
              this.state.releases[rKey] = realTaskId;
            }
            existing.updatedAt = now;
            delete this.state.uncertainQueues[rKey];
            updatedCount++;

            if (existing.matchedBookId && this.bookorbitUrl) {
              this.fulfillBookOrbitRequests(existing, fetchFn).catch((err) => {
                console.warn(`[Bridge] Fulfillment error on adopted task ${realTaskId}: ${sanitizeLog(err.message)}`);
              });
            }
          } else {
            // Construct new task record
            const taskRecord = {
              taskId: realTaskId,
              releaseKey: rKey,
              title: unrec.release?.title,
              author: unrec.release?.author,
              year: parsePositiveInt(unrec.release?.year || unrec.release?.publicationYear) || null,
              isbn: unrec.release?.isbn13 || unrec.release?.isbn || null,
              requestTitle: unrec.requestTitle || null,
              requestAuthor: unrec.requestAuthor || null,
              requestYear: parsePositiveInt(unrec.requestYear) || null,
              requestYears: { ...(unrec.requestYears || {}) },
              requestIsbn: unrec.requestIsbn || null,
              requestIsbns: { ...(unrec.requestIsbns || {}) },
              requestTitles: { ...(unrec.requestTitles || {}) },
              requestAuthorsMap: { ...(unrec.requestAuthorsMap || {}) },
              requestLanguage: unrec.requestLanguage || 'en',
              requestLanguages: { ...(unrec.requestLanguages || {}) },
              trustedIsbns: gatherTrustedIsbnsBridge(unrec.trustedIsbns, unrec.bookMetadata, unrec.release?.extra?.bookMetadata, unrec.release),
              bookMetadata: unrec.bookMetadata || unrec.release?.extra?.bookMetadata || null,
              format: (unrec.release?.format || 'epub').toLowerCase(),
              source: unrec.release?.source,
              sourceId: unrec.release?.source_id,
              libraryId: unrec.libraryId,
              folderId: unrec.folderId,
              shelfmarkUrl: smUrl,
              status: isComplete ? 'completed' : 'downloading',
              filePath: null,
              dockFileId: null,
              matchedBookId: null,
              requestIds: (Array.isArray(unrec.requestIds) && unrec.requestIds.length ? unrec.requestIds : (unrec.requestId ? [unrec.requestId] : [])),
              userIds: (Array.isArray(unrec.userIds) && unrec.userIds.length ? [...unrec.userIds] : (unrec.userId ? [unrec.userId] : [])),
              requestFulfillments: {},
              fulfilledRequestIds: [],
              unfulfilledRequestIds: (Array.isArray(unrec.requestIds) && unrec.requestIds.length ? [...unrec.requestIds] : (unrec.requestId ? [unrec.requestId] : [])),
              createdAt: unrec.queuedAt || now,
              updatedAt: now,
            };
            this.state.tasks[realTaskId] = taskRecord;
            this.state.releases[rKey] = realTaskId;
            for (const rid of (Array.isArray(unrec.requestIds) && unrec.requestIds.length ? unrec.requestIds : (unrec.requestId ? [unrec.requestId] : []))) {
              this.state.requests[rid] = realTaskId;
            }
            delete this.state.uncertainQueues[rKey];
            updatedCount++;
          }
        }
      }
    }

    // 4. Correlate tracked tasks against complete and error groups
    const completedMap = new Map();
    for (const t of parsedStatus.complete) {
      const id = t.id || t.task_id;
      if (id !== undefined && id !== null) completedMap.set(String(id), t);
    }

    const failedMap = new Map();
    for (const t of parsedStatus.error) {
      const id = t.id || t.task_id;
      if (id !== undefined && id !== null) failedMap.set(String(id), t);
    }

    const downloadingMap = new Map();
    for (const t of parsedStatus.downloading) {
      const id = t.id || t.task_id;
      if (id !== undefined && id !== null) downloadingMap.set(String(id), t);
    }

    const queuedMap = new Map();
    for (const t of parsedStatus.queued) {
      const id = t.id || t.task_id;
      if (id !== undefined && id !== null) queuedMap.set(String(id), t);
    }

    const cancelledMap = new Map();
    for (const t of parsedStatus.cancelled || []) {
      const id = t.id || t.task_id;
      if (id !== undefined && id !== null) cancelledMap.set(String(id), t);
    }

    for (const task of Object.values(this.state.tasks)) {
      if (task.status === 'fulfilled') {
        continue;
      }
      if (task.isbnVerificationFailed || task.editionVerificationFailed || task.status === 'finalization_failed' || task.status === 'review_required') {
        continue;
      }

      const taskIdStr = String(task.taskId);

      if (downloadingMap.has(taskIdStr)) {
        const smTask = downloadingMap.get(taskIdStr);
        const rawPct = smTask?.progress ?? smTask?.percent ?? smTask?.percentage ?? smTask?.download_percentage ?? 0;
        const pct = typeof rawPct === 'number' ? rawPct : parseFloat(rawPct) || 0;
        const milestone = Math.min(100, Math.max(0, Math.floor(pct / 25) * 25));
        task.progress = milestone;
        task.downloadPercent = pct;
        for (const rid of (task.requestIds || [])) {
          const priorMilestone = this.state.requestProgress[rid]?.downloadMilestone;
          if (priorMilestone === undefined || milestone !== priorMilestone) {
            const link = task.downloadUrl || task.sourceUrl || task.infoUrl || 'N/A';
            console.log(`[Bridge] Download progress: ${milestone}% (${pct.toFixed(1)}%) for request ${rid} ("${task.title || ''}") [upstream: ${task.source || 'unknown'}, link: ${link}]`);
          }
          this.setRequestProgress(rid, 'downloading', {
            reason: 'downloading',
            downloadMilestone: milestone,
            progressPercent: pct,
            downloadProgress: `${milestone}%`,
            progress: milestone,
            upstream: task.source || 'unknown',
            downloadUrl: task.downloadUrl || task.sourceUrl || null,
          });
        }
      }
      if (queuedMap.has(taskIdStr)) {
        task.progress = 0;
        task.downloadPercent = 0;
        for (const rid of (task.requestIds || [])) {
          this.setRequestProgress(rid, 'queued', {
            reason: 'queued',
            downloadMilestone: 0,
            progressPercent: 0,
            downloadProgress: '0%',
            progress: 0,
            upstream: task.source || 'unknown',
            downloadUrl: task.downloadUrl || task.sourceUrl || null,
          });
        }
      }

      if (cancelledMap.has(taskIdStr)) {
        task.status = 'cancelled';
        task.error = 'Shelfmark cancelled task';
        task.errorSource = 'shelfmark';
        task.updatedAt = now;
        if (task.releaseKey && this.state.releases[task.releaseKey] === task.taskId) {
          delete this.state.releases[task.releaseKey];
        }
        for (const rid of (task.requestIds || [])) {
          this.setRequestProgress(rid, 'cancelled', { reason: 'cancelled' });
          if (!task.requestFulfillments?.[rid]?.fulfilled) {
            delete this.state.requests[rid];
          }
        }
      }

      if (completedMap.has(taskIdStr) && task.status !== 'cancelled' && task.status !== 'fulfilled' && task.status !== 'finalization_failed' && task.status !== 'review_required' && !task.editionVerificationFailed && !task.isbnVerificationFailed) {
        // Shelfmark positively reports completion for this exact task ID!
        // Recovers tasks in 'queued', 'downloading', 'awaiting_file', 'completed',
        // or earlier transient verification failure
        const smTask = completedMap.get(taskIdStr);
        const candidatePath = smTask.download_path || smTask.file_path || smTask.target || smTask.paths?.target || smTask.final_paths?.[0] || task.filePath;
        if (candidatePath) {
          const verify = this.verifyFile(candidatePath, task.format);
          if (verify.ok) {
            if (task.status !== 'partially_fulfilled') {
              task.status = 'completed';
            }
            task.progress = 100;
            task.downloadPercent = 100;
            for (const rid of (task.requestIds || [])) {
              const priorMilestone = this.state.requestProgress[rid]?.downloadMilestone;
              const link = task.downloadUrl || task.sourceUrl || task.infoUrl || 'N/A';
              if (priorMilestone !== 100) {
                console.log(`[Bridge] Download progress: 100% (100.0%) for request ${rid} ("${task.title || ''}") [upstream: ${task.source || 'unknown'}, link: ${link}]`);
              }
              this.setRequestProgress(rid, 'verifying', {
                reason: 'download_verifying',
                downloadMilestone: 100,
                progressPercent: 100,
                downloadProgress: '100%',
                progress: 100,
                upstream: task.source || 'unknown',
                downloadUrl: task.downloadUrl || task.sourceUrl || null,
              });
            }
            task.filePath = verify.safePath;
            task.sizeBytes = verify.sizeBytes;
            task.error = null;
            delete task.errorSource;
            task.updatedAt = now;
            if (task.releaseKey) {
              this.state.releases[task.releaseKey] = task.taskId;
            }
            updatedCount++;

            if (this.bookorbitUrl) {
              const key = String(task.taskId || task.id || '');
              let promise = this._finalizationPromises.get(key);
              if (!promise) {
                promise = this.runExclusive(() => this.fulfillBookOrbitRequests(task, fetchFn))
                  .catch((err) => {
                    console.warn(`[Bridge] Reconciliation finalization failed for ${key}: ${sanitizeLog(err?.message || err)}`);
                  })
                  .finally(() => this._finalizationPromises.delete(key));
                this._finalizationPromises.set(key, promise);
              }
              await promise;
            }
          } else {
            // Completed by Shelfmark, but file is not yet visible / verifiable
            if (task.status !== 'awaiting_file') {
              task.status = 'awaiting_file';
              task.filePath = candidatePath;
              task.error = verify.error;
              task.errorSource = 'companion_verification';
              task.updatedAt = now;
              updatedCount++;
            }
          }
        }
      } else if (failedMap.has(taskIdStr)) {
        // Shelfmark genuinely reports failure for this task ID!
        const smError = failedMap.get(taskIdStr);
        task.status = 'failed';
        task.error = smError?.status_message || smError?.error || smError?.message || smError?.status || 'Shelfmark reported failure';
        task.errorSource = 'shelfmark';
        task.updatedAt = now;
        if (this.shelfmarkUrl && (task.taskId || task.id)) {
          const smDismissId = task.taskId || task.id;
          try {
            const dismissHeaders = {
              'Content-Type': 'application/json',
              ...(this.shelfmarkApiKey ? { 'X-Api-Key': this.shelfmarkApiKey, 'Authorization': `Bearer ${this.shelfmarkApiKey}` } : {}),
            };
            fetchFn(`${this.shelfmarkUrl}/api/activity/dismiss`, {
              method: 'POST',
              headers: dismissHeaders,
              body: JSON.stringify({ item_type: 'download', item_key: `download:${smDismissId}` }),
            }).catch(() => {});
          } catch (_) {}
        }
        if (task.releaseKey && this.state.releases[task.releaseKey] === task.taskId) {
          delete this.state.releases[task.releaseKey];
        }
        if (task.releaseKey) {
          this.state.failedReleases[task.releaseKey] = {
            releaseKey: task.releaseKey,
            source: task.source,
            sourceId: task.sourceId,
            failedAt: now,
            error: task.error,
          };
        }

        const link = task.downloadUrl || task.sourceUrl || task.infoUrl || 'N/A';
        const upstream = task.source || 'unknown';
        const attemptId = `shelfmark:${task.taskId}`;
        let newlyFailed = false;

        // Bounded selection of alternative eligible sources/releases with idempotent attempt counting
        for (const reqId of (task.requestIds || [])) {
          if (!task.requestFulfillments || !task.requestFulfillments[reqId]?.fulfilled) {
            console.error(`[Bridge] Download failed for request ${reqId} ("${task.title || ''}") from upstream "${upstream}" (link: ${link}): ${task.error}. Trying other upstreams...`);
            this.state.requestTasks = this.state.requestTasks || {};
            this.state.requestTasks[reqId] = task.taskId || task.id;
            this.state.requestAttempts[reqId] = this.state.requestAttempts[reqId] || [];
            const alreadyCounted = this.state.requestAttempts[reqId].some((a) => a.attemptId === attemptId);
            if (!alreadyCounted) {
              this.state.requestAttempts[reqId].push({
                attemptId,
                taskId: task.taskId,
                releaseKey: task.releaseKey,
                source: task.source,
                sourceId: task.sourceId,
                timestamp: now,
                error: task.error,
              });
              const attempts = Math.max(this.state.requestAttempts[reqId].length, (this.state.requestSourceAttempts[reqId] || 0) + 1);
              this.state.requestSourceAttempts[reqId] = attempts;
              this.state.requestErrors[reqId] = {
                error: task.error,
                errorType: 'shelfmark_download_failed',
                lastAttemptAt: now,
                attempts,
              };
              newlyFailed = true;

              delete this.state.requests[reqId];
              if (attempts < this.maxSourceAttempts) {
                this.setRequestProgress(reqId, 'shelfmark_download_failed', {
                  reason: task.error || 'shelfmark_download_failed',
                  error: task.error,
                });
              } else {
                console.warn(`[Bridge] Request ${reqId} reached max source attempts (${attempts}/${this.maxSourceAttempts}) on shelfmark_download_failed. Terminally rejecting in BookOrbit.`);
                this.setRequestProgress(reqId, 'exhausted', {
                  reason: task.error || 'shelfmark_download_failed',
                  error: task.error,
                });
                await this.rejectBookOrbitRequest(reqId, {
                  stage: 'shelfmark_download_failed',
                  reason: task.error || 'shelfmark_download_failed',
                  task,
                }, fetchFn);
              }
            } else {
              if (this.state.requests[reqId] === (task.taskId || task.id)) {
                delete this.state.requests[reqId];
              }
              const p = this.state.requestProgress?.[reqId];
              if (p && (p.stage === 'queued' || p.stage === 'downloading')) {
                this.setRequestProgress(reqId, 'shelfmark_download_failed', {
                  reason: 'shelfmark_download_failed',
                  error: task.error,
                });
              }
            }
          }
        }
        if (newlyFailed) {
          updatedCount++;
          if ((task.requestIds || []).some((rid) => (this.state.requestSourceAttempts[rid] || 0) < this.maxSourceAttempts)) {
            this.triggerProcessPendingRequests(100);
          }
        }
      } else if (task.status === 'completed' || task.status === 'imported' || task.status === 'partially_fulfilled' || task.status === 'uncertain_upload') {
        // Task completed or partially fulfilled mid-flight; retry fulfillment
        if (this.bookorbitUrl) {
          // Do not retry fulfillment for tasks whose requests are all cancelled.
          // Only skip when every request is VERIFIED terminated/settled.
          // UNKNOWN is a temporary state and must remain eligible for a future retry.
          const activeIds = [];
          const unknownIds = [];
          for (const rid of (task.requestIds || [])) {
            if (task.requestFulfillments?.[rid]?.fulfilled) continue;
            const st = await this.getRequestStatus(rid, fetchFn);
            if (st === 'active') activeIds.push(rid);
            else if (st !== 'cancelled' && st !== 'fulfilled') unknownIds.push(rid);
          }
          if ((task.requestIds || []).length > 0 && activeIds.length === 0 && unknownIds.length === 0) {
            // Terminal requests; nothing to upload or retry.
            continue;
          }
          if (activeIds.length === 0 && unknownIds.length > 0) {
            // Unknown request status is temporary. Recover when durable upload evidence exists;
            // otherwise keep task as-is until status becomes checkable.
            if (!task.matchedBookId && !task.filePath) {
              continue;
            }
          }
          if (task.matchedBookId) {
            // Already uploaded! Retry fulfillment for unfulfilled requests directly without re-uploading
            await this.fulfillBookOrbitRequests(task, fetchFn);
            updatedCount++;
          } else if (task.filePath) {
            const verify = this.verifyFile(task.filePath, task.format);
            if (verify.ok) {
              await this.fulfillBookOrbitRequests(task, fetchFn);
              updatedCount++;
            }
          }
        }
      }
    }

    if (updatedCount > 0) {
      this.saveState();
    }

    return { ok: true, updatedCount };
    } finally {
      this.isReconciling = false;
    }
  }

  /**
   * Starts periodic reconciliation loop.
   * Runs an immediate reconciliation on startup by default, then falls back to periodic interval.
   */
  startReconciliation({ runImmediately = true } = {}) {
    if (runImmediately) {
      this.reconcile().catch((err) => {
        console.warn(`[Bridge] Initial startup reconciliation error: ${sanitizeLog(err.message)}`);
      });
    }
    if (this.reconcileTimer) return;
    this.reconcileTimer = setInterval(() => {
      this.reconcile().catch((err) => {
        console.warn(`[Bridge] Periodic reconciliation error: ${sanitizeLog(err.message)}`);
      });
    }, this.reconcileIntervalMs);
    if (this.reconcileTimer.unref) {
      this.reconcileTimer.unref();
    }
  }

  scheduleActiveReconciliation(delayMs = 15000) {
    if (this._activeReconcileTimer) return;
    this._activeReconcileTimer = setTimeout(async () => {
      this._activeReconcileTimer = null;
      try {
        await this.reconcile();
      } catch (err) {
        console.warn(`[Bridge] Active reconciliation error: ${sanitizeLog(err.message)}`);
      }
      const hasActive = Object.values(this.state.tasks || {}).some((t) =>
        t && (t.status === 'queued' || t.status === 'downloading' || t.status === 'awaiting_file')
      ) || Object.keys(this.state.uncertainQueues || {}).length > 0;
      if (hasActive) {
        this.scheduleActiveReconciliation(15000);
      }
    }, delayMs);
    if (this._activeReconcileTimer.unref) {
      this._activeReconcileTimer.unref();
    }
  }

  /**
   * Stops periodic reconciliation loop and socket listeners.
   */
  stop() {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    if (this._activeReconcileTimer) {
      clearTimeout(this._activeReconcileTimer);
      this._activeReconcileTimer = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.socketClient) {
      this.socketClient.close();
      this.socketClient = null;
    }
  }

  /**
   * Starts HTTP server for webhook and queueing APIs.
   * Enforces timing-safe secret validation, request body size limits,
   * and local/private network binding.
   */
  /**
   * Read-only diagnostic report for a request or the whole bridge state.
   * Never includes credentials, authorization headers, private URLs or full payloads.
   */
   diagnose(requestId = null) {
     const tasks = this.state.tasks || {};
    const requests = this.state.requests || {};
    const progress = this.state.requestProgress || {};
    const attempts = this.state.requestAttempts || {};
    const errors = this.state.requestErrors || {};
    const failedReleases = this.state.failedReleases || {};
    const uncertain = this.state.uncertainQueues || {};
    const sourceAttempts = this.state.requestSourceAttempts || {};
    const reqVerification = requestId ? (this.state.requestVerification?.[requestId] || null) : null;
    const mappedTaskId = (requestId && (requests[requestId] || this.state.requestTasks?.[requestId])) || null;
    const taskObj = mappedTaskId ? tasks[mappedTaskId] : null;

     const report = {
      generatedAt: new Date().toISOString(),
      requestId: requestId || null,
      request: requestId ? (mappedTaskId ? { taskId: mappedTaskId } : null) : undefined,
      stage: requestId ? (progress[requestId] || null) : undefined,
      lastTransitionReason: requestId ? (this.state.requestFailureReasons?.[requestId] || null) : undefined,
      searchAttempts: requestId ? (sourceAttempts[requestId] ?? 0) : sourceAttempts,
      attempts: requestId ? (attempts[requestId] || []) : attempts,
       errors: requestId ? (errors[requestId] || null) : errors,
       verificationEvidence: requestId ? (taskObj?.verificationEvidence || reqVerification?.evidence || null) : undefined,
       verificationConflicts: requestId ? (taskObj?.verificationConflicts || reqVerification?.conflicts || null) : undefined,
       lastVerification: requestId ? reqVerification : undefined,
      retryState: requestId ? { attempts: sourceAttempts[requestId] ?? 0, max: this.maxSourceAttempts } : undefined,
      taskStatuses: Object.fromEntries(Object.entries(tasks).map(([k, v]) => [k, v?.status || v?.state || 'unknown'])),
       uncertainQueueCount: Object.keys(uncertain).length,
       failedReleaseCount: Object.keys(failedReleases).length,
     };
     // Candidate counts (per request or global aggregate below)
     const getCandidateCounts = (rid) => {
       const p = (rid && progress[rid]) || {};
       const meta = p.metadataCandidateCount ?? this.state.requestMetadataCandidateCounts?.[rid] ?? this.state.requestCandidateCounts?.[rid]?.metadataCandidateCount;
       const rel = p.releaseCandidateCount ?? this.state.requestReleaseCandidateCounts?.[rid] ?? this.state.requestCandidateCounts?.[rid]?.releaseCandidateCount;
       const rej = p.candidateRejectionReasonCounts ?? this.state.requestCandidateRejectionReasons?.[rid];
       const out = {};
       if (meta !== undefined) { out.metadataCandidateCount = meta; out.metadataCandidateCounts = meta; }
       if (rel !== undefined) { out.releaseCandidateCount = rel; out.releaseCandidateCounts = rel; }
       if (rej !== undefined) { out.candidateRejectionReasonCounts = rej; }
       if (rej !== undefined) {
         let total = 0;
         for (const n of Object.values(rej || {})) total += (Number(n) || 0);
         out.candidateRejectionReasonCount = total;
       }
       return out;
     };
     if (requestId) {
       Object.assign(report, getCandidateCounts(requestId));
     }

     if (requestId) {
       const t = taskObj;
       if (t) {
         report.task = {
           id: t.id || t.taskId || t.task_id || null,
           status: t.status || t.state || null,
           error: t.error || null,
           format: t.format || null,
           source: t.source || null,
           sourceId: t.source_id || t.sourceId || null,
           year: t.year || t.publicationYear || null,
           isbn: t.isbn || t.isbn13 || null,
           title: t.title || t.book_title || null,
           author: t.author || null,
           matchedBookId: t.matchedBookId || null,
           fulfilled: !!(t.requestFulfillments && t.requestFulfillments[requestId] && t.requestFulfillments[requestId].fulfilled),
           verificationEvidence: t.verificationEvidence || t.verification?.evidence || null,
           verificationConflicts: t.verificationConflicts || t.verification?.conflicts || null,
         };
       }
       // Raw uncertain-queue / failed-release records are intentionally not returned.
     } else {
       // Global candidate aggregates
       const metadataCandidateCounts = {};
       const releaseCandidateCounts = {};
       const candidateRejectionReasonCounts = {};
       let metadataTotal = 0;
       let releaseTotal = 0;
       let hasMeta = false;
       let hasRel = false;
       for (const rid of Object.keys(progress)) {
         const c = getCandidateCounts(rid);
         if (c.metadataCandidateCount !== undefined) {
           metadataCandidateCounts[rid] = c.metadataCandidateCount;
           metadataTotal += c.metadataCandidateCount;
           hasMeta = true;
         }
         if (c.releaseCandidateCount !== undefined) {
           releaseCandidateCounts[rid] = c.releaseCandidateCount;
           releaseTotal += c.releaseCandidateCount;
           hasRel = true;
         }
         const rej = c.candidateRejectionReasonCounts;
         if (rej && typeof rej === 'object') {
           for (const [r, n] of Object.entries(rej)) {
             candidateRejectionReasonCounts[r] = (candidateRejectionReasonCounts[r] || 0) + (Number(n) || 0);
           }
         }
       }
       report.metadataCandidateCounts = metadataCandidateCounts;
       report.releaseCandidateCounts = releaseCandidateCounts;
       report.candidateRejectionReasonCounts = candidateRejectionReasonCounts;
       if (hasMeta) report.metadataCandidateCount = metadataTotal;
       if (hasRel) report.releaseCandidateCount = releaseTotal;

       // Structured listing of all tracked requests for administrative visibility
       const allRequestIds = new Set([
         ...Object.keys(progress),
         ...Object.keys(requests),
         ...Object.keys(sourceAttempts),
         ...Object.keys(errors),
         ...Object.keys(this.state.requestTasks || {}),
       ]);
       const tracked = [];
       for (const rid of allRequestIds) {
         const p = progress[rid] || {};
         const tId = requests[rid] || this.state.requestTasks?.[rid] || null;
         const t = tId ? tasks[tId] : null;
         tracked.push({
           requestId: rid,
           stage: p.stage || p.status || 'unknown',
           reason: this.state.requestFailureReasons?.[rid] || p.reason || null,
           attempts: sourceAttempts[rid] ?? 0,
           maxAttempts: this.maxSourceAttempts,
           activeTaskId: requests[rid] || null,
           associatedTaskId: tId,
           taskStatus: t ? (t.status || t.state || 'unknown') : null,
           error: errors[rid]?.error || null,
           rejectedInBookOrbit: !!this.state.rejectedRequests?.[rid],
           cooldownUntil: p.cooldownUntil || null,
           updatedAt: p.updatedAt || null,
         });
       }
       report.trackedRequests = tracked;

       const shelfmarkDownloaded = Object.values(tasks).filter(
         (t) => ['completed', 'awaiting_file', 'imported', 'partially_fulfilled', 'fulfilled', 'finalization_failed', 'review_required'].includes(t.status)
       ).length;
       const companionFulfilled = Object.values(tasks).filter((t) => t.status === 'fulfilled').length;
       const rejectedInBookOrbitCount = Object.keys(this.state.rejectedRequests || {}).length;

       report.fulfillmentStats = {
         shelfmarkDownloadedTasks: shelfmarkDownloaded,
         companionFulfilledTasks: companionFulfilled,
         bookorbitRejectedRequests: rejectedInBookOrbitCount,
         totalTrackedRequests: allRequestIds.size,
         activeUnfulfilledRequests: tracked.filter(
           (r) => !['fulfilled', 'rejected', 'cancelled'].includes(r.stage)
         ).length,
       };
     }

     return redactSensitive(report);
  }

  createServer(port = 8085, host = this.host) {
    if (!this._httpLock) this._httpLock = Promise.resolve();
    const runLocked = (fn) => {
      const next = this._httpLock.then(() => fn(), () => fn());
      this._httpLock = next.then(() => {}, () => {});
      return next;
    };
    const server = http.createServer(async (req, res) => {
      let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Bad Request' }));
      return;
    }

      // Helper to read and cap body size at 1MB
      const readCappedBody = (cb) => {
        let body = '';
        let bodyLen = 0;
        const maxLen = 1024 * 1024; // 1 MB
        let aborted = false;

        req.on('data', (chunk) => {
          if (aborted) return;
          bodyLen += chunk.length;
          if (bodyLen > maxLen) {
            aborted = true;
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Payload Too Large' }));
            req.destroy();
            return;
          }
          body += chunk;
        });

        req.on('end', () => {
          if (!aborted) cb(body);
        });
      };

      // Helper for timing-safe auth verification
      const checkAuth = () => {
        const authHeader = req.headers['x-bridge-secret'] || (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
        return timingSafeCompare(authHeader, this.secret);
      };

      // Webhook endpoint: POST /webhook/shelfmark
      if (req.method === 'POST' && url.pathname === '/webhook/shelfmark') {
        if (!checkAuth()) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Unauthorized: Invalid bridge secret' }));
          return;
        }
        readCappedBody(async (body) => {
          await runLocked(async () => {
            try {
              const payload = body ? JSON.parse(body) : {};
              const authHeader = req.headers['x-bridge-secret'] || req.headers['authorization'];
              const result = await this.handleWebhook(payload, authHeader);
              res.writeHead(result.statusCode || 200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(result));
            } catch (err) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: sanitizeLog(err.message) }));
            }
          });
        });
        return;
      }

      // Queue endpoint: POST /api/queue
      if (req.method === 'POST' && url.pathname === '/api/queue') {
        if (!checkAuth()) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Unauthorized: Invalid bridge secret' }));
          return;
        }
        readCappedBody(async (body) => {
          await runLocked(async () => {
            try {
              const payload = body ? JSON.parse(body) : {};
              const result = await this.queueRelease(payload);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(result));
            } catch (err) {
              const status = /required|invalid|required field/i.test(err.message || '') ? 400 : 500;
              res.writeHead(status, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: sanitizeLog(err.message) }));
            }
          });
        });
        return;
      }

      // Reconcile endpoint: POST /api/reconcile
      if (req.method === 'POST' && url.pathname === '/api/reconcile') {
        if (!checkAuth()) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Unauthorized: Invalid bridge secret' }));
          return;
        }
        readCappedBody(async (body) => {
          await runLocked(async () => {
            try {
              const result = await this.reconcile();
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(result));
            } catch (err) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: sanitizeLog(err.message) }));
            }
          });
        });
        return;
      }

      // Read-only diagnostics endpoint: GET /api/diagnostics or /api/diagnostics/:requestId
      if (req.method === 'GET' && (url.pathname === '/api/diagnostics' || url.pathname.startsWith('/api/diagnostics/'))) {
        if (!checkAuth()) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
          return;
        }
        await runLocked(async () => {
          try {
            let rid = null;
            if (url.pathname !== '/api/diagnostics') {
              try { rid = decodeURIComponent(url.pathname.slice('/api/diagnostics/'.length)); }
              catch (e) { rid = null; }
            } else {
              rid = url.searchParams.get('requestId');
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(this.diagnose(rid)));
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: sanitizeLog(e.message) }));
          }
        });
        return;
      }

      // Companion-proxied BookOrbit book detail: GET /api/book/:id
      if (req.method === 'GET' && url.pathname.startsWith('/api/book/')) {
        if (!checkAuth()) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
          return;
        }
        const bookId = decodeURIComponent(url.pathname.slice('/api/book/'.length));
        await runLocked(async () => {
          try {
            const headers = await this.getAuthHeaders();
            const fetchFn = this.authManager.fetchFn || globalThis.fetch;
            const r = await fetchFn(`${this.bookorbitUrl}/api/v1/books/${encodeURIComponent(bookId)}`, { headers });
            const text = await r.text();
            let body; try { body = JSON.parse(text); } catch { body = text; }
            res.writeHead(r.status || 200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(body));
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: sanitizeLog(e.message) }));
          }
        });
        return;
      }

      // Companion-extracted EPUB metadata: GET /api/epub-metadata/:fileId
      if (req.method === 'GET' && url.pathname.startsWith('/api/epub-metadata/')) {
        if (!checkAuth()) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
          return;
        }
        const fileId = decodeURIComponent(url.pathname.slice('/api/epub-metadata/'.length));
        await runLocked(async () => {
          try {
            const headers = await this.getAuthHeaders();
            const fetchFn = this.authManager.fetchFn || globalThis.fetch;
            const r = await fetchFn(`${this.bookorbitUrl}/api/v1/books/files/${encodeURIComponent(fileId)}/download`, { headers });
            if (!r.ok) {
              const text = await r.text();
              res.writeHead(r.status || 500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: sanitizeLog(text.slice(0, 200)) }));
              return;
            }
            const ab = await r.arrayBuffer();
            const buf = Buffer.from(ab);
            const meta = extractEpubMetadata(buf);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, metadata: meta }));
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: sanitizeLog(e.message) }));
          }
        });
        return;
      }

      // Health and status endpoint: GET /api/status
      if (req.method === 'GET' && url.pathname === '/api/status') {
        await runLocked(async () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          const activeUnfulfilledRequests = Object.values(this.state.requestProgress || {}).filter(
            (p) => p && !['fulfilled', 'rejected', 'cancelled'].includes(p.stage)
          ).length;
          res.end(JSON.stringify({
            status: 'healthy',
            tasksCount: Object.keys(this.state.tasks).length,
            requestsCount: Math.max(Object.keys(this.state.requests).length, activeUnfulfilledRequests),
            activeRequestsCount: activeUnfulfilledRequests,
            activeMappingCount: Object.keys(this.state.requests).length,
            baselineCount: Object.keys(this.state.baselineRequestIds || {}).length,
            uncertainCount: Object.keys(this.state.uncertainQueues || {}).length,
            socketConnected: this.socketClient ? this.socketClient.isConnected : false,
          }));
        });
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
    });

    return server;
  }
}

// Standalone execution entrypoint
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  if (process.argv.includes('--diagnose')) {
    const bridge = new BridgeService({ host: process.env.BRIDGE_HOST || '127.0.0.1' });
    const rid = process.argv[process.argv.indexOf('--diagnose') + 1];
    const report = bridge.diagnose(rid && !rid.startsWith('--') ? rid : null);
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  }
  const parsedPort = parsePositiveInt(process.env.BRIDGE_PORT);
  const port = parsedPort || 8085;
  const host = process.env.BRIDGE_HOST || '127.0.0.1';
  const bridge = new BridgeService({ host });
  bridge.startReconciliation();
  bridge.startSocketListener();
  const server = bridge.createServer(port, host);
  server.listen(port, host, () => {
    console.log(`[Bridge] BookOrbit ↔ Shelfmark Companion Bridge running on ${host}:${port}`);
    console.log('[Bridge] Notice: Ensure BookOrbit auto-grab is DISABLED in Settings > Automated Processing > Auto Grab.');
    console.log('[Bridge] Native Shelfmark indexer searches and manual grab remain active; the companion handles approved request queueing and fulfillment asynchronously.');
  });
}


// Re-export shared identity helpers under bridge-friendly names for tests.
export {
  validateIsbn,
  sameIsbn,
  isbn10To13,
  isbn13To10,
  titleMatchDecision,
  authorMatchDecision,
  editionCompatibility,
  matchDecision,
  normalizeIsbn,
  areVerifiedCounterparts,
  extractSearchTitleCandidates,
  extractSeriesVolumeNumber,
  decomposeTitleStructure,
  generateDelimiterSlidingWindows,
  stripEditionDescriptors,
  hasMultiVolumeIndicator,
  hasCompilationIndicator,
  scoreBookMatch,
} from '../shared/identity.mjs';
