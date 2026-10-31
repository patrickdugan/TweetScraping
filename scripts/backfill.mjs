#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { argumentsFor } from '../src/cli.mjs';
import { exportRows, readJson, writeJson } from '../src/store.mjs';

const argv = process.argv.slice(2);
const options = argumentsFor(['collect', ...argv, '--provider', 'nitter', '--mode', 'search']);
if (options.help) {
  console.log('Public backfill: node scripts/backfill.mjs --handle USER --since YYYY-MM-DD --until YYYY-MM-DD --include-replies --max-minutes 1440\nUses Nitter only. Common collect options apply. --max-minutes bounds the whole job; each child batch is at most 15 minutes.');
  process.exit(0);
}
fs.mkdirSync(options.out, { recursive: true });
const lock = path.join(options.out, 'backfill.lock');
const jobFile = path.join(options.out, 'backfill-job.json');
let lockFd;
try { lockFd = fs.openSync(lock, 'wx'); }
catch { throw new Error(`A backfill job lock already exists: ${lock}. Check its PID before removing a stale lock.`); }
fs.writeSync(lockFd, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
const started = Date.now(); const deadline = started + options.maxMinutes * 60000;
const job = { pid: process.pid, child_pid: null, status: 'running', handle: options.handle,
  since: options.since, until: options.until, started_at: new Date(started).toISOString(),
  deadline: new Date(deadline).toISOString(), batches: 0, total_tweets: null, error: null };
const save = () => writeJson(jobFile, { ...job, updated_at: new Date().toISOString() });
let child = null; let interrupted = false;
function stop() { interrupted = true; if (child) child.kill(); }
process.once('SIGINT', stop); process.once('SIGTERM', stop);
function exportSnapshot() {
  if (!fs.existsSync(path.join(options.out, 'tweets.jsonl'))) return;
  exportRows(options.out, 'corpus', path.join(options.out, 'corpus.jsonl'));
  exportRows(options.out, 'csv', path.join(options.out, 'tweets.csv'));
}
try {
  save();
  while (!interrupted && Date.now() < deadline) {
    const batchMinutes = Math.min(15, (deadline - Date.now()) / 60000);
    if (batchMinutes < 0.01) break;
    const batchArgs = job.batches ? argv.filter(arg => arg !== '--fresh') : argv;
    const args = [path.resolve(import.meta.dirname, '../src/cli.mjs'), 'collect', ...batchArgs,
      '--provider', 'nitter', '--mode', 'search', '--max-minutes', String(batchMinutes)];
    const attemptAt = Date.now();
    child = spawn(process.execPath, args, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.pipe(process.stdout, { end: false }); child.stderr.pipe(process.stderr, { end: false });
    job.batches++; job.child_pid = child.pid; job.status = 'running'; save();
    const childPid = child.pid;
    const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code ?? 1)); });
    child = null; job.child_pid = null;
    // A forced interruption may leave this job's own child lock. Never remove another writer's lock.
    const writerLock = path.join(options.out, '.lock');
    const owner = readJson(writerLock, null);
    if (owner?.pid === childPid) fs.unlinkSync(writerLock);
    if (interrupted) { job.status = 'interrupted'; break; }
    const summary = readJson(path.join(options.out, 'summary.json'), null);
    if (!summary || Date.parse(summary.started_at) < attemptAt - 1000) throw new Error('Child ended without a fresh run summary.');
    job.total_tweets = summary.total_tweets; job.last_exit_code = exitCode;
    job.error = summary.error; exportSnapshot(); save();
    if (summary.results?.some(result => result.provider === 'nitter' && result.stop === 'requested_windows_finished')) {
      job.status = 'completed'; job.error = null; break;
    }
    if (summary.results?.some(result => result.stop === 'repeated_cursor')) throw new Error('Mirror pagination repeated a cursor; checkpoint retained for inspection.');
    if (interrupted) break;
    const transient = /Mirror HTTP (?:429|5\d\d)|fetch failed|timed out|aborted|Maximum run time|run budget/i.test(summary.error ?? '');
    if (summary.status !== 'bounded' && !transient) throw new Error(summary.error ?? `Backfill batch failed (${summary.status}).`);
    if (transient && !/Maximum run time|run budget/i.test(summary.error ?? '')) {
      const wait = Math.min(120000, deadline - Date.now());
      if (wait > 0) { job.status = 'cooldown'; job.next_retry_at = new Date(Date.now() + wait).toISOString(); save(); await sleep(wait); }
    }
  }
  if (job.status !== 'completed') job.status = interrupted ? 'interrupted' : 'bounded';
} catch (error) { job.status = 'failed'; job.error = error.message; console.error(error.message); }
finally {
  process.off('SIGINT', stop); process.off('SIGTERM', stop);
  job.finished_at = new Date().toISOString(); save();
  fs.closeSync(lockFd); fs.unlinkSync(lock);
  console.log(JSON.stringify({ job: jobFile, status: job.status, total_tweets: job.total_tweets, error: job.error }, null, 2));
  process.exitCode = job.status === 'completed' ? 0 : job.status === 'failed' ? 1 : 2;
}
