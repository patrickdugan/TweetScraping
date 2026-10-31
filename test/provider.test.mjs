import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectFx, fetchJson, hydrateFx } from '../src/fx.mjs';
import { Store } from '../src/store.mjs';
import { Budget } from '../src/pace.mjs';

const post = (id, author = 'tarunchitra') => ({ type: 'status', id, author: { screen_name: author }, text: `Post ${id}`, created_at: '2026-10-01T00:00:00Z' });
async function fixture(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tweets-api-'));
  const store = new Store(dir); const budget = new Budget(1);
  t.after(async () => { budget.close(); store.close(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, budget, options: { handle: 'tarunchitra', apiBase: `http://127.0.0.1:${server.address().port}`, mode: 'timeline', includeReplies: true, limit: 1, maxPages: 10, retries: 0, gaitMinMs: 1, gaitMaxMs: 1 } };
}

test('limit mid-page resumes the same page without dropping remaining posts', async t => {
  const requests = [];
  const { store, budget, options } = await fixture(t, (req, res) => {
    const url = new URL(req.url, 'http://fixture'); requests.push(url.searchParams.get('cursor'));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ code: 200, results: url.searchParams.has('cursor') ? [post('3')] : [post('1'), post('2')], cursor: url.searchParams.has('cursor') ? {} : { bottom: 'next' } }));
  });
  assert.equal((await collectFx(options, store, budget)).stop, 'limit');
  assert.equal(store.loadCheckpoint('fx').cursor, null);
  // Simulate a new invocation by resetting the baseline; persisted rows remain.
  store.initial = store.rows.size;
  assert.equal((await collectFx({ ...options, limit: 10 }, store, budget)).stop, 'available_results_exhausted');
  assert.deepEqual([...store.rows.keys()], ['1', '2', '3']);
  assert.deepEqual(requests, [null, null, 'next']);
});

test('repost-only first page still advances; duplicate cursors stop boundedly', async t => {
  const { store, budget, options } = await fixture(t, (req, res) => {
    const cursor = new URL(req.url, 'http://fixture').searchParams.get('cursor');
    res.end(JSON.stringify({ code: 200, results: cursor ? [post('2')] : [post('1', 'someone_else')], cursor: { bottom: 'same' } }));
  });
  const result = await collectFx({ ...options, limit: 10 }, store, budget);
  assert.equal(result.stop, 'repeated_cursor'); assert.deepEqual([...store.rows.keys()], ['2']);
});

test('provider error in HTTP 200 is rejected, non-JSON gate is recorded', async t => {
  const { store, budget, options } = await fixture(t, (req, res) => { res.end(JSON.stringify({ code: 404, message: 'Unavailable' })); });
  await assert.rejects(fetchJson(options.apiBase, options, store, budget), /provider code 404/);
  const fetcher = async () => new Response('<html>Challenge</html>', { status: 403 });
  await assert.rejects(fetchJson(options.apiBase, options, store, budget, fetcher), /Non-JSON/);
  assert.equal(store.events.length, 2);
});

test('429 honors Retry-After when the wait exceeds the remaining budget', async t => {
  const { store, budget, options } = await fixture(t, (req, res) => { res.writeHead(429, { 'Retry-After': '3600' }); res.end('{"code":429}'); });
  await assert.rejects(fetchJson(options.apiBase, { ...options, retries: 1 }, store, budget), /Retry-After exceeds/);
});

test('search uses documented feed parameter; hydration rejects mismatched authors', async t => {
  const requests = [];
  const { store, budget, options } = await fixture(t, (req, res) => {
    requests.push(req.url);
    res.end(JSON.stringify(req.url.startsWith('/2/search') ? { code: 200, results: [post('1')], cursor: {} } : { code: 200, status: post('2', 'impostor') }));
  });
  await collectFx({ ...options, mode: 'search', limit: 10 }, store, budget);
  assert.match(requests[0], /feed=latest/); assert.match(requests[0], /q=from/);
  const urlsFile = path.join(store.dir, 'urls.txt'); fs.writeFileSync(urlsFile, 'https://x.com/tarunchitra/status/2');
  await hydrateFx({ ...options, urlsFile, limit: 10 }, store, budget);
  assert.equal(store.rows.has('2'), false);
});
