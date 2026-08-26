const STORAGE_KEY = 'authorityDomains';
let running = false;
let stopRequested = false;
let workerTabId = null;

const delayInput = document.getElementById('delay');
const recheckInput = document.getElementById('recheck');
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

async function run() {
  const { [STORAGE_KEY]: stored = [] } = await chrome.storage.local.get(STORAGE_KEY);
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
    }

    progressEl.textContent = `${done}/${queue.length}`;

    if (!stopRequested && done < queue.length) {
      await new Promise((r) => setTimeout(r, delayMs + Math.random() * 1000));
    }
  }

  const wasStopped = stopRequested;
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
