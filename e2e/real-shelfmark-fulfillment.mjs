#!/usr/bin/env node
// Guarded fulfillment probe. Mutates live Shelfmark state (may queue a download).
// Runs ONLY when E2E_ALLOW_MUTATION=1 is set. Default is dry-run (search only).
import plugin from '../index.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const allowMutation = process.env.E2E_ALLOW_MUTATION === '1';
// Default to the ISOLATED stack port, never the production tunnel.
const baseUrl = process.env.SHELFMARK_BASE_URL || 'http://127.0.0.1:18085';
const apiKey = process.env.SHELFMARK_API_KEY || '';
const liveEndpoints = ['127.0.0.1:18084', 'localhost:18084', '192.168.7.142:8084'];
const isLiveTarget = liveEndpoints.some((e) => baseUrl.includes(e));
if (allowMutation && isLiveTarget && process.env.E2E_ALLOW_LIVE_MUTATION !== '1') {
  console.error('REFUSING: mutation target is the LIVE Shelfmark endpoint. Set E2E_ALLOW_LIVE_MUTATION=1 to override (not recommended).');
  process.exit(2);
}
const title = process.env.E2E_TITLE || '1984';
const author = process.env.E2E_AUTHOR || 'George Orwell';

const host = {
  fetch: async (url, opts = {}) => {
    const r = await fetch(url, opts);
    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { ok: r.ok, status: r.status, json: async () => body, text: async () => text };
  },
  logger: { log(...a){ console.log('[host]', ...a); }, warn(...a){ console.warn('[host]', ...a); }, error(...a){ console.error('[host]', ...a); } },
  buildSearchText: (q) => [q?.title, q?.author].filter(Boolean).join(' ').trim(),
  fail: (code, message) => { const e = new Error(message || code); e.code = code; return e; },
};

const cfg = {
  id: 1, name: 'Shelfmark (e2e)', baseUrl,
  settings: { apiKey, preferFormat: 'epub', downloadViaShelfmark: true, pollTimeoutSeconds: 30, pollIntervalMs: 2000 },
};

console.log(`Mode: ${allowMutation ? 'MUTATION (resolveFile enabled)' : 'DRY-RUN (search only)'}`);
const releases = await plugin.search({ title, author }, cfg, host);
console.log(`search returned ${releases.length} releases`);
if (!allowMutation) {
  console.log('Set E2E_ALLOW_MUTATION=1 to run resolveFile against the first release.');
  process.exit(0);
}

const selected = releases[0];
console.log('Selected:', selected?.title, selected?.author, selected?.format, selected?.extra?.releasePayload?.source_id);
const started = Date.now();
let result = null, error = null;
try {
  result = await plugin.resolveFile(selected, cfg, host);
} catch (e) {
  error = { message: e?.message, code: e?.code };
}
const elapsed = Date.now() - started;
const evidence = { startedAt: new Date(started).toISOString(), baseUrl, query: { title, author }, selected: selected?.title, elapsedMs: elapsed, result, error };
mkdirSync('e2e/results', { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
writeFileSync(join('e2e/results', `fulfillment-${stamp}.json`), JSON.stringify(evidence, null, 2));
console.log(`resolveFile finished in ${elapsed}ms -> e2e/results/fulfillment-${stamp}.json`);
if (error) { console.error('ERROR:', error.message); process.exit(1); }
