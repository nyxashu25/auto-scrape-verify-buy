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

### 3. Read / export
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
| `runner.html/.css/.js` | Batch lookup driver |
| `popup.html/.css/.js` | Sorted table, CSV export |
| `background.js` | Badge count |
