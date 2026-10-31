import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { accepts, graphqlRows, searchWindows, tweetUrl } from './model.mjs';
import { gait } from './pace.mjs';

export function gateKind({ url = '', title = '', text = '', articles = 0, status = 200 }) {
  if (status === 429 || (!articles && /rate limit exceeded|you are rate limited|too many requests/i.test(text))) return 'rate_limit';
  if (/\/i\/flow\/(login|signup)|\/account\/access|\/login(?:[/?]|$)/.test(url)) return 'login';
  if (/just a moment|attention required.*cloudflare|checking your browser/i.test(title) || (!articles && /verify you are human|performing security verification|unusual traffic from your computer/i.test(text))) return 'challenge';
  if (!articles && /sign in to x|log in to x|sign in to twitter/i.test(text)) return 'login';
  if (!articles && /something went wrong|try reloading|this page is down/i.test(text)) return 'transient';
  if (!articles && /these posts are protected|account is suspended/i.test(text)) return 'unavailable';
  if (status === 403) return 'forbidden';
  return null;
}

export async function openBrowser(options) {
  if (options.cdpUrl) {
    const browser = await chromium.connectOverCDP(options.cdpUrl, { timeout: 20000 });
    const contexts = browser.contexts();
    const context = contexts.find(c => c.pages().some(p => /^https:\/\/(?:www\.)?x\.com\//.test(p.url()))) ?? contexts[0];
    if (!context) { await browser.close(); throw new Error('CDP browser has no context.'); }
    const page = await context.newPage();
    return { context, page, close: async () => { await page.close().catch(() => {}); await browser.close(); } };
  }
  const profile = path.resolve(options.userDataDir);
  fs.mkdirSync(profile, { recursive: true });
  const context = await chromium.launchPersistentContext(profile, {
    channel: options.channel === 'chromium' ? undefined : options.channel,
    headless: options.headless, viewport: { width: 1365, height: 1000 }, locale: 'en-US',
    timeout: 20000,
  });
  const page = context.pages()[0] ?? await context.newPage();
  return { context, page, close: () => context.close() };
}

async function dismissConsent(page) {
  for (const name of ['Refuse non-essential cookies', 'Reject all', 'Accept all cookies']) {
    const button = page.getByRole('button', { name, exact: true }).first();
    if (await button.isVisible().catch(() => false)) { await button.click({ timeout: 1000 }).catch(() => {}); break; }
  }
}

async function inspect(page, status = 200) {
  return {
    url: page.url(), title: await page.title(), status,
    articles: await page.locator('article[data-testid="tweet"]').count(),
    text: (await page.locator('body').innerText({ timeout: 5000 })).slice(0, 14000),
  };
}

async function navigate(page, target, store, budget) {
  try {
    return await page.goto(target, { waitUntil: 'domcontentloaded', timeout: Math.min(30000, budget.remaining()) });
  } catch (error) {
    const screenshot = path.join(store.runDir, `navigation-error-${Date.now()}.png`);
    await page.screenshot({ path: screenshot, timeout: 5000 }).catch(() => {});
    store.event({ provider: 'browser', status: 'navigation_failed', target,
      error: error.message, screenshot: path.relative(store.dir, screenshot) });
    throw error;
  }
}

export async function recoverGate(page, target, options, store, budget, status = 200) {
  await dismissConsent(page);
  let state = await inspect(page, status);
  let kind = gateKind(state);
  if (!kind) return;
  const screenshot = path.join(store.runDir, `gate-${Date.now()}.png`);
  await page.screenshot({ path: screenshot }).catch(() => {});
  store.event({ provider: 'browser', status: 'gate', kind, url: page.url(), screenshot: path.relative(store.dir, screenshot) });
  if (kind === 'unavailable') throw new Error('Account unavailable or protected.');
  if (kind === 'rate_limit' || kind === 'transient') {
    for (let retry = 0; retry < options.retries; retry++) {
      console.log(`[browser] ${kind}; backing off before retry ${retry + 1}`);
      await budget.wait(Math.min(60000, 15000 * 2 ** retry));
      const response = await navigate(page, target, store, budget);
      await budget.wait(2500);
      state = await inspect(page, response?.status()); kind = gateKind(state);
      if (!kind) return;
      if (!['rate_limit', 'transient'].includes(kind)) break;
    }
  }
  if (!['login', 'challenge', 'forbidden'].includes(kind) || options.headless || options.gateWaitMs === 0) {
    throw new Error(`Browser gate: ${kind}. Evidence saved. Use login or --cdp-url with an authenticated session.`);
  }
  console.log(`[browser] ${kind}: complete the check/login in the browser; waiting up to ${options.gateWaitMs} ms.`);
  const deadline = Math.min(Date.now() + options.gateWaitMs, budget.deadline);
  while (Date.now() < deadline) {
    await budget.wait(1500);
    state = await inspect(page);
    kind = gateKind(state);
    if (!kind) {
      if (page.url() !== target) {
        await navigate(page, target, store, budget);
        await budget.wait(2500);
        if (gateKind(await inspect(page))) continue;
      }
      store.event({ provider: 'browser', status: 'gate_cleared', url: page.url() });
      return;
    }
  }
  throw new Error(`Browser ${kind ?? 'access'} gate was not cleared within the configured wait.`);
}

// This function runs inside the page; keep it free of module closures.
export function extractDomTweets() {
  const rows = [];
  for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
    // The first timestamp belongs to the outer post, later timestamps may be quotes.
    const time = article.querySelector('time[datetime]');
    const anchor = time?.closest('a[href]');
    if (!anchor) continue;
    const match = new URL(anchor.href).pathname.match(/^\/([a-z0-9_]{1,15})\/status\/(\d+)/i);
    if (!match) continue;
    const textNode = article.querySelector('[data-testid="tweetText"]');
    const text = textNode?.innerText ?? '';
    const imageUrls = [...article.querySelectorAll('[data-testid="tweetPhoto"] img')].map(img => img.src);
    if (!text && !imageUrls.length) continue;
    const social = article.querySelector('[data-testid="socialContext"]')?.innerText ?? '';
    // A quote card can be the only tweetText in an otherwise empty outer post.
    const quotedOnly = textNode?.closest('[role="link"]');
    if (quotedOnly && quotedOnly !== article) continue;
    const isReply = /Replying to/.test(article.innerText);
    rows.push({ id: match[2], author: match[1].toLowerCase(), author_id: null,
      url: `https://x.com/${match[1].toLowerCase()}/status/${match[2]}`, text,
      created_at: time.getAttribute('datetime'), lang: textNode?.getAttribute('lang') ?? null,
      conversation_id: null, reply_to: isReply ? 'visible_reply_context' : null,
      quote_id: null, reposted_by: /reposted|retweeted/i.test(social) ? social : null,
      metrics: {}, media: imageUrls.length ? { photos: imageUrls } : null,
      source: 'x_browser_dom', text_status: 'visible_text_may_be_truncated' });
  }
  return rows;
}

export async function collectBrowser(options, store, budget) {
  const session = await openBrowser(options);
  const { page } = session;
  const pending = new Set();
  let batch = 0; let active = true;
  const responseListener = response => {
    if (!active || !/https:\/\/(?:x\.com|api\.x\.com)\/(?:i\/api\/)?graphql\//.test(response.url())) return;
    if (response.status() === 429) store.event({ provider: 'browser', status: 'network_rate_limit', url: response.url().split('?')[0] });
    if (!response.ok()) return;
    const task = (async () => {
      const payload = await response.json();
      const rows = graphqlRows(payload).filter(row => accepts(row, options));
      if (!rows.length) return;
      const evidence = store.evidence(`browser-response-${batch++}.json`, { url: response.url().split('?')[0], rows });
      for (const row of rows) if (store.added < options.limit) store.add(row, evidence);
    })().catch(error => store.event({ status: 'response_parse_error', error: error.message }));
    pending.add(task); task.finally(() => pending.delete(task));
  };
  page.on('response', responseListener);
  const drain = async () => { await Promise.allSettled([...pending]); };
  let scrolls = 0;
  const queries = options.mode === 'search' ? searchWindows(options) : [null];
  const scope = JSON.stringify({ handle: options.handle, queries, replies: options.includeReplies });
  const saved = options.fresh ? null : store.loadCheckpoint('browser');
  let queryIndex = saved?.scope === scope && !saved.complete ? saved.queryIndex : 0;
  try {
    for (; queryIndex < queries.length; queryIndex++) {
      const query = queries[queryIndex];
      const target = query ? `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=live`
        : `https://x.com/${options.handle}${options.includeReplies ? '/with_replies' : ''}`;
      store.checkpoint('browser', { scope, queryIndex, complete: false });
      const response = await navigate(page, target, store, budget);
      await budget.wait(3000);
      await recoverGate(page, target, options, store, budget, response?.status());
      let stagnant = 0;
      while (scrolls < options.maxPages && store.added < options.limit) {
        budget.check(); await drain();
        await recoverGate(page, target, options, store, budget);
        const before = store.rows.size;
        const rows = await page.evaluate(extractDomTweets);
        const evidence = store.evidence(`dom-${scrolls}.json`, { url: page.url(), rows });
        for (const row of rows) if (accepts(row, options) && store.added < options.limit) store.add(row, evidence);
        const after = store.rows.size;
        const signature = rows.map(row => row.id).join(',');
        const prior = await page.evaluate(() => document.documentElement.scrollHeight);
        await page.mouse.wheel(0, 500 + Math.round(Math.random() * 500));
        await budget.wait(gait(options.gaitMinMs, options.gaitMaxMs));
        await drain();
        const nextSignature = (await page.evaluate(extractDomTweets)).map(row => row.id).join(',');
        const height = await page.evaluate(() => document.documentElement.scrollHeight);
        stagnant = after === before && signature === nextSignature && height === prior ? stagnant + 1 : 0;
        scrolls++;
        console.log(`[browser] scroll ${scrolls}: ${store.added} new posts`);
        if (stagnant >= 5) { store.event({ status: 'stagnant_window', query, scrolls }); break; }
      }
      if (scrolls >= options.maxPages || store.added >= options.limit) break;
      store.checkpoint('browser', { scope, queryIndex: queryIndex + 1, complete: queryIndex + 1 >= queries.length });
    }
    await drain();
    return { provider: 'browser', stop: store.added >= options.limit ? 'limit' : scrolls >= options.maxPages ? 'max_scrolls' : 'visible_windows_finished', scrolls };
  } finally {
    active = false; page.off('response', responseListener);
    await drain(); await session.close();
  }
}

export async function discover(options, store, budget) {
  const session = await openBrowser(options);
  const file = path.join(store.dir, 'candidates.jsonl');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const known = new Set(existing.map(row => row.id));
  let added = 0; let pages = 0;
  try {
    for (const window of searchWindows(options)) {
      const dates = window.match(/since:(\S+) until:(\S+)/);
      const q = `(site:x.com/${options.handle}/status/ OR site:twitter.com/${options.handle}/status/)${dates ? ` after:${dates[1]} before:${dates[2]}` : ''}`;
      for (let start = 0; pages < options.maxPages && added < options.limit; start += 10) {
        budget.check();
        const target = `https://www.google.com/search?q=${encodeURIComponent(q)}&start=${start}`;
        const response = await navigate(session.page, target, store, budget);
        await budget.wait(2500);
        await recoverGate(session.page, target, options, store, budget, response?.status());
        const links = await session.page.locator('a[href]').evaluateAll(anchors => anchors.map(a => ({ href: a.href, title: a.innerText })));
        let matched = 0;
        for (const link of links) {
          let href = link.href;
          try { const u = new URL(href); if (u.pathname === '/url') href = u.searchParams.get('q') ?? u.searchParams.get('url') ?? href; } catch {}
          const item = tweetUrl(href);
          if (!item || item.author !== options.handle) continue;
          matched++;
          if (known.has(item.id) || added >= options.limit) continue;
          known.add(item.id); added++;
          fs.appendFileSync(file, JSON.stringify({ ...item, discovered_from: target, discovered_at: new Date().toISOString(), status: 'candidate', title: link.title }) + '\n');
        }
        pages++;
        store.event({ provider: 'google', query: q, page: pages, matched, new_candidates: added });
        if (!matched) break;
        await budget.wait(gait(options.gaitMinMs, options.gaitMaxMs));
      }
      if (pages >= options.maxPages || added >= options.limit) break;
    }
    return { provider: 'google', pages, new_candidates: added, stop: 'discovery_finished' };
  } finally { await session.close(); }
}

export async function login(options, store, budget) {
  const session = await openBrowser({ ...options, headless: false });
  try {
    const target = 'https://x.com/home';
    await navigate(session.page, target, store, budget);
    console.log('Log into X in the opened browser. Waiting for the authenticated account menu.');
    await session.page.locator('[data-testid="SideNav_AccountSwitcher_Button"]').waitFor({ timeout: Math.min(options.gateWaitMs || 300000, budget.remaining()) });
    console.log(`Session ready in ${options.cdpUrl ? 'attached browser' : path.resolve(options.userDataDir)}`);
    return { provider: 'browser', stop: 'session_ready' };
  } finally { await session.close(); }
}
