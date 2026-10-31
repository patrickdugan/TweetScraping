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

## Live account exercise: @duganist

The public provider reported account ID `3100174815` and **84,742 statuses**.
That account counter includes reposts and is distinct from the saved authored
post count. The initial batch collected 1,000 unique authored posts; continuation
through the same replies-timeline cursor brought the dataset to **2,954**, with
**2,221 replies**. A separate posts-only timeline pass exhausted 44 API pages
and added zero new records. Both routes ended on empty result pages.

The observed post dates range from May 6, 2026 at 00:44:49 UTC to October 31,
2026 at 08:14:28 UTC. This range describes observed records and does not imply
continuous or complete coverage between the dates. This is not the full
account history. Both undated and January 2025 search probes failed with
HTTP/provider 404; no authenticated browser session was available for search.

A direct post-hydration check returned a matching @duganist record. The final
dataset has 2,954 distinct IDs, a single matching author ID, valid post URLs,
matching SHA-256 text hashes, valid timestamps, and existing evidence files
for every record. The corpus and CSV exports both contain 2,954 posts. Data,
reports and response evidence remain local under `runs/duganist/` and are
ignored by Git.

During the exercise, the collector was restarted from its durable cursor to
reduce API pacing from 3–7 seconds to 1–2 seconds. The interrupted run has an
`interrupted.json` note; resumed records passed the same integrity checks.

Fixes made during this exercise:

- Report saved authored posts, observed date range and the provider's separate
  account status count, avoiding an implied full-account count.
- Report remaining URLs and a bounded stop when hydration hits its limit.
- Continue through already-known pages while cursors advance. The previous
  ten-page heuristic could prevent a backfill from reaching older new posts.

The subsequent public-search work below provides a credential-free historical
route. Archive import has not been implemented or exercised.

## Credential-free historical search

Public mirror probes found a working historical search at
`https://nitter.mie.foundation/duganist/search`. A January 2024 live page returned
20 parseable cards; after author checks and exclusive end-date filtering, **15
new authored posts** were added. A separate publicly indexed URL was hydrated
successfully for February 6, 2020. The date-partitioned backfill then retrieved
posts from **March 20, 2015** and continued forward through later 2015 windows.
The durable bulk scan remains a running job, not a completed full-account archive.

The mirror includes some posts on the requested exclusive end day, so local
filtering is mandatory. Sidebar links include recent posts even on historical
search pages; the parser reads only actual timeline cards. It excludes other
authors' retweeted text and quoted text from the target author's writing.
Numeric author IDs are unavailable on mirror rows; author handles and canonical
post URLs must agree. Precise timestamps are derived from tweet snowflake IDs,
with the displayed mirror date retained separately.

The live run exposed an end-page markup variant: a `timeline-item` utility row
containing only “Load newest.” It is now ignored so “No more items” can finish
the window. HTTP 429 responses were observed and recovered using longer
exponential backoff. The durable worker resumes bounded child runs and transient
failures, exports snapshots after batches, and stops rather than spinning on a
repeated cursor or unrecognized page.

Other probes: the main Nitter service and XCancel returned suspension notices;
several mirrors were unreachable, challenged, or had search disabled. A normal
Chrome probe with reduced automation signals passed one mirror's Anubis check,
but that mirror's search was disabled. No universal Cloudflare bypass is claimed.
Public archive indexes did not supply a viable bulk source during these probes.

## Checks

`node scripts/check.mjs` and `node --test`: **24 tests passed**. Tests include
real Chrome DOM extraction on local fixtures, mixed authors/quotes, long note
text, exclusive dates, pagination and mid-page resume, cursor loops,
HTTP-200 provider errors, Retry-After, mismatched hydration authors, lock
exclusion, crash-tail recovery, CSV/corpus exports, separate account-counter
reporting, correct stop/remaining counts for bounded hydration batches, and
backfills that cross more than ten known pages before reaching new records,
historical HTML extraction and strict dates, utility-row handling, safe mirror
pagination, lossless historical resume, durable child-batch resumption, export
snapshots, and safe termination on repeated cursors.

The local HTTP and Chrome checks required execution outside the desktop
sandbox; restricted loopback connections failed inside it. No test needs an
X account, API token or live third-party service.
