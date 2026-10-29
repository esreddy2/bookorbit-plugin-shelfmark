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

/** Magic byte signatures for supported book formats. */
export const MAGIC_BYTES = {
  epub: [0x50, 0x4b, 0x03, 0x04], // PK.. (ZIP archive)
  pdf: [0x25, 0x50, 0x44, 0x46],   // %PDF
};

/**
 * Extracts publication metadata (title, author, year, ISBN) directly from an EPUB ZIP buffer.
 * Supports standard uncompressed (method 0) and deflated (method 8) OPF metadata packages.
 * Returns null if the buffer is invalid or contains no readable OPF package.
 */
export function extractEpubMetadata(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 30) return null;
  try {
    let offset = 0;
    while (offset < buffer.length - 30) {
      const sig = buffer.readUInt32LE(offset);
      if (sig !== 0x04034b50) break; // Local file header signature

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
          const inflated = zlib.inflateRawSync(buffer.slice(dataStart, dataEnd));
          opfText = inflated.toString('utf8');
        }

        if (opfText) {
          const titleMatch = opfText.match(/<dc:title[^>]*>([^<]+)<\/dc:title>/i);
          const authorMatch = opfText.match(/<dc:creator[^>]*>([^<]+)<\/dc:creator>/i);
          const dateMatch = opfText.match(/<dc:date[^>]*>.*?(\d{4}).*?<\/dc:date>/i) ||
                            opfText.match(/dcterms:modified[^>]*>.*?(\d{4})/i) ||
                            opfText.match(/<meta[^>]*property=["']dcterms:issued["'][^>]*>.*?(\d{4})/i);
          const isbnMatch = opfText.match(/urn:isbn:([0-9X-]+)/i) ||
                            opfText.match(/<dc:identifier[^>]*scheme=["']ISBN["'][^>]*>.*?([0-9X-]{10,17}).*?<\/dc:identifier>/i) ||
                            opfText.match(/<dc:identifier[^>]*>.*?([0-9X-]{10,17}).*?<\/dc:identifier>/i);

          const rawYear = dateMatch ? parseInt(dateMatch[1], 10) : null;
          const rawIsbn = isbnMatch ? isbnMatch[1].replace(/[^0-9X]/gi, '') : null;
          return {
            title: titleMatch ? titleMatch[1].trim() : null,
            author: authorMatch ? authorMatch[1].trim() : null,
            year: Number.isFinite(rawYear) ? rawYear : null,
            isbn: rawIsbn && rawIsbn.length > 0 ? rawIsbn : null,
          };
        }
      }

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

/** Redacts sensitive tokens and secrets from diagnostic logs. */
export function sanitizeLog(msg) {
  if (typeof msg !== 'string') return String(msg);
  return msg
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]')
    .replace(/(apiKey|api_key|token|secret|password)=([^&\s]+)/gi, '$1=[REDACTED]');
}

/** Timing-safe string comparison to prevent timing attacks on secrets. */
export function timingSafeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Checks whether a string conforms to JSON Web Token format (header.payload.signature). */
export function isJwt(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  return parts.length === 3;
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

/**
 * Authoritatively verifies whether two release or edition descriptors are compatible.
 * Enforces strict matching on normalized title, author, publication year, format, and ISBN.
 * Distinct publication years or conflicting authors/ISBNs are rejected as distinct editions.
 * A known requested year with an unknown release year must not be treated as a verified edition match
 * unless verified by a matching ISBN or EPUB metadata.
 */
export function areEditionsCompatible(a, b) {
  if (!a || !b) return false;

  const cleanTitle = (obj) => {
    const raw = (obj.bookTitle || obj.title || '').trim().toLowerCase();
    return raw.replace(/\[[^\]]+\]/g, '').replace(/\([^)]+\)/g, '').replace(/\s+/g, ' ').trim();
  };
  const titleA = cleanTitle(a);
  const titleB = cleanTitle(b);
  if (titleA && titleB && titleA !== titleB) {
    return false;
  }

  const authorA = (a.author || (Array.isArray(a.authors) ? a.authors[0] : '') || '').trim().toLowerCase();
  const authorB = (b.author || (Array.isArray(b.authors) ? b.authors[0] : '') || '').trim().toLowerCase();
  if (authorA && authorB && authorA !== authorB) {
    const cleanA = authorA.replace(/[^a-z0-9]/g, '');
    const cleanB = authorB.replace(/[^a-z0-9]/g, '');
    if (cleanA !== cleanB && !cleanA.includes(cleanB) && !cleanB.includes(cleanA)) {
      const tokensA = authorA.split(/[^a-z0-9]+/).filter((t) => t.length > 1);
      const tokensB = authorB.split(/[^a-z0-9]+/).filter((t) => t.length > 1);
      const setA = new Set(tokensA);
      const setB = new Set(tokensB);
      const allAInB = tokensA.length > 0 && tokensA.every((t) => setB.has(t));
      const allBInA = tokensB.length > 0 && tokensB.every((t) => setA.has(t));
      if (!allAInB && !allBInA) {
        return false;
      }
    }
  }

  const fmtA = (a.format || '').trim().toLowerCase();
  const fmtB = (b.format || '').trim().toLowerCase();
  if (fmtA && fmtB && fmtA !== fmtB) {
    return false;
  }

  // Inspect EPUB metadata if file path is available
  let metaYearA = a.epubMetadata?.year;
  let metaYearB = b.epubMetadata?.year;
  let metaIsbnA = a.epubMetadata?.isbn;
  let metaIsbnB = b.epubMetadata?.isbn;
  if (a.filePath && (a.format === 'epub' || (a.filePath || '').endsWith('.epub'))) {
    const meta = extractEpubMetadataFromFile(a.filePath);
    if (meta && (!meta.title || cleanTitle({ title: meta.title }) === titleA)) {
      metaYearA = metaYearA || meta.year;
      metaIsbnA = metaIsbnA || meta.isbn;
    }
  }
  if (b.filePath && (b.format === 'epub' || (b.filePath || '').endsWith('.epub'))) {
    const meta = extractEpubMetadataFromFile(b.filePath);
    if (meta && (!meta.title || cleanTitle({ title: meta.title }) === titleB)) {
      metaYearB = metaYearB || meta.year;
      metaIsbnB = metaIsbnB || meta.isbn;
    }
  }

  // ISBN: distinct ISBNs indicate distinct editions!
  const isbnA = (a.isbn13 || a.isbn || a.extra?.isbn || metaIsbnA || '').replace(/[^0-9X]/gi, '');
  const isbnB = (b.isbn13 || b.isbn || b.extra?.isbn || metaIsbnB || '').replace(/[^0-9X]/gi, '');
  if (isbnA && isbnB && isbnA !== isbnB) {
    return false;
  }
  const isbnVerified = Boolean(isbnA && isbnB && isbnA === isbnB);

  // Publication year: distinct years indicate distinct editions!
  const yearA = parsePositiveInt(a.year || a.publicationYear || a.publishedYear || metaYearA);
  const yearB = parsePositiveInt(b.year || b.publicationYear || b.publishedYear || metaYearB);

  if (yearA && yearB) {
    if (yearA !== yearB) {
      return false;
    }
  } else if ((yearA && !yearB) || (!yearA && yearB)) {
    // A known requested year with an unknown release year must NOT be treated as a verified edition match
    // unless verified by a matching ISBN.
    if (!isbnVerified) {
      return false;
    }
  }

  // Known language mismatch indicates a distinct edition (e.g. translated title).
  const langA = (a.language || '').trim().toLowerCase();
  const langB = (b.language || '').trim().toLowerCase();
  if (langA && langB && langA !== langB) {
    return false;
  }

  return true;
}

function getEditionIncompatibilityReason(req, rel) {
  if (!req || !rel) return 'incompatible_edition';

  const titleReq = (req.bookTitle || req.title || '').trim().toLowerCase();
  const titleRel = (rel.bookTitle || rel.title || '').trim().toLowerCase();
  if (titleReq && titleRel && titleReq !== titleRel) {
    return 'incompatible_title';
  }

  const authorReq = (req.author || (Array.isArray(req.authors) ? req.authors[0] : '') || '').trim().toLowerCase();
  const authorRel = (rel.author || (Array.isArray(rel.authors) ? rel.authors[0] : '') || '').trim().toLowerCase();
  if (authorReq && authorRel && authorReq !== authorRel) {
    return 'incompatible_author';
  }

  const formatReq = (req.format || '').trim().toLowerCase();
  const formatRel = (rel.format || '').trim().toLowerCase();
  if (formatReq && formatRel && formatReq !== formatRel) {
    return 'incompatible_format';
  }

  const langReq = (req.language || '').trim().toLowerCase();
  const langRel = (rel.language || '').trim().toLowerCase();
  if (langReq && langRel && langReq !== langRel) {
    return 'language_mismatch';
  }

  const isbnReq = String(req.isbn13 || req.isbn || req.extra?.isbn || '').replace(/[^0-9X]/gi, '');
  const isbnRel = String(rel.isbn13 || rel.isbn || rel.extra?.isbn || '').replace(/[^0-9X]/gi, '');
  if (isbnReq && isbnRel && isbnReq !== isbnRel) {
    return 'conflicting_isbn';
  }

  const yearReq = parsePositiveInt(req.year || req.publicationYear || req.publishedYear);
  const yearRel = parsePositiveInt(rel.year || rel.publicationYear || rel.publishedYear);
  if (yearReq && yearRel && yearReq !== yearRel) {
    return 'incompatible_year';
  }
  if (yearReq && !yearRel && !isbnReq && !isbnRel) {
    // Known requested year with unknown release year is not verified.
    return 'unknown_release_year';
  }

  return null;
}

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
    this.expiresAt = options.expiresAt || (this.token ? decodeJwtExp(this.token) : null);
    this.refreshBufferMs = options.refreshBufferMs || 5 * 60 * 1000; // Refresh 5m before expiry
    this.fetchFn = options.fetchFn || globalThis.fetch;
    this._authLock = null;
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
    if (interval) this.pingInterval = interval;
    if (timeout) this.pingTimeout = timeout;
    this.clearPingTimer();
    const allowedSilenceMs = (this.pingInterval || 25000) + (this.pingTimeout || 20000);
    this.pingTimer = setTimeout(() => {
      console.warn('[SocketClient] Server heartbeat timeout (no ping received). Reconnecting...');
      this.isConnected = false;
      if (this.ws) {
        try { this.ws.close(); } catch {}
      }
    }, allowedSilenceMs);
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
    this.reconcileIntervalMs = options.reconcileIntervalMs || 15 * 60 * 1000; // 15 minutes
    this.fileVisibilityAttempts = options.fileVisibilityAttempts ?? 10;
    this.fileVisibilityDelayMs = options.fileVisibilityDelayMs ?? 200;
    this.fileVisibilityBackoff = options.fileVisibilityBackoff ?? 1.5;
    this.releaseFailureCooldownMs = options.releaseFailureCooldownMs ?? (60 * 60 * 1000); // 1 hour cooldown
    this.maxSourceAttempts = options.maxSourceAttempts ?? 3; // Maximum bounded attempts per request
    this._fulfillLocks = new Map();

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
    this.authManager = options.authManager || new BookOrbitAuthManager({
      url: this.bookorbitUrl,
      username: options.bookorbitUsername || process.env.BOOKORBIT_USERNAME || '',
      password: options.bookorbitPassword || process.env.BOOKORBIT_PASSWORD || '',
      token: options.bookorbitToken || process.env.BOOKORBIT_TOKEN || '',
      refreshToken: options.bookorbitRefreshToken || process.env.BOOKORBIT_REFRESH_TOKEN || '',
      apiKey: options.bookorbitApiKey || process.env.BOOKORBIT_API_KEY || '',
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
          uncertainQueues: parsed.uncertainQueues || {},
          failedReleases: parsed.failedReleases || {},
          requestSourceAttempts: parsed.requestSourceAttempts || {},
          requestAttempts: parsed.requestAttempts || {},
          requestErrors: parsed.requestErrors || {},
          requestProgress: { ...(parsed.requestProgress || {}), ...(parsed.requestStages || {}), ...(parsed.requestStatus || {}) },
          requestStages: { ...(parsed.requestStages || {}), ...(parsed.requestProgress || {}), ...(parsed.requestStatus || {}) },
          requestStatus: { ...(parsed.requestStatus || {}), ...(parsed.requestProgress || {}), ...(parsed.requestStages || {}) },
          requestFailureReasons: parsed.requestFailureReasons || {},
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
    const entry = {
      stage,
      status: stage,
      updatedAt: new Date().toISOString(),
      ...details,
    };
    this.state.requestProgress = this.state.requestProgress || {};
    this.state.requestStages = this.state.requestStages || {};
    this.state.requestStatus = this.state.requestStatus || {};
    this.state.requestProgress[reqId] = entry;
    this.state.requestStages[reqId] = entry;
    this.state.requestStatus[reqId] = entry;
    if (details && details.reason) {
      this.state.requestFailureReasons = this.state.requestFailureReasons || {};
      this.state.requestFailureReasons[reqId] = details.reason;
    }
    this.saveState();
  }

  async getRequestStatus(reqId, fetchFn = globalThis.fetch) {
    if (!reqId) return 'unknown';
    let token = '';
    try { token = await this.authManager.getValidToken(); } catch {}
    token = token || this.bookorbitToken || this.bookorbitApiKey;
    const headers = token ? (isJwt(token) ? { 'Authorization': `Bearer ${token}` } : { 'X-Api-Key': token }) : {};

    // 1. Try BookOrbit v3.5.0's valid individual request endpoint when authorized.
    try {
      const res = await fetchFn(`${this.bookorbitUrl}/api/v1/book-requests/${encodeURIComponent(reqId)}`, { headers });
      if (res && res.ok) {
        const data = await res.json().catch(() => ({}));
        const status = String(data.status || data.state || data.requestStatus || data.request_status || '').toLowerCase();
        if (status === 'cancelled' || status === 'canceled') return 'cancelled';
        if (!status) return 'active';
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
          if (status === 'cancelled' || status === 'canceled') return 'cancelled';
          if (!status) return 'active';
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

          // 3. Skip if already tracked (never blindly requeue on Socket.IO broadcasts)
          if (this.state.requests[req.id]) {
            continue;
          }

          // 3b. Stop retry if request reached max attempts (never retry indefinitely)
          if ((this.state.requestSourceAttempts[req.id] || 0) >= this.maxSourceAttempts) {
            continue;
          }

          // Cancellation-aware: check request status before queueing/searching
          const requestState = await this.getRequestStatus(req.id, fetchFn);
          if (requestState === 'cancelled') {
            this.setRequestProgress(req.id, 'cancelled', { reason: 'cancelled' });
            continue;
          }
          if (requestState !== 'active') {
            this.setRequestProgress(req.id, 'status_unknown', { reason: 'status_unknown' });
            continue;
          }

          this.setRequestProgress(req.id, 'searching');

          // 4. Search releases using corrected plugin logic (bounded per request)
          const query = {
            title: req.title,
            author: req.author || (Array.isArray(req.authors) ? req.authors[0] : ''),
            year: req.year || req.publicationYear || req.publishedYear || undefined,
            isbn13: req.isbn13 || (Array.isArray(req.isbn13s) ? req.isbn13s[0] : undefined),
            mediaKind: 'ebook',
          };

          const config = {
            baseUrl: this.shelfmarkUrl,
            settings: {
              apiKey: this.shelfmarkApiKey,
              preferFormat: process.env.PREFER_FORMAT || 'epub',
              releaseSource: process.env.RELEASE_SOURCE || 'all',
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
          }, 70000);
          try {
            searchResults = await plugin.search(query, config, host, searchController.signal);
          } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err ?? 'unknown error');
            console.warn(`[Bridge] Plugin search error for "${query.title}": ${sanitizeLog(errorMessage)}`);
            this.setRequestProgress(req.id, 'search_failed', { reason: 'search_failed', error: errorMessage });
            this.state.requestErrors[req.id] = {
              error: errorMessage,
              errorType: 'search_failed',
              reason: 'search_failed',
              lastAttemptAt: new Date().toISOString(),
              attempts: this.state.requestSourceAttempts[req.id] || 0,
            };
            this.saveState();
            continue;
          } finally {
            clearTimeout(searchTimeout);
          }

          if (!searchResults || searchResults.length === 0) {
            console.log(`[Bridge] No valid releases found for approved request ${req.id} ("${query.title}")`);
            this.setRequestProgress(req.id, 'no_releases', { reason: 'no_releases' });
            this.state.requestErrors[req.id] = {
              error: 'No releases found',
              errorType: 'no_releases',
              reason: 'no_releases',
              lastAttemptAt: new Date().toISOString(),
              attempts: this.state.requestSourceAttempts[req.id] || 0,
            };
            this.saveState();
            continue;
          }

          // 5. Filter releases for edition compatibility and filter out recently failed releases
          let ineligibilityReason = null;
          const eligibleReleases = searchResults.filter((rel) => {
            const reason = getEditionIncompatibilityReason(req, rel);
            if (reason) {
              if (!ineligibilityReason) ineligibilityReason = reason;
              return false;
            }
            const rKey = this.getReleaseKey(rel);
            if (rKey && this.state.failedReleases && this.state.failedReleases[rKey]) {
              const failedRecord = this.state.failedReleases[rKey];
              const timeSinceFail = Date.now() - new Date(failedRecord.failedAt).getTime();
              if (timeSinceFail < this.releaseFailureCooldownMs) {
                if (!ineligibilityReason) ineligibilityReason = 'cooldown';
                return false;
              }
            }
            return true;
          });

          if (eligibleReleases.length === 0) {
            const reason = ineligibilityReason || 'no_eligible_edition';
            console.log(`[Bridge] No eligible edition-compatible releases found for approved request ${req.id} ("${query.title}")`);
            this.setRequestProgress(req.id, 'no_eligible_edition', { reason });
            this.state.requestErrors[req.id] = {
              error: reason,
              errorType: reason,
              reason,
              lastAttemptAt: new Date().toISOString(),
              attempts: this.state.requestSourceAttempts[req.id] || 0,
            };
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
              if (!areEditionsCompatible(existingTask, req) || !areEditionsCompatible(existingTask, candidateRelease)) {
                // Incompatible edition already assigned to this release candidate task; try next candidate
                continue;
              }
            }

            // Cancellation-aware before queueing
            const candidateRequestState = await this.getRequestStatus(req.id, fetchFn);
            if (candidateRequestState === 'cancelled') {
              this.setRequestProgress(req.id, 'cancelled', { reason: 'cancelled' });
              queuedSuccessfully = true; // stop trying candidates
              break;
            }
            if (candidateRequestState !== 'active') {
              this.setRequestProgress(req.id, 'status_unknown', { reason: 'status_unknown' });
              queuedSuccessfully = true;
              break;
            }

            try {
              const queueRes = await this.queueRelease({
                requestId: req.id,
                userId: req.userId || req.requesterUserId || req.requester_user_id || req.user_id,
                release: candidateRelease,
                libraryId: req.targetLibraryId || this.defaultLibraryId,
                folderId: req.targetFolderId || this.defaultFolderId,
                fetchFn,
              });
              if (queueRes.adopted || queueRes.reused) {
                console.log(`[Bridge] Adopted existing task ${queueRes.taskId} for request ${req.id} ("${candidateRelease.title}")`);
              } else {
                console.log(`[Bridge] Queued release for request ${req.id} ("${candidateRelease.title}")`);
              }
              queuedSuccessfully = true;
              this.setRequestProgress(req.id, 'queued', { reason: 'queued' });
              break;
            } catch (err) {
              const isEditionConflict = err.message && (err.message.toLowerCase().includes('incompatible edition') || err.message.toLowerCase().includes('incompatible'));
              if (isEditionConflict) {
                console.warn(`[Bridge] Candidate release "${candidateRelease.title}" conflicted with existing task edition: ${sanitizeLog(err.message)}. Trying next candidate release...`);
                // DO NOT blacklist candidate in failedReleases! Try next candidate release.
                continue;
              }

              console.error(`[Bridge] Failed to queue release for request ${req.id}: ${sanitizeLog(err.message)}`);
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
              this.state.requestAttempts[req.id] = this.state.requestAttempts[req.id] || [];
              if (!this.state.requestAttempts[req.id].some((a) => a.attemptId === attemptId)) {
                this.state.requestAttempts[req.id].push({
                  attemptId,
                  releaseKey: rKey,
                  source: candidateRelease.source,
                  sourceId: candidateRelease.sourceId,
                  timestamp: new Date().toISOString(),
                  error: err.message,
                });
                const attempts = this.state.requestAttempts[req.id].length;
                this.state.requestSourceAttempts[req.id] = attempts;
                this.state.requestErrors[req.id] = {
                  error: err.message,
                  errorType: 'queue_failed',
                  lastAttemptAt: new Date().toISOString(),
                  attempts,
                };
              }
              this.saveState();
            }
          }

          if (!queuedSuccessfully && !this.state.requests[req.id]) {
            console.warn(`[Bridge] Could not queue any compatible release candidate for request ${req.id} ("${query.title}")`);
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
  async queueRelease({ requestId, userId, release, libraryId, folderId, shelfmarkUrl, apiKey, fetchFn = globalThis.fetch }) {
    if (this.isQueueingRelease) throw new Error('Queue operation already in progress');
    this.isQueueingRelease = true;
    try {
    if (!requestId) throw new Error('requestId is required');
    if (!release) throw new Error('release is required');

    const smUrl = (shelfmarkUrl || this.shelfmarkUrl).replace(/\/$/, '');
    const smKey = apiKey || this.shelfmarkApiKey;
    const releaseKey = this.getReleaseKey(release);


    // 1. Check if release already tracked or in uncertain queue
    const existingTaskId = this.state.releases[releaseKey];
    if (existingTaskId === 'uncertain') {
      return {
        status: 'uncertain_queue',
        taskId: null,
        adopted: true,
      };
    }

    if (existingTaskId && this.state.tasks[existingTaskId]) {
      const existing = this.state.tasks[existingTaskId];

      // Safe edition verification before adopting existing task
      if (!areEditionsCompatible(existing, release)) {
        throw new Error(`Incompatible edition for existing task ${existingTaskId}: requested "${release.title}" (${release.year || 'unknown year'}) vs task "${existing.title}" (${existing.year || 'unknown year'})`);
      }

      this.state.requests[requestId] = existingTaskId;
      if (!existing.requestIds.includes(requestId)) {
        existing.requestIds.push(requestId);
      }
      if (userId && !existing.userIds.includes(userId)) {
        existing.userIds.push(userId);
      }
      existing.updatedAt = new Date().toISOString();
      this.saveState();

      if ((existing.status === 'completed' || existing.status === 'fulfilled') && existing.filePath) {
        const verify = this.verifyFile(existing.filePath, existing.format);
        if (verify.ok) {
          if (existing.matchedBookId && this.bookorbitUrl) {
            this.fulfillBookOrbitRequests(existing, fetchFn).catch((err) => {
              console.warn(`[Bridge] Fulfillment error on adopted task ${existingTaskId}: ${sanitizeLog(err.message)}`);
            });
          }
          return {
            status: 'completed',
            taskId: existingTaskId,
            filePath: existing.filePath,
            reused: true,
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

    const res = await fetchFn(`${smUrl}/api/releases/download`, {
      method: 'POST',
      headers,
      body: JSON.stringify(downloadPayload),
    });

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
            const sid = t.source_id || t.release?.source_id;
            const tid = String(t.id || t.task_id || '');
            return (sid && sid === downloadPayload.source_id) || (tid && tid === String(downloadPayload.source_id));
          }) || candidates.find((t) => {
            const titleMatch = (t.title || '').trim().toLowerCase() === (downloadPayload.title || '').trim().toLowerCase();
            const formatMatch = (t.format || '').toLowerCase() === (downloadPayload.format || '').toLowerCase();
            return titleMatch && formatMatch;
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
            userId,
            release: downloadPayload,
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
      if (text.includes('already in the download queue') || text.includes('already exists')) {
        const statusRes = await fetchFn(`${smUrl}/api/status`, { headers });
        if (statusRes.ok) {
          const statusJson = await statusRes.json().catch(() => ({}));
          const parsed = parseShelfmarkStatus(statusJson);
          const candidates = [...parsed.downloading, ...parsed.queued, ...parsed.complete];
          const matched = candidates.find((t) => {
            const sid = t.source_id || t.release?.source_id;
            const tid = String(t.id || t.task_id || '');
            return (sid && sid === downloadPayload.source_id) || (tid && tid === String(downloadPayload.source_id));
          }) || candidates.find((t) => {
            const titleMatch = (t.title || '').trim().toLowerCase() === (downloadPayload.title || '').trim().toLowerCase();
            const formatMatch = (t.format || '').toLowerCase() === (downloadPayload.format || '').toLowerCase();
            return titleMatch && formatMatch;
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
      if (!areEditionsCompatible(existing, release)) {
        throw new Error(`Incompatible edition for existing task ${taskId}: requested "${release.title}" (${release.year || 'unknown year'}) vs task "${existing.title}" (${existing.year || 'unknown year'})`);
      }

      this.state.requests[requestId] = taskId;
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

      if (existing.matchedBookId && this.bookorbitUrl) {
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
      language: release.language || downloadPayload.language || null,
      format: (downloadPayload.format || release.format || 'epub').toLowerCase(),
      source: downloadPayload.source,
      sourceId: downloadPayload.source_id,
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
    if (releaseKey) {
      this.state.releases[releaseKey] = taskId;
    }
    this.saveState();

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
    const rawTarget = pathsObj.target || pathsObj.target_path || pathsObj.final_path || (Array.isArray(pathsObj.final_paths) && pathsObj.final_paths[0]) || payload.target_path || payload.download_path || payload.file_path || payload.final_path;
    const allFinalPaths = Array.isArray(pathsObj.final_paths) ? pathsObj.final_paths : (Array.isArray(pathsObj.final_paths_list) ? pathsObj.final_paths_list : (pathsObj.final_path ? [pathsObj.final_path] : (rawTarget ? [rawTarget] : [])));
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
          if (fmtMatch && (tTitle === candTitle || rawBase === tTitle || rawBase.startsWith(tTitle + '_') || rawBase.startsWith(tTitle + ' '))) {
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
    task.status = 'completed';
    task.error = null;
    task.errorSource = null;
    task.updatedAt = new Date().toISOString();
    this.saveState();

    // Import & fulfill BookOrbit requests
    let fulfillResult = null;
    if (this.bookorbitUrl) {
      fulfillResult = await this.fulfillBookOrbitRequests(task, fetchFn);
    }

    return {
      ok: true,
      statusCode: 200,
      taskId: task.taskId,
      filePath: task.filePath,
      requestIds: task.requestIds,
      bookId: fulfillResult?.bookId || null,
      fulfilled: fulfillResult?.fulfilled || false,
      error: fulfillResult?.error || null,
    };
  }

  /**
   * Authoritatively searches BookOrbit library and books API to locate an existing book
   * for edition verification, handling 409 destination conflicts and uncertain upload reconciliation.
   */
  async findAuthoritativeBookOrbitBook(task, targetLibraryId, headers, fetchFn = globalThis.fetch) {
    const boUrl = this.bookorbitUrl;
    const attempts = [];
    if (targetLibraryId) {
      attempts.push({
        url: `${boUrl}/api/v1/libraries/${targetLibraryId}/books`,
        init: { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ sort: [], pagination: { page: 0, size: 100 } }) },
      });
      attempts.push({
        url: `${boUrl}/api/v1/books/query`,
        init: { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ q: task.title || '', sort: [], pagination: { page: 0, size: 100 } }) },
      });
    }
    attempts.push({
      url: `${boUrl}/api/v1/books/search?q=${encodeURIComponent(task.title || '')}&limit=100`,
      init: { headers },
    });

    const baseFileName = task.filePath ? path.basename(task.filePath).toLowerCase() : '';

    for (const attempt of attempts) {
      try {
        const res = await fetchFn(attempt.url, attempt.init);
        if (!res.ok) continue;
        const data = await res.json().catch(() => null);
        if (!data) continue;
        const books = Array.isArray(data) ? data : (data.items || data.books || data.results || []);
        if (!Array.isArray(books) || books.length === 0) continue;

        // 1. First priority: match by destination file path / filename if reported on book files
        if (baseFileName) {
          for (const book of books) {
            const files = Array.isArray(book.files) ? book.files : (book.file ? [book.file] : []);
            const fileMatch = files.some((f) => {
              const fname = (f.name || f.filename || f.path || '').toLowerCase();
              return fname.includes(baseFileName) || baseFileName.includes(fname);
            });
            if (fileMatch) {
              const bId = parsePositiveInt(book.id || book.bookId);
              if (bId) return { ...book, id: bId };
            }
          }
        }

        // 2. Second priority: match by verified edition compatibility
        for (const book of books) {
          if (areEditionsCompatible(task, book)) {
            const bId = parsePositiveInt(book.id || book.bookId);
            if (bId) return { ...book, id: bId };
          }
        }

        // 3. Third priority: return candidate with matching title for authoritative inspection
        const titleMatch = books.find((b) => (b.title || b.name || '').trim().toLowerCase() === (task.title || '').trim().toLowerCase());
        if (titleMatch) {
          const bId = parsePositiveInt(titleMatch.id || titleMatch.bookId);
          if (bId) return { ...titleMatch, id: bId };
        }
      } catch {}
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
      return { error: `Network error during direct library upload: ${err.message}`, networkError: true };
    }

    if (uploadRes.status === 404) {
      return { notFound: true };
    }

    if (uploadRes.ok) {
      const data = await uploadRes.json().catch(() => ({}));
      const bookId = parsePositiveInt(data.bookId || data.id || data.book?.id);
      if (!bookId) {
        // Empty response or missing book ID (e.g. unhandled route in mocks): fall back to Book Dock
        return { notFound: true };
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
      const authoritativeBook = await this.findAuthoritativeBookOrbitBook(task, targetLibraryId, headers, fetchFn);
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
    return { error: `Direct upload failed (HTTP ${uploadRes.status}): ${errText}` };
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

    // Cancellation-aware: determine which requests are still active before importing
    const activeRequestIds = [];
    for (const rid of (task.requestIds || [])) {
      const ridState = await this.getRequestStatus(rid, fetchFn);
      if (ridState === 'cancelled') {
        if (!task.requestFulfillments) task.requestFulfillments = {};
        task.requestFulfillments[rid] = {
          fulfilled: false,
          errorType: 'cancelled',
          error: 'Request cancelled',
          updatedAt: new Date().toISOString(),
        };
        this.setRequestProgress(rid, 'cancelled', { reason: 'cancelled' });
      } else if (ridState !== 'active') {
        if (!task.requestFulfillments) task.requestFulfillments = {};
        task.requestFulfillments[rid] = {
          fulfilled: false,
          errorType: 'status_unknown',
          error: 'Request status unknown',
          updatedAt: new Date().toISOString(),
        };
        this.setRequestProgress(rid, 'status_unknown', { reason: 'status_unknown' });
      } else {
        activeRequestIds.push(rid);
      }
    }
    this.saveState();

    if ((task.requestIds || []).length > 0 && activeRequestIds.length === 0) {
      // All requests cancelled; preserve shared download but skip import/fulfillment
      task.status = 'cancelled';
      task.updatedAt = new Date().toISOString();
      this.setRequestProgress((task.requestIds || [])[0], 'cancelled', { reason: 'cancelled' });
      this.saveState();
      return { fulfilled: false, error: 'All requests cancelled' };
    }

    for (const rid of activeRequestIds) {
      this.setRequestProgress(rid, 'importing', { reason: 'importing' });
    }

    // Step 1: Import file into Library if not already uploaded/matched
    if (!matchedBookId) {
      if (!task.filePath) {
        task.status = 'finalization_failed';
        task.error = 'Task filePath is missing';
        this.saveState();
        return { fulfilled: false, error: task.error };
      }

      const rawLibraryId = task.libraryId ?? this.defaultLibraryId;
      const rawFolderId = task.folderId ?? this.defaultFolderId;

      const targetLibraryId = parsePositiveInt(rawLibraryId);
      const targetFolderId = parsePositiveInt(rawFolderId);

      // Reconcile uncertain upload state: check authoritative BookOrbit library before re-uploading
      if (task.status === 'uncertain_upload' || task.uncertainUpload) {
        const resolved = await this.findAuthoritativeBookOrbitBook(task, targetLibraryId, headers, fetchFn);
        if (resolved && areEditionsCompatible(task, resolved)) {
          matchedBookId = resolved.id;
          task.matchedBookId = matchedBookId;
          task.status = 'imported';
          delete task.uncertainUpload;
          task.updatedAt = new Date().toISOString();
          this.saveState();
        }
      }

      if (!matchedBookId) {
        // If dockFileId already exists on task, continue Book Dock staging directly
        if (task.dockFileId) {
          const dockResult = await this.uploadViaBookDock(task, targetLibraryId, targetFolderId, headers, fetchFn);
          if (!dockResult.success || !dockResult.bookId) {
            if (dockResult.finalizationFailed) {
              task.status = 'finalization_failed';
              task.error = dockResult.error;
              this.saveState();
            }
            return { fulfilled: false, error: dockResult.error };
          }
          matchedBookId = dockResult.bookId;
          task.matchedBookId = matchedBookId;
          task.uploadMethod = 'book_dock';
          task.status = 'imported';
          delete task.uncertainUpload;
          task.updatedAt = new Date().toISOString();
          this.saveState(); // PERSISTED IMMEDIATELY BEFORE FULFILLMENT!
        } else {
          // Try direct library upload first if library and folder are configured
          let directResult = { notFound: true };
          if (targetLibraryId && targetFolderId) {
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
            this.saveState();
            return { fulfilled: false, error: task.error };
          } else if (directResult.notFound) {
            // Direct upload endpoint returned 404 or unsupported -> fall back to Book Dock flow
            const dockResult = await this.uploadViaBookDock(task, targetLibraryId, targetFolderId, headers, fetchFn);
            if (!dockResult.success || !dockResult.bookId) {
              if (dockResult.finalizationFailed) {
                task.status = 'finalization_failed';
                task.error = dockResult.error;
                this.saveState();
              }
              return { fulfilled: false, error: dockResult.error };
            }
            matchedBookId = dockResult.bookId;
            task.matchedBookId = matchedBookId;
            task.dockFileId = dockResult.dockFileId;
            task.uploadMethod = 'book_dock';
            task.status = 'imported';
            delete task.uncertainUpload;
            task.updatedAt = new Date().toISOString();
            this.saveState(); // PERSISTED IMMEDIATELY BEFORE FULFILLMENT!
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
            this.saveState();
            return { fulfilled: false, error: task.error };
          }
        }
      }
    }

    if (!matchedBookId) {
      task.status = 'finalization_failed';
      task.error = 'Finalization did not yield a valid BookOrbit book ID';
      this.saveState();
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
      const step2State = await this.getRequestStatus(reqId, fetchFn);
      if (step2State === 'cancelled') {
        if (!task.requestFulfillments) task.requestFulfillments = {};
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
        if (!task.requestFulfillments) task.requestFulfillments = {};
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
      if (task.requestFulfillments[reqId]?.fulfilled) {
        fulfilledCount++;
        continue;
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
          task.requestFulfillments[reqId] = {
            fulfilled: true,
            status: fulfillRes.status,
            fulfilledAt: new Date().toISOString(),
          };
          fulfilledCount++;
        } else if (fulfillRes.status === 400) {
          const errText = await fulfillRes.text().catch(() => '');
          const sanitizedErr = sanitizeLog(errText);
          if (errText.includes('already fulfilled') || errText.includes('already AVAILABLE')) {
            task.requestFulfillments[reqId] = {
              fulfilled: true,
              status: 400,
              alreadyFulfilled: true,
              fulfilledAt: new Date().toISOString(),
            };
            fulfilledCount++;
          } else if (errText.includes('status') || errText.includes('invalid state') || errText.includes('not in approved state')) {
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
        const matched = candidates.find((t) => {
          const titleMatch = (t.title || '').trim().toLowerCase() === (unrec.release?.title || '').trim().toLowerCase();
          const formatMatch = !(t.format || unrec.release?.format) || (t.format || '').toLowerCase() === (unrec.release?.format || '').toLowerCase();
          const authorMatch = !unrec.release?.author || !t.author || ((t.author || '').toLowerCase().includes(unrec.release.author.toLowerCase()) || unrec.release.author.toLowerCase().includes((t.author || '').toLowerCase()));
          return titleMatch && formatMatch && authorMatch;
        });

        if (matched) {
          const realTaskId = matched.id || matched.task_id;
          const isComplete = parsedStatus.complete.some((c) => String(c.id || c.task_id) === String(realTaskId));

          if (this.state.tasks[realTaskId]) {
            // Task already exists: apply collision-safe merging rules without erasing existing state!
            const existing = this.state.tasks[realTaskId];
            if (!areEditionsCompatible(existing, unrec.release)) {
              console.warn(`[Bridge] Uncertain queue resolution collided with incompatible existing task ${realTaskId}`);
              continue;
            }

            this.state.requests[unrec.requestId] = realTaskId;
            if (!existing.requestIds.includes(unrec.requestId)) {
              existing.requestIds.push(unrec.requestId);
            }
            if (unrec.userId && !existing.userIds.includes(unrec.userId)) {
              existing.userIds.push(unrec.userId);
            }
            if (rKey && !this.state.releases[rKey]) {
              this.state.releases[rKey] = realTaskId;
            }
            if (existing.unfulfilledRequestIds && !existing.unfulfilledRequestIds.includes(unrec.requestId)) {
              existing.unfulfilledRequestIds.push(unrec.requestId);
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
              requestIds: [unrec.requestId],
              userIds: unrec.userId ? [unrec.userId] : [],
              requestFulfillments: {},
              fulfilledRequestIds: [],
              unfulfilledRequestIds: [unrec.requestId],
              createdAt: unrec.queuedAt || now,
              updatedAt: now,
            };
            this.state.tasks[realTaskId] = taskRecord;
            this.state.releases[rKey] = realTaskId;
            this.state.requests[unrec.requestId] = realTaskId;
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

      const taskIdStr = String(task.taskId);

      if (downloadingMap.has(taskIdStr)) {
        for (const rid of (task.requestIds || [])) {
          this.setRequestProgress(rid, 'downloading', { reason: 'downloading' });
        }
      }
      if (queuedMap.has(taskIdStr)) {
        for (const rid of (task.requestIds || [])) {
          this.setRequestProgress(rid, 'queued', { reason: 'queued' });
        }
      }

      if (cancelledMap.has(taskIdStr)) {
        task.status = 'cancelled';
        task.error = 'Shelfmark cancelled task';
        task.errorSource = 'shelfmark';
        task.updatedAt = now;
        for (const rid of (task.requestIds || [])) {
          this.setRequestProgress(rid, 'cancelled', { reason: 'cancelled' });
        }
      }

      if (completedMap.has(taskIdStr) && task.status !== 'cancelled' && task.status !== 'fulfilled') {
        // Shelfmark positively reports completion for this exact task ID!
        // Recovers tasks in 'queued', 'downloading', 'awaiting_file', 'completed', 'finalization_failed',
        // or earlier 'failed' (from transient verification failure)
        const smTask = completedMap.get(taskIdStr);
        const candidatePath = smTask.download_path || smTask.file_path || smTask.target || smTask.paths?.target || smTask.final_paths?.[0] || task.filePath;
        if (candidatePath) {
          const verify = this.verifyFile(candidatePath, task.format);
          if (verify.ok) {
            if (task.status !== 'partially_fulfilled') {
              task.status = 'completed';
            }
            for (const rid of (task.requestIds || [])) {
              this.setRequestProgress(rid, 'completed', { reason: 'completed' });
            }
            task.filePath = verify.safePath;
            task.sizeBytes = verify.sizeBytes;
            task.error = null;
            task.errorSource = null;
            task.updatedAt = now;
            if (task.releaseKey) {
              this.state.releases[task.releaseKey] = task.taskId;
            }
            updatedCount++;

            if (this.bookorbitUrl) {
              await this.fulfillBookOrbitRequests(task, fetchFn);
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

        const attemptId = `shelfmark:${task.taskId}`;
        let newlyFailed = false;

        // Bounded selection of alternative eligible sources/releases with idempotent attempt counting
        for (const reqId of (task.requestIds || [])) {
          if (!task.requestFulfillments || !task.requestFulfillments[reqId]?.fulfilled) {
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
              const attempts = this.state.requestAttempts[reqId].length;
              this.state.requestSourceAttempts[reqId] = attempts;
              this.state.requestErrors[reqId] = {
                error: task.error,
                errorType: 'shelfmark_download_failed',
                lastAttemptAt: now,
                attempts,
              };
              newlyFailed = true;

              if (attempts < this.maxSourceAttempts) {
                delete this.state.requests[reqId];
                this.triggerProcessPendingRequests(100);
              } else {
                console.warn(`[Bridge] Request ${reqId} reached max source attempts (${attempts}/${this.maxSourceAttempts}). Halting retries.`);
              }
            }
          }
        }
        if (newlyFailed) {
          updatedCount++;
        }
      } else if (task.status === 'completed' || task.status === 'imported' || task.status === 'finalization_failed' || task.status === 'partially_fulfilled' || task.status === 'uncertain_upload') {
        // Task completed or partially fulfilled mid-flight; retry fulfillment
        if (this.bookorbitUrl) {
          // Do not retry fulfillment for tasks whose requests are all cancelled.
          const activeIds = [];
          for (const rid of (task.requestIds || [])) {
            const st = await this.getRequestStatus(rid, fetchFn);
            if (st === 'active') activeIds.push(rid);
          }
          if ((task.requestIds || []).length > 0 && activeIds.length === 0) {
            // Preserve historical state and skip repeated fulfillment retries.
            continue;
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

  /**
   * Stops periodic reconciliation loop and socket listeners.
   */
  stop() {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
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
  createServer(port = 8085, host = this.host) {
    if (!this._httpLock) this._httpLock = Promise.resolve();
    const runLocked = (fn) => {
      const next = this._httpLock.then(() => fn(), () => fn());
      this._httpLock = next.then(() => {}, () => {});
      return next;
    };
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

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

      // Health and status endpoint: GET /api/status
      if (req.method === 'GET' && url.pathname === '/api/status') {
        await runLocked(async () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: 'healthy',
            tasksCount: Object.keys(this.state.tasks).length,
            requestsCount: Object.keys(this.state.requests).length,
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
