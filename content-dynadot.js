// Stage 4: run every domain that cleared the SEMrush Authority Score threshold
// through Dynadot's bulk search, then select all and add to cart.
//
// Two ways in. Manually: open Dynadot yourself and click Run. Automatically:
// the SEMrush runner flips the dynadotAuto flag and opens this page, and the
// panel drains the queue on its own while SEMrush keeps feeding it.
(function () {
  const STORAGE_KEY = 'authorityDomains';
  const SETTINGS_KEY = 'dynadotSettings';
  const AUTO_KEY = 'dynadotAuto';
  const OWNER_KEY = 'dynadotAutoOwner';
  const BULK_PATH = '/domain/bulk-search';
  const BULK_URL = 'https://www.dynadot.com/domain/bulk-search';
  // Bumped on every change to this file so you can tell at a glance whether
  // Chrome actually picked up a reload.
  const PANEL_VERSION = 'v1.3';

  const DEFAULTS = {
    minAS: 7,
    batchSize: 100,
    recheck: false,
  };

  // Dynadot caps a single exact search per account tier — 1000 regular, 2000
  // Bulk, 5000 Super Bulk. The page prints the real figure, so read it rather
  // than guessing; this is only the ceiling if that read fails.
  const MAX_BATCH = 5000;
  const FALLBACK_LIMIT = 1000;

  // Generous, because a slow render that gets parsed half-finished is far more
  // expensive than waiting. Every step also settles before the next one.
  const SETTLE_MS = 2500;
  const RESULTS_TIMEOUT_MS = 90000;
  const CART_TIMEOUT_MS = 30000;
  const BATCH_PAUSE_MS = 8000;
  const PAGE_READY_TIMEOUT_MS = 30000;

  // Auto mode runs alongside the SEMrush stage, so the queue trickles in a few
  // domains at a time. Rather than search once per domain, hold results back
  // until enough accumulate — or until the trickle stalls, or SEMrush finishes.
  const AUTO_POLL_MS = 5000;
  const AUTO_MIN_BATCH = 25;
  const AUTO_MAX_WAIT_MS = 60000;

  // Only one tab may drive auto mode. Two tabs both carting would double up on
  // real purchases, so ownership is claimed with a heartbeat.
  const TAB_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const HEARTBEAT_MS = 8000;
  const OWNER_STALE_MS = 25000;

  // Two batches in a row where the cart click never confirms almost always
  // means the session is logged out. Stop rather than burn the whole queue.
  const MAX_CART_FAILURES = 2;
  const MAX_BATCH_ERRORS = 3;

  const SEL = {
    tab: '.bulk-search-tab-item',
    tabActive: '.tab-item-active',
    textarea: 'textarea.dyna-textarea__inner',
    limitText: '.bulk-search-limit',
    selectAllWrap: '.select_all_wrap',
    selectAll: '.select_all_wrap input[type="checkbox"]',
    row: '.res-item',
    label: '.res-input-label',
    priceWrap: '.price-wrap',
    renewalWrap: '.renewal-price-wrap',
    takenIcon: 'i.fa-window-minimize',
    cartRow: '.add-to-cart-row',
    cartBtn: 'button.add_to_cart, button[name="t_ad_add"]',
    addAllBtn: 'button.all-cart-button',
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

  async function loadAuto() {
    const { [AUTO_KEY]: a = {} } = await chrome.storage.local.get(AUTO_KEY);
    return { enabled: false, semrushRunning: false, ...a };
  }

  async function patchAuto(patch) {
    const cur = await loadAuto();
    await chrome.storage.local.set({ [AUTO_KEY]: { ...cur, ...patch } });
  }

  // Best-effort mutex. chrome.storage has no compare-and-swap, so we write then
  // read back: if another tab wrote in between, it wins and we stand down.
  async function claimAuto() {
    const { [OWNER_KEY]: owner } = await chrome.storage.local.get(OWNER_KEY);
    if (owner && owner.id !== TAB_ID && Date.now() - owner.at < OWNER_STALE_MS) return false;
    await chrome.storage.local.set({ [OWNER_KEY]: { id: TAB_ID, at: Date.now() } });
    await sleep(120);
    const { [OWNER_KEY]: check } = await chrome.storage.local.get(OWNER_KEY);
    return !!check && check.id === TAB_ID;
  }

  function heartbeat() {
    return chrome.storage.local.set({ [OWNER_KEY]: { id: TAB_ID, at: Date.now() } });
  }

  async function releaseAuto() {
    const { [OWNER_KEY]: owner } = await chrome.storage.local.get(OWNER_KEY);
    if (owner && owner.id === TAB_ID) await chrome.storage.local.remove(OWNER_KEY);
  }

  // ---------- page helpers ----------

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(fn, timeoutMs, interval = 400) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > deadline) return null;
      await sleep(interval);
    }
  }

  // innerText is absent outside a rendering engine and empty for elements the
  // layout has not resolved yet, so fall back to textContent.
  function labelOf(el) {
    return (el.innerText || el.textContent || '').trim();
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
    return $$('button').find((b) => re.test(labelOf(b)));
  }

  // Exact mode is mandatory. The default "Filter by TLD" mode cross-products
  // every name against the selected TLDs, so a 50-domain queue becomes 500
  // results and the cart fills with names nobody asked for.
  function isExactMode() {
    const active = $(SEL.tabActive);
    if (active) return /exact search/i.test(labelOf(active));
    const ta = $(SEL.textarea);
    return !!ta && /with the tld/i.test(ta.placeholder || '');
  }

  async function ensureExactMode() {
    if (isExactMode()) return true;
    const tab = $$(SEL.tab).find((t) => /exact search/i.test(labelOf(t)));
    if (!tab) return false;
    tab.click();
    const ok = !!(await waitFor(isExactMode, 10000));
    if (ok) await sleep(SETTLE_MS);
    return ok;
  }

  // The page prints "Domain Limit: 3/2000" — the ceiling depends on account
  // tier, so read it instead of hardcoding one.
  function pageSearchLimit() {
    const el = $(SEL.limitText);
    const m = el && labelOf(el).replace(/,/g, '').match(/\/\s*(\d+)/);
    const n = m ? parseInt(m[1], 10) : NaN;
    return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_BATCH) : FALLBACK_LIMIT;
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
        // Dynadot renders a selectable checkbox only for names you can buy;
        // taken rows get a fa-window-minimize glyph in its place. We do not
        // decide anything from this — select-all does — we only record it.
        const priceEl = $(SEL.priceWrap, row);
        return {
          domain,
          checkbox,
          selectable: !!checkbox && !$(SEL.takenIcon, row),
          priceText: priceEl ? labelOf(priceEl) : '',
          price: parsePrice(priceEl?.textContent),
          renewal: parsePrice($(SEL.renewalWrap, row)?.textContent),
        };
      })
      .filter(Boolean);
  }

  function checkedCount() {
    return $$(`${SEL.row} ${SEL.label} input[type="checkbox"]`).filter((c) => c.checked).length;
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
        pageSearchLimit(),
        Math.max(1, Number($('#ddp-batch', panel).value) || DEFAULTS.batchSize)
      ),
      recheck: $('#ddp-recheck', panel).checked,
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

  async function processBatch(batch) {
    const names = batch.map((d) => d.domain.toLowerCase());

    const ta = $(SEL.textarea);
    if (!ta) throw new Error('search box not found');
    setModelValue(ta, names.join('\n'));
    await sleep(SETTLE_MS);

    const searchBtn = findButton(/^search(\s+in\s+bulk)?$/i);
    if (!searchBtn) throw new Error('search button not found');
    searchBtn.click();

    // Exact search echoes back exactly what was submitted, so "every name in
    // this batch has a row" is a reliable readiness signal. Require it three
    // polls running so a half-rendered list never gets acted on.
    let stable = 0;
    const rows = await waitFor(
      () => {
        const current = readRows();
        const seen = new Set(current.map((r) => r.domain));
        if (names.every((n) => seen.has(n))) {
          stable++;
          if (stable >= 3) return current;
        } else {
          stable = 0;
        }
        return null;
      },
      RESULTS_TIMEOUT_MS,
      500
    );

    // Prices and checkboxes can land a beat after the names do.
    await sleep(SETTLE_MS);

    const finalRows = rows || readRows();
    if (!rows) log(`results incomplete after ${RESULTS_TIMEOUT_MS / 1000}s — using what rendered`, 'warn');

    const byDomain = new Map(finalRows.map((r) => [r.domain, r]));
    const now = Date.now();
    const updates = [];
    const selectable = [];
    let missing = 0;

    for (const item of batch) {
      const row = byDomain.get(item.domain.toLowerCase());
      if (!row) {
        missing++;
        updates.push({
          domain: item.domain,
          data: { dynadotStatus: 'not-returned', dynadotCheckedAt: now },
        });
      } else if (row.selectable) {
        selectable.push(row);
        updates.push({
          domain: item.domain,
          data: {
            dynadotStatus: 'available',
            dynadotPrice: row.price,
            dynadotPriceText: row.priceText,
            dynadotRenewal: row.renewal,
            dynadotCheckedAt: now,
          },
        });
      } else {
        updates.push({ domain: item.domain, data: { dynadotStatus: 'taken', dynadotCheckedAt: now } });
      }
    }

    await mergeResults(updates);
    log(
      `${selectable.length} available, ${batch.length - selectable.length - missing} taken${
        missing ? `, ${missing} no result` : ''
      }`
    );

    if (!selectable.length) return { availableCount: 0, carted: 0, confirmed: true };

    // Select all rather than ticking names one by one: Dynadot only renders a
    // checkbox for buyable names, so the master toggle selects exactly the
    // available ones. Exact mode guarantees the results are only our batch.
    const master = $(SEL.selectAll);
    if (master) {
      if (!master.checked) master.click();
      await sleep(SETTLE_MS);
    }

    // Fall back to ticking rows individually if the master toggle did nothing.
    if (checkedCount() === 0) {
      log('select-all did not take — ticking rows individually', 'warn');
      for (const row of readRows()) {
        if (row.checkbox && !row.checkbox.checked) row.checkbox.click();
      }
      await sleep(SETTLE_MS);
    }

    const selected = checkedCount();
    if (!selected) {
      log('nothing got selected — skipping cart', 'err');
      return { availableCount: selectable.length, carted: 0, confirmed: true };
    }

    // The footer renders a tick after the last checkbox toggles, and its
    // subtotal fills in a tick after that, so wait for the figure.
    const subtotalText = await waitFor(() => {
      if (!$(SEL.cartRow)) return null;
      const el = $(SEL.subtotal);
      const t = el ? labelOf(el).replace(/\s+/g, ' ') : '';
      return /\d/.test(t) ? t : null;
    }, 15000);

    if (!$(SEL.cartRow)) {
      log('selection footer never appeared — nothing carted', 'err');
      return { availableCount: selectable.length, carted: 0, confirmed: false };
    }

    log(`adding ${selected} to cart — ${subtotalText || '(subtotal unread)'}`);

    const cartBtn = $(SEL.cartBtn) || $(SEL.addAllBtn);
    if (!cartBtn) {
      log('add-to-cart button not found', 'err');
      return { availableCount: selectable.length, carted: 0, confirmed: false };
    }
    cartBtn.click();

    const confirmed = await waitFor(
      () => !$(SEL.cartRow) || checkedCount() === 0,
      CART_TIMEOUT_MS
    );
    await sleep(SETTLE_MS);

    const cartData = {
      dynadotInCart: true,
      dynadotCartConfirmed: !!confirmed,
      dynadotCartedAt: Date.now(),
    };
    await mergeResults(selectable.map((r) => ({ domain: r.domain, data: cartData })));

    if (confirmed) log(`carted ${selected}`, 'ok');
    else log(`clicked add for ${selected}, no confirmation — check the cart`, 'warn');

    return { availableCount: selectable.length, carted: selected, confirmed: !!confirmed };
  }

  // Auto mode may mount before the SPA has drawn the search form.
  async function waitForPageReady() {
    const ok = await waitFor(() => $(SEL.textarea), PAGE_READY_TIMEOUT_MS);
    if (ok) await sleep(SETTLE_MS);
    return !!ok;
  }

  async function drain(settings, onBatch) {
    const queue = await buildQueue(settings);
    if (!queue.length) return { done: 0 };
    const batches = [];
    for (let i = 0; i < queue.length; i += settings.batchSize) {
      batches.push(queue.slice(i, i + settings.batchSize));
    }
    log(`${queue.length} domains in ${batches.length} batch(es)`);
    let done = 0;
    for (let i = 0; i < batches.length; i++) {
      if (stopRequested) break;
      setStatus(`Batch ${i + 1}/${batches.length} — searching ${batches[i].length}…`);
      await onBatch(batches[i], i, batches.length);
      done += batches[i].length;
      await refreshQueueCount();
      if (!stopRequested && i < batches.length - 1) await sleep(BATCH_PAUSE_MS);
    }
    return { done };
  }

  async function runManual() {
    const settings = readSettingsFromPanel();
    await saveSettings(settings);

    if (!(await waitForPageReady())) {
      setStatus('Search form never loaded — aborted.');
      return;
    }
    if (!(await ensureExactMode())) {
      setStatus('Could not switch to Exact Search — aborted.');
      log('Exact Search tab not found', 'err');
      return;
    }

    let available = 0;
    let carted = 0;
    const { done } = await drain(settings, async (batch) => {
      try {
        const res = await processBatch(batch);
        available += res.availableCount;
        carted += res.carted;
      } catch (err) {
        log(`batch failed: ${err.message}`, 'err');
      }
    });

    setStatus(
      done
        ? `${stopRequested ? 'Stopped' : 'Finished'} — ${done} checked, ${available} available, ${carted} carted.`
        : `Nothing queued at AS ≥ ${settings.minAS}.`
    );
  }

  // ---------- auto mode ----------

  // Drains the queue continuously while the SEMrush stage feeds it, then stops
  // once SEMrush is done and nothing is left. No clicks required.
  async function runAuto() {
    if (running) return;
    if (!(await claimAuto())) {
      log('another Dynadot tab is already auto-running', 'warn');
      setStatus('Idle — another tab owns auto mode.');
      return;
    }

    running = true;
    stopRequested = false;
    const btn = $('#ddp-run', panel);
    if (btn) btn.textContent = 'Stop';
    log('auto mode on — carting as SEMrush finds them', 'ok');

    const beat = setInterval(heartbeat, HEARTBEAT_MS);

    try {
      if (!(await waitForPageReady())) {
        setStatus('Search form never loaded — auto mode stopped.');
        log('bulk search form did not render', 'err');
        return;
      }
      if (!(await ensureExactMode())) {
        setStatus('Could not switch to Exact Search — auto mode stopped.');
        log('Exact Search tab not found', 'err');
        return;
      }

      let idleSince = Date.now();
      let cartFailures = 0;
      let batchErrors = 0;

      while (!stopRequested) {
        const settings = readSettingsFromPanel();
        const auto = await loadAuto();
        const queue = await refreshQueueCount();

        if (queue.length) {
          // Wait for a worthwhile batch, but never stall: go early if the feed
          // has gone quiet or the SEMrush stage has finished.
          const ready =
            queue.length >= AUTO_MIN_BATCH ||
            !auto.semrushRunning ||
            Date.now() - idleSince > AUTO_MAX_WAIT_MS;

          if (ready) {
            const batch = queue.slice(0, settings.batchSize);
            setStatus(`Auto — checking ${batch.length}…`);
            try {
              const res = await processBatch(batch);
              if (res.carted) cartFailures = res.confirmed ? 0 : cartFailures + 1;
              batchErrors = 0;
            } catch (err) {
              // A throw leaves the batch unmarked, so it requeues. Without a
              // ceiling a broken page would retry the same names forever.
              batchErrors++;
              log(`batch failed: ${err.message}`, 'err');
              if (batchErrors >= MAX_BATCH_ERRORS) {
                setStatus(`Stopped — ${batchErrors} batches failed in a row (${err.message}).`);
                log('giving up; the page markup may have changed', 'err');
                break;
              }
            }
            idleSince = Date.now();

            if (cartFailures >= MAX_CART_FAILURES) {
              setStatus('Stopped — cart is not confirming. Check you are logged in to Dynadot.');
              log(`${cartFailures} batches carted without confirmation — stopping`, 'err');
              break;
            }
            await sleep(BATCH_PAUSE_MS);
            continue;
          }
        } else if (!auto.semrushRunning) {
          setStatus('Auto — finished, queue empty.');
          log('queue drained and SEMrush is done', 'ok');
          break;
        }

        setStatus(
          auto.semrushRunning
            ? `Auto — ${queue.length} pending, waiting for SEMrush…`
            : 'Auto — wrapping up…'
        );
        await sleep(AUTO_POLL_MS);
      }
    } finally {
      clearInterval(beat);
      await releaseAuto();
      await patchAuto({ enabled: false });
      running = false;
      stopRequested = false;
      if (btn) btn.textContent = 'Run availability check';
      updateModeUI();
      refreshQueueCount();
    }
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
      <button id="ddp-run">Run availability check</button>
      <div class="ddp-status" id="ddp-status">Idle.</div>
      <div class="ddp-log" id="ddp-log"></div>
    `;
    document.body.appendChild(panel);

    const settings = await loadSettings();
    $('#ddp-minas', panel).value = settings.minAS;
    $('#ddp-batch', panel).value = settings.batchSize;
    $('#ddp-recheck', panel).checked = settings.recheck;

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
        await runManual();
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
    await refreshQueueCount();

    // The runner flips this on when SEMrush produces its first qualifying
    // domain, then opens this page. Start without waiting for a click.
    const auto = await loadAuto();
    if (auto.enabled && onBulkPage()) runAuto();
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
    ['#ddp-batch', '#ddp-recheck'].forEach((sel) => {
      const el = $(sel, panel);
      if (el) el.closest('label').style.display = bulk ? '' : 'none';
    });
    $('#ddp-log', panel).style.display = bulk ? '' : 'none';
    $('#ddp-status', panel).style.display = bulk ? '' : 'none';
  }

  function syncToPath() {
    mount().then(updateModeUI);
  }

  // Covers the case where a Dynadot tab was already open before the SEMrush
  // run started — it picks up auto mode without needing to be reloaded.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[AUTO_KEY]?.newValue?.enabled && !running && panel && onBulkPage()) {
      runAuto();
    }
    // Keep the queue line live while the SEMrush stage writes new scores.
    if (changes[STORAGE_KEY] && panel && !running) refreshQueueCount();
  });

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
