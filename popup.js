const STORAGE_KEY = 'authorityDomains';
let data = [];
let sortKey = 'semrushAS';
let sortDir = -1; // -1 = high to low

async function load() {
  const { [STORAGE_KEY]: stored = [] } = await chrome.storage.local.get(STORAGE_KEY);
  data = stored;
  render();
}

function render() {
  const sorted = [...data].sort((a, b) => {
    const av = a[sortKey];
    const bv = b[sortKey];
    // Missing values always sink to the bottom, regardless of sort direction,
    // so "never looked up" never outranks a real low score.
    const aMissing = av === undefined || av === null || av === '';
    const bMissing = bv === undefined || bv === null || bv === '';
    if (aMissing && bMissing) return 0;
    if (aMissing) return 1;
    if (bMissing) return -1;
    if (typeof av === 'string' || typeof bv === 'string') {
      return sortDir * String(av).localeCompare(String(bv));
    }
    return sortDir * (av - bv);
  });

  const checked = data.filter((d) => d.semrushCheckedAt != null).length;
  document.getElementById('meta').textContent =
    `${data.length} domains stored · ${checked} checked on SEMrush — sorted by ${sortKey} ${
      sortDir === -1 ? '(high → low)' : '(low → high)'
    }`;

  const tbody = document.getElementById('results-body');
  tbody.innerHTML = sorted
    .map(
      (d) => `
    <tr>
      <td><a href="https://member.expireddomains.net/domain/${encodeURIComponent(d.domain)}/" target="_blank" rel="noopener">${d.domain}</a></td>
      <td>${d.score}</td>
      <td>${d.semrushAS ?? '-'}</td>
      <td>${d.semrushBacklinks ?? '-'}</td>
      <td>${d.bl}</td>
      <td>${d.dp}</td>
      <td>${d.mmgr}</td>
      <td>${d.wikilinks}</td>
      <td>${d.wby || '-'}</td>
      <td>${d.status || '-'}</td>
    </tr>`
    )
    .join('');
}

document.querySelectorAll('#results thead th').forEach((th) => {
  th.addEventListener('click', () => {
    const key = th.dataset.key;
    if (sortKey === key) {
      sortDir *= -1;
    } else {
      sortKey = key;
      sortDir = -1;
    }
    render();
  });
});

document.getElementById('open-runner').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('runner.html') });
});

document.getElementById('export-csv').addEventListener('click', () => {
  const header = [
    'domain',
    'score',
    'semrushAS',
    'semrushBacklinks',
    'semrushOrganicTraffic',
    'semrushRefDomains',
    'bl',
    'dp',
    'mmgr',
    'wikilinks',
    'acr',
    'wby',
    'aby',
    'status',
    'sourceList',
    'addDate',
  ];
  const rows = [...data].sort((a, b) => (b.semrushAS ?? -1) - (a.semrushAS ?? -1) || b.score - a.score);
  const csv = [header.join(',')]
    .concat(rows.map((d) => header.map((k) => `"${String(d[k] ?? '').replace(/"/g, '""')}"`).join(',')))
    .join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `authority-domains-${rows.length}.csv`;
  a.click();
});

document.getElementById('clear-all').addEventListener('click', async () => {
  if (!confirm('Clear all stored domains?')) return;
  await chrome.storage.local.remove(STORAGE_KEY);
  data = [];
  render();
});

// Keep the table live while the SEMrush runner writes results in another tab.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEY]) {
    data = changes[STORAGE_KEY].newValue || [];
    render();
  }
});

load();
