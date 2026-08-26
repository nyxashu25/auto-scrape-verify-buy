// Shared helpers used by content.js and popup.js.
// ExpiredDomains.net does not expose real Moz DA/PA anywhere in its markup.
// AUTHORITY_SCORE is a proxy built from the metrics the site actually gives us:
// Majestic backlinks (bl), SEOkicks domain pop (dp), Majestic Million global
// rank (mmgr), Wikipedia backlinks (wikilinks), Archive.org crawl results
// (acr), and domain age (wby - whois creation year).

function parseNum(el) {
  if (!el) return 0;
  const raw = el.getAttribute('title') || el.textContent || '';
  const cleaned = raw.replace(/[^0-9.]/g, '');
  return cleaned ? parseFloat(cleaned) : 0;
}

function computeAuthorityScore(d, currentYear) {
  const wbyYear = parseInt(d.wby, 10) || 0;
  const ageScore = wbyYear >= 1990 && wbyYear <= currentYear ? (currentYear - wbyYear) * 5 : 0;
  // Rank 100 -> 1000pts, rank 1000 -> 100pts, rank 1,000,000 -> ~0.1pt, unranked (0) -> 0.
  const mmgrScore = d.mmgr > 0 ? Math.min(5000, 100000 / d.mmgr) : 0;

  return Math.round(
    d.bl * 1 +
    d.dp * 3 +
    d.acr * 2 +
    d.wikilinks * 200 +
    mmgrScore +
    ageScore
  );
}

function parseAbbreviatedNumber(text) {
  if (!text) return null;
  const t = text.trim();
  if (t === '' || t === '-' || /^n\/?a$/i.test(t)) return null;
  const cleaned = t.replace(/,/g, '');
  const m = cleaned.match(/^([\d.]+)\s*([KMB])?$/i);
  if (!m) {
    const n = parseFloat(cleaned.replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1;
  return Math.round(parseFloat(m[1]) * mult);
}

if (typeof module !== 'undefined') {
  module.exports = { parseNum, computeAuthorityScore, parseAbbreviatedNumber };
}
