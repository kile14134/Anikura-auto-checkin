const statusEl = document.getElementById('status');
const lastEl = document.getElementById('last');
const notifyToggle = document.getElementById('notify-toggle');

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
