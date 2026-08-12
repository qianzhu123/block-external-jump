// background service worker —— blacklist storage + cross-page message hub
// Data shape:
//   blacklist: string[]                       user-entered rule strings
//   exceptions: { from, to }[]                permanent allow list ("Don't notify again")
//
// Hit logic (kept in sync with inject.js / content.js):
//   A blacklist entry hits the current page URL iff the string is a substring of the URL.
//   Cross-origin: target's registrable domain != current page's registrable domain.

const KEY_BLACK = "blacklist";
const KEY_EXC = "exceptions";

// Registrarable domain (eTLD+1) — simplified, good enough for self-use.
// e.g. a.b.example.com -> example.com;  example.com.cn -> example.com.cn
// IPv4 / single-label hosts (e.g. 127.0.0.1, localhost) return the whole host, no trimming.
function regDomain(urlStr) {
  try {
    const u = new URL(urlStr);
    const host = u.hostname;
    const parts = host.split(".");
    if (parts.length <= 2) return host;
    const allNum = parts.every( p => /^[0-9]{1,3}$/.test(p) );
    if (allNum) return host;
    if (/^\d+$/.test(parts[0])) return host;
    const secondLast = parts[parts.length - 2];
    if (secondLast.length <= 2) return parts.slice(-3).join(".");
    return parts.slice(-2).join(".");
  } catch {
    return "";
  }
}

async function getBlacklist() {
  const r = await chrome.storage.local.get(KEY_BLACK);
  return r[KEY_BLACK] || [];
}
async function getExceptions() {
  const r = await chrome.storage.local.get(KEY_EXC);
  return r[KEY_EXC] || [];
}

// Does urlStr hit any blacklist rule (substring match)?
function hitBlacklist(urlStr, list) {
  const s = urlStr || "";
  return list.some(rule => rule && s.includes(rule));
}

// Listen for check requests from content/inject
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === "CHECK") {
      // From the page side: is the current page in the blacklist? (decides whether interception is active)
      const pageUrl = msg.pageUrl;
      const list = await getBlacklist();
      sendResponse({ enabled: hitBlacklist(pageUrl, list) });
      return;
    }
    if (msg.type === "IS_EXCEPTION") {
      // Is this from->to pair in the permanent allow list?
      const exc = await getExceptions();
      const hit = exc.some(e => e.from === msg.fromDomain && e.to === msg.toDomain);
      sendResponse({ exception: hit });
      return;
    }
    if (msg.type === "ADD_EXCEPTION") {
      const exc = await getExceptions();
      if (!exc.some(e => e.from === msg.fromDomain && e.to === msg.toDomain)) {
        exc.push({ from: msg.fromDomain, to: msg.toDomain });
        await chrome.storage.local.set({ [KEY_EXC]: exc });
      }
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "GET_ALL") {
      const [b, e] = await Promise.all([getBlacklist(), getExceptions()]);
      sendResponse({ blacklist: b, exceptions: e });
      return;
    }
    if (msg.type === "ADD_RULE") {
      const list = await getBlacklist();
      if (msg.rule && !list.includes(msg.rule)) list.push(msg.rule);
      await chrome.storage.local.set({ [KEY_BLACK]: list });
      sendResponse({ ok: true, blacklist: list });
      return;
    }
    if (msg.type === "DEL_RULE") {
      let list = await getBlacklist();
      list = list.filter(r => r !== msg.rule);
      await chrome.storage.local.set({ [KEY_BLACK]: list });
      sendResponse({ ok: true, blacklist: list });
      return;
    }
    if (msg.type === "SET_BLACKLIST") {
      await chrome.storage.local.set({ [KEY_BLACK]: msg.blacklist || [] });
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "DEL_EXCEPTION") {
      let exc = await getExceptions();
      exc = exc.filter(e => !(e.from === msg.fromDomain && e.to === msg.toDomain));
      await chrome.storage.local.set({ [KEY_EXC]: exc });
      sendResponse({ ok: true, exceptions: exc });
      return;
    }
    if (msg.type === "CLEAR_EXCEPTIONS") {
      await chrome.storage.local.set({ [KEY_EXC]: [] });
      sendResponse({ ok: true, exceptions: [] });
      return;
    }
    sendResponse({ ok: false, err: "unknown" });
  })();
  return true; // async
});

// Expose utils for popup / options (same-name functions; each page may also import locally).
self.regDomain = regDomain;
