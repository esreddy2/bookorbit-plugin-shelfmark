/**
 * BookOrbit ↔ Shelfmark Asynchronous Companion Bridge
 *
 * Provides an event-driven integration between BookOrbit and Shelfmark:
 * 1. Persists durable mappings between BookOrbit request IDs, releases, and Shelfmark tasks.
 * 2. Queues each release exactly once, preventing duplicate downloads.
 * 3. Handles Shelfmark post-download webhook notifications via authenticated callback.
 * 4. Verifies completed files (presence, size, magic bytes) before triggering import.
 * 5. Safely fulfills BookOrbit requests only after verified import.
 * 6. Implements bounded periodic reconciliation (every 15m) instead of tight polling.
 * 7. Recovers state across process restarts and supports multi-user requests.
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
    this.reconcileIntervalMs = options.reconcileIntervalMs || 15 * 60 * 1000; // 15 minutes

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
  verifyFile(filePath, expectedFormat) {
    if (!filePath || typeof filePath !== 'string') {
      return { ok: false, error: 'Invalid file path' };
    }
    if (!fs.existsSync(filePath)) {
      return { ok: false, error: `File not found on disk: ${filePath}` };
    }
    let stats;
    try {
      stats = fs.statSync(filePath);
    } catch (err) {
      return { ok: false, error: `Failed to stat file: ${err.message}` };
    }

    if (stats.size === 0) {
      return { ok: false, error: `File is 0 bytes: ${filePath}` };
    }

    const fmt = (expectedFormat || path.extname(filePath).replace('.', '')).toLowerCase();
    const expectedMagic = MAGIC_BYTES[fmt];
    if (expectedMagic) {
      let fd;
      try {
        fd = fs.openSync(filePath, 'r');
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

    return { ok: true, sizeBytes: stats.size };
  }

  /**
   * Queues a release exactly once. If already queued or completed, adopts existing task.
   */
  async queueRelease({ requestId, userId, release, shelfmarkUrl, apiKey, fetchFn = globalThis.fetch }) {
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
   * Processes post-download webhook notifications from Shelfmark's CUSTOM_SCRIPT hook.
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

    const taskId = payload.task_id || payload.taskId || payload.id;
    const filePath = payload.download_path || payload.file_path || payload.path;
    const format = payload.format || (filePath ? path.extname(filePath).replace('.', '') : 'epub');

    let task = taskId ? this.state.tasks[taskId] : null;

    // Fallback: match by title and format if taskId is not found or was generated
    if (!task && (payload.title || filePath)) {
      const candTitle = (payload.title || path.basename(filePath || '')).trim().toLowerCase();
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
      // Unassociated task: record as untracked completed task
      console.warn(`[Bridge] Webhook received for unassociated task: ${taskId || filePath}`);
      return { ok: true, statusCode: 200, message: 'Webhook received for unassociated task' };
    }

    // 2. Strict file verification
    const targetFile = filePath || task.filePath;
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
    task.filePath = targetFile;
    task.sizeBytes = verification.sizeBytes;
    task.status = 'completed';
    task.updatedAt = new Date().toISOString();
    this.saveState();

    // 4. Import & fulfill BookOrbit requests
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
      fulfilled: fulfillResult?.fulfilled || false,
    };
  }

  /**
   * Imports completed file into BookOrbit and fulfills matching requests.
   */
  async fulfillBookOrbitRequests(task, fetchFn = globalThis.fetch) {
    const boUrl = this.bookorbitUrl.replace(/\/$/, '');
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.bookorbitApiKey}`,
      'X-Api-Key': this.bookorbitApiKey,
    };

    let fulfilledCount = 0;
    for (const reqId of task.requestIds) {
      try {
        // 1. Notify BookOrbit to import file into library
        const importRes = await fetchFn(`${boUrl}/api/v1/import/file`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            filePath: task.filePath,
            requestId: reqId,
            format: task.format,
            title: task.title,
            author: task.author,
          }),
        });

        if (importRes.ok) {
          // 2. Transition request to AVAILABLE / fulfilled
          const fulfillRes = await fetchFn(`${boUrl}/api/v1/requests/${reqId}/fulfill`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              status: 'AVAILABLE',
              source: 'shelfmark',
              taskId: task.taskId,
            }),
          });
          if (fulfillRes.ok) {
            fulfilledCount++;
          }
        }
      } catch (err) {
        console.error(`[Bridge] Failed to fulfill BookOrbit request ${reqId}: ${err.message}`);
      }
    }

    return { fulfilled: fulfilledCount > 0, count: fulfilledCount };
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
          const candidatePath = smTask.download_path || smTask.file_path || task.filePath;
          if (candidatePath) {
            const verify = this.verifyFile(candidatePath, task.format);
            if (verify.ok) {
              task.status = 'completed';
              task.filePath = candidatePath;
              task.sizeBytes = verify.sizeBytes;
              task.updatedAt = now;
              updatedCount++;
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
    // Unref timer so it does not hold event loop alive in test environments
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
