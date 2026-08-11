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
});
