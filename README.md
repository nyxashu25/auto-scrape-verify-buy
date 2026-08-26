# ExpiredDomains → SEMrush Authority Sorter

Collects domains from ExpiredDomains.net, looks each one up on SEMrush's Domain
Overview, and sorts the combined list by **Authority Score**, high → low.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select this folder
4. After any code change, hit the reload icon on the extension card

## Use

### 1. Collect domains
Open any ExpiredDomains.net results page (keyword search or a per-TLD list).
A **Authority Collector** panel appears bottom-right.

- **Scan This Page** — stores the ~200 rows currently displayed
- **Scan All Pages** — walks `?start=0,200,400…` until two empty pages in a row,
  with a 2.5–4.5s randomized pause between requests. Click again to stop.

Domains are deduplicated by name. Re-scanning never erases SEMrush results.

### 2. Look up Authority Score
Click the extension icon → **Lookup on SEMrush**. This opens a runner tab.

Press **Start**. It opens one worker tab and drives it through each domain's
Domain Overview page, scraping Authority Score, Backlinks, Ref. Domains,
Organic/Paid Traffic and Keywords.

- Default 6s + jitter between lookups. Raise it if SEMrush starts throttling.
- **Re-check domains already looked up** is off by default, so stopping and
  restarting resumes instead of redoing work.
- Keep the worker tab visible — if SEMrush shows a login wall or captcha you
  need to see it. The runner detects a logged-out state and stops on its own.

### 3. Check availability and cart on Dynadot
Log in to Dynadot yourself and open
[Bulk Search](https://www.dynadot.com/domain/bulk-search). A **Dynadot
Auto-Cart** panel appears bottom-right. The extension never opens or navigates
this tab for you.

- **Min SEMrush AS** — default `7`. Only domains whose scraped Authority Score
  is at or above this go in the queue. Domains never looked up on SEMrush are
  never queued.
- **Batch size** — default 100. Dynadot's exact search caps at 1000 per query.
- **Add available to cart** — on by default. Turn it off to check availability
  without touching the cart.

Press **Run availability check**. Per batch it fills the search box, searches,
records every result, then ticks only the available domains from that batch and
clicks **Add to cart**. The subtotal is logged in the panel before the click.

The panel forces Dynadot's **Exact Search** mode. The default "Filter by TLD"
mode multiplies every name against the 10 selected TLDs — 50 domains would
become 500 results and cart names you never asked for.

Nothing is ever purchased. The run stops at the cart; checkout stays manual.

### 4. Read / export
Click the extension icon. Table is sorted by **SEMrush AS** by default; click any
column header to re-sort. Domains not yet looked up always sort to the bottom
rather than counting as zero.

**Export CSV** writes every stored field, ordered by SEMrush AS then local score.

## About the two score columns

| Column | Source |
|---|---|
| **SEMrush AS** | Real Authority Score scraped from SEMrush (0–100). Blank = not looked up; `n/a` = SEMrush has no data for that domain. |
| **Local Score** | Heuristic computed offline in `utils.js` from ExpiredDomains' own columns (backlinks, domain pop, Archive.org crawls, Wikipedia links, Majestic Million rank, domain age). A fallback ranking only. |

Neither is Moz DA/PA — SEMrush does not expose Moz metrics, and ExpiredDomains
doesn't either. Authority Score is SEMrush's own equivalent and is the closest
real authority metric available here. Freshly-dropped domains are usually
absent from SEMrush's index entirely and will show `n/a`.

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest |
| `utils.js` | Shared number parsing + local score formula |
| `content.js` / `content.css` | ExpiredDomains scraper + floating panel |
| `content-semrush.js` | SEMrush Domain Overview scraper |
| `content-dynadot.js` / `content-dynadot.css` | Dynadot bulk-search availability + cart panel |
| `runner.html/.css/.js` | Batch lookup driver |
| `popup.html/.css/.js` | Sorted table, CSV export |
| `background.js` | Badge count |
