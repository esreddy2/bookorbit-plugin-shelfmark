/**
 * BookOrbit ↔ Shelfmark Asynchronous Companion Bridge
 *
 * Fully event-driven integration between BookOrbit v3.5.0 and Shelfmark v1.5.1
 * without modifying BookOrbit core:
 *
 * 1. BookOrbit Socket.IO Trigger:
 *    - Authenticates to `/book-requests` namespace with service account JWT.
 *    - Listens for `book-requests:changed` broadcast events.
 *    - Debounces and serializes fetching of approved ebook requests via admin API.
 *    - Handles session expiration, auto-reconnection, and network resilience.
 *
 * 2. Release Search & Ranking:
 *    - Directly reuses corrected plugin search and ranking logic from index.mjs.
 *    - Queues top candidate release strictly once, persisting durable mappings.
 *
 * 3. Shelfmark v1.5.1 Custom Script Hook Integration:
 *    - Handles simultaneous $1 target path and nested stdin JSON payload.
 *    - Zero-exit protection: custom script exits 0 on bridge unavailability so
 *      Shelfmark never marks completed downloads as failed.
 *
 * 4. Symlink-Safe Canonical Path Containment:
 *    - Uses realpath canonicalization to reject directory traversal and null bytes.
 *    - Safely maps container paths to companion mount points.
 *
 * 5. Real BookOrbit v3.5.0 Book Dock & Fulfillment:
 *    - Ingests file via BookDockController (`POST /api/v1/book-dock/upload`).
 *    - Waits for upload to settle into finalizable state.
 *    - Finalizes into library using request target library/folder ahead of defaults
 *      via BookDockFinalizeService (`POST /api/v1/book-dock/finalize`).
 *    - Strictly checks `results[].success` and `results[].bookId`. If finalization
 *      fails or needs review, NEVER marks the request Available.
 *    - Fulfills via BookRequestAdminController (`POST /api/v1/admin/book-requests/:id/fulfill`)
 *      using real `FulfillBookRequestDto`.
 *    - Survives mid-flight crashes without duplicate uploads.
 *
 * 6. Bounded Periodic Reconciliation:
 *    - Runs at startup and on bounded 15-minute intervals.
 *    - No continuous 5-second polling loops.
 *
 * Zero external dependencies — pure Node.js ECMAScript module.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import plugin from '../index.mjs';

/** Magic byte signatures for supported book formats. */
const MAGIC_BYTES = {
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

/**
 * Lightweight, zero-dependency Socket.IO v4 client connecting to BookOrbit's
 * `/book-requests` WebSocket gateway using native Node.js WebSocket.
 */
export class BookOrbitSocketClient {
  constructor(options = {}) {
    this.baseUrl = (options.url || 'http://localhost:8080').replace(/\/$/, '');
    this.token = options.token || '';
    this.getTokenFn = options.getTokenFn || null;
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
    if (this.getTokenFn) {
      try {
        const refreshed = await this.getTokenFn();
        if (refreshed) this.token = refreshed;
      } catch (err) {
        console.warn(`[SocketClient] Token refresh failed: ${sanitizeLog(err.message)}`);
      }
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

    this.ws.onopen = () => {
      // Waiting for Engine.IO open packet ('0')
    };

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
        this.setupPing(pingInterval);

        // Send Socket.IO connect packet for /book-requests namespace with auth token
        const connectPacket = `40/book-requests,${JSON.stringify({ token: this.token })}`;
        this.ws.send(connectPacket);
      } catch {}
      return;
    }

    // Engine.IO packet 2: Ping from server -> reply with Pong ('3')
    if (data === '2') {
      try { this.ws.send('3'); } catch {}
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

  setupPing(interval) {
    this.clearPingTimer();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try { this.ws.send('2'); } catch {}
      }
    }, interval);
    if (this.pingTimer.unref) this.pingTimer.unref();
  }

  clearPingTimer() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
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
    this.bookorbitUrl = (options.bookorbitUrl || process.env.BOOKORBIT_URL || 'http://localhost:8080').replace(/\/$/, '');
    this.bookorbitApiKey = options.bookorbitApiKey || process.env.BOOKORBIT_API_KEY || '';
    this.bookorbitToken = options.bookorbitToken || process.env.BOOKORBIT_TOKEN || '';
    this.shelfmarkUrl = (options.shelfmarkUrl || process.env.SHELFMARK_URL || 'http://localhost:8084').replace(/\/$/, '');
    this.shelfmarkApiKey = options.shelfmarkApiKey || process.env.SHELFMARK_API_KEY || '';
    this.defaultLibraryId = options.defaultLibraryId !== undefined ? options.defaultLibraryId : (process.env.BOOKORBIT_DEFAULT_LIBRARY_ID ? parseInt(process.env.BOOKORBIT_DEFAULT_LIBRARY_ID, 10) : 1);
    this.defaultFolderId = options.defaultFolderId !== undefined ? options.defaultFolderId : (process.env.BOOKORBIT_DEFAULT_FOLDER_ID ? parseInt(process.env.BOOKORBIT_DEFAULT_FOLDER_ID, 10) : 1);
    this.reconcileIntervalMs = options.reconcileIntervalMs || 15 * 60 * 1000; // 15 minutes

    // Path translation & containment
    this.shelfmarkPathPrefix = options.shelfmarkPathPrefix || process.env.SHELFMARK_PATH_PREFIX || '';
    this.localPathPrefix = options.localPathPrefix || process.env.LOCAL_PATH_PREFIX || '';
    this.allowedBaseDirs = options.allowedBaseDirs || [
      process.cwd(),
      '/staging',
      '/downloads',
      '/tmp',
    ];

    // In-memory state cache
    this.state = {
      tasks: {},     // taskId -> TaskRecord
      requests: {},  // requestId -> taskId
      releases: {},  // releaseKey -> taskId
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
        };
      }
    } catch (err) {
      console.warn(`[Bridge] Warning: Failed to read state file: ${sanitizeLog(err.message)}. Starting fresh.`);
    }
  }

  /**
   * Persists state to disk atomically using a temporary file.
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
    } catch (err) {
      console.error(`[Bridge] Error: Failed to save state to ${this.stateFilePath}: ${sanitizeLog(err.message)}`);
    }
  }

  /**
   * Translates Shelfmark container path to local filesystem path with
   * symlink-safe canonical path containment.
   */
  resolvePath(rawPath) {
    if (!rawPath || typeof rawPath !== 'string') return null;
    if (rawPath.includes('\0')) return null; // Reject null bytes

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
      return { ok: false, error: `Invalid or disallowed file path: ${rawFilePath}` };
    }
    let stats;
    try {
      stats = fs.statSync(safePath);
    } catch (err) {
      return { ok: false, error: `Failed to stat file: ${err.message}` };
    }

    if (stats.size === 0) {
      return { ok: false, error: `File is 0 bytes: ${safePath}` };
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
   * Connects to BookOrbit Socket.IO gateway and hooks into book-requests:changed.
   */
  startSocketListener() {
    if (!this.bookorbitToken && !this.bookorbitApiKey) {
      console.warn('[Bridge] No BookOrbit token/API key configured. Socket.IO listener disabled.');
      return;
    }

    this.socketClient = new BookOrbitSocketClient({
      url: this.bookorbitUrl,
      token: this.bookorbitToken || this.bookorbitApiKey,
    });

    this.socketClient.onConnect(() => {
      console.log('[Bridge] Connected to BookOrbit /book-requests Socket.IO gateway.');
      this.triggerProcessPendingRequests(0); // Check on connect
    });

    this.socketClient.onChange(() => {
      console.log('[Bridge] Received book-requests:changed broadcast from BookOrbit.');
      this.triggerProcessPendingRequests(500); // Debounced 500ms
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
      const boHeaders = {
        'Authorization': `Bearer ${this.bookorbitToken || this.bookorbitApiKey}`,
        'X-Api-Key': this.bookorbitApiKey || this.bookorbitToken,
      };

      // 1. Fetch approved requests from BookOrbit BookRequestAdminController
      const url = `${this.bookorbitUrl}/api/v1/admin/book-requests?status=approved&limit=100`;
      const res = await fetchFn(url, { headers: boHeaders });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          console.warn('[Bridge] Admin API unauthorized. Check service account token/permissions.');
        }
        return;
      }

      const data = await res.json().catch(() => ({}));
      const requests = Array.isArray(data) ? data : data.items || [];

      for (const req of requests) {
        // Only process approved ebook requests; ignore settled (available, cancelled, rejected)
        if (req.status !== 'approved') continue;
        if (req.mediaKind && req.mediaKind !== 'ebook') continue;

        // Skip if already tracked
        if (this.state.requests[req.id]) {
          const existingTask = this.state.tasks[this.state.requests[req.id]];
          if (existingTask && existingTask.status !== 'failed') {
            continue;
          }
        }

        // 2. Search releases using corrected plugin logic
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

        // Host adapter routing calls to Shelfmark API
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

        // 3. Select top-ranked candidate and queue to Shelfmark
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
    } finally {
      this.isProcessingRequests = false;
    }
  }

  /**
   * Queues a release exactly once. If already queued or completed, adopts existing task.
   */
  async queueRelease({ requestId, userId, release, libraryId, folderId, shelfmarkUrl, apiKey, fetchFn = globalThis.fetch }) {
    if (!requestId) throw new Error('requestId is required');
    if (!release) throw new Error('release is required');

    const smUrl = (shelfmarkUrl || this.shelfmarkUrl).replace(/\/$/, '');
    const smKey = apiKey || this.shelfmarkApiKey;
    const releaseKey = this.getReleaseKey(release);

    // 1. Check if release already tracked
    const existingTaskId = this.state.releases[releaseKey];
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

      if (existing.status === 'completed' && existing.filePath) {
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

      if (existing.status === 'queued' || existing.status === 'downloading') {
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
    } else if (res.status === 500) {
      const text = await res.text().catch(() => '');
      if (text.includes('already in the download queue') || text.includes('already exists')) {
        const statusRes = await fetchFn(`${smUrl}/api/status`, { headers });
        if (statusRes.ok) {
          const statusJson = await statusRes.json().catch(() => ({}));
          const candidates = [
            ...(statusJson.active_tasks || []),
            ...(statusJson.queued_tasks || []),
            ...(statusJson.completed_tasks || []),
          ];
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

    if (!taskId) {
      taskId = `sm-${crypto.randomBytes(8).toString('hex')}`;
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
    if (incomingSecret !== this.secret) {
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

    let task = taskId ? this.state.tasks[taskId] : null;

    if (!task && (title || rawTarget)) {
      const candTitle = (title || path.basename(rawTarget || '')).trim().toLowerCase();
      for (const t of Object.values(this.state.tasks)) {
        if (t.status !== 'completed' && t.status !== 'fulfilled' && t.format === format.toLowerCase()) {
          if (candTitle.includes((t.title || '').trim().toLowerCase())) {
            task = t;
            break;
          }
        }
      }
    }

    if (!task) {
      console.warn(`[Bridge] Webhook received for unassociated task: ${taskId || rawTarget}`);
      return { ok: true, statusCode: 200, message: 'Webhook received for unassociated task' };
    }

    // Strict file verification & containment
    const targetFile = rawTarget || task.filePath;
    const verification = this.verifyFile(targetFile, task.format);
    if (!verification.ok) {
      console.error(`[Bridge] File verification failed for task ${task.taskId}: ${verification.error}`);
      task.status = 'failed';
      task.error = verification.error;
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
    task.updatedAt = new Date().toISOString();
    this.saveState();

    // Import & fulfill BookOrbit requests
    let fulfillResult = null;
    if (this.bookorbitUrl && (this.bookorbitApiKey || this.bookorbitToken)) {
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
   * 2. Wait for upload to reach finalizable state
   * 3. Finalize into Library: POST /api/v1/book-dock/finalize with library and folder
   * 4. Fulfill Book Request: POST /api/v1/admin/book-requests/:id/fulfill
   */
  async fulfillBookOrbitRequests(task, fetchFn = globalThis.fetch) {
    const boUrl = this.bookorbitUrl;
    const authHeader = `Bearer ${this.bookorbitToken || this.bookorbitApiKey}`;
    const headers = {
      'Authorization': authHeader,
      'X-Api-Key': this.bookorbitApiKey || this.bookorbitToken,
    };

    // Reuse existing dockFileId if previously uploaded before restart
    let bookDockFileId = task.dockFileId || null;
    let matchedBookId = task.matchedBookId || null;

    // Step 1: Ingest file into Book Dock if not already uploaded
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
          bookDockFileId = uploadJson.id || uploadJson.fileId;
          task.dockFileId = bookDockFileId;
          this.saveState();
        } else {
          const errText = await uploadRes.text().catch(() => '');
          return { fulfilled: false, error: `Book Dock upload failed (HTTP ${uploadRes.status}): ${errText}` };
        }
      } catch (err) {
        return { fulfilled: false, error: `Book Dock upload error: ${err.message}` };
      }
    }

    if (!bookDockFileId) {
      return { fulfilled: false, error: 'Book Dock file ID could not be obtained' };
    }

    // Step 2: Wait for upload to reach a finalizable state (not processing)
    try {
      let isReady = false;
      for (let attempt = 0; attempt < 10; attempt++) {
        const checkRes = await fetchFn(`${boUrl}/api/v1/book-dock/files/${bookDockFileId}`, { headers });
        if (checkRes.ok) {
          const fileInfo = await checkRes.json().catch(() => ({}));
          if (fileInfo.status && fileInfo.status !== 'processing' && fileInfo.status !== 'ingesting') {
            isReady = true;
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    } catch {}

    // Step 3: Finalize into Target Library & Destination Folder
    if (!matchedBookId) {
      try {
        const finalizePayload = {
          fileIds: [bookDockFileId],
          defaultLibraryId: task.libraryId ?? this.defaultLibraryId,
          defaultFolderId: task.folderId ?? this.defaultFolderId,
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

        // CRITICAL: Strictly verify results[].success and results[].bookId
        const isSuccess = Boolean(resultItem) && resultItem.success !== false && (resultItem.success === true || finalizeJson.success === true) && Boolean(resultItem.bookId);
        if (!resultItem || !isSuccess) {
          task.status = 'finalization_failed';
          task.error = resultItem?.message || 'Finalization returned failed or needs review';
          this.saveState();
          return { fulfilled: false, error: task.error };
        }

        matchedBookId = resultItem.bookId;
        task.matchedBookId = matchedBookId;
        this.saveState();
      } catch (err) {
        task.status = 'finalization_failed';
        task.error = `Book Dock finalize error: ${err.message}`;
        this.saveState();
        return { fulfilled: false, error: task.error };
      }
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
   * Bounded reconciliation strategy to catch missed webhook events.
   * Runs periodically (e.g. every 15m) without continuous 5s polling.
   */
  async reconcile({ fetchFn = globalThis.fetch } = {}) {
    // 1. Reconcile pending BookOrbit requests
    if (this.bookorbitUrl && (this.bookorbitApiKey || this.bookorbitToken)) {
      await this.processPendingRequests({ fetchFn }).catch((err) => {
        console.warn(`[Bridge] Reconciliation request scan error: ${sanitizeLog(err.message)}`);
      });
    }

    // 2. Reconcile completed Shelfmark downloads
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

    const completedMap = new Map();
    for (const t of statusData.completed_tasks || []) {
      const id = t.id || t.task_id;
      if (id) completedMap.set(id, t);
    }

    const failedMap = new Map();
    for (const t of statusData.failed_tasks || []) {
      const id = t.id || t.task_id;
      if (id) failedMap.set(id, t);
    }

    let updatedCount = 0;
    const now = new Date().toISOString();

    for (const task of Object.values(this.state.tasks)) {
      if (task.status === 'queued' || task.status === 'downloading') {
        if (completedMap.has(task.taskId)) {
          const smTask = completedMap.get(task.taskId);
          const candidatePath = smTask.download_path || smTask.file_path || smTask.target || task.filePath;
          if (candidatePath) {
            const verify = this.verifyFile(candidatePath, task.format);
            if (verify.ok) {
              task.status = 'completed';
              task.filePath = verify.safePath;
              task.sizeBytes = verify.sizeBytes;
              task.updatedAt = now;
              updatedCount++;

              if (this.bookorbitUrl && (this.bookorbitApiKey || this.bookorbitToken)) {
                await this.fulfillBookOrbitRequests(task, fetchFn);
              }
            }
          }
        } else if (failedMap.has(task.taskId)) {
          task.status = 'failed';
          task.error = failedMap.get(task.taskId)?.error || 'Shelfmark reported failure';
          task.updatedAt = now;
          if (task.releaseKey && this.state.releases[task.releaseKey] === task.taskId) {
            delete this.state.releases[task.releaseKey];
          }
          updatedCount++;
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
   */
  startReconciliation() {
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
   */
  createServer(port = 8085) {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

      // Webhook endpoint: POST /webhook/shelfmark
      if (req.method === 'POST' && url.pathname === '/webhook/shelfmark') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', async () => {
          try {
            const payload = body ? JSON.parse(body) : {};
            const authHeader = req.headers['x-bridge-secret'] || req.headers['authorization'];
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
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', async () => {
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
  const bridge = new BridgeService();
  bridge.startReconciliation();
  bridge.startSocketListener();
  const server = bridge.createServer(port);
  server.listen(port, () => {
    console.log(`[Bridge] BookOrbit ↔ Shelfmark Companion Bridge running on port ${port}`);
  });
}
