// Anikura CN 自动签到 - 后台服务
// 读取浏览器中 anikura.cn 的登录 cookie，调用网站自身的 Supabase RPC 完成每日签到。

const SUPABASE_URL = 'https://ktpmvwcfzauqzkqnneus.supabase.co';
const ANON_KEY = 'sb_publishable_Zg3zu2JiVX1tQDlRj6R_fQ_tkiVE2jL';
const AUTH_URL = SUPABASE_URL + '/auth/v1';
const COOKIE_PREFIX = 'sb-ktpmvwcfzauqzkqnneus-auth-token';
const SITE_URL = 'https://www.anikura.cn/';

const ALARM_NAME = 'anikura-daily';
const STATUS_KEY = 'anikura_status';
const SETTINGS_KEY = 'anikura_settings';
const LAST_NOTIFY_KEY = 'anikura_last_notify';

// ---------- 基础工具 ----------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function storageGet(key) {
  return new Promise((resolve) => chrome.storage.local.get(key, resolve));
}

function storageSet(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

function getAllCookies(details) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (cookies, err) => {
      if (settled) return;
      settled = true;
      resolve({ cookies: cookies || [], error: err ? String((err && err.message) || err) : null });
    };
    try {
      const maybe = chrome.cookies.getAll(details, (cookies) => {
        finish(cookies, chrome.runtime.lastError);
      });
      if (maybe && typeof maybe.then === 'function') {
        maybe.then((c) => finish(c, null)).catch((e) => finish([], e));
      }
    } catch (e) {
      finish([], e);
    }
  });
}

