#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { handle } from './model.mjs';
import { Store, exportRows } from './store.mjs';
import { Budget } from './pace.mjs';
import { collectFx, hydrateFx } from './fx.mjs';

const help = `TweetScraping — no X API token required

node src/cli.mjs collect --handle tarunchitra [--provider auto|fx|browser]
node src/cli.mjs collect --handle tarunchitra --mode search --since 2020-01-01 --until 2021-01-01
node src/cli.mjs login [--user-data-dir .sessions/x | --cdp-url http://127.0.0.1:9222]
node src/cli.mjs discover --handle tarunchitra
node src/cli.mjs hydrate --handle tarunchitra --urls-file runs/tarunchitra/candidates.jsonl
node src/cli.mjs export --handle tarunchitra --format corpus --output runs/tarunchitra/corpus.jsonl

Options:
  --out DIR              Durable dataset (default runs/HANDLE). Same directory resumes.
  --limit N              Maximum NEW authored posts per invocation (default 1000).
  --max-pages N          Provider pages / browser scrolls / hydrate attempts (default 40).
  --max-minutes N        Total execution budget (default 15).
  --include-replies      Include authored replies (reposts by others are excluded).
  --since YYYY-MM-DD     Inclusive start; --until is exclusive.
  --window-days N        Search date window width (default 30).
  --fresh                Restart pagination while preserving collected records.
  --gait-min-ms N        Minimum Gaussian pace delay (default 3000).
  --gait-max-ms N        Maximum delay (default 7000).
  --retries N            Request/reload retries (default 2).
  --headless             Run browser without UI; gate waits fail immediately.
  --gate-wait-ms N       Headed browser login/challenge wait (default 120000).
  --channel chrome|msedge|chromium  Browser channel (default chrome).
  --user-data-dir DIR    Dedicated persistent session (default .sessions/x).
  --cdp-url URL          Attach to existing authenticated Chrome/Edge.
  --api-base URL         Fx-compatible server (default https://api.fxtwitter.com).

Exit codes: 0 = command yielded data/session; 2 = bounded/partial/empty; 1 = failed.
Coverage and provider failures are always recorded in summary.json.
`;

export function argumentsFor(argv) {
  const strings = ['handle', 'out', 'provider', 'mode', 'limit', 'max-pages', 'max-minutes', 'since', 'until', 'window-days', 'gait-min-ms', 'gait-max-ms', 'retries', 'gate-wait-ms', 'channel', 'user-data-dir', 'cdp-url', 'api-base', 'urls-file', 'format', 'output'];
  const booleans = ['help', 'headless', 'fresh', 'include-replies'];
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: Object.fromEntries([
    ...strings.map(key => [key, { type: 'string' }]), ...booleans.map(key => [key, { type: 'boolean' }]),
  ]) });
  if (values.help) return { help: true };
  if (positionals.length !== 1 || !['collect', 'discover', 'hydrate', 'export', 'login'].includes(positionals[0])) throw new Error('Choose collect, discover, hydrate, export or login. Use --help.');
  const command = positionals[0];
  const name = handle(values.handle ?? (command === 'login' ? 'session' : ''));
  function number(key, fallback, min, max = 1000000) {
    const value = Number(values[key] ?? fallback);
    if (!Number.isFinite(value) || value < min || value > max || (key !== 'max-minutes' && !Number.isInteger(value))) throw new Error(`Invalid --${key}. Expected ${min}–${max}.`);
    return value;
  }
  for (const key of ['since', 'until']) {
    if (values[key] && (!/^\d{4}-\d{2}-\d{2}$/.test(values[key]) || Number.isNaN(Date.parse(values[key])) || new Date(values[key]).toISOString().slice(0, 10) !== values[key])) throw new Error(`Invalid --${key} date.`);
  }
  if (values.since && values.until && values.since >= values.until) throw new Error('--since must precede --until.');
  const provider = values.provider ?? 'auto'; const mode = values.mode ?? 'timeline';
  if (!['auto', 'fx', 'browser'].includes(provider)) throw new Error('Invalid --provider.');
  if (!['timeline', 'search'].includes(mode)) throw new Error('Invalid --mode.');
  const channel = values.channel ?? 'chrome';
  if (!['chrome', 'msedge', 'chromium'].includes(channel)) throw new Error('Invalid --channel.');
  const gaitMinMs = number('gait-min-ms', 3000, 100, 60000);
  const gaitMaxMs = number('gait-max-ms', 7000, gaitMinMs, 60000);
  const apiBase = new URL(values['api-base'] ?? 'https://api.fxtwitter.com').href;
  if (!/^https?:/.test(apiBase)) throw new Error('--api-base must be HTTP(S).');
  return { command, handle: name, out: path.resolve(values.out ?? `runs/${name}`), provider, mode,
    limit: number('limit', 1000, 1), maxPages: number('max-pages', 40, 1, 10000),
    maxMinutes: number('max-minutes', 15, 0.01, 1440), since: values.since, until: values.until,
    windowDays: number('window-days', 30, 1, 366), includeReplies: !!values['include-replies'],
    fresh: !!values.fresh, headless: !!values.headless, gaitMinMs, gaitMaxMs,
    retries: number('retries', 2, 0, 10), gateWaitMs: number('gate-wait-ms', 120000, 0, 3600000),
    channel, userDataDir: values['user-data-dir'] ?? '.sessions/x', cdpUrl: values['cdp-url'],
    apiBase, urlsFile: values['urls-file'], format: values.format ?? 'corpus', output: values.output };
}

