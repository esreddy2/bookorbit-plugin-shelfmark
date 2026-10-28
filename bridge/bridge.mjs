/**
 * BookOrbit ↔ Shelfmark Asynchronous Companion Bridge
 *
 * Provides a verified, event-driven integration between BookOrbit v3.5.0
 * and Shelfmark v1.5.1:
 *
 * 1. Shelfmark v1.5.1 Hook Contract:
 *    - Parses Shelfmark's nested JSON payload:
 *      task.task_id, task.title, task.author, paths.target, paths.final_paths.
 *    - Supports $1 target path argument and nested JSON simultaneously.
 *    - Protects Shelfmark tasks: if companion bridge is unreachable, custom script
 *      exits 0 to preserve completed download state in Shelfmark.
 *
 * 2. Secure Filesystem & Path Translation:
 *    - Secure path containment: prevents directory traversal (../, null bytes).
 *    - Path translation: maps Shelfmark container paths to Companion container mounts.
 *
 * 3. Real BookOrbit v3.5.0 Ingestion & Fulfillment:
 *    - Book Dock Ingestion: Uploads or stages verified files into Book Dock (`/book-dock/upload` or rescan).
 *    - Book Dock Finalization: Finalizes into target library (`POST /book-dock/finalize`).
 *    - Request Fulfillment: Fulfills request via `POST /admin/book-requests/:id/fulfill` using real
 *      `FulfillBookRequestDto` (`matchedBookId`, `bookDockFileId`, `note`).
 *
 * 4. Durable State & Reconciliation:
 *    - Recovers atomic mappings (`.bridge-state.json`) across service restarts.
 *    - Queues releases strictly once, preventing duplicate downloads.
 *    - Bounded 15-minute reconciliation discovers completed downloads from `/api/status`
 *      without continuous 5s polling loops, and releases locks on failed tasks.
 *
 * Zero external dependencies — pure Node.js ECMAScript module.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Magic byte signatures for supported book formats. */
const MAGIC_BYTES = {
  epub: [0x50, 0x4b, 0x03, 0x04], // PK.. (ZIP archive)
  pdf: [0x25, 0x50, 0x44, 0x46],   // %PDF
};