function shanghaiToday() {
  return new Date().toLocaleDateString('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

function base64UrlDecode(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// 读取 anikura.cn 的登录态（Supabase session）
// 顺序：chrome.cookies（含 HttpOnly，兼容 www 与裸域名）→ 页面 content script（localStorage / document.cookie）
let lastDiag = null;

function sessionFromCookies(cookies) {
  const related = cookies.filter(
    (c) =>
      (c.name === COOKIE_PREFIX || c.name.startsWith(COOKIE_PREFIX + '.')) &&
      !c.name.includes('code-verifier')
  );
  if (!related.length) return { session: null, cookieNames: [] };

  const chunked = related.filter((c) => c.name.includes('.'));
  const list = chunked.length
    ? chunked.sort((a, b) => {
        const na = parseInt(a.name.slice(COOKIE_PREFIX.length + 1), 10);
        const nb = parseInt(b.name.slice(COOKIE_PREFIX.length + 1), 10);
        return na - nb;
      })
    : related;

  let raw = list.map((c) => c.value).join('');
  if (raw.startsWith('base64-')) raw = raw.slice('base64-'.length);
  try {
    const session = JSON.parse(base64UrlDecode(raw));
    return {
      session: session && session.access_token ? session : null,
      cookieNames: related.map((c) => c.name),
    };
  } catch (e) {
    console.warn('[Anikura Auto Check-in] 解析登录态失败', e);
    return {
      session: null,
      cookieNames: related.map((c) => c.name),
      parseError: String((e && e.message) || e),
    };
  }
}

function askContentScript() {
  return new Promise((resolve) => {
    chrome.tabs.query({ url: ['https://www.anikura.cn/*', 'https://anikura.cn/*'] }, (tabs) => {
      const targets = tabs || [];
      if (!targets.length) {
        resolve(null);
        return;
      }
      let pending = targets.length;
      let found = null;
      for (const tab of targets) {
        try {
          chrome.tabs.sendMessage(tab.id, { type: 'anikura-get-page-session' }, (resp) => {
            if (!chrome.runtime.lastError && !found && resp && resp.token) found = resp;
            pending--;
            if (pending === 0) resolve(found);
          });
        } catch (e) {
          pending--;
          if (pending === 0) resolve(found);
        }
      }
    });
  });
}

async function collectSessionData() {
  const diag = { cookieProbes: [], lsKeys: [], pageCookies: [], parseError: null };
  let session = null;

  // 1) chrome.cookies 多种查询方式探测：定位为什么常规查询读不到登录 cookie
  const isSbAuth = (c) =>
    c.name.startsWith('sb-') && c.name.includes('auth-token') && !c.name.includes('code-verifier');
  const collected = [];
  const runProbe = async (label, details) => {
    const r = await getAllCookies(details);
    const sb = r.cookies.filter(isSbAuth);
    diag.cookieProbes.push({
      label,
      count: r.cookies.length,
      sb: sb.length,
      error: r.error,
    });
    if (sb.length) collected.push(...sb);
  };
  await runProbe('url www', { url: SITE_URL });
  await runProbe('url 裸域', { url: 'https://anikura.cn/' });
  await runProbe('url www/checkin', { url: 'https://www.anikura.cn/checkin' });
  await runProbe('全部可读', {});
  await runProbe('按域名 anikura.cn', { domain: 'anikura.cn' });
  await runProbe('分区 www', { url: SITE_URL, partitionKey: { topLevelSite: 'https://www.anikura.cn' } });
  await runProbe('分区 裸域', { url: SITE_URL, partitionKey: { topLevelSite: 'https://anikura.cn' } });

  // 去重后统一解析
  const seen = new Set();
  const uniqueCookies = [];
  for (const c of collected) {
    const key = c.name + '|' + c.value;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueCookies.push(c);
    }
  }
  const fromCookie = sessionFromCookies(uniqueCookies);
  diag.parseError = fromCookie.parseError || null;
  if (fromCookie.session) session = fromCookie.session;

  // 2) 页面 content script：localStorage / document.cookie 兜底
  if (!session) {
    try {
      const page = await askContentScript();
      if (page) {
        diag.lsKeys = page.lsKeys || [];
        diag.pageCookies = page.pageCookies || [];
        if (page.token) session = { access_token: page.token };
      }
    } catch (e) {
      diag.contentScriptError = String((e && e.message) || e);
    }
  }
  return { session, diag };
}

async function readSession() {
  const result = await collectSessionData();
  lastDiag = result.diag;
  return result.session;
}

async function callCheckIn(accessToken) {
  const res = await fetch(SUPABASE_URL + '/rest/v1/rpc/perform_checkin', {
    method: 'POST',
    headers: {
      apikey: ANON_KEY,
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
      'X-Client-Info': 'anikura-auto-checkin/1.0.0',
    },
    body: '{}',
  });
  if (!res.ok) {
    let message = 'HTTP ' + res.status;
    try {
      const body = await res.json();
      if (body && body.message) message = body.message;
    } catch (e) { /* 忽略解析失败 */ }
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// access_token 过期时，用 refresh_token 刷新出新 session
async function refreshSession(refreshToken) {
  const res = await fetch(AUTH_URL + '/token?grant_type=refresh_token', {
    method: 'POST',
    headers: {
      apikey: ANON_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!res.ok) {
    let message = 'HTTP ' + res.status;
    try {
      const body = await res.json();
      if (body && (body.error_description || body.error)) message = body.error_description || body.error;
    } catch (e) { /* 忽略解析失败 */ }
    throw new Error(message);
  }
  return res.json();
}

function notify(title, message) {
  chrome.notifications.create('anikura-checkin', {
    type: 'basic',
    iconUrl: 'icon128.png',
    title,
    message,
  });
}

async function getSettings() {
  const d = await storageGet(SETTINGS_KEY);
  const s = d[SETTINGS_KEY] || {};
  return { notifyEnabled: s.notifyEnabled !== false };
}

// 每种结果（成功/失败）每天最多提示一次，避免每小时闹铃重复打扰
async function notifyOnce(type, title, message) {
  const settings = await getSettings();
  if (!settings.notifyEnabled) return;
  const today = shanghaiToday();
  const d = (await storageGet(LAST_NOTIFY_KEY))[LAST_NOTIFY_KEY];
  if (d && d.date === today && d.type === type) return;
  notify(title, message);
  await storageSet({ [LAST_NOTIFY_KEY]: { date: today, type } });
}

// 点击通知跳转到签到页
chrome.notifications.onClicked.addListener((id) => {
  if (id === 'anikura-checkin') {
    chrome.tabs.create({ url: SITE_URL + 'checkin' });
  }
});

async function saveStatus(status) {
  await storageSet({ [STATUS_KEY]: { ...status, updatedAt: Date.now() } });
}

// ---------- 核心：执行签到 ----------

async function checkInNow(force = false) {
  const today = shanghaiToday();
  const stored = (await storageGet(STATUS_KEY))[STATUS_KEY];
  if (!force && stored && stored.ok && stored.today === today) {
    return { ok: true, already: true, today, skipped: true };
  }

  let session = await readSession();
  if (!session) {
    await saveStatus({ ok: false, reason: 'not_logged_in', today, diag: lastDiag });
    await notifyOnce('fail', 'Anikura CN 签到未完成', '未检测到登录状态，请先打开 anikura.cn 登录一次');
    return { ok: false, reason: 'not_logged_in', today };
  }

  const finishSuccess = async (data) => {
    const points = data && data.points != null ? data.points : 0;
    const streak = data && data.streak != null ? data.streak : 0;
    const already = !!(data && data.already);
    await saveStatus({ ok: true, already, points, streak, today });
    if (!already) {
      await notifyOnce('success', 'Anikura CN 签到成功', '获得 ' + points + ' 积分，连续签到 ' + streak + ' 天');
    }
    return { ok: true, already, points, streak, today };
  };

  try {
    return await finishSuccess(await callCheckIn(session.access_token));
  } catch (err) {
    // 登录态过期：尝试刷新一次再签
    if ((err.status === 401 || err.status === 403) && session.refresh_token) {
      try {
        const fresh = await refreshSession(session.refresh_token);
        return await finishSuccess(await callCheckIn(fresh.access_token));
      } catch (e2) {
        await saveStatus({ ok: false, reason: 'auth_refresh_failed', error: String((e2 && e2.message) || e2), today });
        await notifyOnce('fail', 'Anikura CN 签到失败', '登录态已过期且刷新失败，请重新登录 anikura.cn');
        return { ok: false, reason: 'auth_refresh_failed', error: String((e2 && e2.message) || e2), today };
      }
    }
    await saveStatus({ ok: false, reason: 'rpc_error', error: String((err && err.message) || err), today });
    await notifyOnce('fail', 'Anikura CN 签到失败', String((err && err.message) || err));
    return { ok: false, reason: 'rpc_error', error: String((err && err.message) || err), today };
  }
}

function installAlarm() {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 60 });
}

// ---------- 生命周期 ----------

chrome.runtime.onInstalled.addListener(() => {
  installAlarm();
  checkInNow(false);
});

chrome.runtime.onStartup.addListener(() => {
  installAlarm();
  checkInNow(false);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) checkInNow(false);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'checkin-now') {
    checkInNow(true)
      .then((r) => sendResponse({ ok: true, result: r }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true; // 异步响应
  }
  if (msg && msg.type === 'get-status') {
    storageGet(STATUS_KEY).then((d) => sendResponse({ ok: true, status: d[STATUS_KEY] || null }));
    return true;
  }
  if (msg && msg.type === 'get-settings') {
    getSettings().then((s) => sendResponse({ ok: true, settings: s }));
    return true;
  }
  if (msg && msg.type === 'set-settings') {
    const next = { notifyEnabled: !!msg.notifyEnabled };
    storageSet({ [SETTINGS_KEY]: next }).then(() => sendResponse({ ok: true, settings: next }));
    return true;
  }
  if (msg && msg.type === 'run-diag') {
    collectSessionData().then((r) =>
      sendResponse({ ok: true, hasSession: !!r.session, diag: r.diag })
    );
    return true;
  }
});
