# TweetScraping

Collect actual public X/Twitter post text with author checks, evidence, pagination,
resumption, and reusable corpus exports. No X API bearer token or OpenAI key is required.

Built from the browser research patterns in
[PuppetMaster](https://github.com/patrickdugan/PuppetMaster), upstream revision
`5e910ee5d206a359dac92943718604a0a3e722d3`.
PuppetMaster uses **Playwright**, despite the Puppeteer shorthand in the original request.
See [NOTICE](NOTICE) for attribution.

## Install and collect

Requires Node.js 22+ and npm or pnpm. Browser commands use installed Chrome by default;
the public API provider needs no browser.

```powershell
npm install
npm run collect -- --handle tarunchitra --include-replies
```

The default `auto` provider first uses the public
[FxTwitter v2 timeline](https://docs.fxembed.com/api/twitter/operations/2profilehandlestatuses/).
It falls back to browser capture if that fails or yields an empty dataset.
This third-party provider can fail, change, or return a limited historical window.
It is not the official X API. Every post carries its actual provider and extraction method.

```powershell
# Public provider only; run again with the same arguments to resume.
npm run collect -- --handle tarunchitra --provider fx --include-replies --limit 1000 --max-pages 100

# Refresh from the top while keeping/deduplicating already collected posts.
npm run collect -- --handle tarunchitra --provider fx --include-replies --fresh

# Historical search: inclusive start, exclusive end, paginated 30-day windows.
npm run collect -- --handle tarunchitra --provider fx --mode search --since 2020-01-01 --until 2021-01-01 --include-replies --max-pages 100
```

`--limit` counts **new unique authored posts per invocation**. A page dominated by
reposts may add few or no records. Other authors' reposts and embedded quote text
are never attributed to the requested author. Replies require `--include-replies`.
Date filters on timeline mode filter what the timeline returns; use search mode
to request older date ranges directly.

## Browser sessions, gait and access gates

PuppetMaster contributed persistent sessions/CDP, Gaussian pacing and scrolling,
bounded runs, and evidence capture. The browser provider reads rendered tweet
cards and tweet responses loaded by that browser. It does not require a private
GraphQL operation ID or extract bearer tokens from your browser.

```powershell
# First save an authenticated session in this repo's dedicated .sessions/x profile.
# Complete login in the window opened by this command.
npm run login

# Reuse that session for direct timeline collection.
npm run collect -- --handle tarunchitra --provider browser --include-replies

# Adjust gait: bounded Gaussian delays between 3 and 7 seconds by default.
npm run collect -- --handle tarunchitra --provider browser --gait-min-ms 5000 --gait-max-ms 15000
```

To attach an existing debugging-enabled Chrome instead:

```powershell
# Run this yourself to open an interactive Chrome using a dedicated profile.
& 'C:\Program Files\Google\Chrome\Application\chrome.exe' '--remote-debugging-address=127.0.0.1' '--remote-debugging-port=9222' "--user-data-dir=$PWD\.sessions\cdp" 'https://x.com/home'
# Log into X there, then in another terminal:
npm run collect -- --handle tarunchitra --provider browser --cdp-url http://127.0.0.1:9222
```

The collector selects the context containing X and opens its own capture tab.
CDP cleanup closes that tab and disconnects the automation connection. The
user's browser remains open. It never clones your daily browser's cookie database.

Login/Cloudflare/CAPTCHA challenges are detected and saved with screenshots.
In a headed session the collector waits up to `--gate-wait-ms 120000` for you to
complete the check, then continues. Headless mode fails immediately at an
interactive gate. Rate limits and transient failures use bounded backoff;
the public provider honors `Retry-After`.

**Gait is pacing, not a guaranteed Cloudflare/CAPTCHA bypass.** The alternative
public provider can retrieve tweets when direct browser navigation is blocked.
Persistent authenticated sessions can avoid repeated logins. Active challenges
still sometimes require human completion. The program reports these failures;
it never calls a blocked or empty scan a completed archive.

Use `--channel msedge` for Edge. For bundled Chromium:

```powershell
npx playwright install chromium
npm run collect -- --handle tarunchitra --provider browser --channel chromium
```

## Discover links, then retrieve text

Google discovery is a separate optional tool based on PuppetMaster's research
script. Its output is a **candidate list**, not tweet text. Google may present a
challenge; use headed mode and the same persistent session to complete it.

```powershell
npm run discover -- --handle tarunchitra --max-pages 5
npm run hydrate -- --handle tarunchitra --include-replies --urls-file runs/tarunchitra/candidates.jsonl
```

Hydration accepts plain text or JSONL containing X/Twitter status links and
retrieves each post using the public
[Get post endpoint](https://docs.fxembed.com/api/twitter/operations/2statusid/).
The author and tweet ID in the response must match the requested account/post.
Failures remain in the run events for a later retry.

## Data and resumption

Default output: `runs/<handle>/`. Sessions and run data are ignored by Git.

| File | Meaning |
| --- | --- |
| `tweets.jsonl` | Captured text, author, date, metrics/media, source, text status and SHA-256 |
| `checkpoint-fx.json` | Cursor and date-window position; written after durable post writes |
| `checkpoint-browser.json` | Search window; browser scrolling restarts and deduplicates on resume |
| `candidates.jsonl` | Discovered links, kept outside the captured tweet dataset |
| `evidence/<run-id>/` | Public API responses, DOM records, gate screenshots and events |
| `summary.json` | Latest run outcome, new vs total counts, bounds and errors |

Use the same `--out` directory to combine search and timeline results. A different
provider/query scope starts fresh pagination while preserving unique posts. Use
separate output directories for separate handles. A run lock prevents concurrent
writers. After a hard process kill, check that the recorded PID in `.lock` is no
longer running before removing that lock; normal exit/Ctrl+C cleans it up.

Each run has a maximum time budget (`--max-minutes 15`), page/scroll/attempt cap
(`--max-pages 40`), and new-post cap (`--limit 1000`). Interrupted runs preserve
completed records and the last cursor. Do not edit JSONL while collecting.
An incomplete final JSONL write from a crash is quarantined on resume; earlier
corruption is reported instead of silently discarded.

Exit codes: **0** for a successful data/session command, **2** for bounded,
partial or empty runs, **1** for failure. Reaching a configured limit is code 2
so a caller can distinguish a finite batch from exhausted available results.
Even exhausted results do not prove historical completeness.

DOM extraction is labeled `visible_text_may_be_truncated`; browser responses
preserve long note text when available. Media URLs are recorded, not downloaded.
Third-party text is marked `provider_text` and is not independently verified
against a primary X response.

## Export for Chitraverse and other projects

```powershell
npm run export -- --handle tarunchitra --format corpus --output runs/tarunchitra/corpus.jsonl
npm run export -- --handle tarunchitra --format csv --output runs/tarunchitra/tweets.csv
```

The generic corpus JSONL contains `id`, `title`, `url`, `kind`, `author`,
`published`, `text`, `source`, and `text_sha256`. It can be consumed by verse
projects without coupling this collector to their internal catalog schema.
CSV cells are escaped, including spreadsheet formula prefixes.

## Checks

```powershell
npm run check
npm test
```

Tests cover live-browser extraction against local fixtures, quoted/reposted
authorship, long post text, date windows, HTTP error handling, Retry-After,
mid-page resume without lost records, cursor loops, lock exclusion, and exports.
The browser test needs Chrome installed. Provider tests use only a local HTTP
server; the test suite does not query X, Google or FxTwitter.

Use `node src/cli.mjs --help` for all options. No secrets should be committed;
`.sessions/` contains sensitive local browser state and remains ignored.
