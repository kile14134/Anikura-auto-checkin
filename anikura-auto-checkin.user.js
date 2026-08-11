// ==UserScript==
// @name         Anikura CN 自动签到
// @namespace    anikura-auto-checkin
// @version      1.1.0
// @description  anikura.cn 每日自动签到：打开网站任意页面时自动调用网站自身的签到接口，并提示签到结果。
// @match        https://www.anikura.cn/*
// @run-at       document-idle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  // ---------- 网站接口配置（2026-08 抓取自 anikura.cn 前端资源） ----------
  const SUPABASE_URL = 'https://ktpmvwcfzauqzkqnneus.supabase.co';
  const ANON_KEY = 'sb_publishable_Zg3zu2JiVX1tQDlRj6R_fQ_tkiVE2jL';
  // 登录态 session 存放在该 cookie（base64url 编码，可能按 .0/.1/.2 分片）
  const COOKIE_PREFIX = 'sb-ktpmvwcfzauqzkqnneus-auth-token';

  const STORAGE_KEY = 'anikura_last_checkin_date';
  const MAX_ATTEMPTS = 3;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // 与网站保持一致：以 Asia/Shanghai 时区的日期作为“今天”
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

  // 从 cookie 中读取 Supabase session，返回 access_token
  function tokenFromCookies() {
    const cookies = document.cookie
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
    if (!cookies.length) return null;

    const chunked = cookies.filter((c) => c.name.includes('.'));
    const list = chunked.length
      ? chunked.sort((a, b) => {
          const na = parseInt(a.name.slice(COOKIE_PREFIX.length + 1), 10);
          const nb = parseInt(b.name.slice(COOKIE_PREFIX.length + 1), 10);
          return na - nb;
        })
      : cookies;

    let raw = list.map((c) => c.value).join('');
    if (raw.startsWith('base64-')) raw = raw.slice('base64-'.length);
    try {
      const session = JSON.parse(base64UrlDecode(raw));
      return typeof session.access_token === 'string' ? session.access_token : null;
    } catch (e) {
      console.warn('[Anikura Auto Check-in] 解析登录态失败', e);
      return null;
    }
  }

  // 登录态优先读 cookie；读不到时再试 localStorage（部分情况下站点可能把 session 存在这里）
  function readAccessToken() {
    const fromCookie = tokenFromCookies();
    if (fromCookie) return fromCookie;
    try {
      const lsKeys = Object.keys(localStorage).filter(
        (k) => k.startsWith('sb-') && k.includes('auth-token') && !k.includes('code-verifier')
      );
      for (const k of lsKeys) {
        const session = JSON.parse(
          base64UrlDecode(String(localStorage.getItem(k)).replace(/^base64-/, ''))
        );
        if (session && typeof session.access_token === 'string') return session.access_token;
      }
    } catch (e) {
      console.warn('[Anikura Auto Check-in] 读取 localStorage 登录态失败', e);
    }
    return null;
  }

  // 等待页面自身的 supabase 客户端完成初始化/刷新 token
  async function waitForToken(timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const token = readAccessToken();
      if (token) return token;
      await sleep(500);
    }
    return readAccessToken();
  }

  // 与网站“立即签到”按钮调用的是同一个 RPC：perform_checkin
  async function callCheckIn(accessToken) {
    const res = await fetch(SUPABASE_URL + '/rest/v1/rpc/perform_checkin', {
      method: 'POST',
      headers: {
        apikey: ANON_KEY,
        Authorization: 'Bearer ' + accessToken,
        'Content-Type': 'application/json',
        'X-Client-Info': 'anikura-auto-checkin/1.3.0',
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

  // 页面右下角小提示
  let toastEl = null;
  function showToast(text, type = 'info') {
    if (!toastEl) {
      toastEl = document.createElement('div');
      Object.assign(toastEl.style, {
        position: 'fixed',
        right: '16px',
        bottom: '16px',
        zIndex: '2147483647',
        maxWidth: '340px',
        padding: '12px 16px',
        borderRadius: '10px',
        fontFamily: 'system-ui, sans-serif',
        fontSize: '13px',
        lineHeight: 1.5,
        color: '#fff',
        boxShadow: '0 6px 24px rgba(0,0,0,.35)',
        transition: 'opacity .3s',
        pointerEvents: 'none',
      });
      document.body.appendChild(toastEl);
    }
    const bg = { success: '#10b981', info: '#6d28d9', warn: '#d97706', error: '#dc2626' }[type] || '#333';
    toastEl.style.background = bg;
    toastEl.textContent = text;
    toastEl.style.opacity = '1';
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => { toastEl.style.opacity = '0'; }, 6000);
  }

  // 兜底：如果直接调接口失败且当前就在签到页，就点一下网站自己的按钮
  function tryClickCheckInButton() {
    if (location.pathname !== '/checkin') return false;
    const btn = Array.from(document.querySelectorAll('button')).find((b) =>
      /立即签到|签到/.test(b.textContent || '')
    );
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  }

  // 兜底 2：读不到登录态时，直接在签到页点“立即签到”（登录态由网站自己管理）
  async function tryPageButtonCheckIn() {
    if (location.pathname !== '/checkin' || !document.body) return false;
    if (/今日已签到/.test(document.body.innerText)) {
      showToast('今天已经签到过啦', 'info');
      return true;
    }
    const btn = Array.from(document.querySelectorAll('button')).find((b) =>
      /立即签到/.test(b.textContent || '')
    );
    if (!btn) return false;
    btn.click();
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      await sleep(600);
      if (/今日已签到/.test(document.body.innerText)) {
        showToast('签到成功（通过页面按钮完成）', 'success');
        return true;
      }
    }
    showToast('已点击签到，但未检测到结果，请查看页面状态', 'warn');
    return true;
  }

  let running = false;
  async function runCheckIn(force = false) {
    if (running) return;
    running = true;
    try {
      const today = shanghaiToday();
      if (!force && GM_getValue(STORAGE_KEY, '') === today) return;

      let token = await waitForToken();
      if (!token) {
        if (await tryPageButtonCheckIn()) return;
        showToast('未检测到登录状态：请先登录 anikura.cn。若已登录仍提示，登录 cookie 可能被设为 HttpOnly，建议改用 Chrome 插件版', 'warn');
        return;
      }

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          const data = await callCheckIn(token);
          GM_setValue(STORAGE_KEY, today);
          const streak = data && data.streak != null ? data.streak : 0;
          const points = data && data.points != null ? data.points : 0;
          if (data && data.already) {
            showToast('今天已经签到过啦 · 连续签到 ' + streak + ' 天', 'info');
          } else {
            showToast('签到成功 +' + points + ' 积分 · 连续签到 ' + streak + ' 天', 'success');
            if (typeof GM_notification === 'function') {
              GM_notification({
                title: 'Anikura CN 签到成功',
                text: '获得 ' + points + ' 积分，连续签到 ' + streak + ' 天',
              });
            }
          }
          return;
        } catch (err) {
          const retriable = err.status === 401 || err.status === 403;
          if (retriable && attempt < MAX_ATTEMPTS) {
            // token 可能刚过期，页面自身会自动刷新，等一会儿再读一次
            await sleep(2000 * attempt);
            token = readAccessToken();
            if (!token) {
              showToast('自动签到失败：无法获取有效登录态，请重新登录 anikura.cn', 'error');
              return;
            }
            continue;
          }
          if (!tryClickCheckInButton()) {
            showToast('自动签到失败：' + (err.message || '未知错误') + '（可打开 /checkin 页手动签到）', 'error');
          }
          return;
        }
      }
    } finally {
      running = false;
    }
  }

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('立即签到（手动触发）', () => runCheckIn(true));
  }

  // 页面加载后自动执行
  setTimeout(() => runCheckIn(false), 1500);
})();
