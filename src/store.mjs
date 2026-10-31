import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export function readLines(file) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try { out.push(JSON.parse(lines[i])); }
    catch (error) { throw new Error(`Invalid JSONL at ${file}:${i + 1}: ${error.message}`); }
  }
  return out;
}

function recoverJournal(file, onRecovery) {
  if (!fs.existsSync(file)) return;
  const raw = fs.readFileSync(file);
  if (!raw.length || raw.at(-1) === 10) return;
  const newline = raw.lastIndexOf(10);
  const tail = raw.subarray(newline + 1);
  try {
    JSON.parse(tail.toString('utf8'));
    // A valid record without a final newline must not concatenate with a new one.
    fs.appendFileSync(file, '\n');
  } catch {
    const quarantine = `${file}.torn-${Date.now()}`;
    fs.writeFileSync(quarantine, tail);
    fs.truncateSync(file, newline + 1);
    onRecovery({ status: 'recovered_torn_journal_tail', quarantine, bytes: tail.length });
  }
}

export class Store {
  constructor(dir) {
    this.dir = path.resolve(dir);
    fs.mkdirSync(this.dir, { recursive: true });
    this.lock = path.join(this.dir, '.lock');
    this.fd = fs.openSync(this.lock, 'wx');
    fs.writeSync(this.fd, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
    try {
      const recoveries = [];
      recoverJournal(path.join(this.dir, 'tweets.jsonl'), value => recoveries.push(value));
      this.rows = new Map(readLines(path.join(this.dir, 'tweets.jsonl')).map(row => [row.id, row]));
      this.initial = this.rows.size;
      this.runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex');
      this.runDir = path.join(this.dir, 'evidence', this.runId);
      fs.mkdirSync(this.runDir, { recursive: true });
      this.events = [];
      for (const recovery of recoveries) this.event(recovery);
    } catch (error) { this.close(); throw error; }
  }
  get added() { return this.rows.size - this.initial; }
  add(row, evidence) {
    if (this.rows.has(row.id)) return false;
    const record = { ...row, retrieved_at: new Date().toISOString(), evidence,
      text_sha256: crypto.createHash('sha256').update(row.text).digest('hex') };
    // Flush each record before advancing any cursor. Never write auth headers/cookies.
    const fd = fs.openSync(path.join(this.dir, 'tweets.jsonl'), 'a');
    try { fs.writeSync(fd, JSON.stringify(record) + '\n'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    this.rows.set(row.id, record);
    return true;
  }
  event(value) {
    const record = { at: new Date().toISOString(), ...value };
    this.events.push(record);
    fs.appendFileSync(path.join(this.runDir, 'events.jsonl'), JSON.stringify(record) + '\n');
  }
  checkpoint(key, value) { writeJson(path.join(this.dir, `checkpoint-${key}.json`), value); }
  loadCheckpoint(key) { return readJson(path.join(this.dir, `checkpoint-${key}.json`), null); }
  evidence(name, value) {
    const file = path.join(this.runDir, name);
    writeJson(file, value);
    return path.relative(this.dir, file).replaceAll('\\', '/');
  }
  finish(summary) {
    const report = { ...summary, run_id: this.runId, new_tweets: this.added,
      total_tweets: this.rows.size, finished_at: new Date().toISOString(),
      coverage: 'Observed available results only; historical completeness is not established.',
      events: this.events };
    writeJson(path.join(this.runDir, 'summary.json'), report);
    writeJson(path.join(this.dir, 'summary.json'), report);
    return report;
  }
  close() {
    if (this.fd != null) { fs.closeSync(this.fd); this.fd = null; fs.unlinkSync(this.lock); }
  }
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function exportRows(dir, format, output) {
  const rows = readLines(path.join(dir, 'tweets.jsonl'));
  const target = path.resolve(output);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (path.resolve(dir, 'tweets.jsonl') === target) throw new Error('Export must not overwrite tweets.jsonl.');
  if (format === 'csv') {
    const fields = ['id', 'author', 'url', 'created_at', 'text', 'source', 'text_status'];
    fs.writeFileSync(target, [fields.join(','), ...rows.map(row => fields.map(f => csvCell(row[f])).join(','))].join('\n') + '\n');
  } else if (format === 'corpus') {
    const docs = rows.map(row => ({ id: `tweet:${row.id}`, title: `@${row.author} — ${row.created_at ?? row.id}`,
      url: row.url, kind: 'tweet', author: row.author, published: row.created_at,
      text: row.text, source: row.source, text_sha256: row.text_sha256 }));
    fs.writeFileSync(target, docs.map(row => JSON.stringify(row)).join('\n') + (docs.length ? '\n' : ''));
  } else throw new Error('Format must be csv or corpus.');
  return rows.length;
}
