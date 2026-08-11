// Anikura CN 自动签到 - 后台服务
// 读取浏览器中 anikura.cn 的登录 cookie，调用网站自身的 Supabase RPC 完成每日签到。

const SUPABASE_URL = 'https://ktpmvwcfzauqzkqnneus.supabase.co';
const ANON_KEY = 'sb_publishable_Zg3zu2JiVX1tQDlRj6R_fQ_tkiVE2jL';
const AUTH_URL = SUPABASE_URL + '/auth/v1';
const COOKIE_PREFIX = 'sb-ktpmvwcfzauqzkqnneus-auth-token';
const SITE_URL = 'https://www.anikura.cn/';

const ALARM_NAME = 'anikura-daily';
const STATUS_KEY = 'anikura_status';

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

// 读取 anikura.cn 的登录 cookie（Supabase session，base64url 编码，可能分片）
async function readSession() {
  const cookies = await chrome.cookies.getAll({ url: SITE_URL });
  const related = cookies.filter(
    (c) =>
      (c.name === COOKIE_PREFIX || c.name.startsWith(COOKIE_PREFIX + '.')) &&
      !c.name.includes('code-verifier')
  );
  if (!related.length) return null;

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
    return JSON.parse(base64UrlDecode(raw));
  } catch (e) {
    console.warn('[Anikura Auto Check-in] 解析登录态失败', e);
    return null;
  }
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
    await saveStatus({ ok: false, reason: 'not_logged_in', today });
    return { ok: false, reason: 'not_logged_in', today };
  }

  const finishSuccess = async (data) => {
    const points = data && data.points != null ? data.points : 0;
    const streak = data && data.streak != null ? data.streak : 0;
    const already = !!(data && data.already);
    await saveStatus({ ok: true, already, points, streak, today });
    if (!already) {
      notify('Anikura CN 签到成功', '获得 ' + points + ' 积分，连续签到 ' + streak + ' 天');
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
        return { ok: false, reason: 'auth_refresh_failed', error: String((e2 && e2.message) || e2), today };
      }
    }
    await saveStatus({ ok: false, reason: 'rpc_error', error: String((err && err.message) || err), today });
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
});
