(function () {
  if (!document.querySelector('table.base1')) return;

  const STORAGE_KEY = 'authorityDomains';
  const CURRENT_YEAR = new Date().getFullYear();

  function parseRows(doc) {
    doc = doc || document;
    const rows = [...doc.querySelectorAll('table.base1 tbody tr')];
    return rows
      .map((tr) => {
        const domainEl = tr.querySelector('td.field_domain a[title]');
        if (!domainEl) return null;
        const d = {
          domain: domainEl.getAttribute('title'),
          status: (tr.querySelector('td.field_whois2')?.textContent || '').trim(),
          bl: parseNum(tr.querySelector('td.field_bl a')),
          dp: parseNum(tr.querySelector('td.field_domainpop a')),
          mmgr: parseNum(tr.querySelector('td.field_majestic_globalrank a')),
          wikilinks: parseNum(tr.querySelector('td.field_wikipedia_links')),
          acr: parseNum(tr.querySelector('td.field_aentries')),
          wby: (tr.querySelector('td.field_creationdate')?.textContent || '').trim(),
          aby: (tr.querySelector('td.field_abirth')?.textContent || '').trim(),
          sourceList: (tr.querySelector('td.field_domainlist')?.textContent || '').trim(),
          addDate: (tr.querySelector('td.field_adddate')?.textContent || '').trim(),
        };
        d.score = computeAuthorityScore(d, CURRENT_YEAR);
        return d;
      })
      .filter(Boolean);
  }

  async function mergeAndStore(newRows) {
    const { [STORAGE_KEY]: existing = [] } = await chrome.storage.local.get(STORAGE_KEY);
    const byDomain = new Map(existing.map((d) => [d.domain, d]));
    const now = Date.now();
    newRows.forEach((d) => {
      const prev = byDomain.get(d.domain);
      // prev first: re-scanning ExpiredDomains must never wipe SEMrush results.
      byDomain.set(d.domain, { ...prev, ...d, firstSeen: prev?.firstSeen || now, lastSeen: now });
    });
    const merged = [...byDomain.values()].sort((a, b) => b.score - a.score);
    await chrome.storage.local.set({ [STORAGE_KEY]: merged });
    return merged.length;
  }

  const panel = document.createElement('div');
  panel.id = 'auth-collector-panel';
  panel.innerHTML = `
    <div class="acp-header">Authority Collector</div>
    <div class="acp-count">Stored: <span id="acp-count">…</span></div>
    <button id="acp-scan-page">Scan This Page</button>
    <button id="acp-scan-all">Scan All Pages</button>
    <div class="acp-status" id="acp-status">Click extension icon to view sorted results.</div>
  `;
  document.body.appendChild(panel);

  const countEl = panel.querySelector('#acp-count');
  const statusEl = panel.querySelector('#acp-status');

  async function refreshCount() {
    const { [STORAGE_KEY]: existing = [] } = await chrome.storage.local.get(STORAGE_KEY);
    countEl.textContent = existing.length;
  }
  refreshCount();

  panel.querySelector('#acp-scan-page').addEventListener('click', async () => {
    const rows = parseRows();
    const total = await mergeAndStore(rows);
    statusEl.textContent = `Scanned page: +${rows.length} rows, ${total} total stored.`;
    refreshCount();
  });

  let stopFlag = false;
  panel.querySelector('#acp-scan-all').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (btn.dataset.running === '1') {
      stopFlag = true;
      return;
    }
    stopFlag = false;
    btn.dataset.running = '1';
    btn.textContent = 'Stop Scanning';

    const url = new URL(location.href);
    const qParam = url.searchParams.get('q') || '';
    let start = parseInt(url.searchParams.get('start'), 10) || 0;
    let consecutiveEmpty = 0;

    while (!stopFlag) {
      const pageUrl = `${url.pathname}?start=${start}&flimit=200${qParam ? `&q=${encodeURIComponent(qParam)}` : ''}`;
      let doc;
      try {
        const res = await fetch(pageUrl, { credentials: 'same-origin' });
        const html = await res.text();
        doc = new DOMParser().parseFromString(html, 'text/html');
      } catch (err) {
        statusEl.textContent = `Error fetching start=${start}: ${err.message}`;
        break;
      }

      const trs = doc.querySelectorAll('table.base1 tbody tr');
      if (!trs.length) {
        consecutiveEmpty++;
        if (consecutiveEmpty >= 2) break;
      } else {
        consecutiveEmpty = 0;
      }

      const rows = parseRows(doc);
      const total = await mergeAndStore(rows);
      refreshCount();
      statusEl.textContent = `start=${start}: +${rows.length} rows, ${total} total stored.`;

      start += 200;
      await new Promise((r) => setTimeout(r, 2500 + Math.random() * 2000));
    }

    btn.dataset.running = '0';
    btn.textContent = 'Scan All Pages';
    statusEl.textContent += stopFlag ? ' — stopped.' : ' — done.';
  });
})();
