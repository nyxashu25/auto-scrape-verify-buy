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
