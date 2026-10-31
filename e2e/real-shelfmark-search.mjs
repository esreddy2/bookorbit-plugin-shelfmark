#!/usr/bin/env node
import plugin from '../index.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const baseUrl = process.env.SHELFMARK_BASE_URL || 'http://127.0.0.1:18084';
const apiKey = process.env.SHELFMARK_API_KEY || '';
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
  logger: { log() {}, warn() {}, error() {} },
  buildSearchText: (q) => [q?.title, q?.author].filter(Boolean).join(' ').trim(),
  fail: (code, message) => { const e = new Error(message || code); e.code = code; return e; },
};

const cfg = {
  id: 1, name: 'Shelfmark (e2e)', baseUrl,
  settings: { apiKey, preferFormat: 'epub', downloadViaShelfmark: true, pollTimeoutSeconds: 1, pollIntervalMs: 10 },
};

const started = Date.now();
let result;
let error = null;
try {
  result = await plugin.search({ title, author }, cfg, host);
} catch (e) {
  error = { message: e?.message, code: e?.code, stack: e?.stack };
}
const elapsed = Date.now() - started;

const evidence = {
  startedAt: new Date(started).toISOString(),
  baseUrl,
  query: { title, author },
  elapsedMs: elapsed,
  releaseCount: Array.isArray(result) ? result.length : 0,
  releases: Array.isArray(result) ? result.map((r) => ({
    title: r.title, bookTitle: r.bookTitle, author: r.author, format: r.format,
    sizeBytes: r.sizeBytes, language: r.language, year: r.year, isbn: r.isbn,
    source: r?.extra?.releasePayload?.source, source_id: r?.extra?.releasePayload?.source_id,
    downloadUrl: r.downloadUrl,
  })) : null,
  error,
};

mkdirSync('e2e/results', { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = join('e2e/results', `search-${stamp}.json`);
writeFileSync(outPath, JSON.stringify(evidence, null, 2));

console.log(`E2E search: ${evidence.releaseCount} releases in ${elapsed}ms -> ${outPath}`);
