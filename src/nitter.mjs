import { load } from 'cheerio';
import { accepts, handle, searchWindows } from './model.mjs';
import { gait, retryAfter } from './pace.mjs';
import path from 'node:path';
import { writeJson } from './store.mjs';

export function snowflakeDate(id) {
  if (!/^\d{15,22}$/.test(String(id))) return null;
  const timestamp = Number((BigInt(id) >> 22n) + 1288834974657n);
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// Parse only actual timeline cards. Profile/sidebar links can contain unrelated dates.
export function parseNitter(html, base) {
  const $ = load(html);
  const title = $('title').text();
  const body = $('body').text();
  const gatePattern = /search disabled|access denied|service is suspended|confirm this search|making sure you|just a moment|checking your browser/i;
  const gate = gatePattern.test(title) || (!$('.timeline').length && gatePattern.test(body.slice(0, 1200)));
  if (gate) throw new Error(`Mirror unavailable or gated: ${title.slice(0, 160)}`);
  if (!$('.timeline').length) throw new Error(`Mirror did not return a timeline: ${title.slice(0, 160)}`);
  // End pages also use timeline-item for a "Load newest" utility row.
  const cards = $('.timeline > .timeline-item').filter((_, element) => $(element).children('a.tweet-link').length > 0);
  const rows = [];
  cards.each((_, element) => {
    const item = $(element);
    const bodyNode = item.children('.tweet-body').first();
    const header = bodyNode.find('.tweet-header').first();
    const username = header.find('a.username').first().attr('title') ?? header.find('a.username').first().text();
    const link = item.children('a.tweet-link').first().attr('href');
    const match = link?.match(/^\/([a-z0-9_]{1,15})\/status\/(\d+)(?:[?#/]|$)/i);
    if (!match || !username || username.replace(/^@/, '').trim().toLowerCase() !== match[1].toLowerCase()) return;
    const author = handle(match[1]); const id = match[2];
    const content = bodyNode.children('.tweet-content').first().clone();
    content.find('.quote, .quote-big, .quote-link').remove();
    content.find('br').replaceWith('\n');
    const text = content.text().trim();
    const photos = bodyNode.children('.attachments').find('img').map((_, img) => {
      const src = $(img).attr('src');
      try { return new URL(src, base).href; } catch { return null; }
    }).get().filter(Boolean);
    const attachments = bodyNode.children('.attachments').length > 0;
    if (!text && !attachments) return;
    const createdAt = snowflakeDate(id);
    if (!createdAt) return;
    const reply = bodyNode.children('.replying-to').first().text().trim();
    rows.push({ id, author, author_id: null, url: `https://x.com/${author}/status/${id}`, text,
      created_at: createdAt, created_at_source: 'snowflake_id',
      displayed_date: header.find('.tweet-date a').first().attr('title') ?? null,
      lang: null, conversation_id: null, reply_to: reply || null,
      quote_id: bodyNode.children('.quote').find('a[href*="/status/"]').first().attr('href')?.match(/\/status\/(\d+)/)?.[1] ?? null,
      reposted_by: item.find('.retweet-header').first().text().trim() || null,
      metrics: {}, media: attachments ? { photos, attachments_present: true } : null,
      source: 'nitter_public_search', text_status: 'mirror_rendered_text', mirror: new URL(base).origin });
  });
  const more = $('.timeline > .show-more a').last().attr('href');
  let cursor = null;
  if (more) {
    const next = new URL(more, base);
    if (next.origin !== new URL(base).origin) throw new Error('Mirror pagination left the configured origin.');
    cursor = next.searchParams.get('cursor');
  }
  if (cards.length && !rows.length) throw new Error('Timeline cards were present but none could be parsed safely.');
  return { rows, cursor, cards: cards.length, title,
    empty: cards.length === 0 && /no (?:items|results|tweets) found|no more items/i.test(body) };
}

async function fetchMirror(url, options, store, budget) {
  for (let attempt = 0; attempt <= options.retries; attempt++) {
    budget.check();
    try {
      const response = await fetch(url, {
        signal: AbortSignal.any([budget.signal, AbortSignal.timeout(Math.min(30000, budget.remaining()))]),
        headers: { Accept: 'text/html', 'User-Agent': 'TweetScraping/0.1 public research' },
      });
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length; if (size > 10000000) throw new Error('Mirror response exceeded 10 MB.');
        chunks.push(chunk);
      }
      const html = Buffer.concat(chunks).toString('utf8');
      if (!response.ok) {
        const error = new Error(`Mirror HTTP ${response.status}.`);
        error.terminal = ![429, 500, 502, 503, 504].includes(response.status);
        error.wait = retryAfter(response.headers.get('retry-after'));
        error.status = response.status;
        error.retryAfter = response.headers.get('retry-after');
        throw error;
      }
      return { html, url: response.url };
    } catch (error) {
      store.event({ provider: 'nitter', status: 'request_failed', url: url.href, attempt,
        http_status: error.status, retry_after: error.retryAfter, error: error.message });
      if (error.terminal || attempt === options.retries || budget.signal.aborted) throw error;
      const wait = Math.max(error.wait ?? 0, error.status === 429 ? 15000 * 2 ** attempt : 2000 * 2 ** attempt);
      if (wait >= budget.remaining()) throw new Error('Mirror Retry-After exceeds run budget.');
      await budget.wait(wait);
    }
  }
}

export async function collectNitter(options, store, budget) {
  if (options.mode !== 'search' || !options.since || !options.until) throw new Error('Nitter backfill requires --mode search, --since and --until.');
  const windows = searchWindows(options).map(query => ({ since: query.match(/since:(\S+)/)[1], until: query.match(/until:(\S+)/)[1] }));
  const scope = JSON.stringify({ mirror: options.mirrorBase, handle: options.handle, windows, replies: options.includeReplies });
  const saved = options.fresh ? null : store.loadCheckpoint('nitter');
  const state = saved?.scope === scope && !saved.complete ? saved : { scope, windowIndex: 0, cursor: null, complete: false };
  const seen = new Set(); let pages = 0; let completed = 0;
  store.checkpoint('nitter', state);
  while (state.windowIndex < windows.length && pages < options.maxPages && store.added < options.limit) {
    budget.check();
    const window = windows[state.windowIndex];
    const url = new URL(`/${options.handle}/search`, options.mirrorBase);
    url.searchParams.set('f', 'tweets');
    url.searchParams.set('q', options.includeReplies ? '' : '-filter:replies');
    url.searchParams.set('since', window.since); url.searchParams.set('until', window.until);
    if (state.cursor) url.searchParams.set('cursor', state.cursor);
    const response = await fetchMirror(url, options, store, budget);
    const evidence = store.evidence(`nitter-${String(pages).padStart(5, '0')}.json`, response);
    const page = parseNitter(response.html, response.url);
    if (!page.cards && !page.empty) throw new Error('Mirror returned neither tweet cards nor an explicit empty result.');
    pages++; let added = 0; let truncated = false;
    for (const row of page.rows) {
      // A tested mirror includes the exclusive end day. Enforce the interval here.
      if (!accepts(row, { ...options, ...window }) || store.rows.has(row.id)) continue;
      if (store.added >= options.limit) { truncated = true; break; }
      if (store.add(row, evidence)) added++;
    }
    store.event({ provider: 'nitter', page: pages, ...window, received: page.rows.length, added });
    console.log(`[nitter] ${window.since} to ${window.until}, page ${pages}: ${added} new; ${store.rows.size} saved total`);
    if (truncated) { store.checkpoint('nitter', state); return { provider: 'nitter', stop: 'limit', pages, windows_completed: completed }; }
    const next = page.cursor;
    if (!next || page.empty) {
      store.event({ provider: 'nitter', status: 'window_finished', ...window });
      state.windowIndex++; state.cursor = null; completed++;
    } else {
      const key = `${state.windowIndex}:${next}`;
      if (seen.has(key) || next === state.cursor) {
        store.checkpoint('nitter', state);
        return { provider: 'nitter', stop: 'repeated_cursor', pages, windows_completed: completed };
      }
      seen.add(key); state.cursor = next;
    }
    state.complete = state.windowIndex >= windows.length;
    store.checkpoint('nitter', state);
    writeJson(path.join(store.dir, 'progress.json'), { provider: 'nitter', updated_at: new Date().toISOString(),
      total_tweets: store.rows.size, new_tweets: store.added, pages_this_run: pages,
      windows_completed: state.windowIndex, windows_total: windows.length,
      next_window: windows[state.windowIndex] ?? null, complete: state.complete });
    if (!state.complete && pages < options.maxPages && store.added < options.limit) await budget.wait(gait(options.gaitMinMs, options.gaitMaxMs));
  }
  return { provider: 'nitter', stop: state.complete ? 'requested_windows_finished' : store.added >= options.limit ? 'limit' : 'max_pages',
    pages, windows_completed: completed, windows_total: windows.length };
}
