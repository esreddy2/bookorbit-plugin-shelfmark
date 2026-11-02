#!/usr/bin/env node

/**
 * Diagnostic status tool for BookOrbit ↔ Shelfmark Companion Bridge.
 * Reuses running companion bridge diagnostics endpoint or inspects bridge state.
 *
 * Usage:
 *   node scripts/diagnose.mjs [requestId]
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeService } from '../bridge/bridge.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const rid = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
const port = process.env.BRIDGE_PORT || 8085;
const host = process.env.BRIDGE_HOST || '127.0.0.1';
const secret = process.env.BRIDGE_SECRET || '';

async function run() {
  // First attempt to query running companion over HTTP
  try {
    const url = rid
      ? `http://${host}:${port}/api/diagnostics/${encodeURIComponent(rid)}`
      : `http://${host}:${port}/api/diagnostics`;
    const headers = {};
    if (secret) headers['X-Bridge-Secret'] = secret;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      const data = await res.json();
      console.log(JSON.stringify(data, null, 2));
      return;
    }
  } catch {}

  // Fallback: inspect disk state directly without launching server
  const stateFile = process.env.STATE_FILE_PATH || path.resolve(process.cwd(), '.bridge-state.json');
  const bridge = new BridgeService({
    host,
    stateFilePath: stateFile,
  });
  const report = bridge.diagnose(rid);
  console.log(JSON.stringify(report, null, 2));
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
