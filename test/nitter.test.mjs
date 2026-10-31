import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { parseNitter, snowflakeDate, collectNitter } from '../src/nitter.mjs';
import { accepts } from '../src/model.mjs';
import { Store } from '../src/store.mjs';
import { Budget } from '../src/pace.mjs';
import { argumentsFor } from '../src/cli.mjs';

const id = (date, sequence = 0) => String(((BigInt(Date.parse(date)) - 1288834974657n) << 22n) + BigInt(sequence));
const card = (tweetId, author = 'duganist', text = 'Own &amp; public<br>words', reply = false) => `<div class="timeline-item">
<a class="tweet-link" href="/${author}/status/${tweetId}#m"></a><div class="tweet-body">
<div class="tweet-header"><a class="username" title="@${author}">@${author}</a><span class="tweet-date"><a title="Jan 1, 2024 · 12:00 PM UTC"></a></span></div>
${reply ? '<div class="replying-to">Replying to @other</div>' : ''}<div class="tweet-content">${text}</div>
<div class="quote"><div class="tweet-header"><a class="username" title="@other">@other</a></div><div class="tweet-content">Quoted words</div></div>
</div></div>`;
const page = (cards, cursor = null) => `<html><head><title>Public search</title></head><body><aside><a href="/duganist/status/9999999999999999999">Unrelated sidebar post</a></aside><div class="timeline">${cards || 'No items found'}${cursor ? `<div class="show-more"><a href="?cursor=${encodeURIComponent(cursor)}">Load more</a></div>` : ''}</div></body></html>`;

test('Nitter extracts own card text, not sidebar or quoted authors, with precise ID dates', () => {
  const tweetId = id('2024-01-31T23:59:59.999Z');
  const parsed = parseNitter(page(card(tweetId)), 'https://mirror.test/duganist/search');
  assert.equal(parsed.rows.length, 1); assert.equal(parsed.rows[0].text, 'Own & public\nwords');
  assert.equal(parsed.rows[0].author, 'duganist'); assert.equal(parsed.rows[0].created_at, '2024-01-31T23:59:59.999Z');
  assert.equal(parsed.rows[0].source, 'nitter_public_search'); assert.equal(snowflakeDate('bad'), null);
});

test('exclusive end date is enforced even when mirror returns the end day', () => {
  const parsed = parseNitter(page(card(id('2024-02-01T13:19:56Z')) + card(id('2024-01-31T23:00:00Z'))), 'https://mirror.test');
  const rows = parsed.rows.filter(row => accepts(row, { handle: 'duganist', includeReplies: true, since: '2024-01-01', until: '2024-02-01' }));
  assert.equal(rows.length, 1); assert.equal(rows[0].created_at, '2024-01-31T23:00:00.000Z');
});

test('disabled search, challenge pages and foreign pagination cannot become empty success', () => {
  assert.throws(() => parseNitter('<title>Search disabled</title><body>No items found</body>', 'https://mirror.test'), /unavailable or gated/);
  assert.throws(() => parseNitter('<title>Making sure you are not a bot!</title>', 'https://mirror.test'), /unavailable or gated/);
  const html = page(card(id('2024-01-01T12:00:00Z')), 'x').replace('?cursor=x', 'https://different.test/?cursor=x');
  assert.throws(() => parseNitter(html, 'https://mirror.test'), /left the configured origin/);
  assert.equal(parseNitter(page(''), 'https://mirror.test').empty, true);
  assert.equal(parseNitter('<title>Public search</title><body><div class="timeline"><div class="timeline-item"><a>Load newest</a></div>No more items</div></body>', 'https://mirror.test').empty, true);
});

test('public historical provider requires explicit date bounds', () => {
  assert.throws(() => argumentsFor(['collect', '--handle', 'duganist', '--provider', 'nitter']), /Nitter requires/);
});

test('historical pagination and mid-page resumption lose no posts', async t => {
  const first = id('2024-01-31T12:00:00Z'); const second = id('2024-01-30T12:00:00Z'); const third = id('2024-01-29T12:00:00Z');
  const server = http.createServer((req, res) => {
    const cursor = new URL(req.url, 'http://fixture').searchParams.get('cursor');
    res.setHeader('Content-Type', 'text/html');
    res.end(cursor ? page(card(third)) : page(card(first) + card(second) + card(id('2024-01-01T00:00:00Z'), 'other'), 'older'));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nitter-test-')); const store = new Store(dir); const budget = new Budget(1);
  t.after(async () => { store.close(); budget.close(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  const options = { handle: 'duganist', mode: 'search', since: '2024-01-01', until: '2024-02-01', windowDays: 31,
    includeReplies: true, mirrorBase: `http://127.0.0.1:${server.address().port}`, limit: 1, maxPages: 5, retries: 0, gaitMinMs: 1, gaitMaxMs: 1 };
  assert.equal((await collectNitter(options, store, budget)).stop, 'limit');
  assert.equal(store.loadCheckpoint('nitter').cursor, null);
  store.initial = store.rows.size;
  assert.equal((await collectNitter({ ...options, limit: 10 }, store, budget)).stop, 'requested_windows_finished');
  assert.deepEqual([...store.rows.keys()], [first, second, third]);
  assert.equal(store.loadCheckpoint('nitter').complete, true);
});
