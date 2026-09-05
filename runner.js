const STORAGE_KEY = 'authorityDomains';
const SETTINGS_KEY = 'dynadotSettings';
const AUTO_KEY = 'dynadotAuto';
const DYNADOT_BULK_URL = 'https://www.dynadot.com/domain/bulk-search';

let running = false;
let stopRequested = false;
let workerTabId = null;
let dynadotWindowId = null;

const delayInput = document.getElementById('delay');
const recheckInput = document.getElementById('recheck');
const autoDynadotInput = document.getElementById('auto-dynadot');
const startBtn = document.getElementById('start');
const stopBtn = document.getElementById('stop');
const statusEl = document.getElementById('status');
const progressEl = document.getElementById('progress');
const logBody = document.getElementById('log-body');

function logRow(domain, as, status) {
  const tr = document.createElement('tr');
  tr.innerHTML = `<td></td><td></td><td></td>`;
  tr.children[0].textContent = domain;
  tr.children[1].textContent = as ?? '-';
  tr.children[2].textContent = status;
  logBody.prepend(tr);
}

function waitForResult(domain, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      chrome.runtime.onMessage.removeListener(listener);
      resolve(null);
    }, timeoutMs);

    function listener(message) {
      if (message?.type !== 'semrush-result' || message.domain !== domain) return;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.runtime.onMessage.removeListener(listener);
      resolve(message.data);
    }
    chrome.runtime.onMessage.addListener(listener);
  });
}

async function ensureWorkerTab() {
  if (workerTabId) {
    try {
      await chrome.tabs.get(workerTabId);
      return workerTabId;
    } catch {
      workerTabId = null;
    }
  }
  const tab = await chrome.tabs.create({
    url: 'https://www.semrush.com/analytics/overview/',
    active: true,
  });
  workerTabId = tab.id;
  chrome.tabs.onRemoved.addListener(function handler(tabId) {
    if (tabId === workerTabId) {
      workerTabId = null;
      stopRequested = true;
      chrome.tabs.onRemoved.removeListener(handler);
    }
  });
  return workerTabId;
}

// ---------- CSV import ----------

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9-]+)+$/i;
const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

// Columns the exporter writes, so an exported CSV round-trips back in.
const NUMERIC_FIELDS = [
  'score', 'semrushAS', 'semrushBacklinks', 'semrushRefDomains', 'semrushOrganicTraffic',
  'semrushPaidTraffic', 'semrushOrganicKeywords', 'semrushPaidKeywords',
  'bl', 'dp', 'mmgr', 'wikilinks', 'acr',
];
const TEXT_FIELDS = ['status', 'sourceList', 'addDate', 'wby', 'aby', 'dynadotStatus'];

