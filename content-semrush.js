(function () {
  const url = new URL(location.href);
  if (!url.pathname.startsWith('/analytics/overview/')) return;
  const domain = url.searchParams.get('q');
  if (!domain) return;

  const STORAGE_KEY = 'authorityDomains';
  const READY_TIMEOUT_MS = 20000;

  const SELECTORS = {
    authorityScore: 'do-summary-as',
    organicTraffic: 'do-summary-ot',
    paidTraffic: 'do-summary-pt',
    trafficShare: 'do-summary-ts',
    organicKeywords: 'do-summary-ok',
    paidKeywords: 'do-summary-pk',
    refDomains: 'do-summary-ref_domains',
    backlinks: 'do-summary-bl',
  };

  function readMetric(key) {
    const block = document.querySelector(`[data-at="${SELECTORS[key]}"]`);
    if (!block) return undefined;
    let el = block.querySelector('a[data-at="main-number"]');
    if (el) return el.textContent.trim();
    el = block.querySelector('[data-at="primary-data"] span');
    if (el) return el.textContent.trim();
    el = Array.from(block.querySelectorAll('span[size="500"]')).find(
      (s) => !s.closest('[data-at="summary-title"]')
    );
    return el ? el.textContent.trim() : undefined;
  }

  // The Authority Score block is rendered by the SPA only once the summary data
  // has actually resolved, so its presence is our readiness signal.
  function isReady() {
    return readMetric('authorityScore') !== undefined;
  }

  // If SEMrush bounced us to a login/upgrade wall the header search field for
  // this domain never renders. Used to report a distinct status to the runner.
  function looksLoggedOut() {
    return (
      document.querySelector('a[href*="/sso/login"], form[action*="/sso/login"]') !== null &&
      document.querySelector('[data-at="do-summary-as"]') === null
    );
  }

  async function mergeIntoStorage(domainKey, data) {
    const { [STORAGE_KEY]: existing = [] } = await chrome.storage.local.get(STORAGE_KEY);
    const idx = existing.findIndex((d) => d.domain === domainKey);
    if (idx === -1) {
      existing.push({ domain: domainKey, ...data });
    } else {
      existing[idx] = { ...existing[idx], ...data };
    }
    await chrome.storage.local.set({ [STORAGE_KEY]: existing });
  }

  function notifyRunner(data) {
    chrome.runtime.sendMessage({ type: 'semrush-result', domain, data }, () => {
      // Runner tab may be closed; swallow "no receiving end" noise.
      void chrome.runtime.lastError;
    });
  }

  let done = false;
  let observer = null;
  let timeoutId = null;

  function teardown() {
    if (observer) observer.disconnect();
    if (timeoutId) clearTimeout(timeoutId);
    observer = null;
    timeoutId = null;
  }

  async function complete() {
    if (done) return;
    done = true;
    teardown();

    const raw = {};
    for (const key of Object.keys(SELECTORS)) raw[key] = readMetric(key);

    const data = {
      semrushAS: parseAbbreviatedNumber(raw.authorityScore),
      semrushOrganicTraffic: parseAbbreviatedNumber(raw.organicTraffic),
      semrushPaidTraffic: parseAbbreviatedNumber(raw.paidTraffic),
      semrushOrganicKeywords: parseAbbreviatedNumber(raw.organicKeywords),
      semrushPaidKeywords: parseAbbreviatedNumber(raw.paidKeywords),
      semrushRefDomains: parseAbbreviatedNumber(raw.refDomains),
      semrushBacklinks: parseAbbreviatedNumber(raw.backlinks),
      semrushCheckedAt: Date.now(),
      semrushStatus: parseAbbreviatedNumber(raw.authorityScore) === null ? 'no-data' : 'ok',
    };
    await mergeIntoStorage(domain, data);
    notifyRunner(data);
  }

  async function bail(status) {
    if (done) return;
    done = true;
    teardown();
    const data = { semrushCheckedAt: Date.now(), semrushStatus: status };
    await mergeIntoStorage(domain, data);
    notifyRunner(data);
  }

  function check() {
    if (done) return;
    if (isReady()) complete();
    else if (looksLoggedOut()) bail('logged-out');
  }

  observer = new MutationObserver(check);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  timeoutId = setTimeout(() => bail('timeout'), READY_TIMEOUT_MS);

  // The summary may already be present if the script ran late.
  check();
})();
