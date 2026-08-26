// Stage 4: drive Dynadot's bulk search for every domain that cleared the
// SEMrush Authority Score threshold, then add the available ones to the cart.
//
// This script never opens or navigates anything on its own. It mounts a panel
// on Dynadot's bulk-search page and waits for an explicit click, so you stay
// logged in and in control of the tab.
(function () {
  const STORAGE_KEY = 'authorityDomains';
  const SETTINGS_KEY = 'dynadotSettings';
  const BULK_PATH = '/domain/bulk-search';
  const BULK_URL = 'https://www.dynadot.com/domain/bulk-search';
  // Bumped on every change to this file so you can tell at a glance whether
  // Chrome actually picked up a reload.
  const PANEL_VERSION = 'v1.1';

  const DEFAULTS = {
    minAS: 7,
    batchSize: 100,
    recheck: false,
    addToCart: true,
  };

  // Dynadot caps a single exact search at 1000 names.
  const MAX_BATCH = 1000;
  const RESULTS_TIMEOUT_MS = 60000;
  const CART_TIMEOUT_MS = 20000;
  const BATCH_PAUSE_MS = 3000;

  const SEL = {
    tab: '.bulk-search-tab-item',
    textarea: 'textarea.dyna-textarea__inner',
    row: '.res-item',
    label: '.res-input-label',
    priceWrap: '.price-wrap',
    renewalWrap: '.renewal-price-wrap',
    takenIcon: 'i.fa-window-minimize',
    cartRow: '.add-to-cart-row',
    cartBtn: 'button.add_to_cart, button[name="t_ad_add"]',
    subtotal: '.add-to-cart-row-right',
  };

  const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9-]+)+$/i;

  // ---------- storage ----------

  // All writes funnel through one promise chain. The popup and the SEMrush
  // scraper touch the same array, so overlapping read-modify-write would drop
  // results.
  let writeChain = Promise.resolve();

  function serialize(fn) {
    const next = writeChain.then(fn, fn);
    writeChain = next.catch(() => {});
    return next;
  }

  function mergeResults(updates) {
    return serialize(async () => {
      const { [STORAGE_KEY]: existing = [] } = await chrome.storage.local.get(STORAGE_KEY);
      const byDomain = new Map(existing.map((d) => [d.domain.toLowerCase(), d]));
      updates.forEach(({ domain, data }) => {
        const key = domain.toLowerCase();
        const prev = byDomain.get(key);
        if (prev) byDomain.set(key, { ...prev, ...data });
        else byDomain.set(key, { domain, ...data });
      });
      await chrome.storage.local.set({ [STORAGE_KEY]: [...byDomain.values()] });
    });
  }

  async function loadSettings() {
    const { [SETTINGS_KEY]: s = {} } = await chrome.storage.local.get(SETTINGS_KEY);
    return { ...DEFAULTS, ...s };
  }

  function saveSettings(s) {
    return chrome.storage.local.set({ [SETTINGS_KEY]: s });
  }

  // ---------- page helpers ----------

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(fn, timeoutMs, interval = 300) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > deadline) return null;
      await sleep(interval);
    }
  }

  // Vue tracks the textarea through its own value setter, so assigning .value
  // directly leaves the component model empty and the search runs on nothing.
  function setModelValue(el, value) {
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
    desc.set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function findButton(re) {
    return $$('button').find((b) => re.test((b.innerText || '').trim()));
  }

  // Exact mode is mandatory. The default "Filter by TLD" mode cross-products
  // every name against the 10 selected TLDs, so a 50-domain queue becomes 500
  // results and the cart fills with names nobody asked for. The two modes are
  // only distinguishable by the textarea placeholder.
  function isExactMode() {
    const ta = $(SEL.textarea);
    return !!ta && /with the tld/i.test(ta.placeholder || '');
  }

  async function ensureExactMode() {
    if (isExactMode()) return true;
    const tab = $$(SEL.tab).find((t) => /exact search/i.test(t.innerText || ''));
    if (!tab) return false;
    tab.click();
    return !!(await waitFor(isExactMode, 8000));
  }

  function rowDomain(label) {
    const spans = $$('span', label);
    const hit = spans.find((s) => DOMAIN_RE.test((s.textContent || '').trim()));
    return ((hit || spans[spans.length - 1])?.textContent || '').trim().toLowerCase();
  }

  function readRows() {
    return $$(SEL.row)
      .map((row) => {
        const label = $(SEL.label, row);
        if (!label) return null;
        const domain = rowDomain(label);
        if (!DOMAIN_RE.test(domain)) return null;
        const checkbox = $('input[type="checkbox"]', label);
        // Availability is structural: Dynadot only renders a selectable
        // checkbox for names you can actually buy. Taken rows get a
        // fa-window-minimize glyph in its place.
        const taken = !!$(SEL.takenIcon, row);
        return {
          domain,
          checkbox,
          available: !!checkbox && !taken,
          price: parsePriceUSD($(SEL.priceWrap, row)?.textContent),
          renewal: parsePriceUSD($(SEL.renewalWrap, row)?.textContent),
        };
      })
      .filter(Boolean);
  }

  // ---------- panel ----------

  let panel = null;
  let running = false;
  let stopRequested = false;

  function log(msg, kind) {
    const el = $('#ddp-log', panel);
    if (!el) return;
    const line = document.createElement('div');
    line.className = `ddp-line${kind ? ` ddp-${kind}` : ''}`;
    line.textContent = msg;
    el.prepend(line);
    while (el.children.length > 60) el.lastChild.remove();
  }

  function setStatus(msg) {
    const el = $('#ddp-status', panel);
    if (el) el.textContent = msg;
  }

  async function buildQueue(settings) {
    const { [STORAGE_KEY]: stored = [] } = await chrome.storage.local.get(STORAGE_KEY);
    return stored.filter((d) => {
      if (typeof d.semrushAS !== 'number' || d.semrushAS < settings.minAS) return false;
      if (settings.recheck) return true;
      return d.dynadotCheckedAt == null;
    });
  }

  function readSettingsFromPanel() {
    return {
      minAS: Math.max(0, Number($('#ddp-minas', panel).value) || DEFAULTS.minAS),
      batchSize: Math.min(
        MAX_BATCH,
        Math.max(1, Number($('#ddp-batch', panel).value) || DEFAULTS.batchSize)
      ),
      recheck: $('#ddp-recheck', panel).checked,
      addToCart: $('#ddp-cart', panel).checked,
    };
  }

  // An empty queue has several very different causes, and "0 domains" alone
  // gives you no way to tell them apart.
  async function refreshQueueCount() {
    const settings = readSettingsFromPanel();
    const { [STORAGE_KEY]: stored = [] } = await chrome.storage.local.get(STORAGE_KEY);
    const queue = await buildQueue(settings);
    const el = $('#ddp-queue', panel);
    if (!el) return queue;

    if (queue.length) {
      el.textContent = `${queue.length} domain${queue.length === 1 ? '' : 's'} at AS ≥ ${settings.minAS}`;
    } else if (!stored.length) {
      el.textContent = '0 queued — no domains stored yet.';
    } else {
      const scored = stored.filter((d) => typeof d.semrushAS === 'number');
      if (!scored.length) {
        el.textContent = `0 queued — ${stored.length} stored, none looked up on SEMrush yet.`;
      } else {
        const maxAS = Math.max(...scored.map((d) => d.semrushAS));
        const eligible = scored.filter((d) => d.semrushAS >= settings.minAS).length;
        el.textContent = eligible
          ? `0 queued — all ${eligible} at AS ≥ ${settings.minAS} already checked (tick re-check).`
          : `0 queued — ${scored.length} scored, highest AS is ${maxAS} (need ≥ ${settings.minAS}).`;
      }
    }
    return queue;
  }

  // ---------- the run ----------

  async function processBatch(batch, settings) {
    const names = batch.map((d) => d.domain.toLowerCase());

    const ta = $(SEL.textarea);
    if (!ta) throw new Error('search box not found');
    setModelValue(ta, names.join('\n'));

    const searchBtn = findButton(/^search(\s+in\s+bulk)?$/i);
    if (!searchBtn) throw new Error('search button not found');
    searchBtn.click();

    // Exact search echoes back exactly what was submitted, so "every name in
    // this batch has a row" is a reliable readiness signal. Require it twice
    // running so a half-rendered list doesn't get parsed.
    let stable = 0;
    const rows = await waitFor(
      () => {
        const current = readRows();
        const seen = new Set(current.map((r) => r.domain));
        if (names.every((n) => seen.has(n))) {
          stable++;
          if (stable >= 2) return current;
        } else {
          stable = 0;
        }
        return null;
      },
      RESULTS_TIMEOUT_MS,
      400
    );

    const finalRows = rows || readRows();
    const byDomain = new Map(finalRows.map((r) => [r.domain, r]));
    const now = Date.now();
    const updates = [];
    const toCart = [];
    let availableCount = 0;
    let takenCount = 0;
    let missingCount = 0;

    for (const item of batch) {
      const key = item.domain.toLowerCase();
      const row = byDomain.get(key);
      if (!row) {
        missingCount++;
        updates.push({
          domain: item.domain,
          data: { dynadotStatus: 'not-returned', dynadotCheckedAt: now },
        });
        continue;
      }
      if (row.available) {
        availableCount++;
        toCart.push(row);
        updates.push({
          domain: item.domain,
          data: {
            dynadotStatus: 'available',
            dynadotPrice: row.price,
            dynadotRenewal: row.renewal,
            dynadotCheckedAt: now,
          },
        });
      } else {
        takenCount++;
        updates.push({ domain: item.domain, data: { dynadotStatus: 'taken', dynadotCheckedAt: now } });
      }
    }

    await mergeResults(updates);
    log(`${availableCount} available, ${takenCount} taken${missingCount ? `, ${missingCount} no result` : ''}`);

    if (!toCart.length) return { availableCount, carted: 0 };
    if (!settings.addToCart) {
      log(`${toCart.length} available not carted (adding is off)`, 'warn');
      return { availableCount, carted: 0 };
    }

    // Only ever cart rows from this batch. Anything already ticked that we did
    // not queue gets cleared first, so a stray manual selection can't ride
    // along on our click.
    const wanted = new Set(toCart.map((r) => r.domain));
    let deselected = 0;
    for (const row of readRows()) {
      if (!row.checkbox) continue;
      const shouldCheck = wanted.has(row.domain);
      if (row.checkbox.checked && !shouldCheck) {
        row.checkbox.click();
        deselected++;
      } else if (!row.checkbox.checked && shouldCheck) {
        row.checkbox.click();
      }
    }
    if (deselected) log(`deselected ${deselected} row(s) not in this queue`, 'warn');

    // The footer is rendered a tick after the last checkbox toggles, and its
    // subtotal fills in a tick after that, so wait for the figure rather than
    // the container.
    const subtotalText = await waitFor(() => {
      if (!$(SEL.cartRow)) return null;
      const t = ($(SEL.subtotal)?.innerText || '').replace(/\s+/g, ' ').trim();
      return /\$/.test(t) ? t : null;
    }, 8000);

    if (!$(SEL.cartRow)) {
      log('selection footer never appeared — nothing carted', 'err');
      return { availableCount, carted: 0 };
    }

    const subtotal = subtotalText || '(subtotal unread)';
    log(`adding ${toCart.length} to cart — ${subtotal}`);

    const cartBtn = $(SEL.cartBtn);
    if (!cartBtn) {
      log('add-to-cart button not found', 'err');
      return { availableCount, carted: 0 };
    }
    cartBtn.click();

    const confirmed = await waitFor(
      () =>
        !$(SEL.cartRow) ||
        $$(`${SEL.row} ${SEL.label} input[type="checkbox"]:checked`).length === 0,
      CART_TIMEOUT_MS
    );

    const cartData = {
      dynadotInCart: true,
      dynadotCartConfirmed: !!confirmed,
      dynadotCartedAt: Date.now(),
    };
    await mergeResults(toCart.map((r) => ({ domain: r.domain, data: cartData })));

    if (confirmed) log(`carted ${toCart.length}`, 'ok');
    else log(`clicked add for ${toCart.length}, no confirmation — check the cart`, 'warn');

    return { availableCount, carted: toCart.length };
  }

  async function run() {
    const settings = readSettingsFromPanel();
    await saveSettings(settings);

    if (!(await ensureExactMode())) {
      setStatus('Could not switch to Exact Search — aborted.');
      log('Exact Search tab not found on this page', 'err');
      return;
    }

    const queue = await buildQueue(settings);
    if (!queue.length) {
      setStatus(`Nothing queued at AS ≥ ${settings.minAS}.`);
      return;
    }

    const batches = [];
    for (let i = 0; i < queue.length; i += settings.batchSize) {
      batches.push(queue.slice(i, i + settings.batchSize));
    }

    log(`starting: ${queue.length} domains in ${batches.length} batch(es)`);

    let done = 0;
    let available = 0;
    let carted = 0;

    for (let i = 0; i < batches.length; i++) {
      if (stopRequested) break;
      setStatus(`Batch ${i + 1}/${batches.length} — searching ${batches[i].length}…`);
      try {
        const res = await processBatch(batches[i], settings);
        available += res.availableCount;
        carted += res.carted;
      } catch (err) {
        log(`batch ${i + 1} failed: ${err.message}`, 'err');
      }
      done += batches[i].length;
      await refreshQueueCount();
      if (!stopRequested && i < batches.length - 1) await sleep(BATCH_PAUSE_MS);
    }

    setStatus(
      `${stopRequested ? 'Stopped' : 'Finished'} — ${done} checked, ${available} available, ${carted} carted.`
    );
  }

  // ---------- mount ----------

  async function mount() {
    if (panel) return;
    panel = document.createElement('div');
    panel.id = 'dynadot-cart-panel';
    panel.innerHTML = `
      <div class="ddp-header">Dynadot Auto-Cart <span class="ddp-ver">${PANEL_VERSION}</span></div>
      <div class="ddp-queue" id="ddp-queue">…</div>
      <div class="ddp-note" id="ddp-note" hidden></div>
      <label class="ddp-field">Min SEMrush AS
        <input type="number" id="ddp-minas" min="0" max="100" step="1" />
      </label>
      <label class="ddp-field">Batch size
        <input type="number" id="ddp-batch" min="1" max="${MAX_BATCH}" step="10" />
      </label>
      <label class="ddp-check"><input type="checkbox" id="ddp-recheck" /> Re-check already checked</label>
      <label class="ddp-check"><input type="checkbox" id="ddp-cart" /> Add available to cart</label>
      <button id="ddp-run">Run availability check</button>
      <div class="ddp-status" id="ddp-status">Idle.</div>
      <div class="ddp-log" id="ddp-log"></div>
    `;
    document.body.appendChild(panel);

    const settings = await loadSettings();
    $('#ddp-minas', panel).value = settings.minAS;
    $('#ddp-batch', panel).value = settings.batchSize;
    $('#ddp-recheck', panel).checked = settings.recheck;
    $('#ddp-cart', panel).checked = settings.addToCart;

    ['#ddp-minas', '#ddp-recheck'].forEach((sel) => {
      $(sel, panel).addEventListener('change', refreshQueueCount);
    });

    $('#ddp-run', panel).addEventListener('click', async (e) => {
      const btn = e.currentTarget;

      // Away from the bulk-search page there is nothing to drive, so the
      // button just takes you there. Navigating on your click keeps the
      // extension from ever opening Dynadot on its own.
      if (!onBulkPage()) {
        location.href = BULK_URL;
        return;
      }

      if (running) {
        stopRequested = true;
        setStatus('Stopping after this batch…');
        return;
      }
      running = true;
      stopRequested = false;
      btn.textContent = 'Stop';
      try {
        await run();
      } catch (err) {
        setStatus(`Error: ${err.message}`);
        log(err.message, 'err');
      }
      running = false;
      stopRequested = false;
      btn.textContent = 'Run availability check';
      refreshQueueCount();
    });

    updateModeUI();
    refreshQueueCount();
  }

  function onBulkPage() {
    return location.pathname.startsWith(BULK_PATH);
  }

  // The panel shows up on every Dynadot page so it is never silently absent;
  // only its action changes.
  function updateModeUI() {
    if (!panel || running) return;
    const bulk = onBulkPage();
    const note = $('#ddp-note', panel);
    const btn = $('#ddp-run', panel);
    btn.textContent = bulk ? 'Run availability check' : 'Open Bulk Search';
    note.hidden = bulk;
    if (!bulk) note.textContent = 'Availability checks run on the Bulk Search page.';
    ['#ddp-batch', '#ddp-cart', '#ddp-recheck'].forEach((sel) => {
      const el = $(sel, panel);
      if (el) el.closest('label').style.display = bulk ? '' : 'none';
    });
    $('#ddp-log', panel).style.display = bulk ? '' : 'none';
    $('#ddp-status', panel).style.display = bulk ? '' : 'none';
  }

  function syncToPath() {
    mount().then(updateModeUI);
  }

  syncToPath();
  // Dynadot routes client-side, so a content script that only ran on the
  // initial load would miss the bulk-search page entirely.
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    syncToPath();
  }, 1500);
})();
