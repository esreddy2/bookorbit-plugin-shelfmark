/**
 * Companion-only regression tests for the v1.5.8 recovery hotfix.
 * Run from repository root:
 *   node --test tests/v158_recovery_hotfix.test.mjs
 * All tests use synthetic HTTP responses and temporary state; no live server access.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeService } from '../bridge/bridge.mjs';

const reply = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json' },
});
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'bookorbit-v158-recovery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bridge = new BridgeService({
    stateFilePath: join(dir, 'isolated-state.json'),
    bookorbitUrl: 'http://bookorbit.test',
    bookorbitApiKey: 'fake-test-api-key',
    defaultLibraryId: 1,
    defaultFolderId: 1,
    allowedBaseDirs: [dir],
  });
  const filePath = join(dir, 'book.epub');
  writeFileSync(filePath, Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.alloc(64)]));
  return { bridge, dir, filePath };
}
const frankTask = (overrides = {}) => ({
  taskId: 'task-frankenstein', title: 'Frankenstein', author: 'Mary Shelley',
  year: 1818, format: 'epub', requestIds: ['req-1'], requestFulfillments: {},
  status: 'completed', libraryId: 1, folderId: 1, ...overrides,
});
const bookCard = (id, year = 1818) => ({
  id, title: 'Frankenstein', author: 'Mary Shelley', year, format: 'epub',
});

function fakeLibrary(cards, { status = 200, record } = {}) {
  return async (url, opts = {}) => {
    const path = new URL(url).pathname;
    if (path === '/api/v1/libraries/1/books') {
      record?.push(`${opts.method || 'GET'} ${path}`);
      assert.equal(opts.method, 'POST', 'BookOrbit v3.5.0 library query is POST');
      const body = JSON.parse(opts.body);
      assert.equal(body.pagination.page, 0);
      assert.equal(body.q, 'Frankenstein');
      return reply({ items: cards, total: cards.length }, status);
    }
    throw new Error(`Unexpected HTTP route: ${opts.method || 'GET'} ${path}`);
  };
}

test('lookup uses real v3.5.0 POST BookQuery and accepts a unique exact edition', async (t) => {
  const { bridge } = fixture(t);
  const calls = [];
  const result = await bridge.findAuthoritativeBookOrbitBook(frankTask(), 1, {}, fakeLibrary([bookCard(72)], { record: calls }));
  assert.equal(result?.id, 72);
  assert.deepEqual(calls, ['POST /api/v1/libraries/1/books']);
});

test('lookup rejects wrong publication year and ambiguous matching editions', async (t) => {
  const { bridge } = fixture(t);
  assert.equal(await bridge.findAuthoritativeBookOrbitBook(frankTask(), 1, {}, fakeLibrary([bookCard(72, 2015)])), null);
  assert.equal(await bridge.findAuthoritativeBookOrbitBook(frankTask(), 1, {}, fakeLibrary([bookCard(72), bookCard(73)])), null);
});

test('uncertain upload recovery adopts only a NEW matching ID', async (t) => {
  const { bridge } = fixture(t);
  const task = frankTask({ uploadBaselineChecked: true, uploadBaselineIds: [72] });
  const result = await bridge.findAuthoritativeBookOrbitBook(task, 1, {}, fakeLibrary([bookCard(72), bookCard(73)]), 'uncertain');
  assert.equal(result?.id, 73);
});

test('an API outage never converts a completed task into a permanent cancellation', async (t) => {
  const { bridge } = fixture(t);
  const task = frankTask();
  let uploads = 0;
  const http = async (url) => {
    if (url.includes('/upload')) uploads++;
    return reply({ error: 'temporary outage' }, 503);
  };
  const result = await bridge.fulfillBookOrbitRequests(task, http);
  assert.equal(result.fulfilled, false);
  assert.equal(task.status, 'completed');
  assert.equal(uploads, 0);
});

test('already-Available requests do not trigger upload or fulfillment twice', async (t) => {
  const { bridge } = fixture(t);
  const task = frankTask();
  const calls = [];
  const http = async (url, opts = {}) => {
    const path = new URL(url).pathname;
    calls.push(`${opts.method || 'GET'} ${path}`);
    if (path === '/api/v1/book-requests/req-1') return reply({ id: 'req-1', status: 'available' });
    throw new Error(`Unexpected HTTP route ${path}`);
  };
  const result = await bridge.fulfillBookOrbitRequests(task, http);
  assert.equal(result.fulfilled, true);
  assert.equal(task.status, 'fulfilled');
  assert.equal(calls.filter((c) => c.includes('/upload') || c.includes('/fulfill')).length, 0);
});

test('previously fulfilled sibling remains fulfilled after status lookup failure', async (t) => {
  const { bridge } = fixture(t);
  const task = frankTask({
    requestIds: ['req-done', 'req-pending'], matchedBookId: 321,
    requestFulfillments: { 'req-done': { fulfilled: true, fulfilledAt: '2026-10-29T00:00:00Z' } },
  });
  const fulfilled = [];
  const http = async (url, opts = {}) => {
    const path = new URL(url).pathname;
    if (path === '/api/v1/libraries/1/books') return reply({ items: [bookCard(321)], total: 1 });
    if (path.endsWith('/req-pending')) return reply({ id: 'req-pending', status: 'approved' });
    if (path.includes('/admin/book-requests/') && path.endsWith('/fulfill')) {
      fulfilled.push(path);
      return reply({ status: 'AVAILABLE' });
    }
    if (path.includes('/book-requests/')) return reply({ error: 'unavailable' }, 503);
    throw new Error(`Unexpected HTTP route ${opts.method || 'GET'} ${path}`);
  };
  await bridge.fulfillBookOrbitRequests(task, http);
  assert.equal(task.requestFulfillments['req-done'].fulfilled, true);
  assert.equal(task.requestFulfillments['req-pending'].fulfilled, true);
  assert.equal(fulfilled.length, 1);
  assert.ok(fulfilled[0].endsWith('/req-pending/fulfill'));
});