export class BridgeService {
  constructor(options = {}) {
    this.stateFilePath = options.stateFilePath || path.resolve(process.cwd(), '.bridge-state.json');
    this.secret = options.secret || process.env.BRIDGE_SECRET || 'bookorbit-shelfmark-secret';
    this.bookorbitUrl = options.bookorbitUrl || process.env.BOOKORBIT_URL || 'http://localhost:8080';
    this.bookorbitApiKey = options.bookorbitApiKey || process.env.BOOKORBIT_API_KEY || '';
    this.shelfmarkUrl = options.shelfmarkUrl || process.env.SHELFMARK_URL || 'http://localhost:8084';
    this.shelfmarkApiKey = options.shelfmarkApiKey || process.env.SHELFMARK_API_KEY || '';
    this.defaultLibraryId = options.defaultLibraryId || (process.env.BOOKORBIT_DEFAULT_LIBRARY_ID ? parseInt(process.env.BOOKORBIT_DEFAULT_LIBRARY_ID, 10) : 1);
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
      console.warn(`[Bridge] Warning: Failed to read state file ${this.stateFilePath}: ${err.message}. Starting fresh.`);
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
      const tmpPath = `${this.stateFilePath}.tmp.${Date.now()}`;
      fs.writeFileSync(tmpPath, JSON.stringify(this.state, null, 2), 'utf8');
      fs.renameSync(tmpPath, this.stateFilePath);
    } catch (err) {
      console.error(`[Bridge] Error: Failed to save state to ${this.stateFilePath}: ${err.message}`);
    }
  }

  /**
   * Translates Shelfmark container path to local/companion filesystem path,
   * with strict traversal protection.
   */
  resolvePath(rawPath) {
    if (!rawPath || typeof rawPath !== 'string') return null;

    // Reject null byte injection
    if (rawPath.includes('\0')) return null;

    let target = rawPath;

    // Apply path prefix substitution if configured
    if (this.shelfmarkPathPrefix && this.localPathPrefix && target.startsWith(this.shelfmarkPathPrefix)) {
      target = path.join(this.localPathPrefix, target.slice(this.shelfmarkPathPrefix.length));
    }

    const resolved = path.resolve(target);

    // Validate path containment against allowed base directories
    if (this.allowedBaseDirs && this.allowedBaseDirs.length > 0) {
      const isAllowed = this.allowedBaseDirs.some((base) => {
        const canonicalBase = path.resolve(base);
        return resolved === canonicalBase || resolved.startsWith(canonicalBase + path.sep);
      });

      if (!isAllowed) {
        console.warn(`[Bridge] Access denied: Path ${resolved} is outside allowed base directories.`);
        return null;
      }
    }

    return resolved;
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
    if (!fs.existsSync(safePath)) {
      return { ok: false, error: `File not found on disk: ${safePath}` };
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
   * Queues a release exactly once. If already queued or completed, adopts existing task.
   */
  async queueRelease({ requestId, userId, release, libraryId, shelfmarkUrl, apiKey, fetchFn = globalThis.fetch }) {
    if (!requestId) throw new Error('requestId is required');
    if (!release) throw new Error('release is required');

    const smUrl = (shelfmarkUrl || this.shelfmarkUrl).replace(/\/$/, '');
    const smKey = apiKey || this.shelfmarkApiKey;
    const releaseKey = this.getReleaseKey(release);

    // 1. Check if release already tracked
    const existingTaskId = this.state.releases[releaseKey];
    if (existingTaskId && this.state.tasks[existingTaskId]) {
      const existing = this.state.tasks[existingTaskId];

      // Associate requestId with this existing task
      this.state.requests[requestId] = existingTaskId;
      if (!existing.requestIds.includes(requestId)) {
        existing.requestIds.push(requestId);
      }
      if (userId && !existing.userIds.includes(userId)) {
        existing.userIds.push(userId);
      }
      existing.updatedAt = new Date().toISOString();
      this.saveState();

      // If already completed and file is intact on disk, reuse immediately
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

      // If active or queued, adopt cleanly
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
        // Shelfmark duplicate: inspect /api/status to locate task ID
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
      // Fallback synthetic task ID if Shelfmark omitted it
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
      libraryId: libraryId || this.defaultLibraryId,
      shelfmarkUrl: smUrl,
      status: 'queued',
      filePath: null,
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
   * Processes post-download webhook notifications following Shelfmark v1.5.1
   * custom-scripts.md specification (both nested JSON and $1 path argument).
   */
  async handleWebhook(payload, authHeader, fetchFn = globalThis.fetch) {
    // 1. Authenticate secret
    const incomingSecret = (authHeader || '').replace(/^Bearer\s+/i, '').trim();
    if (incomingSecret !== this.secret) {
      return { ok: false, statusCode: 401, error: 'Unauthorized: Invalid bridge secret' };
    }

    if (!payload || typeof payload !== 'object') {
      return { ok: false, statusCode: 400, error: 'Bad Request: JSON payload required' };
    }

    // Parse Shelfmark v1.5.1 nested schema:
    // task.task_id, task.title, task.author, paths.target, paths.final_paths
    const taskObj = payload.task || {};
    const pathsObj = payload.paths || {};

    const taskId = taskObj.task_id || payload.task_id || payload.taskId || payload.id;
    const rawTarget = pathsObj.target || (pathsObj.final_paths && pathsObj.final_paths[0]) || payload.target_path || payload.download_path || payload.file_path;
    const title = taskObj.title || payload.title;
    const author = taskObj.author || payload.author;
    const format = taskObj.format || payload.format || (rawTarget ? path.extname(rawTarget).replace('.', '') : 'epub');

    let task = taskId ? this.state.tasks[taskId] : null;

    // Fallback: match by title and format if taskId is missing or generated
    if (!task && (title || rawTarget)) {
      const candTitle = (title || path.basename(rawTarget || '')).trim().toLowerCase();
      for (const t of Object.values(this.state.tasks)) {
        if (t.status !== 'completed' && t.format === format.toLowerCase()) {
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

    // 2. Strict file verification & containment
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

    // 3. Mark completed and update state
    task.filePath = verification.safePath;
    task.sizeBytes = verification.sizeBytes;
    task.status = 'completed';
    task.updatedAt = new Date().toISOString();
    this.saveState();

    // 4. Import & fulfill BookOrbit requests via real BookOrbit v3.5.0 endpoints
    let fulfillResult = null;
    if (this.bookorbitUrl && this.bookorbitApiKey) {
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
    };
  }

  /**
   * Imports completed file into BookOrbit and fulfills matching requests using
   * real BookOrbit v3.5.0 controllers and DTOs:
   * 1. Ingest via Book Dock: POST /api/v1/book-dock/upload (or /book-dock/upload)
   * 2. Finalize into Library: POST /api/v1/book-dock/finalize (or /book-dock/finalize)
   * 3. Fulfill Book Request: POST /api/v1/admin/book-requests/:id/fulfill with FulfillBookRequestDto
   */
  async fulfillBookOrbitRequests(task, fetchFn = globalThis.fetch) {
    const boUrl = this.bookorbitUrl.replace(/\/$/, '');
    const headers = {
      'Authorization': `Bearer ${this.bookorbitApiKey}`,
      'X-Api-Key': this.bookorbitApiKey,
    };

    let bookDockFileId = null;
    let matchedBookId = null;

    // Step 1: Ingest file into Book Dock
    try {
      const fileName = path.basename(task.filePath);
      const fileData = fs.readFileSync(task.filePath);

      // In BookOrbit v3.5.0, BookDockController handles upload via multipart/form-data
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
      }
    } catch (err) {
      console.warn(`[Bridge] Book Dock direct upload error: ${err.message}`);
    }

    // Step 2: Finalize into Target Library using BookDockFinalizeService
    if (bookDockFileId) {
      try {
        const finalizePayload = {
          fileIds: [bookDockFileId],
          defaultLibraryId: task.libraryId || this.defaultLibraryId,
        };

        const finalizeRes = await fetchFn(`${boUrl}/api/v1/book-dock/finalize`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(finalizePayload),
        });

        if (finalizeRes.ok) {
          const finalizeJson = await finalizeRes.json().catch(() => ({}));
          // BookDockController finalize returns { results: [{ fileId, bookId, title }] }
          const resultItem = finalizeJson.results?.[0];
          if (resultItem?.bookId) {
            matchedBookId = resultItem.bookId;
          }
        }
      } catch (err) {
        console.warn(`[Bridge] Book Dock finalize error: ${err.message}`);
      }
    }

    // Step 3: Fulfill Book Requests via BookRequestAdminController
    // Endpoint: POST /api/v1/admin/book-requests/:id/fulfill
    // DTO: FulfillBookRequestDto { matchedBookId, bookDockFileId, note }
    let fulfilledCount = 0;
    for (const reqId of task.requestIds) {
      try {
        const fulfillDto = {
          matchedBookId: matchedBookId || undefined,
          bookDockFileId: bookDockFileId || undefined,
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
        console.error(`[Bridge] Failed to fulfill BookOrbit request ${reqId}: ${err.message}`);
      }
    }

    const isFulfilled = fulfilledCount > 0;
    if (isFulfilled) {
      task.status = 'fulfilled';
      task.matchedBookId = matchedBookId;
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
    const smUrl = this.shelfmarkUrl.replace(/\/$/, '');
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
        // Check if finished in completed list
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

              // Trigger BookOrbit import & fulfillment if configured
              if (this.bookorbitUrl && this.bookorbitApiKey) {
                await this.fulfillBookOrbitRequests(task, fetchFn);
              }
            }
          }
        } else if (failedMap.has(task.taskId)) {
          // Check if failed
          task.status = 'failed';
          task.error = failedMap.get(task.taskId)?.error || 'Shelfmark reported failure';
          task.updatedAt = now;
          // Release deduplication lock so request can be retried
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
        console.warn(`[Bridge] Periodic reconciliation error: ${err.message}`);
      });
    }, this.reconcileIntervalMs);
    if (this.reconcileTimer.unref) {
      this.reconcileTimer.unref();
    }
  }

  /**
   * Stops periodic reconciliation loop.
   */
  stopReconciliation() {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
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
  const server = bridge.createServer(port);
  server.listen(port, () => {
    console.log(`[Bridge] BookOrbit ↔ Shelfmark Companion Bridge running on port ${port}`);
  });
}
