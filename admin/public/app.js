'use strict';

const $ = (sel) => document.querySelector(sel);

// 鉴权钩子（默认关）：若服务端设置了 WINCLAW_ADMIN_TOKEN，
// 先在控制台执行 localStorage.setItem('admin_token','<token>') 再刷新页面。
const token = (localStorage.getItem('admin_token') || '').trim();

let releases = [];

function fmtSize(n) {
  if (!n) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString('zh-CN', { hour12: false });
}

function shortSha(sha) {
  return sha ? sha.slice(0, 12) : '—';
}

function toast(msg, isError) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('error', !!isError);
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 3200);
}

async function api(url, opts) {
  const headers = Object.assign({}, opts && opts.headers);
  if (opts && opts.body && !(opts.body instanceof FormData)) {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  }
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(url, Object.assign({}, opts, { headers }));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

async function refresh() {
  try {
    const data = await api('/api/config');
    $('#base-url').textContent = '发布前缀：' + data.baseUrl;
    if (data.active) {
      const badge = $('#active-badge');
      badge.classList.remove('hidden');
      $('#active-version').textContent = data.active.version;
      if (data.orphan) toast('警告：当前发布版本的安装包在卷中缺失', true);
    } else {
      $('#active-badge').classList.add('hidden');
    }
    const list = await api('/api/releases');
    releases = list.releases || [];
    render();
  } catch (e) {
    $('#list-error').textContent = '加载失败：' + e.message;
    $('#list-error').classList.remove('hidden');
  }
}

function render() {
  const tbody = $('#release-rows');
  $('#list-count').textContent = `（${releases.length} 个版本）`;
  if (!releases.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="hint">卷内暂无发布包，请先上传</td></tr>';
    return;
  }
  tbody.innerHTML = '';
  for (const r of releases) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <span class="ver">v${r.version}</span>
        ${r.active ? '<span class="badge active">已发布</span>' : '<span class="badge">未发布</span>'}
      </td>
      <td class="num">${fmtSize(r.exeSize)}</td>
      <td class="mono">${shortSha(r.sha256)}</td>
      <td>${fmtTime(r.uploadedAt)}</td>
      <td class="notes-cell" title="${escapeAttr(r.notes || '')}">${escapeHtml(r.notes || '（无说明）')}</td>
      <td class="ops">
        ${r.active
          ? '<span class="hint">当前发布版本</span>'
          : `<button class="btn-sm primary" data-act="publish" data-ver="${r.version}">设为发布</button>`}
        <button class="btn-sm" data-act="notes" data-ver="${r.version}">编辑说明</button>
        <button class="btn-sm danger${r.active ? ' disabled' : ''}" data-act="del" data-ver="${r.version}" ${r.active ? 'disabled' : ''}>删除</button>
      </td>`;
    tbody.appendChild(tr);
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) {
  return s.replace(/"/g, '&quot;').replace(/\n/g, ' ');
}

// ---------- 上传 ----------

function uploadFile(file) {
  const zone = $('#drop-zone');
  const bar = $('#upload-progress');
  const fill = $('#progress-fill');
  const txt = $('#progress-text');
  const err = $('#upload-error');

  console.log(file.name);
  if (!/\.(zip|exe)$/i.test(file.name)) {
    err.textContent = '仅支持 .zip 或 .exe 文件';
    err.classList.remove('hidden');
    return;
  }
  if (file.name.length > 120) {
    err.textContent = '文件名过长';
    err.classList.remove('hidden');
    return;
  }

  zone.classList.add('hidden');
  err.classList.add('hidden');
  bar.classList.remove('hidden');
  fill.style.width = '0%';

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/upload?filename=' + encodeURIComponent(file.name));
  if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
  xhr.responseType = 'json';
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      const pct = Math.round((e.loaded / e.total) * 100);
      fill.style.width = pct + '%';
      txt.textContent = `上传中 ${pct}%（${fmtSize(e.loaded)} / ${fmtSize(e.total)}）`;
    }
  };
  xhr.onload = () => {
    bar.classList.add('hidden');
    zone.classList.remove('hidden');
    if (xhr.status >= 200 && xhr.status < 300) {
      toast(`已上传 v${xhr.response.version}，点击「设为发布」使其生效`);
      refresh();
    } else {
      err.textContent = '上传失败：' + ((xhr.response && xhr.response.error) || ('HTTP ' + xhr.status));
      err.classList.remove('hidden');
    }
  };
  xhr.onerror = () => {
    bar.classList.add('hidden');
    zone.classList.remove('hidden');
    err.textContent = '上传失败：网络错误';
    err.classList.remove('hidden');
  };
  xhr.send(file);
}

// ---------- 操作 ----------

let confirmCb = null;

function openModal(id) {
  const m = $('#' + id);
  m.classList.remove('hidden');
}
function closeModals() {
  $('#modal-notes').classList.add('hidden');
  $('#modal-confirm').classList.add('hidden');
}

function askConfirm(title, text, dangerous, cb) {
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  const ok = $('#confirm-ok');
  ok.classList.toggle('danger', !!dangerous);
  confirmCb = cb;
  openModal('modal-confirm');
}

async function doPublish(version) {
  try {
    const data = await api(`/api/releases/${encodeURIComponent(version)}/publish`, { method: 'POST' });
    toast(`已发布 v${version}，客户端将开始在 24h 检查周期内拉取`);
    refresh();
  } catch (e) {
    toast(e.message, true);
  }
}

async function doDelete(version) {
  try {
    await api(`/api/releases/${encodeURIComponent(version)}`, { method: 'DELETE' });
    toast(`已删除 v${version}`);
    refresh();
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------- 事件绑定 ----------

$('#btn-refresh').addEventListener('click', refresh);

$('#file-input').addEventListener('change', (e) => {
  if (e.target.files[0]) uploadFile(e.target.files[0]);
  e.target.value = '';
});

const zone = $('#drop-zone');
['dragenter', 'dragover'].forEach((ev) =>
  zone.addEventListener(ev, (e) => {
    e.preventDefault();
    zone.classList.add('dragover');
  })
);
['dragleave', 'drop'].forEach((ev) =>
  zone.addEventListener(ev, (e) => {
    e.preventDefault();
    zone.classList.remove('dragover');
  })
);
zone.addEventListener('drop', (e) => {
  const f = e.dataTransfer.files[0];
  if (f) uploadFile(f);
});

$('#release-rows').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const ver = btn.getAttribute('data-ver');
  const act = btn.getAttribute('data-act');
  if (act === 'publish') {
    askConfirm('发布版本', `确定将 v${ver} 设为当前发布版本？客户端将自动拉取它覆盖旧版。`, false, () => {
      closeModals();
      doPublish(ver);
    });
  } else if (act === 'notes') {
    openNotes(ver);
  } else if (act === 'del') {
    askConfirm('删除版本', `确定删除 v${ver} 的安装包？该操作不可恢复。`, true, () => {
      closeModals();
      doDelete(ver);
    });
  }
});

function openNotes(ver) {
  const r = releases.find((x) => x.version === ver);
  if (!r) return;
  $('#notes-version').textContent = 'v' + ver;
  $('#notes-text').value = r.notes || '';
  $('#notes-mandatory').checked = !!r.mandatory;
  openModal('modal-notes');
}

$('#notes-save').addEventListener('click', async () => {
  const ver = $('#notes-version').textContent.replace('v', '');
  try {
    await api(`/api/releases/${encodeURIComponent(ver)}/notes`, {
      method: 'POST',
      body: JSON.stringify({ notes: $('#notes-text').value, mandatory: $('#notes-mandatory').checked }),
    });
    closeModals();
    toast('说明已保存');
    refresh();
  } catch (e) {
    toast(e.message, true);
  }
});

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) closeModals();
  if (e.target.classList.contains('modal')) closeModals();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModals();
});

$('#confirm-ok').addEventListener('click', () => {
  const cb = confirmCb;
  confirmCb = null;
  if (cb) cb();
});

refresh();