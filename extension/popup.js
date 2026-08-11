const statusEl = document.getElementById('status');
const lastEl = document.getElementById('last');
const notifyToggle = document.getElementById('notify-toggle');
const diagBtn = document.getElementById('diag');
const diagOut = document.getElementById('diag-out');

chrome.runtime.sendMessage({ type: 'get-settings' }, (resp) => {
  if (resp && resp.ok && resp.settings) {
    notifyToggle.checked = resp.settings.notifyEnabled !== false;
  }
});

notifyToggle.addEventListener('change', () => {
  chrome.runtime.sendMessage({
    type: 'set-settings',
    notifyEnabled: notifyToggle.checked,
  });
});

diagBtn.addEventListener('click', () => {
  diagBtn.disabled = true;
  diagOut.style.display = 'block';
  diagOut.textContent = '诊断中…（请确保已登录并打开 anikura.cn 页面）';
  chrome.runtime.sendMessage({ type: 'run-diag' }, (resp) => {
    diagBtn.disabled = false;
    if (!resp || !resp.ok) {
      diagOut.textContent = '诊断失败：' + ((resp && resp.error) || '未知原因');
      return;
    }
    const d = resp.diag || {};
    const lines = [];
    lines.push('后台 chrome.cookies 找到 ' + (d.cookieNames || []).length + ' 个 sb-* 登录 cookie：');
    lines.push((d.cookieNames || []).join('、') || '（无）');
    lines.push('页面上下文 localStorage 键：' + ((d.lsKeys || []).join('、') || '（无）'));
    lines.push('页面 document.cookie 中的登录 cookie：' + ((d.pageCookies || []).join('、') || '（无）'));
    if (d.parseError) lines.push('cookie 解析错误：' + d.parseError);
    if (d.contentScriptError) lines.push('页面读取错误：' + d.contentScriptError);
    lines.push(resp.hasSession ? '✅ 已找到可用登录态' : '❌ 未找到可用登录态');
    diagOut.textContent = lines.join('\n');
  });
});

function render(result) {
  const s = result.status;
  if (!s) {
    statusEl.textContent = '暂无记录';
    statusEl.className = '';
    lastEl.textContent = '';
    return;
  }
  lastEl.textContent = '上次执行：' + (s.today || '-') + '（' + new Date(s.updatedAt || Date.now()).toLocaleTimeString('zh-CN') + '）';
  if (s.ok) {
    if (s.already) {
      statusEl.textContent = '今天已签到 · 连续 ' + (s.streak ?? '-') + ' 天';
    } else {
      statusEl.textContent = '签到成功 +' + s.points + ' 积分 · 连续 ' + (s.streak ?? '-') + ' 天';
    }
    statusEl.className = 'ok';
  } else if (s.reason === 'not_logged_in') {
    statusEl.textContent = '未检测到登录状态：请先在 anikura.cn 登录一次';
    statusEl.className = 'warn';
  } else {
    statusEl.textContent = '签到失败：' + (s.error || s.reason || '未知原因');
    statusEl.className = 'err';
  }
}

chrome.runtime.sendMessage({ type: 'get-status' }, (resp) => {
  if (resp && resp.ok) render(resp);
  else statusEl.textContent = '读取状态失败';
});

document.getElementById('checkin').addEventListener('click', () => {
  statusEl.textContent = '签到中…';
  statusEl.className = '';
  chrome.runtime.sendMessage({ type: 'checkin-now' }, (resp) => {
    if (resp && resp.ok && resp.result) {
      const r = resp.result;
      if (r.ok && r.already) {
        statusEl.textContent = '今天已签到 · 连续 ' + (r.streak ?? '-') + ' 天';
        statusEl.className = 'ok';
      } else if (r.ok) {
        statusEl.textContent = '签到成功 +' + r.points + ' 积分 · 连续 ' + (r.streak ?? '-') + ' 天';
        statusEl.className = 'ok';
      } else if (r.reason === 'not_logged_in') {
        statusEl.textContent = '未检测到登录状态：请先在 anikura.cn 登录一次';
        statusEl.className = 'warn';
      } else {
        statusEl.textContent = '签到失败：' + (r.error || r.reason || '未知原因');
        statusEl.className = 'err';
      }
    } else {
      statusEl.textContent = '签到请求失败：' + ((resp && resp.error) || '未知原因');
      statusEl.className = 'err';
    }
  });
});

document.getElementById('open').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://www.anikura.cn/checkin' });
});
