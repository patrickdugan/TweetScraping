import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const id = day => String((BigInt(Date.parse(`2024-01-${day}T12:00:00Z`)) - 1288834974657n) << 22n);
const card = tweetId => `<div class="timeline-item"><a class="tweet-link" href="/duganist/status/${tweetId}"></a><div class="tweet-body"><div class="tweet-header"><a class="username" title="@duganist">@duganist</a></div><div class="tweet-content">A public post</div></div></div>`;
const page = (cards, cursor) => `<title>Search</title><div class="timeline">${cards}${cursor ? `<div class="show-more"><a href="?cursor=${cursor}">Load more</a></div>` : ''}</div>`;

async function runJob(t, loop) {
  const server = http.createServer((req, res) => {
    const cursor = new URL(req.url, 'http://fixture').searchParams.get('cursor');
    res.end(cursor ? page(card(id('29')), loop ? 'older' : null) : page(card(id('31')) + card(id('30')), 'older'));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tweet-backfill-'));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  const child = spawn(process.execPath, ['scripts/backfill.mjs', '--handle', 'duganist', '--since', '2024-01-01', '--until', '2024-02-01', '--window-days', '31',
    '--include-replies', '--out', dir, '--mirror-base', `http://127.0.0.1:${server.address().port}`, '--limit', loop ? '10' : '1', '--max-pages', '10',
    '--max-minutes', '1', '--gait-min-ms', '100', '--gait-max-ms', '100'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const timeout = setTimeout(() => child.kill(), 20000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  clearTimeout(timeout);
  return { code, dir, job: JSON.parse(fs.readFileSync(path.join(dir, 'backfill-job.json'), 'utf8')), output };
}

test('durable backfill crosses bounded child batches, exports, and cleans both locks', async t => {
  const result = await runJob(t, false);
  assert.equal(result.code, 0, result.output); assert.equal(result.job.status, 'completed');
  assert.equal(result.job.batches, 3); assert.equal(result.job.total_tweets, 3);
  assert.equal(fs.existsSync(path.join(result.dir, '.lock')), false);
  assert.equal(fs.existsSync(path.join(result.dir, 'backfill.lock')), false);
  assert.equal(fs.readFileSync(path.join(result.dir, 'corpus.jsonl'), 'utf8').trim().split('\n').length, 3);
  assert.ok(fs.existsSync(path.join(result.dir, 'tweets.csv')));
});

test('repeated mirror cursors stop the job rather than creating an immediate retry loop', async t => {
  const result = await runJob(t, true);
  assert.equal(result.code, 1); assert.equal(result.job.status, 'failed'); assert.equal(result.job.batches, 1);
  assert.match(result.job.error, /pagination repeated/);
});
