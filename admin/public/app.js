'use strict';

const $ = (selector) => document.querySelector(selector);
let token = '';
let channels = null;
let releases = [];

function message(value, error = false) {
  const box = $('#message');
  box.textContent = value;
  box.classList.toggle('error', error);
}
function size(bytes) { return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`; }
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...options.headers, Authorization: `Bearer ${token}` } });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}
async function refresh() {
  const [channelData, releaseData] = await Promise.all([api('/api/v2/channels'), api('/api/v2/releases')]);
  channels = channelData;
  releases = releaseData.releases;
  for (const name of ['preview', 'stable']) {
    const pointer = channels[name];
    $(`#${name}-current`).textContent = pointer.releaseId
      ? `${pointer.releaseId} · revision ${pointer.revision} · ${new Date(pointer.publishedAt).toLocaleString()}`
      : '尚未发布';
    $(`#${name}-restore`).disabled = !pointer.previousReleaseId;
  }
  const table = $('#releases');
  table.replaceChildren();
  if (!releases.length) {
    const row = table.insertRow();
    row.insertCell().textContent = '尚无已校验的完整安装包';
    row.cells[0].colSpan = 5;
    return;
  }
  for (const release of releases) {
    const row = table.insertRow();
    const version = row.insertCell();
    version.textContent = release.version;
    const link = document.createElement('a');
    link.href = `/update/winclaw2/releases/${encodeURIComponent(release.releaseId)}/${encodeURIComponent(release.file)}`;
    link.textContent = '下载安装包';
    version.append(document.createElement('br'), link);
    const hash = row.insertCell();
    hash.textContent = `${size(release.size)} / ${release.sha512.slice(0, 16)}…`;
    hash.className = 'mono';
    row.insertCell().textContent = `${release.buildCommit.slice(0, 10)} · ${new Date(release.builtAt).toLocaleDateString()}`;
    row.insertCell().textContent = release.channels.length ? release.channels.join('、') : '可发布';
    const actions = row.insertCell();
    actions.className = 'actions';
    for (const name of ['preview', 'stable']) {
      const button = document.createElement('button');
      button.textContent = name === 'preview' ? '发布预览' : '发布正式';
      button.disabled = release.channels.includes(name);
      button.addEventListener('click', () => publish(name, release.releaseId));
      actions.append(button);
    }
    const remove = document.createElement('button');
    remove.className = 'danger';
    remove.textContent = '删除';
    remove.disabled = release.channels.length > 0;
    remove.addEventListener('click', () => deleteRelease(release.releaseId));
    actions.append(remove);
  }
}
async function publish(channel, releaseId) {
  const old = channels[channel];
  if (!confirm(`将 ${channel} 从 ${old.releaseId || '未发布'} 切换为 ${releaseId}？`)) return;
  try {
    await api(`/api/v2/channels/${channel}/publish`, {
      method: 'POST', body: JSON.stringify({ releaseId, expectedRevision: old.revision }),
      headers: { 'Content-Type': 'application/json' },
    });
    message(`已发布 ${releaseId} 到 ${channel}`);
    await refresh();
  } catch (error) { message(error.message, true); await refresh(); }
}
async function restore(channel) {
  const old = channels[channel];
  if (!old.previousReleaseId || !confirm(`撤回 ${channel} 至 ${old.previousReleaseId}？已安装新版本的用户不会自动降级。`)) return;
  try {
    await api(`/api/v2/channels/${channel}/restore`, {
      method: 'POST', body: JSON.stringify({ expectedRevision: old.revision }),
      headers: { 'Content-Type': 'application/json' },
    });
    message(`${channel} 已撤回到 ${old.previousReleaseId}`);
    await refresh();
  } catch (error) { message(error.message, true); await refresh(); }
}
async function deleteRelease(id) {
  if (!confirm(`永久删除 ${id} 的完整安装包？`)) return;
  try {
    await api(`/api/v2/releases/${encodeURIComponent(id)}`, { method: 'DELETE' });
    message(`已删除 ${id}`);
    await refresh();
  } catch (error) { message(error.message, true); }
}
function uploadBinary(id, file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/v2/uploads/${id}/installer`);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        $('#upload-progress').value = Math.round(100 * event.loaded / event.total);
        $('#upload-status').textContent = `${size(event.loaded)} / ${size(event.total)}`;
      }
    };
    xhr.onload = () => {
      let result = {};
      try { result = JSON.parse(xhr.responseText); } catch { /* handled below */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(result);
      else reject(new Error(result.error || `HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('上传连接中断'));
    xhr.send(file);
  });
}
async function upload() {
  const releaseFile = $('#release-file').files[0];
  const installer = $('#installer-file').files[0];
  if (!releaseFile || !installer) return message('请选择 release.json 和完整 EXE', true);
  if (releaseFile.name !== 'release.json' || !/^WinClaw-2\.\d+\.\d+-win-x64\.exe$/.test(installer.name))
    return message('文件名不符合完整安装包规范', true);
  const button = $('#upload');
  button.disabled = true;
  $('#upload-progress').hidden = false;
  try {
    const meta = JSON.parse(await releaseFile.text());
    if (meta.file !== installer.name || meta.size !== installer.size) throw new Error('文件名或大小与 release.json 不一致');
    const session = await api('/api/v2/uploads', { method: 'POST', body: JSON.stringify(meta), headers: { 'Content-Type': 'application/json' } });
    await uploadBinary(session.uploadId, installer);
    const complete = await api(`/api/v2/uploads/${session.uploadId}/complete`, { method: 'POST' });
    message(`${complete.releaseId} 已校验，可以选择通道发布`);
    await refresh();
  } catch (error) { message(error.message, true); }
  finally { button.disabled = false; $('#upload-progress').hidden = true; }
}
$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  token = $('#token').value.trim();
  try {
    await refresh();
    $('#login-panel').hidden = true;
    $('#workspace').hidden = false;
    $('#logout').hidden = false;
    $('#token').value = '';
    message('管理数据已加载');
  } catch (error) { token = ''; message(error.message, true); }
});
$('#logout').addEventListener('click', () => {
  token = ''; channels = null; releases = [];
  $('#login-panel').hidden = false; $('#workspace').hidden = true; $('#logout').hidden = true;
  message('已退出');
});
$('#refresh').addEventListener('click', () => refresh().catch((error) => message(error.message, true)));
$('#upload').addEventListener('click', upload);
for (const channel of ['stable', 'preview']) $('#'+channel+'-restore').addEventListener('click', () => restore(channel));
