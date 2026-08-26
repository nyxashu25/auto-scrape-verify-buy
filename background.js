const STORAGE_KEY = 'authorityDomains';

async function updateBadge() {
  const { [STORAGE_KEY]: stored = [] } = await chrome.storage.local.get(STORAGE_KEY);
  chrome.action.setBadgeBackgroundColor({ color: '#3a7bd5' });
  const n = stored.length;
  // Badge fits ~4 glyphs; abbreviate so 12,340 doesn't render as garbage.
  const text = n === 0 ? '' : n > 9999 ? `${Math.floor(n / 1000)}k` : String(n);
  chrome.action.setBadgeText({ text });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEY]) updateBadge();
});

chrome.runtime.onInstalled.addListener(updateBadge);
chrome.runtime.onStartup.addListener(updateBadge);