export async function main(argv = process.argv.slice(2)) {
  const options = argumentsFor(argv);
  if (options.help) { console.log(help); return 0; }
  if (options.command === 'export') {
    if (!options.output) throw new Error('export requires --output.');
    console.log(`Exported ${exportRows(options.out, options.format, options.output)} posts.`); return 0;
  }
  if (options.command === 'hydrate' && !options.urlsFile) throw new Error('hydrate requires --urls-file.');
  const store = new Store(options.out); const budget = new Budget(options.maxMinutes);
  const onSignal = () => budget.controller.abort(new Error('Interrupted; saved records and checkpoint retained.'));
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  const results = []; const errors = [];
  const startedAt = new Date().toISOString();
  let failure = null;
  try {
    if ([...store.rows.values()].some(row => row.author !== options.handle)) throw new Error('Output directory contains another author. Choose a separate --out directory.');
    if (options.command === 'collect') {
      if (['auto', 'fx'].includes(options.provider)) {
        try { results.push(await collectFx(options, store, budget)); }
        catch (error) {
          errors.push({ provider: 'fxtwitter', error: error.message });
          store.event({ provider: 'fxtwitter', status: 'provider_failed', error: error.message });
          if (options.provider === 'fx') throw error;
          console.log(`[auto] Public provider failed: ${error.message}. Trying browser.`);
        }
      }
      if (options.provider === 'browser' || (options.provider === 'auto' && (!results.length || store.rows.size === 0))) {
        const { collectBrowser } = await import('./browser.mjs');
        results.push(await collectBrowser(options, store, budget));
      }
    } else if (options.command === 'hydrate') results.push(await hydrateFx(options, store, budget));
    else {
      const browser = await import('./browser.mjs');
      results.push(await browser[options.command](options, store, budget));
    }
  } catch (error) { failure = error; store.event({ status: 'failed', error: error.message }); }
  finally {
    budget.close(); process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
    try {
      const partialStops = ['limit', 'max_pages', 'max_scrolls', 'repeated_cursor', 'partial_errors'];
      const empty = options.command === 'discover' ? !results.some(r => r.new_candidates) : options.command !== 'login' && store.added === 0;
      const status = failure ? (store.added ? 'partial' : 'failed') : partialStops.some(stop => results.some(r => r.stop === stop)) ? 'bounded' : empty ? 'empty' : errors.length ? 'recovered' : 'collected';
      const summary = store.finish({ mission: options.command, handle: options.handle, started_at: startedAt,
        status, options: { provider: options.provider, mode: options.mode, since: options.since, until: options.until,
          limit: options.limit, max_pages: options.maxPages, include_replies: options.includeReplies },
        results, errors, error: failure?.message ?? null });
      console.log(JSON.stringify({ status, new_tweets: summary.new_tweets, total_tweets: summary.total_tweets,
        observed_range: summary.observed_range, account_status_count: summary.account?.reported_status_count,
        account_counter_includes_reposts: summary.account ? true : undefined,
        new_candidates: results.find(r => r.new_candidates != null)?.new_candidates,
        summary: path.join(options.out, 'summary.json') }, null, 2));
      process.exitCode = status === 'failed' ? 1 : ['partial', 'bounded', 'empty'].includes(status) ? 2 : 0;
    } finally { store.close(); }
  }
  return process.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
