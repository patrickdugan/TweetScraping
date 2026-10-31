import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handle, tweetUrl, fxRows, graphqlRows, accepts, searchWindows } from '../src/model.mjs';
import { Store, readLines, exportRows } from '../src/store.mjs';
import { argumentsFor } from '../src/cli.mjs';
import { gait, retryAfter } from '../src/pace.mjs';

test('strict CLI dates, limits and canonical tweet URLs', () => {
  assert.equal(handle('@TarunChitra'), 'tarunchitra');
  assert.throws(() => handle('../../a'));
  assert.equal(tweetUrl('https://twitter.com/TarunChitra/status/123/photo/1').url, 'https://x.com/tarunchitra/status/123');
  assert.equal(tweetUrl('https://x.com.attacker.test/tarunchitra/status/123'), null);
  assert.throws(() => argumentsFor(['collect', '--handle', 'a', '--limit', 'NaN']));
  assert.throws(() => argumentsFor(['collect', '--handle', 'a', '--since', '2025-02-30']));
  assert.throws(() => argumentsFor(['collect', '--handle', 'a', '--gait-max-ms', '2']));
  assert.equal(argumentsFor(['collect', '--handle', 'a', '--include-replies']).includeReplies, true);
});

test('mixed timeline authors and quotes cannot become Tarun writing', () => {
  const rows = fxRows({ results: [
    { type: 'status', id: '1', author: { screen_name: 'Other' }, text: 'Reposted text', reposted_by: { screen_name: 'tarunchitra' } },
    { type: 'status', id: '2', author: { screen_name: 'tarunchitra' }, text: 'Own words', quote: { id: '3', text: 'Other words' } },
    { type: 'tombstone', id: '4' },
  ] });
  const own = rows.filter(row => accepts(row, { handle: 'tarunchitra', includeReplies: true }));
  assert.equal(own.length, 1); assert.equal(own[0].text, 'Own words'); assert.equal(own[0].quote_id, '3');
});

test('GraphQL note text is preserved; quoted and retweeted objects excluded', () => {
  const tweet = (id, text, author = 'tarunchitra') => ({ rest_id: id, legacy: { full_text: text }, core: { user_results: { result: { rest_id: '10', core: { screen_name: author } } } } });
  const outer = tweet('1', 'truncated…');
  outer.note_tweet = { note_tweet_results: { result: { text: 'The full long post' } } };
  outer.quoted_status_result = { result: tweet('2', 'quoted post') };
  const repost = tweet('3', 'RT someone');
  repost.legacy.retweeted_status_result = { result: tweet('4', 'original') };
  const rows = graphqlRows({ data: { entries: [outer, repost, outer] } });
  assert.deepEqual(rows.map(row => row.id), ['1']); assert.equal(rows[0].text, 'The full long post');
});

test('exclusive date bounds, reply filtering, contiguous search windows', () => {
  const options = { handle: 'a', since: '2020-01-01', until: '2020-03-01', windowDays: 30 };
  const windows = searchWindows(options);
  assert.deepEqual(windows, ['from:a since:2020-01-01 until:2020-01-31 -filter:replies', 'from:a since:2020-01-31 until:2020-03-01 -filter:replies']);
  assert.equal(accepts({ author: 'a', created_at: '2020-03-01T00:00:00.000Z' }, options), false);
  assert.equal(accepts({ author: 'a', created_at: '2020-02-01T00:00:00.000Z', reply_to: '99' }, options), false);
});

test('durable deduplication, lock exclusion and safe corpus/CSV exports', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tweets-store-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const row = { id: '1', author: 'a', url: 'https://x.com/a/status/1', text: '=SUM(1,2)\n"quoted"', source: 'fixture' };
  let store = new Store(dir);
  try { assert.equal(store.add(row, 'fixture'), true); assert.equal(store.add(row, 'fixture'), false); assert.throws(() => new Store(dir)); }
  finally { store.close(); }
  store = new Store(dir);
  try { assert.equal(store.rows.size, 1); assert.equal(store.added, 0); assert.equal(store.add(row), false); }
  finally { store.close(); }
  const csv = path.join(dir, 'tweets.csv'); const corpus = path.join(dir, 'corpus.jsonl');
  assert.equal(exportRows(dir, 'csv', csv), 1); assert.match(fs.readFileSync(csv, 'utf8'), /"'=SUM/);
  exportRows(dir, 'corpus', corpus); assert.equal(readLines(corpus)[0].text, row.text);
  assert.throws(() => exportRows(dir, 'corpus', path.join(dir, 'tweets.jsonl')));
});

test('pacing stays bounded; Retry-After supports seconds and HTTP dates', () => {
  for (let i = 0; i < 100; i++) assert.ok(gait(3000, 7000) >= 3000 && gait(3000, 7000) <= 7000);
  assert.equal(retryAfter('2'), 2000);
  assert.equal(retryAfter('Thu, 01 Jan 1970 00:00:02 GMT', 0), 2000);
});

test('torn last write is quarantined; valid missing newline is repaired', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tweets-torn-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'tweets.jsonl');
  const first = { id: '1', text: 'durable' };
  fs.writeFileSync(file, JSON.stringify(first) + '\n{"id":"2","text":"part');
  let store = new Store(dir);
  try { assert.equal(store.rows.size, 1); assert.equal(store.events[0].status, 'recovered_torn_journal_tail'); }
  finally { store.close(); }
  fs.writeFileSync(file, JSON.stringify(first));
  store = new Store(dir);
  try { store.add({ id: '2', text: 'next' }, 'fixture'); assert.equal(readLines(file).length, 2); }
  finally { store.close(); }
  // Corruption in an earlier complete line must be reported, not erased.
  fs.writeFileSync(file, 'broken\n' + JSON.stringify(first) + '\n');
  assert.throws(() => new Store(dir), /Invalid JSONL/);
  assert.equal(fs.existsSync(path.join(dir, '.lock')), false);
});
