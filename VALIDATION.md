# Validation — October 31, 2026

The implementation was checked locally on Windows with Node.js 24.22.1,
Playwright 1.62.1 and installed Google Chrome.

## Real collection

Command:

```powershell
node src/cli.mjs collect --handle tarunchitra --provider fx --include-replies --limit 1000 --max-pages 40 --max-minutes 8
```

Result: **410 unique authored posts**, including replies, across 38 public API
pages. The last page contained no results. The observed posts range from
**June 22, 2026 through October 30, 2026 (UTC)**. The longest captured text is
2,462 characters. Every stored record's author is `tarunchitra`; unique IDs and
record count both equal 410. Reposts whose author differs were excluded.

This is the provider's observed available window. It does not establish that
all of Tarun's tweets, or even every tweet within that window, were retrieved.
Provider text has not been independently checked against primary X responses.

A fresh one-page repeat received 20 entries and added **0 new records**;
the durable dataset remained 410 records. A separate single-post hydration
request returned the matching author's post successfully.

Both the CSV and generic verse corpus exports contain 410 posts. Local files
are under `runs/tarunchitra/`, ignored by Git. The original collection summary
is preserved as `runs/tarunchitra/first-run-summary.json`; latest `summary.json`
describes the repeat run. Public response evidence is kept per run.

## Boundaries observed during live probes

| Route | Observed result |
| --- | --- |
| FxTwitter v2 timeline | Retrieved and paginated actual post text |
| FxTwitter v2 single-post hydration | Retrieved actual post text |
| FxTwitter search, January 2020 | HTTP/provider 404; zero posts collected |
| Fresh headless browser on X profile | Navigation failed with `ERR_HTTP_RESPONSE_CODE_FAILURE` |
| Headless Google discovery | Google unusual-traffic challenge; zero candidates collected |
| Browser extraction on local fixture | Passed in real Chrome |
| Authenticated CDP/manual challenge recovery | Implemented; not exercised against a logged-in X session here |

No Cloudflare/CAPTCHA bypass is claimed. The public provider supplied data
while direct browser routes were blocked. Gait, session reuse, backoff and
manual challenge recovery are separate features with different purposes.

## Checks

`node scripts/check.mjs` and `node --test`: **17 tests passed**. Tests include
real Chrome DOM extraction on local fixtures, mixed authors/quotes, long note
text, exclusive dates, pagination and mid-page resume, cursor loops,
HTTP-200 provider errors, Retry-After, mismatched hydration authors, lock
exclusion, crash-tail recovery, CSV/corpus exports, separate account-counter
reporting, correct stop/remaining counts for bounded hydration batches, and
backfills that cross more than ten known pages before reaching new records.

The local HTTP and Chrome checks required execution outside the desktop
sandbox; restricted loopback connections failed inside it. No test needs an
X account, API token or live third-party service.
