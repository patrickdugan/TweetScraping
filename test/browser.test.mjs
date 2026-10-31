import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { gateKind, extractDomTweets } from '../src/browser.mjs';

test('gates distinguish login, Cloudflare challenge, rate limit and ordinary timeline', () => {
  assert.equal(gateKind({ url: 'https://x.com/i/flow/login' }), 'login');
  assert.equal(gateKind({ title: 'Just a moment...' }), 'challenge');
  assert.equal(gateKind({ text: 'Our systems have detected unusual traffic from your computer network.' }), 'challenge');
  assert.equal(gateKind({ status: 429 }), 'rate_limit');
  assert.equal(gateKind({ text: 'Sign in to X', articles: 10 }), null);
  assert.equal(gateKind({ text: 'A post discussing verify you are human and too many requests', articles: 10 }), null);
});

test('real browser DOM capture attributes outer post, labels visible text and skips quoted-only text', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<article data-testid="tweet">
      <a href="https://x.com/tarunchitra/status/123"><time datetime="2026-10-01T00:00:00Z"></time></a>
      <div data-testid="tweetText" lang="en">Tarun's actual text</div>
      <div role="link"><div data-testid="tweetText">Quoted author text</div></div>
      </article><article data-testid="tweet">
      <a href="https://x.com/tarunchitra/status/456"><time datetime="2026-10-01T00:00:00Z"></time></a>
      <div role="link"><div data-testid="tweetText">Only a quote</div></div></article>`);
    const rows = await page.evaluate(extractDomTweets);
    assert.equal(rows.length, 1); assert.equal(rows[0].id, '123');
    assert.equal(rows[0].text, "Tarun's actual text"); assert.equal(rows[0].author, 'tarunchitra');
    assert.equal(rows[0].text_status, 'visible_text_may_be_truncated');
  } finally { await browser.close(); }
});
