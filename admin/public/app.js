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
    if (data.runtimeMissing) {
      const warn = $('#runtime-warning');
      if (warn) warn.classList.remove('hidden');
    } else {
      const warn = $('#runtime-warning');
      if (warn) warn.classList.add('hidden');
    }
    renderRuntimes(data.runtimes || []);
    const list = await api('/api/releases');
    releases = list.releases || [];
    render();
  } catch (e) {
    $('#list-error').textContent = '加载失败：' + e.message;
    $('#list-error').classList.remove('hidden');
  }
}

function runtimeHint(r) {
  const list = r.runtimes || [];
  if (!list.length) return '<div class="hint">沿用平台环境包</div>';
  return `<div class="hint">${list.map((x) => escapeHtml((x.id || '') + ' ' + (x.stamp || ''))).join('、')}</div>`;
}

function renderRuntimes(items) {
  const tbody = $('#runtime-rows');
  const count = $('#runtime-count');
  if (!tbody) return;
  if (count) count.textContent = `（${items.length} 个）`;
  if (!items.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="hint">暂无环境包。把 runtime-python-*.zip 拖到上方即可单独上传</td></tr>';
    return;
  }
  tbody.innerHTML = items.map((r) => `
    <tr>
      <td class="mono">${escapeHtml(r.file || r.id || '')}</td>
      <td>${escapeHtml(r.stamp || '')}</td>
      <td class="num">${fmtSize(r.size)}</td>
      <td class="mono">${shortSha(r.sha256)}</td>
    </tr>`).join('');
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
    const file = r.filename || `Hs-WinClaw-Setup-${r.version}.exe`;
    // 直接下载走同源 /update/* 静态分发（nginx alias / 管理端静态路由皆可），
    // 用相对路径以免把 BASE_URL 里写死的 IP 带进浏览器。
    const href = '/update/' + encodeURIComponent(file);
    tr.innerHTML = `
      <td>
        <span class="ver">v${r.version}</span>
        ${r.active ? '<span class="badge active">已发布</span>' : '<span class="badge">未发布</span>'}
        <a class="dl" href="${href}" download="${escapeAttr(file)}" title="下载 ${escapeAttr(file)}（${fmtSize(r.exeSize)}）">下载安装包</a>
        ${runtimeHint(r)}
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

function isRuntimeFileName(name) {
  return /^runtime-[a-zA-Z0-9]+-.+\.zip$/i.test(name || '');
}

function bindDropZone(zone, onFile) {
  if (!zone) return;
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
    if (f) onFile(f);
  });
}

function uploadFile(file, asRuntime) {
  const runtime = !!asRuntime || isRuntimeFileName(file.name);
  const zone = $(runtime ? '#runtime-drop-zone' : '#drop-zone');
  const bar = $(runtime ? '#runtime-upload-progress' : '#upload-progress');
  const fill = $(runtime ? '#runtime-progress-fill' : '#progress-fill');
  const txt = $(runtime ? '#runtime-progress-text' : '#progress-text');
  const err = $(runtime ? '#runtime-upload-error' : '#upload-error');
  const endpoint = runtime
    ? '/api/runtimes?filename=' + encodeURIComponent(file.name)
    : '/api/upload?filename=' + encodeURIComponent(file.name);

  if (runtime) {
    if (!/\.zip$/i.test(file.name)) {
      err.textContent = '环境包仅支持 .zip';
      err.classList.remove('hidden');
      return;
    }
  } else if (!/\.(zip|exe)$/i.test(file.name)) {
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
  xhr.open('POST', endpoint);
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
      const data = xhr.response || {};
      if (data.kind === 'runtime' || runtime) {
        const names = (data.uploaded || data.runtimes || []).map((x) => x.file || x.id).filter(Boolean);
        toast(
          '已上传环境包' + (names.length ? ' ' + names.join('、') : '') +
          (data.published ? '，已写入当前发布清单' : '。还没有发布版本，请先上传并发布一个安装包')
        );
      } else {
        const n = data.split || (data.runtimes || []).length;
        toast(`已上传 v${data.version}` + (n ? `，已分流 ${n} 个环境包` : '（未带新环境包，发布时沿用平台已有环境包）') + '。点击「设为发布」使其生效');
      }
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

const runtimeInput = $('#runtime-file-input');
if (runtimeInput) {
  runtimeInput.addEventListener('change', (e) => {
    if (e.target.files[0]) uploadFile(e.target.files[0], true);
    e.target.value = '';
  });
}

bindDropZone($('#drop-zone'), (f) => uploadFile(f));
bindDropZone($('#runtime-drop-zone'), (f) => uploadFile(f, true));

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