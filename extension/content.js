// 运行在 anikura.cn 页面内：作为诊断与兜底，读取页面上下文可见的登录态
// （localStorage + document.cookie）。HttpOnly cookie 页面看不到，但后台可以用
// chrome.cookies 读到，两者互补。

const COOKIE_PREFIX = 'sb-ktpmvwcfzauqzkqnneus-auth-token';

function base64UrlDecode(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function parseSession(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  let v = raw;
  if (v.startsWith('base64-')) v = v.slice('base64-'.length);
  try {
    const session = JSON.parse(base64UrlDecode(v));
    return session && session.access_token ? session : null;
  } catch (e) {
    return null;
  }
}

function getLsKeys() {
  const keys = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('sb-') && k.includes('auth-token') && !k.includes('code-verifier')) {
        keys.push(k);
      }
    }
  } catch (e) { /* 忽略 */ }
  return keys;
}

function getPageCookieNames() {
  const names = [];
  try {
    for (const part of document.cookie.split(';')) {
      const name = part.slice(0, part.indexOf('=')).trim();
      if ((name === COOKIE_PREFIX || name.startsWith(COOKIE_PREFIX + '.')) && !name.includes('code-verifier')) {
        names.push(name);
      }
    }
  } catch (e) { /* 忽略 */ }
  return names;
}

function tokenFromPageCookies() {
  const chunks = document.cookie
    .split(';')
    .map((part) => {
      const eq = part.indexOf('=');
      return { name: part.slice(0, eq).trim(), value: part.slice(eq + 1).trim() };
    })
    .filter(
      (c) =>
        (c.name === COOKIE_PREFIX || c.name.startsWith(COOKIE_PREFIX + '.')) &&
        !c.name.includes('code-verifier')
    );
  if (!chunks.length) return null;
  const chunked = chunks.filter((c) => c.name.includes('.'));
  const list = chunked.length
    ? chunked.sort((a, b) => {
        const na = parseInt(a.name.slice(COOKIE_PREFIX.length + 1), 10);
        const nb = parseInt(b.name.slice(COOKIE_PREFIX.length + 1), 10);
        return na - nb;
      })
    : chunks;
  const session = parseSession(list.map((c) => c.value).join(''));
  return session ? session.access_token : null;
}

// ---------- 页面按钮签到（兜底，不依赖读取登录态） ----------

function isAlreadyCheckedIn() {
  return !!document.body && /今日已签到/.test(document.body.innerText);
}

function findCheckInButton() {
  return Array.from(document.querySelectorAll('button')).find((b) =>
    /立即签到/.test((b.textContent || '').trim())
  );
}

function clickBasedCheckIn() {
  return new Promise((resolve) => {
    if (isAlreadyCheckedIn()) {
      resolve({ ok: true, already: true });
      return;
    }
    const btn = findCheckInButton();
    if (!btn) {
      resolve({ ok: false, error: '未找到签到按钮（可能未登录或页面未加载完）' });
      return;
    }
    btn.click();
    const deadline = Date.now() + 10000;
    const timer = setInterval(() => {
      if (isAlreadyCheckedIn()) {
        clearInterval(timer);
        resolve({ ok: true, already: false });
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        resolve({ ok: false, error: '点击后未检测到签到成功（可能已签到或网络异常）' });
      }
    }, 600);
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'anikura-get-page-session') {
    const result = { lsKeys: getLsKeys(), pageCookies: getPageCookieNames(), token: null };
    for (const k of result.lsKeys) {
      try {
        const session = parseSession(localStorage.getItem(k));
        if (session) {
          result.token = session.access_token;
          break;
        }
      } catch (e) { /* 继续下一个 */ }
    }
    if (!result.token) result.token = tokenFromPageCookies();
    sendResponse(result);
  }
  if (msg && msg.type === 'anikura-click-checkin') {
    clickBasedCheckIn().then((r) => sendResponse(r));
    return true;
  }
});