// Handles quoted fields and embedded commas/newlines, matching what our own
// Export CSV writes.
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const delim = text.indexOf('\t') !== -1 && text.indexOf(',') === -1 ? '\t' : ',';

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') { field += '"'; i++; }
      else quoted = false;
    } else if (c === '"') {
      quoted = true;
    } else if (c === delim) {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

// Accepts bare domains and full URLs; everything that is not a registrable
// name comes back null so it can be counted as skipped rather than stored.
function normalizeDomain(raw) {
  let s = String(raw ?? '').trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  s = s.split(/[/?#]/)[0];
  s = s.split('@').pop();
  s = s.split(':')[0];
  s = s.replace(/^www\./, '').replace(/\.+$/, '');
  return DOMAIN_RE.test(s) ? s : null;
}

function toNumber(v) {
  if (v == null || String(v).trim() === '') return undefined;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

function buildRecords(rows) {
  const first = rows[0].map((h) => h.trim());
  const lower = first.map((h) => h.toLowerCase());
  // A header row is one whose cells are labels rather than domains.
  const hasHeader = lower.some((h) => h === 'domain') || first.every((c) => normalizeDomain(c) === null);

  let domainIdx = 0;
  let colMap = {};
  if (hasHeader) {
    domainIdx = lower.indexOf('domain');
    if (domainIdx === -1) domainIdx = lower.findIndex((h) => h.includes('domain'));
    if (domainIdx === -1) domainIdx = 0;
    lower.forEach((h, i) => {
      const key = [...NUMERIC_FIELDS, ...TEXT_FIELDS].find((f) => f.toLowerCase() === h);
      if (key && i !== domainIdx) colMap[i] = key;
    });
  } else {
    domainIdx = first.findIndex((c) => normalizeDomain(c) !== null);
    if (domainIdx === -1) domainIdx = 0;
  }

  const body = hasHeader ? rows.slice(1) : rows;
  const seen = new Set();
  const records = [];
  let skipped = 0;
  let duplicates = 0;

  for (const row of body) {
    const domain = normalizeDomain(row[domainIdx]);
    if (!domain) { skipped++; continue; }
    if (seen.has(domain)) { duplicates++; continue; }
    seen.add(domain);

    const rec = { domain };
    for (const [idx, key] of Object.entries(colMap)) {
      const raw = row[idx];
      if (raw == null || String(raw).trim() === '') continue;
      if (NUMERIC_FIELDS.includes(key)) {
        const n = toNumber(raw);
        if (n !== undefined) rec[key] = n;
      } else {
        rec[key] = String(raw).trim();
      }
    }
    records.push(rec);
  }
  return { records, skipped, duplicates, hasHeader, scored: records.filter((r) => typeof r.semrushAS === 'number').length };
}

async function importRecords(records) {
  const { [STORAGE_KEY]: existing = [] } = await chrome.storage.local.get(STORAGE_KEY);
  const byDomain = new Map(existing.map((d) => [d.domain.toLowerCase(), d]));
  const now = Date.now();
  let added = 0;
  let merged = 0;

  for (const rec of records) {
    const prev = byDomain.get(rec.domain);
    if (prev) merged++;
    else added++;
    // prev first: an import must never wipe SEMrush or Dynadot results.
    const next = { score: 0, ...prev, ...rec, firstSeen: prev?.firstSeen || now, lastSeen: now };
    // An imported Authority Score counts as already looked up, so the runner
    // does not spend a SEMrush request re-fetching it.
    if (typeof rec.semrushAS === 'number' && next.semrushCheckedAt == null) {
      next.semrushCheckedAt = now;
      next.semrushStatus = 'imported';
    }
    byDomain.set(rec.domain, next);
  }

  await chrome.storage.local.set({ [STORAGE_KEY]: [...byDomain.values()] });
  return { added, merged, total: byDomain.size };
}

function setImportStatus(msg, kind) {
  const el = document.getElementById('import-status');
  el.textContent = msg;
  el.className = `import-status${kind ? ` is-${kind}` : ''}`;
}

async function handleFile(file) {
  if (!file) return;
  if (file.size > MAX_IMPORT_BYTES) {
    setImportStatus(`${file.name} is too large (max 10 MB).`, 'err');
    return;
  }
  setImportStatus(`Reading ${file.name}…`);
  let text;
  try {
    text = await file.text();
  } catch (err) {
    setImportStatus(`Could not read file: ${err.message}`, 'err');
    return;
  }

  const rows = parseCSV(text);
  if (!rows.length) {
    setImportStatus('That file has no rows.', 'err');
    return;
  }

  const { records, skipped, duplicates, scored } = buildRecords(rows);
  if (!records.length) {
    setImportStatus('No valid domains found — check the file has a domain column.', 'err');
    return;
  }

  const { added, merged, total } = await importRecords(records);
  const bits = [`${added} new`];
  if (merged) bits.push(`${merged} already stored`);
  if (scored) bits.push(`${scored} with an Authority Score (SEMrush will skip these)`);
  if (duplicates) bits.push(`${duplicates} duplicate row${duplicates === 1 ? '' : 's'}`);
  if (skipped) bits.push(`${skipped} not a domain`);
  setImportStatus(`Imported ${records.length} from ${file.name} — ${bits.join(', ')}. ${total} stored in total.`, 'ok');
}

const importZone = document.getElementById('import-zone');
const importFile = document.getElementById('import-file');

document.getElementById('import-pick').addEventListener('click', () => importFile.click());
importFile.addEventListener('change', (e) => {
  handleFile(e.target.files[0]);
  e.target.value = '';
});

['dragenter', 'dragover'].forEach((evt) =>
  importZone.addEventListener(evt, (e) => {
    e.preventDefault();
    importZone.classList.add('is-over');
  })
);
['dragleave', 'drop'].forEach((evt) =>
  importZone.addEventListener(evt, (e) => {
    e.preventDefault();
    if (evt === 'dragleave' && importZone.contains(e.relatedTarget)) return;
    importZone.classList.remove('is-over');
  })
);
importZone.addEventListener('drop', (e) => handleFile(e.dataTransfer?.files?.[0]));

async function setAutoFlag(patch) {
  const { [AUTO_KEY]: cur = {} } = await chrome.storage.local.get(AUTO_KEY);
  await chrome.storage.local.set({ [AUTO_KEY]: { ...cur, ...patch } });
}

// Opened once per run, and only after a domain actually qualifies — no window
// appears if nothing clears the threshold. Its own window rather than a tab
// here, so it does not disturb the SEMrush worker tab.
async function openDynadotWindow() {
  if (dynadotWindowId !== null) return;
  try {
    const win = await chrome.windows.create({ url: DYNADOT_BULK_URL, focused: true });
    dynadotWindowId = win.id;
    logRow('—', null, 'opened Dynadot for auto-carting');
    chrome.windows.onRemoved.addListener(function handler(id) {
      if (id !== dynadotWindowId) return;
      dynadotWindowId = null;
      chrome.windows.onRemoved.removeListener(handler);
    });
  } catch (err) {
    logRow('—', null, `could not open Dynadot: ${err.message}`);
  }
}

async function run() {
  const { [STORAGE_KEY]: stored = [] } = await chrome.storage.local.get(STORAGE_KEY);
  const { [SETTINGS_KEY]: dynadotSettings = {} } = await chrome.storage.local.get(SETTINGS_KEY);
  const autoDynadot = autoDynadotInput.checked;
  const minAS = typeof dynadotSettings.minAS === 'number' ? dynadotSettings.minAS : 7;
  const recheck = recheckInput.checked;
  const queue = stored.filter((d) => recheck || d.semrushCheckedAt == null);

  if (!queue.length) {
    statusEl.textContent = 'Nothing to look up.';
    running = false;
    startBtn.disabled = false;
    stopBtn.disabled = true;
    return;
  }

  const delayMs = Math.max(3, Number(delayInput.value) || 6) * 1000;

  // Set before the first lookup so a Dynadot tab you already have open picks
  // up auto mode immediately rather than waiting for the window we may open.
  await setAutoFlag({ enabled: autoDynadot, semrushRunning: true, startedAt: Date.now() });

  await ensureWorkerTab();

  let done = 0;
  for (const item of queue) {
    if (stopRequested) break;
    progressEl.textContent = `${done}/${queue.length}`;
    statusEl.textContent = `Looking up ${item.domain}...`;

    const url = `https://www.semrush.com/analytics/overview/?q=${encodeURIComponent(item.domain)}&protocol=https&searchType=domain`;

    // Register the listener BEFORE navigating, otherwise a fast page can fire
    // its result before we are listening for it.
    const pending = waitForResult(item.domain, 25000);
    try {
      await chrome.tabs.update(workerTabId, { url });
    } catch (err) {
      statusEl.textContent = `Worker tab lost: ${err.message}`;
      break;
    }

    const result = await pending;
    done++;
    if (!result) {
      logRow(item.domain, null, 'no response');
    } else if (result.semrushStatus === 'logged-out') {
      logRow(item.domain, null, 'not logged in');
      statusEl.textContent = 'Stopped: SEMrush is not logged in. Log in, then start again.';
      stopRequested = true;
    } else if (result.semrushStatus === 'timeout') {
      logRow(item.domain, null, 'timeout');
    } else if (result.semrushStatus === 'no-data') {
      logRow(item.domain, 'n/a', 'no data');
    } else {
      logRow(item.domain, result.semrushAS, 'done');
      // First domain to clear the bar opens Dynadot; the panel there starts
      // itself and keeps draining while this loop carries on.
      if (autoDynadot && typeof result.semrushAS === 'number' && result.semrushAS >= minAS) {
        await openDynadotWindow();
      }
    }

    progressEl.textContent = `${done}/${queue.length}`;

    if (!stopRequested && done < queue.length) {
      await new Promise((r) => setTimeout(r, delayMs + Math.random() * 1000));
    }
  }

  const wasStopped = stopRequested;
  // Tells the Dynadot panel no more domains are coming, so it can flush what
  // is left and stop instead of polling forever.
  await setAutoFlag({ semrushRunning: false });
  running = false;
  stopRequested = false;
  startBtn.disabled = false;
  stopBtn.disabled = true;
  statusEl.textContent = wasStopped ? 'Stopped.' : `Finished — ${done}/${queue.length} processed.`;
}

startBtn.addEventListener('click', () => {
  if (running) return;
  running = true;
  stopRequested = false;
  startBtn.disabled = true;
  stopBtn.disabled = false;
  logBody.innerHTML = '';
  run();
});

stopBtn.addEventListener('click', () => {
  stopRequested = true;
  statusEl.textContent = 'Stopping after current lookup...';
});

// A runner tab closed mid-run leaves semrushRunning set, which would keep a
// Dynadot panel polling for domains that are never coming.
setAutoFlag({ semrushRunning: false });
