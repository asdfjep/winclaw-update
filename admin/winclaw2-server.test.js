'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function startService(t, preparedRoot = null) {
  const root = preparedRoot ?? await fs.mkdtemp(path.join(os.tmpdir(), 'winclaw2-update-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, WINCLAW_UPDATE_DIR: root, WINCLAW_ADMIN_PORT: String(port),
    WINCLAW_UPDATE_BASE_URL: `${base}/update` };
  delete env.WINCLAW_ADMIN_TOKEN;
  const child = spawn(process.execPath, [path.join(__dirname, 'winclaw2-server.js')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostics = '';
  child.stderr.on('data', (part) => { diagnostics += part.toString(); });
  child.stdout.on('data', (part) => { diagnostics += part.toString(); });
  t.after(async () => { child.kill(); await fs.rm(root, { recursive: true, force: true }); });
  for (let attempt = 0; attempt < 50; attempt++) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}`);
    try { if ((await fetch(`${base}/healthz`)).ok) return { root, base }; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`server did not become ready: ${diagnostics}`);
}
async function api(base, route, method = 'GET', body) {
  const response = await fetch(base + route, { method, headers: {
    ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}),
    ...(Buffer.isBuffer(body) ? { 'Content-Type': 'application/octet-stream' } : {}) },
  body: body == null ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
function metadata(version, bytes, prefix = 'HoardSunAI') {
  return { schemaVersion: 1, product: 'winclaw2', appId: 'cn.hoardsun.winclaw2',
    version, platform: 'windows', arch: 'x64', packageType: 'nsis-full',
    file: `${prefix}-${version}-win-x64.exe`, size: bytes.length,
    sha512: crypto.createHash('sha512').update(bytes).digest('base64'),
    unpackedSize: 12345, buildCommit: 'a'.repeat(40), builtAt: '2026-10-14T00:00:00.000Z',
    releaseNotes: `Full update ${version}` };
}
async function upload(base, meta, bytes) {
  const created = await api(base, '/api/v2/uploads', 'POST', meta);
  assert.equal(created.status, 201);
  const id = created.body.uploadId;
  const sent = await api(base, `/api/v2/uploads/${id}/installer`, 'PUT', bytes);
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  return api(base, `/api/v2/uploads/${id}/complete`, 'POST');
}

test('full installer is verified before preview and stable publication', async (t) => {
  const { base, root } = await startService(t);
  const binary = Buffer.from('MZ complete installer fixture');
  const meta = metadata('2.1.1', binary);
  assert.equal((await api(base, '/api/v2/releases')).status, 200);
  assert.equal((await api(base, '/api/v2/channels')).status, 200);
  const page = await (await fetch(base)).text();
  assert.match(page, /HoardSunAI 更新管理/);
  assert.doesNotMatch(page, /login-form|管理 Token/);
  assert.equal((await api(base, '/api/v2/uploads', 'POST', { ...meta, packageType: 'delta' })).status, 400);
  assert.equal((await api(base, '/api/v2/uploads', 'POST', { ...meta, arch: 'arm64' })).status, 400);
  assert.equal((await api(base, '/api/v2/uploads', 'POST',
    { ...meta, file: 'HoardSunAI-2.1.2-win-x64.exe' })).status, 400);
  assert.equal((await api(base, '/api/v2/uploads', 'POST',
    { ...meta, file: '../HoardSunAI-2.1.1-win-x64.exe' })).status, 400);
  assert.equal((await upload(base, meta, binary)).status, 200);
  assert.equal((await upload(base, meta, binary)).body.reused, true);
  assert.equal((await upload(base, metadata('2.1.1', binary, 'WinClaw'), binary)).status, 409);
  const altered = Buffer.from('MZ another complete installer');
  assert.equal((await upload(base, metadata('2.1.1', altered), altered)).status, 409);
  let channels = (await api(base, '/api/v2/channels')).body;
  assert.equal(channels.preview.revision, 0);
  assert.equal((await api(base, '/api/v2/channels/preview/publish', 'POST',
    { releaseId: '2.1.1-windows-x64', expectedRevision: 0 })).status, 200);
  assert.equal((await api(base, '/api/v2/channels/preview/publish', 'POST',
    { releaseId: '2.1.1-windows-x64', expectedRevision: 0 })).status, 409);
  const feed = await fetch(`${base}/update/winclaw2/latest.yml?platform=windows-x86_64&channel=3`);
  const yaml = await feed.text();
  assert.equal(feed.status, 200);
  assert.match(yaml, /version: "2\.1\.1"/);
  assert.ok(yaml.includes(meta.sha512));
  assert.ok(yaml.includes(`${base}/update/winclaw2/releases/2.1.1-windows-x64/${meta.file}`));
  assert.equal((await fetch(`${base}/update/winclaw2/latest.yml?channel=2`)).status, 400);
  assert.equal((await fetch(`${base}/update/winclaw2/latest.yml?channel=1`)).status, 404);
  assert.equal((await api(base, '/api/v2/channels/stable/publish', 'POST',
    { releaseId: '2.1.1-windows-x64', expectedRevision: 0 })).status, 200);
  channels = (await api(base, '/api/v2/channels')).body;
  assert.equal(channels.stable.releaseId, channels.preview.releaseId);
  assert.equal((await api(base, '/api/v2/releases/2.1.1-windows-x64', 'DELETE')).status, 409);
  const publishedFile = path.join(root, 'public', 'winclaw2', 'releases', '2.1.1-windows-x64', meta.file);
  assert.equal(await fs.readFile(publishedFile, 'utf8'), binary.toString());
  // Linux Nginx worker 不能读取 0600；公开包必须在 ready 前可由其他用户读取。
  if (process.platform !== 'win32') assert.equal((await fs.stat(publishedFile)).mode & 0o777, 0o644);
});

test('partial upload never becomes ready and restore requires previous release', async (t) => {
  const { base } = await startService(t);
  const binary = Buffer.from('MZ complete fixture');
  const meta = metadata('2.1.2', binary);
  const created = await api(base, '/api/v2/uploads', 'POST', meta);
  const id = created.body.uploadId;
  assert.equal((await api(base, `/api/v2/uploads/${id}/installer`, 'PUT', Buffer.from('short'))).status, 400);
  assert.equal((await api(base, `/api/v2/uploads/${id}/complete`, 'POST')).status, 409);
  assert.equal((await api(base, '/api/v2/releases')).body.releases.length, 0);
  assert.equal((await api(base, '/api/v2/channels/stable/restore', 'POST', { expectedRevision: 0 })).status, 409);
});

test('channel restore does not downgrade an installer and protects recent assets', async (t) => {
  const { base } = await startService(t);
  for (const [version, prefix] of [['2.1.1', 'WinClaw'], ['2.1.2', 'HoardSunAI']]) {
    const bytes = Buffer.from(`MZ ${version} complete installer`);
    assert.equal((await upload(base, metadata(version, bytes, prefix), bytes)).status, 200);
  }
  assert.equal((await api(base, '/api/v2/channels/preview/publish', 'POST',
    { releaseId: '2.1.1-windows-x64', expectedRevision: 0 })).status, 200);
  assert.equal((await api(base, '/api/v2/channels/preview/publish', 'POST',
    { releaseId: '2.1.2-windows-x64', expectedRevision: 1 })).status, 200);
  const reverted = await api(base, '/api/v2/channels/preview/restore', 'POST', { expectedRevision: 2 });
  assert.equal(reverted.body.revision, 3);
  assert.equal(reverted.body.releaseId, '2.1.1-windows-x64');
  assert.equal((await api(base, '/api/v2/releases/2.1.2-windows-x64', 'DELETE')).status, 409);
  const feed = await fetch(`${base}/update/winclaw2/latest.yml?channel=3`);
  const yaml = await feed.text();
  assert.match(yaml, /version: "2\.1\.1"/);
  assert.ok(yaml.includes(`${base}/update/winclaw2/releases/2.1.1-windows-x64/WinClaw-2.1.1-win-x64.exe`));
  assert.equal((await fetch(`${base}/update/winclaw2/latest.yml?channel=3&platform=darwin-arm64`)).status, 400);
});

test('startup preserves a historical WinClaw release and its manifest URL', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'winclaw2-update-legacy-'));
  const bytes = Buffer.from('MZ historical ready installer');
  const meta = metadata('2.1.3', bytes, 'WinClaw');
  const publicDir = path.join(root, 'public', 'winclaw2', 'releases', '2.1.3-windows-x64');
  const privateDir = path.join(root, 'private');
  await fs.mkdir(publicDir, { recursive: true });
  await fs.mkdir(path.join(privateDir, 'releases'), { recursive: true });
  await fs.mkdir(path.join(privateDir, 'channels'), { recursive: true });
  await fs.writeFile(path.join(publicDir, meta.file), bytes);
  await fs.writeFile(path.join(privateDir, 'releases', '2.1.3-windows-x64.json'), JSON.stringify(meta));
  await fs.writeFile(path.join(privateDir, 'channels', 'stable.json'), JSON.stringify({
    revision: 1, releaseId: '2.1.3-windows-x64', previousReleaseId: null,
    publishedAt: '2026-10-14T00:00:00.000Z',
  }));
  const { base } = await startService(t, root);
  const feed = await fetch(`${base}/update/winclaw2/latest.yml?channel=1`);
  assert.equal(feed.status, 200);
  assert.ok((await feed.text()).includes(`${base}/update/winclaw2/releases/2.1.3-windows-x64/${meta.file}`));
});

test('startup repairs read permission on an existing ready installer', { skip: process.platform === 'win32' }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'winclaw2-update-ready-'));
  const bytes = Buffer.from('MZ existing ready installer');
  const meta = metadata('2.1.3', bytes);
  const publicDir = path.join(root, 'public', 'winclaw2', 'releases', '2.1.3-windows-x64');
  const releaseDir = path.join(root, 'private', 'releases');
  await fs.mkdir(publicDir, { recursive: true });
  await fs.mkdir(releaseDir, { recursive: true });
  const installer = path.join(publicDir, meta.file);
  await fs.writeFile(installer, bytes, { mode: 0o600 });
  await fs.writeFile(path.join(releaseDir, '2.1.3-windows-x64.json'), JSON.stringify(meta));
  await startService(t, root);
  assert.equal((await fs.stat(installer)).mode & 0o777, 0o644);
});
