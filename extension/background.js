const BASE = 'http://127.0.0.1:8765';
let running = false;
const delay = ms => new Promise(r => setTimeout(r, ms));
async function relay(path, data, token) {
  const r = await fetch(BASE + path, {method: data ? 'POST' : 'GET',
    headers: {'Content-Type': 'application/json', ...(token ? {Authorization: 'Bearer '+token} : {})},
    body: data ? JSON.stringify(data) : undefined, signal: AbortSignal.timeout(4000)});
  if (!r.ok) throw new Error('Helper returned '+r.status);
  return r.json();
}
async function loop() {
  if (running) return;
  running = true;
  let results = [];
  try {
    while (true) {
      const config = await chrome.storage.local.get(['token', 'tabId']);
      if (!config.token || !config.tabId) break;
      let state = null;
      try { state = await chrome.tabs.sendMessage(config.tabId, {action: 'state'}); } catch (_) {}
      try {
        const response = await relay('/api/bridge', {state, results}, config.token);
        results = [];
        for (const command of response.commands) {
          try {
            const result = await chrome.tabs.sendMessage(config.tabId, {action: 'command', command});
            results.push({id: command.id, ...result});
          } catch (_) { results.push({id: command.id, ok: false, error: 'SoundCloud tab is loading or closed'}); }
        }
        await chrome.action.setBadgeText({text: state ? 'ON' : 'TAB'});
        await chrome.action.setBadgeBackgroundColor({color: state ? '#ff6500' : '#666666'});
      } catch (_) {
        await chrome.action.setBadgeText({text: 'OFF'});
      }
      await delay(700);
    }
  } finally { running = false; }
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.action === 'wake') { loop(); reply({ok: true}); return; }
  if (message.action === 'connect' && !sender.tab) {
    (async () => {
      try {
        const tabs = await chrome.tabs.query({url: 'https://soundcloud.com/*'});
        const tab = tabs.find(t => t.active) || tabs[0];
        if (!tab) throw new Error('Open SoundCloud in this browser first.');
        try { await chrome.tabs.sendMessage(tab.id, {action:'state'}); }
        catch (_) { throw new Error('Refresh the SoundCloud page, then click Connect again.'); }
        const info = await relay('/api/local-info');
        await chrome.storage.local.set({token: info.token, tabId: tab.id});
        loop();
        reply({ok: true});
      } catch (error) { reply({ok: false, error: error.message}); }
    })();
    return true;
  }
});
chrome.runtime.onStartup.addListener(loop);
chrome.alarms.create('reconnect', {periodInMinutes: 1});
chrome.alarms.onAlarm.addListener(loop);
loop();
