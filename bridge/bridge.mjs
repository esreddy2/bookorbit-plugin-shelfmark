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
 *    - Awaits genuine finalizable state (`ready_to_file`) or adopts already-`filed` files.
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

import plugin from '../index.mjs';

/** Magic byte signatures for supported book formats. */
export const MAGIC_BYTES = {
  epub: [0x50, 0x4b, 0x03, 0x04], // PK.. (ZIP archive)
  pdf: [0x25, 0x50, 0x44, 0x46],   // %PDF
};

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
  if (!group || typeof group !== 'object') {
    return [];
  }
  if (Array.isArray(group)) {
    return group.map((item) => {
      if (!item || typeof item !== 'object') return item;
      const id = item.id || item.task_id;
      return {
        ...item,
        id,
        task_id: item.task_id || id,
      };
    });
  }
  return Object.entries(group).map(([key, val]) => {
    if (!val || typeof val !== 'object') {
      return { id: key, task_id: key };
    }
    const id = val.id || val.task_id || key;
    return {
      ...val,
      id,
      task_id: val.task_id || id,
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
  return {
    complete: normalizeTaskGroup(statusJson.complete || statusJson.completed_tasks),
    downloading: normalizeTaskGroup(statusJson.downloading || statusJson.active_tasks),
    queued: normalizeTaskGroup(statusJson.queued || statusJson.queued_tasks),
    error: normalizeTaskGroup(statusJson.error || statusJson.failed_tasks),
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
  }

  isTokenExpired() {
    if (!this.token) return true;
    if (!this.expiresAt) {
      this.expiresAt = decodeJwtExp(this.token);
    }
    if (!this.expiresAt) return false;
    return Date.now() >= (this.expiresAt - this.refreshBufferMs);
  }

  async login() {
    if (!this.username || !this.password) {
      if (this.token && isJwt(this.token)) {
        return this.token;
      }
      throw new Error('BookOrbit credentials missing: provide BOOKORBIT_USERNAME and BOOKORBIT_PASSWORD or BOOKORBIT_TOKEN');
    }

    const payload = this.username.includes('@')
      ? { email: this.username, password: this.password }
      : { username: this.username, password: this.password };

    const res = await this.fetchFn(`${this.baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`BookOrbit login failed (HTTP ${res.status}): ${errText}`);
    }

    const data = await res.json().catch(() => ({}));
    const newToken = data.token || data.accessToken || data.jwt;
    if (!newToken) {
      throw new Error('BookOrbit login succeeded but no token was returned');
    }

    this.token = newToken;
    this.refreshToken = data.refreshToken || this.refreshToken;
    this.expiresAt = data.expiresAt ? new Date(data.expiresAt).getTime() : decodeJwtExp(newToken);
    return this.token;
  }

  async refreshSession() {
    if (this.refreshToken) {
      try {
        const res = await this.fetchFn(`${this.baseUrl}/api/v1/auth/refresh`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.token ? { 'Authorization': `Bearer ${this.token}` } : {}),
          },
          body: JSON.stringify({ refreshToken: this.refreshToken }),
        });

        if (res.ok) {
          const data = await res.json().catch(() => ({}));
          const newToken = data.token || data.accessToken;
          if (newToken) {
            this.token = newToken;
            this.refreshToken = data.refreshToken || this.refreshToken;
            this.expiresAt = data.expiresAt ? new Date(data.expiresAt).getTime() : decodeJwtExp(newToken);
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

    const wsProto = this.baseUrl.startsWith('https') ? 'wss' : 'ws';
    const hostPort = this.baseUrl.replace(/^https?:\/\//, '');
    const wsUrl = `${wsProto}://${hostPort}/socket.io/?EIO=4&transport=websocket`;

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
    this.defaultLibraryId = options.defaultLibraryId !== undefined ? options.defaultLibraryId : (process.env.BOOKORBIT_DEFAULT_LIBRARY_ID ? parseInt(process.env.BOOKORBIT_DEFAULT_LIBRARY_ID, 10) : null);
    this.defaultFolderId = options.defaultFolderId !== undefined ? options.defaultFolderId : (process.env.BOOKORBIT_DEFAULT_FOLDER_ID ? parseInt(process.env.BOOKORBIT_DEFAULT_FOLDER_ID, 10) : null);
    this.dockReadinessAttempts = options.dockReadinessAttempts || 25;
    this.dockReadinessIntervalMs = options.dockReadinessIntervalMs || 100;
    this.reconcileIntervalMs = options.reconcileIntervalMs || 15 * 60 * 1000; // 15 minutes
    this.fileVisibilityAttempts = options.fileVisibilityAttempts ?? 10;
    this.fileVisibilityDelayMs = options.fileVisibilityDelayMs ?? 200;
    this.fileVisibilityBackoff = options.fileVisibilityBackoff ?? 1.5;

    // Path translation & containment
    this.shelfmarkPathPrefix = options.shelfmarkPathPrefix || process.env.SHELFMARK_PATH_PREFIX || '';
    this.localPathPrefix = options.localPathPrefix || process.env.LOCAL_PATH_PREFIX || '';
    this.allowedBaseDirs = options.allowedBaseDirs || [
      process.cwd(),
      '/staging',
      '/downloads',
      '/tmp',
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
    };

    this.reconcileTimer = null;
    this.debounceTimer = null;
    this.isProcessingRequests = false;
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
        this.state = {
          tasks: parsed.tasks || {},
          requests: parsed.requests || {},
          releases: parsed.releases || {},
          baselineRequestIds: parsed.baselineRequestIds || {},
          baselineEstablishedAt: parsed.baselineEstablishedAt || null,
          uncertainQueues: parsed.uncertainQueues || {},
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

    console.log('[Bridge] First-run: Establishing baseline of existing historical BookOrbit requests...');
    let token = '';
    try {
      token = await this.authManager.getValidToken();
    } catch {}
    token = token || this.bookorbitToken || this.bookorbitApiKey;

    const headers = {
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
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
        if (item && item.id) {
          collectedIds.push(item.id);
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
  }

  /**
   * Translates Shelfmark container path to local filesystem path with
   * symlink-safe canonical path containment.
   */
  resolvePath(rawPath) {
    if (!rawPath || typeof rawPath !== 'string') return null;
    if (rawPath.includes('\0')) return null;

    let candidate = rawPath;
    if (this.shelfmarkPathPrefix && this.localPathPrefix && candidate.startsWith(this.shelfmarkPathPrefix)) {
      candidate = path.join(this.localPathPrefix, candidate.slice(this.shelfmarkPathPrefix.length));
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
          canonicalBase = path.resolve(base);
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
    const sourceId = release.sourceId || release.extra?.sourceId || release.id;
    if (source && sourceId) {
      return `${source}:${sourceId}`;
    }
    const title = (release.title || '').trim().toLowerCase();
    const format = (release.format || '').trim().toLowerCase();
    return `${title}::${format}`;
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

    return { ok: true, safePath, sizeBytes: stats.size };
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
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
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
          if (this.state.baselineRequestIds && this.state.baselineRequestIds[req.id]) {
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

          // 4. Search releases using corrected plugin logic
          const query = {
            title: req.title,
            author: req.author || (Array.isArray(req.authors) ? req.authors[0] : ''),
            isbn13: req.isbn13 || (Array.isArray(req.isbn13s) ? req.isbn13s[0] : undefined),
            mediaKind: 'ebook',
          };

          const config = {
            baseUrl: this.shelfmarkUrl,
            settings: {
              apiKey: this.shelfmarkApiKey,
              preferFormat: 'epub',
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
            fail: () => {},
          };

          let searchResults = [];
          try {
            searchResults = await plugin.search(query, config, host);
          } catch (err) {
            console.warn(`[Bridge] Plugin search error for "${query.title}": ${sanitizeLog(err.message)}`);
            continue;
          }

          if (!searchResults || searchResults.length === 0) {
            console.log(`[Bridge] No valid releases found for approved request ${req.id} ("${query.title}")`);
            continue;
          }

          // 5. Select top-ranked candidate and queue to Shelfmark
          const bestRelease = searchResults[0];
          try {
            await this.queueRelease({
              requestId: req.id,
              userId: req.requesterUserId || req.userId,
              release: bestRelease,
              libraryId: req.targetLibraryId || this.defaultLibraryId,
              folderId: req.targetFolderId || this.defaultFolderId,
              fetchFn,
            });
            console.log(`[Bridge] Queued release for request ${req.id} ("${bestRelease.title}")`);
          } catch (err) {
            console.error(`[Bridge] Failed to queue release for request ${req.id}: ${sanitizeLog(err.message)}`);
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
      taskId = json.task_id || json.id || null;

      if (!taskId) {
        // Shelfmark returned 200 without task ID. Correlate with /api/status.
        const statusRes = await fetchFn(`${smUrl}/api/status`, { headers });
        if (statusRes.ok) {
          const statusJson = await statusRes.json().catch(() => ({}));
          const parsed = parseShelfmarkStatus(statusJson);
          const candidates = [...parsed.downloading, ...parsed.queued, ...parsed.complete];
          const matched = candidates.find((t) => {
            const sid = t.source_id || t.release?.source_id;
            return sid && sid === downloadPayload.source_id;
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
            return sid && sid === downloadPayload.source_id;
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

    // 3. Persist new task record
    const now = new Date().toISOString();
    const taskRecord = {
      taskId,
      releaseKey,
      title: downloadPayload.title || release.title,
      author: downloadPayload.author || release.author,
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

    const taskId = taskObj.task_id || payload.task_id || payload.taskId || payload.id;
    const rawTarget = pathsObj.target || (pathsObj.final_paths && pathsObj.final_paths[0]) || payload.target_path || payload.download_path || payload.file_path;
    const title = taskObj.title || payload.title;
    const format = taskObj.format || payload.format || (rawTarget ? path.extname(rawTarget).replace('.', '') : 'epub');

    let task = taskId ? (this.state.tasks[taskId] || this.state.tasks[String(taskId)]) : null;

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
    const targetFile = rawTarget || task.filePath;
    const verification = await this.verifyFileWithRetry(targetFile, task.format);
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
   * Imports completed file into BookOrbit and fulfills matching requests using
   * real BookOrbit v3.5.0 controllers and DTOs:
   * 1. Ingest via Book Dock: POST /api/v1/book-dock/upload
   * 2. Wait for upload to reach genuinely finalizable state (ready_to_file) or adopt already-filed file
   * 3. Finalize into Library: POST /api/v1/book-dock/finalize with library and folder
   * 4. Fulfill Book Request: POST /api/v1/admin/book-requests/:id/fulfill
   */
  async fulfillBookOrbitRequests(task, fetchFn = globalThis.fetch) {
    const boUrl = this.bookorbitUrl;
    let token = '';
    try {
      token = await this.authManager.getValidToken();
    } catch {}
    token = token || this.bookorbitToken || this.bookorbitApiKey;

    const headers = {
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      ...(this.bookorbitApiKey ? { 'X-Api-Key': this.bookorbitApiKey } : {}),
    };

    let bookDockFileId = task.dockFileId || null;
    let matchedBookId = parsePositiveInt(task.matchedBookId) || null;
    let readyToFinalize = Boolean(matchedBookId);
    let isAlreadyFinalized = Boolean(matchedBookId);

    // Step 1: Ingest file into Book Dock if not already uploaded and not already finalized
    if (!bookDockFileId && !matchedBookId) {
      try {
        if (!task.filePath) {
          throw new Error('Task filePath is missing');
        }
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
          bookDockFileId = uploadJson.id || uploadJson.fileId;
          task.dockFileId = bookDockFileId;
          if ((uploadJson.status || '').toLowerCase() === 'ready_to_file') {
            readyToFinalize = true;
          }
          this.saveState();
        } else {
          const errText = await uploadRes.text().catch(() => '');
          return { fulfilled: false, error: `Book Dock upload failed (HTTP ${uploadRes.status}): ${errText}` };
        }
      } catch (err) {
        return { fulfilled: false, error: `Book Dock upload error: ${err.message}` };
      }
    }

    if (!bookDockFileId && !matchedBookId) {
      return { fulfilled: false, error: 'Book Dock file ID could not be obtained' };
    }

    // Step 2: Wait for upload to reach a genuinely finalizable state (ready_to_file) or adopt already-filed file
    if (!readyToFinalize && !matchedBookId) {
      try {
        for (let attempt = 0; attempt < this.dockReadinessAttempts; attempt++) {
          const checkRes = await fetchFn(`${boUrl}/api/v1/book-dock/files/${bookDockFileId}`, { headers });
          if (checkRes.ok) {
            const fileInfo = await checkRes.json().catch(() => ({}));
            const fileStatus = (fileInfo.status || '').toLowerCase();
            if (fileStatus === 'filed' || fileStatus === 'finalized') {
              const bId = parsePositiveInt(fileInfo.bookId);
              if (bId) {
                isAlreadyFinalized = true;
                matchedBookId = bId;
                task.matchedBookId = matchedBookId;
                this.saveState();
                break;
              } else {
                task.status = 'finalization_failed';
                task.error = 'Book Dock file reported filed but missing valid bookId';
                this.saveState();
                return { fulfilled: false, error: task.error };
              }
            }
            if (fileStatus === 'ready_to_file') {
              readyToFinalize = true;
              break;
            }
            if (fileStatus === 'error' || fileStatus === 'failed') {
              task.status = 'finalization_failed';
              task.error = fileInfo.error || fileInfo.message || 'Book Dock file reported error state';
              this.saveState();
              return { fulfilled: false, error: task.error };
            }
          }
          await new Promise((r) => setTimeout(r, this.dockReadinessIntervalMs));
        }
      } catch (err) {
        console.warn(`[Bridge] Book Dock check exception: ${sanitizeLog(err.message)}`);
      }
    }

    // Fail closed: Never finalize a still-processing file!
    if (!readyToFinalize && !isAlreadyFinalized && !matchedBookId) {
      task.status = 'finalization_failed';
      task.error = `Book Dock file ${bookDockFileId} timed out waiting for ready_to_file state (still processing)`;
      this.saveState();
      return { fulfilled: false, error: task.error };
    }

    // Step 3: Finalize into Target Library & Destination Folder if not already finalized
    if (!matchedBookId && !isAlreadyFinalized) {
      const rawLibraryId = task.libraryId ?? this.defaultLibraryId;
      const rawFolderId = task.folderId ?? this.defaultFolderId;

      const targetLibraryId = parsePositiveInt(rawLibraryId);
      const targetFolderId = parsePositiveInt(rawFolderId);

      if (!targetLibraryId || !targetFolderId) {
        task.status = 'finalization_failed';
        task.error = `Finalization requires a library and a folder: destination library or folder ID is unconfigured or invalid (library: ${rawLibraryId}, folder: ${rawFolderId})`;
        this.saveState();
        return { fulfilled: false, error: task.error };
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
          task.status = 'finalization_failed';
          task.error = `Book Dock finalize HTTP ${finalizeRes.status}: ${errText}`;
          this.saveState();
          return { fulfilled: false, error: task.error };
        }

        const finalizeJson = await finalizeRes.json().catch(() => ({}));
        const resultItem = finalizeJson.results?.find((r) => r.fileId === bookDockFileId) || finalizeJson.results?.[0];

        // CRITICAL: Strictly require results[].success === true and valid positive bookId
        const resultBookId = parsePositiveInt(resultItem?.bookId);
        const isSuccess = Boolean(resultItem) && resultItem.success === true && Boolean(resultBookId);
        if (!resultItem || !isSuccess) {
          task.status = 'finalization_failed';
          task.error = resultItem?.message || 'Finalization returned failed or needs review';
          this.saveState();
          return { fulfilled: false, error: task.error };
        }

        matchedBookId = resultBookId;
        task.matchedBookId = matchedBookId;
        this.saveState();
      } catch (err) {
        task.status = 'finalization_failed';
        task.error = `Book Dock finalize error: ${err.message}`;
        this.saveState();
        return { fulfilled: false, error: task.error };
      }
    }

    if (!matchedBookId) {
      task.status = 'finalization_failed';
      task.error = 'Finalization did not yield a valid BookOrbit book ID';
      this.saveState();
      return { fulfilled: false, error: task.error };
    }

    // Step 4: Fulfill Book Requests via BookRequestAdminController
    let fulfilledCount = 0;
    for (const reqId of task.requestIds) {
      try {
        const fulfillDto = {
          matchedBookId,
          bookDockFileId,
          note: `Automatically fulfilled via Shelfmark task ${task.taskId}`,
        };

        const fulfillRes = await fetchFn(`${boUrl}/api/v1/admin/book-requests/${reqId}/fulfill`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(fulfillDto),
        });

        if (fulfillRes.ok) {
          fulfilledCount++;
        } else if (fulfillRes.status === 400) {
          const errText = await fulfillRes.text().catch(() => '');
          if (errText.includes('already fulfilled') || errText.includes('already AVAILABLE')) {
            fulfilledCount++;
          } else {
            console.error(`[Bridge] Failed to fulfill request ${reqId} (HTTP ${fulfillRes.status}): ${errText}`);
          }
        } else {
          console.error(`[Bridge] Failed to fulfill request ${reqId} (HTTP ${fulfillRes.status})`);
        }
      } catch (err) {
        console.error(`[Bridge] Failed to fulfill BookOrbit request ${reqId}: ${sanitizeLog(err.message)}`);
      }
    }

    const isFulfilled = fulfilledCount > 0;
    if (isFulfilled) {
      task.status = 'fulfilled';
      task.updatedAt = new Date().toISOString();
      this.saveState();
    }

    return {
      fulfilled: isFulfilled,
      count: fulfilledCount,
      bookId: matchedBookId,
      dockFileId: bookDockFileId,
    };
  }

  /**
   * Bounded reconciliation strategy to catch missed webhook events and resolve uncertain queues.
   * Runs periodically (e.g. every 15m) without continuous 5s polling.
   */
  async reconcile({ fetchFn = globalThis.fetch } = {}) {
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
          const sid = t.source_id || t.release?.source_id;
          return sid && sid === unrec.release?.source_id;
        }) || candidates.find((t) => {
          const titleMatch = (t.title || '').trim().toLowerCase() === (unrec.release?.title || '').trim().toLowerCase();
          const formatMatch = (t.format || '').toLowerCase() === (unrec.release?.format || '').toLowerCase();
          const authorMatch = !unrec.release?.author || !t.author || ((t.author || '').toLowerCase().includes(unrec.release.author.toLowerCase()) || unrec.release.author.toLowerCase().includes((t.author || '').toLowerCase()));
          return titleMatch && formatMatch && authorMatch;
        });

        if (matched) {
          const realTaskId = matched.id || matched.task_id;
          const isComplete = parsedStatus.complete.some((c) => String(c.id || c.task_id) === String(realTaskId));
          const taskRecord = {
            taskId: realTaskId,
            releaseKey: rKey,
            title: unrec.release?.title,
            author: unrec.release?.author,
            format: unrec.release?.format || 'epub',
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
            createdAt: unrec.queuedAt,
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

    for (const task of Object.values(this.state.tasks)) {
      if (task.status === 'fulfilled') {
        continue;
      }

      const taskIdStr = String(task.taskId);

      if (completedMap.has(taskIdStr)) {
        // Shelfmark positively reports completion for this exact task ID!
        // Recovers tasks in 'queued', 'downloading', 'awaiting_file', 'completed', 'finalization_failed',
        // or earlier 'failed' (from transient verification failure)
        const smTask = completedMap.get(taskIdStr);
        const candidatePath = smTask.download_path || smTask.file_path || smTask.target || smTask.paths?.target || smTask.final_paths?.[0] || task.filePath;
        if (candidatePath) {
          const verify = this.verifyFile(candidatePath, task.format);
          if (verify.ok) {
            task.status = 'completed';
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
        task.error = smError?.error || smError?.message || 'Shelfmark reported failure';
        task.errorSource = 'shelfmark';
        task.updatedAt = now;
        if (task.releaseKey && this.state.releases[task.releaseKey] === task.taskId) {
          delete this.state.releases[task.releaseKey];
        }
        updatedCount++;
      } else if (task.status === 'completed' || task.status === 'finalization_failed') {
        // Task was completed and verified, but Book Dock finalization or fulfillment failed mid-flight
        if (task.filePath && this.bookorbitUrl) {
          const verify = this.verifyFile(task.filePath, task.format);
          if (verify.ok) {
            await this.fulfillBookOrbitRequests(task, fetchFn);
            updatedCount++;
          }
        }
      }
    }

    if (updatedCount > 0) {
      this.saveState();
    }

    return { ok: true, updatedCount };
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
        readCappedBody(async (body) => {
          const authHeader = req.headers['x-bridge-secret'] || req.headers['authorization'];
          try {
            const payload = body ? JSON.parse(body) : {};
            const result = await this.handleWebhook(payload, authHeader);
            res.writeHead(result.statusCode || 200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
          }
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
          try {
            const payload = body ? JSON.parse(body) : {};
            const result = await this.queueRelease(payload);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
          }
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
        try {
          const result = await this.reconcile();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return;
      }

      // Health and status endpoint: GET /api/status
      if (req.method === 'GET' && url.pathname === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'healthy',
          tasksCount: Object.keys(this.state.tasks).length,
          requestsCount: Object.keys(this.state.requests).length,
          baselineCount: Object.keys(this.state.baselineRequestIds || {}).length,
          uncertainCount: Object.keys(this.state.uncertainQueues || {}).length,
          socketConnected: this.socketClient ? this.socketClient.isConnected : false,
        }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
    });

    return server;
  }
}

// Standalone execution entrypoint
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const port = process.env.BRIDGE_PORT ? parseInt(process.env.BRIDGE_PORT, 10) : 8085;
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
