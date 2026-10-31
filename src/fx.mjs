import fs from 'node:fs';
import { accepts, fxRows, searchWindows, tweetUrl } from './model.mjs';
import { gait, retryAfter } from './pace.mjs';

export async function fetchJson(url, options, store, budget, fetcher = fetch) {
  for (let attempt = 0; attempt <= options.retries; attempt++) {
    budget.check();
    try {
      const response = await fetcher(url, { signal: AbortSignal.any([budget.signal, AbortSignal.timeout(Math.min(30000, budget.remaining()))]),
        headers: { Accept: 'application/json', 'User-Agent': 'TweetScraping/0.1' } });
      if (response.status === 204) return { code: 204, results: [], cursor: {} };
      const declaredLength = Number(response.headers.get('content-length') ?? 0);
      if (declaredLength > 20000000) throw new Error('Response exceeds 20 MB cap.');
      // Enforce the cap while streaming, including chunked responses.
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 20000000) throw new Error('Response exceeds 20 MB cap.');
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      let payload;
      try { payload = JSON.parse(raw); } catch {
        const error = new Error(`Non-JSON response (${response.status}); possible access gate.`);
        error.terminal = [401, 403, 404].includes(response.status);
        error.waitMs = retryAfter(response.headers.get('retry-after'));
        throw error;
      }
      if (!payload || typeof payload !== 'object') throw new Error('Expected a JSON object from the provider.');
      const code = payload.code ?? response.status;
      if (response.ok && code >= 200 && code < 300) return payload;
      const transient = [429, 500, 502, 503, 504].includes(response.status) || [429, 500, 502, 503, 504].includes(code);
      const error = new Error(`HTTP ${response.status}, provider code ${code}: ${String(payload.message ?? 'request failed').slice(0, 160)}`);
      error.terminal = !transient;
      error.waitMs = retryAfter(response.headers.get('retry-after'));
      throw error;
    } catch (error) {
      store.event({ provider: 'fxtwitter', status: 'request_failed', url, attempt, error: error.message });
      if (error.terminal || attempt === options.retries || budget.signal.aborted) throw error;
      const pause = Math.max(error.waitMs ?? 0, Math.min(60000, 2000 * 2 ** attempt));
      if (pause >= budget.remaining()) throw new Error('Retry-After exceeds remaining run budget.');
      await budget.wait(pause);
    }
  }
}

export async function collectFx(options, store, budget) {
  const queries = options.mode === 'search' ? searchWindows(options) : [null];
  const scope = JSON.stringify({ handle: options.handle, queries, replies: options.includeReplies,
    since: options.since, until: options.until, base: options.apiBase });
  const saved = options.fresh ? null : store.loadCheckpoint('fx');
  const state = saved?.scope === scope && !saved.complete ? saved : { scope, queryIndex: 0, cursor: null, complete: false };
  let pages = 0;
  let accountObserved = false;
  const cursors = new Set();
  while (state.queryIndex < queries.length && pages < options.maxPages && store.added < options.limit) {
    budget.check();
    const query = queries[state.queryIndex];
    const url = new URL(query ? '/2/search' : `/2/profile/${options.handle}/statuses`, options.apiBase);
    url.searchParams.set('count', '100');
    if (query) { url.searchParams.set('q', query); url.searchParams.set('feed', 'latest'); }
    if (options.includeReplies) url.searchParams.set('with_replies', 'true');
    if (state.cursor) url.searchParams.set('cursor', state.cursor);
    const payload = await fetchJson(url, options, store, budget);
    if (!Array.isArray(payload.results)) throw new Error('Provider timeline response has no results array.');
    if (!accountObserved) {
      const author = payload.results.find(entry => entry.author?.screen_name?.toLowerCase() === options.handle)?.author;
      if (author) {
        accountObserved = true;
        store.observeAccount({ handle: options.handle, id: author.id ?? null,
          reported_status_count: author.statuses ?? null,
          counter_scope: 'Provider account status counter includes reposts; it is not an authored-post archive count.',
          source: 'fxtwitter_v2' });
        if (author.statuses != null) console.log(`[account] @${options.handle}: provider reports ${author.statuses} statuses (includes reposts; collected separately).`);
      }
    }
    const evidence = store.evidence(`fx-${String(pages).padStart(4, '0')}.json`, { url: url.href, payload });
    pages++;
    const rows = fxRows(payload);
    let truncated = false; let added = 0;
    for (const row of rows) {
      if (!accepts(row, options)) continue;
      if (store.rows.has(row.id)) continue;
      if (store.added >= options.limit) { truncated = true; break; }
      if (store.add(row, evidence)) added++;
    }
    store.event({ provider: 'fxtwitter', page: pages, received: rows.length, added, query });
    console.log(`[fx] page ${pages}: ${rows.length} received, ${added} new @${options.handle} posts; ${store.rows.size} saved total`);
    // Keep the current cursor if the page was cut short, so resume loses no rows.
    if (truncated) { store.checkpoint('fx', state); return { provider: 'fxtwitter', stop: 'limit', pages }; }
    const next = payload.cursor?.bottom;
    if (!next || !rows.length) { state.queryIndex++; state.cursor = null; }
    else {
      const key = `${state.queryIndex}:${next}`;
      if (cursors.has(key) || next === state.cursor) {
        store.checkpoint('fx', state);
        return { provider: 'fxtwitter', stop: 'repeated_cursor', pages };
      }
      cursors.add(key); state.cursor = next;
    }
    state.complete = state.queryIndex >= queries.length;
    store.checkpoint('fx', state);
    // Known posts/reposts are not exhaustion while the cursor still advances.
    // Explicit page/time limits and repeated-cursor detection bound this scan.
    if (!state.complete && pages < options.maxPages && store.added < options.limit) await budget.wait(gait(options.gaitMinMs, options.gaitMaxMs));
  }
  return { provider: 'fxtwitter', stop: state.complete ? 'available_results_exhausted' : store.added >= options.limit ? 'limit' : 'max_pages', pages };
}

export async function hydrateFx(options, store, budget) {
  const text = fs.readFileSync(options.urlsFile, 'utf8');
  const urls = [...new Set(text.match(/https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[a-z0-9_]+\/status\/\d+/gi) ?? [])];
  if (!urls.length) throw new Error('No tweet URLs found in --urls-file.');
  const eligible = [...new Map(urls.map(tweetUrl).filter(item => item?.author === options.handle && !store.rows.has(item.id)).map(item => [item.id, item])).values()];
  let failed = 0; let attempted = 0;
  for (const item of eligible) {
    if (attempted >= options.maxPages || store.added >= options.limit) break;
    budget.check(); attempted++;
    const url = new URL(`/2/status/${item.id}`, options.apiBase);
    try {
      const payload = await fetchJson(url, options, store, budget);
      const evidence = store.evidence(`hydrate-${item.id}.json`, { url: url.href, payload });
      const rows = fxRows(payload).filter(row => row.id === item.id && accepts(row, options));
      if (!rows.length) throw new Error('Requested tweet was unavailable, filtered, or resolved to another author.');
      for (const row of rows) store.add(row, evidence);
    } catch (error) { failed++; store.event({ status: 'hydrate_failed', id: item.id, error: error.message }); }
    if (attempted < Math.min(eligible.length, options.maxPages) && store.added < options.limit) await budget.wait(gait(options.gaitMinMs, options.gaitMaxMs));
  }
  const remaining = eligible.length - attempted;
  return { provider: 'fxtwitter', attempted, failed, remaining,
    stop: failed ? 'partial_errors' : remaining ? (store.added >= options.limit ? 'limit' : 'max_pages') : 'url_batch_finished' };
}
