#!/usr/bin/env node
'use strict';

// Single-writer WinClaw2 release service. Public installers are served by nginx.
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');

const ROOT = process.env.WINCLAW_UPDATE_DIR || '/data/winclaw-update';
const PUBLIC = path.join(ROOT, 'public', 'winclaw2', 'releases');
const PRIVATE = path.join(ROOT, 'private');
const UPLOADS = path.join(PRIVATE, 'uploads');
const RELEASES = path.join(PRIVATE, 'releases');
const CHANNELS = path.join(PRIVATE, 'channels');
const RETENTION = path.join(PRIVATE, 'retention.json');
const AUDIT = path.join(PRIVATE, 'audit.jsonl');
const WEB = path.join(__dirname, 'public');
const BASE_URL = (process.env.WINCLAW_UPDATE_BASE_URL || 'http://10.233.129.67:8091/update').replace(/\/+$/, '');
const PORT = Number(process.env.WINCLAW_ADMIN_PORT || 8091);
const MAX_UPLOAD = 2 * 1024 * 1024 * 1024;
const MAX_JSON = 64 * 1024;
const SESSION_TTL = 24 * 60 * 60 * 1000;
const RETAIN_MS = 30 * 24 * 60 * 60 * 1000;
const SHA512_RE = /^[A-Za-z0-9+/]{86}==$/;
const VERSION_RE = /^2\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const sessions = new Map();
let writeTail = Promise.resolve();

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (status, message) => { throw new HttpError(status, message); };
const exists = async (file) => { try { await fsp.access(file); return true; } catch { return false; } };
const releaseId = (version) => `${version}-windows-x64`;
const releaseMetaPath = (id) => path.join(RELEASES, `${id}.json`);
const channelPath = (channel) => path.join(CHANNELS, `${channel}.json`);
const packagePath = (meta) => path.join(PUBLIC, releaseId(meta.version), meta.file);

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}
function text(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}
async function readJsonFile(file, fallback = null) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
async function syncDir(dir) {
  try { const fd = await fsp.open(dir, 'r'); try { await fd.sync(); } finally { await fd.close(); } }
  catch (error) { if (!['EINVAL', 'EISDIR', 'EPERM'].includes(error.code)) throw error; }
}
async function atomicJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const fd = await fsp.open(temp, 'wx', 0o600);
    try { await fd.writeFile(JSON.stringify(value, null, 2) + '\n'); await fd.sync(); }
    finally { await fd.close(); }
    await fsp.rename(temp, file);
    await syncDir(path.dirname(file));
  } finally { await fsp.rm(temp, { force: true }); }
}
function withWriteLock(callback) {
  const next = writeTail.then(callback, callback);
  writeTail = next.catch(() => {});
  return next;
}
async function readBody(req) {
  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_JSON) bad(413, '元数据超过 64 KiB');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { bad(400, 'JSON 格式无效'); }
}
async function sha512File(file) {
  const hash = crypto.createHash('sha512');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('base64');
}
async function auditEvent(event) {
  try { await fsp.appendFile(AUDIT, JSON.stringify(event) + '\n'); }
  catch (error) { console.error('update audit write failed', error); }
}
function validateRelease(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad(400, 'release.json 必须是对象');
  const version = raw.version;
  if (raw.schemaVersion !== 1 || raw.product !== 'winclaw2' || raw.appId !== 'cn.hoardsun.winclaw2' ||
      typeof version !== 'string' || !VERSION_RE.test(version) || raw.platform !== 'windows' || raw.arch !== 'x64' ||
      raw.packageType !== 'nsis-full') bad(400, '产品、版本或平台不符合完整包契约');
  const validInstallerName = raw.file === `HoardSunAI-${version}-win-x64.exe` ||
    raw.file === `WinClaw-${version}-win-x64.exe`;
  if (!validInstallerName || !Number.isSafeInteger(raw.size) ||
      raw.size < 1 || raw.size > MAX_UPLOAD || !SHA512_RE.test(raw.sha512 || '') ||
      Buffer.from(raw.sha512, 'base64').toString('base64') !== raw.sha512) bad(400, '安装包名称、大小或 SHA512 无效');
  if (!Number.isSafeInteger(raw.unpackedSize) || raw.unpackedSize < 1 ||
      !/^[0-9a-f]{40}$/i.test(raw.buildCommit || '') ||
      typeof raw.builtAt !== 'string' || !Number.isFinite(Date.parse(raw.builtAt)) ||
      typeof raw.releaseNotes !== 'string' || raw.releaseNotes.length > 40000) bad(400, '构建元数据无效');
  return Object.freeze({ schemaVersion: 1, product: raw.product, appId: raw.appId, version,
    platform: 'windows', arch: 'x64', packageType: 'nsis-full', file: raw.file,
    size: raw.size, sha512: raw.sha512, unpackedSize: raw.unpackedSize,
    buildCommit: raw.buildCommit, builtAt: raw.builtAt, releaseNotes: raw.releaseNotes });
}
async function receiveInstaller(req, session) {
  if (session.state !== 'created') bad(409, '此会话已使用');
  if (req.headers['content-type']?.split(';')[0] !== 'application/octet-stream') bad(415, '必须上传完整二进制 EXE');
  const declared = Number(req.headers['content-length']);
  if (req.headers['content-length'] != null && declared !== session.meta.size) bad(400, 'Content-Length 与元数据不符');
  session.state = 'receiving';
  const output = fs.createWriteStream(session.file, { flags: 'wx', mode: 0o600 });
  const hash = crypto.createHash('sha512');
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > session.meta.size || size > MAX_UPLOAD) bad(413, '实际上传大小超过声明值');
      hash.update(chunk);
      if (!output.write(chunk)) await once(output, 'drain');
    }
    output.end();
    await once(output, 'finish');
    await once(output, 'close');
    if (size !== session.meta.size || hash.digest('base64') !== session.meta.sha512) bad(422, 'EXE 大小或 SHA512 校验失败');
    const fd = await fsp.open(session.file, 'r+');
    try {
      const header = Buffer.alloc(2);
      await fd.read(header, 0, 2, 0);
      if (header.toString() !== 'MZ') bad(422, '不是 Windows 完整安装器');
      await fd.sync();
    } finally { await fd.close(); }
    session.state = 'uploaded';
    return size;
  } catch (error) {
    output.destroy();
    session.state = 'failed';
    await fsp.rm(session.file, { force: true });
    throw error;
  }
}
async function commitUpload(session) {
  return withWriteLock(async () => {
    if (session.state === 'complete') return { releaseId: releaseId(session.meta.version), status: 'ready' };
    if (session.state !== 'uploaded') bad(409, '安装包尚未完整上传');
    const id = releaseId(session.meta.version);
    const existing = await readJsonFile(releaseMetaPath(id));
    if (existing) {
      if (existing.sha512 !== session.meta.sha512 || existing.size !== session.meta.size ||
          existing.file !== session.meta.file) bad(409, '此版本已有不同内容或文件名');
      await fsp.rm(session.file, { force: true });
      session.state = 'complete';
      return { releaseId: id, status: 'ready', reused: true };
    }
    const dir = path.join(PUBLIC, id);
    await fsp.mkdir(dir, { recursive: true });
    const finalFile = packagePath(session.meta);
    if (await exists(finalFile)) await fsp.rm(finalFile, { force: true }); // orphan from interrupted complete
    await fsp.rename(session.file, finalFile);
    // 发布前赋予 Nginx worker 读取权限；暂存文件仍保持 0600。
    await fsp.chmod(finalFile, 0o644);
    await syncDir(dir);
    await atomicJson(releaseMetaPath(id), session.meta); // ready marker is committed last
    session.state = 'complete';
    return { releaseId: id, status: 'ready' };
  });
}
async function getRelease(id) {
  if (!/^2\.(0|[1-9]\d*)\.(0|[1-9]\d*)-windows-x64$/.test(id)) bad(400, 'releaseId 无效');
  const meta = await readJsonFile(releaseMetaPath(id));
  if (!meta) bad(404, '版本不存在');
  return meta;
}
async function assertPackage(meta, verifyHash = false) {
  try {
    if ((await fsp.stat(packagePath(meta))).size === meta.size &&
        (!verifyHash || await sha512File(packagePath(meta)) === meta.sha512)) return;
  }
  catch { /* reported below */ }
  bad(503, '安装包缺失或大小错误');
}
async function getChannel(channel) {
  if (!['stable', 'preview'].includes(channel)) bad(400, '未知发布通道');
  return await readJsonFile(channelPath(channel), { revision: 0, releaseId: null, previousReleaseId: null, publishedAt: null });
}
async function retainLostReferences(before, after) {
  const lost = [before.releaseId, before.previousReleaseId].filter((id) => id && id !== after.releaseId && id !== after.previousReleaseId);
  if (!lost.length) return;
  const dates = await readJsonFile(RETENTION, {});
  const until = Date.now() + RETAIN_MS;
  for (const id of lost) dates[id] = Math.max(dates[id] || 0, until);
  await atomicJson(RETENTION, dates); // extra retention after a crash is harmless
}
async function changeChannel(channel, expectedRevision, nextId, operation) {
  return withWriteLock(async () => {
    const current = await getChannel(channel);
    if (current.revision !== expectedRevision) bad(409, `通道已变化，当前 revision=${current.revision}`);
    if (!nextId) bad(409, '没有可恢复的上一个版本');
    const nextRelease = await getRelease(nextId);
    await assertPackage(nextRelease, true);
    if (operation === 'publish' && current.releaseId && current.releaseId !== nextId) {
      const old = await getRelease(current.releaseId);
      const parts = (v) => v.split('.').map(Number);
      const a = parts(nextRelease.version), b = parts(old.version);
      if (a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]) ||
          (a[0] === b[0] && a[1] === b[1] && a[2] < b[2])) bad(409, '普通发布不能降低版本，请使用撤回');
    }
    if (current.releaseId === nextId) return current;
    const next = { revision: current.revision + 1, releaseId: nextId,
      previousReleaseId: current.releaseId, publishedAt: new Date().toISOString() };
    await retainLostReferences(current, next);
    await atomicJson(channelPath(channel), next);
    await auditEvent({ operation, channel, ...next });
    return next;
  });
}
async function deleteRelease(id) {
  return withWriteLock(async () => {
    const meta = await getRelease(id);
    for (const channel of ['stable', 'preview']) {
      const pointer = await getChannel(channel);
      if (pointer.releaseId === id || pointer.previousReleaseId === id) bad(409, '版本仍被通道引用');
    }
    const retained = await readJsonFile(RETENTION, {});
    if ((retained[id] || 0) > Date.now()) bad(409, '版本仍在撤回后保留期');
    await fsp.rm(releaseMetaPath(id)); // feed cannot reference this release
    await fsp.rm(path.dirname(packagePath(meta)), { recursive: true, force: true });
    await auditEvent({ operation: 'delete', releaseId: id, at: new Date().toISOString() });
    return { deleted: id };
  });
}
function manifestYaml(meta, pointer) {
  const fileUrl = `${BASE_URL}/winclaw2/releases/${releaseId(meta.version)}/${meta.file}`;
  const q = JSON.stringify;
  return `version: ${q(meta.version)}\nfiles:\n  - url: ${q(fileUrl)}\n    sha512: ${q(meta.sha512)}\n    size: ${meta.size}\npath: ${q(fileUrl)}\nsha512: ${q(meta.sha512)}\nreleaseDate: ${q(pointer.publishedAt)}\nreleaseNotes: ${q(meta.releaseNotes)}\n`;
}
async function serveManifest(res, url) {
  const allowed = new Set(['channel', 'platform', 'device_mid']);
  if ([...url.searchParams.keys()].some((key) => !allowed.has(key))) bad(400, '未知清单参数');
  const code = url.searchParams.get('channel') || '1';
  const platform = url.searchParams.get('platform') || 'windows-x86_64';
  if (!['1', '3'].includes(code) || platform !== 'windows-x86_64') bad(400, '不支持的通道或平台');
  let pointer;
  try { pointer = await getChannel(code === '1' ? 'stable' : 'preview'); }
  catch { bad(503, '发布指针不可用'); }
  if (!pointer.releaseId) bad(404, '此通道尚未发布版本');
  let meta;
  try { meta = await getRelease(pointer.releaseId); await assertPackage(meta); }
  catch { bad(503, '当前发布版本资产不可用'); }
  text(res, 200, manifestYaml(meta, pointer), 'application/x-yaml; charset=utf-8');
}
async function listReleases() {
  const names = await fsp.readdir(RELEASES);
  const channels = { stable: await getChannel('stable'), preview: await getChannel('preview') };
  const items = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    const meta = await readJsonFile(releaseMetaPath(id));
    if (!meta) continue;
    items.push({ releaseId: id, ...meta,
      channels: Object.entries(channels).filter(([, p]) => p.releaseId === id).map(([key]) => key) });
  }
  items.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  return items;
}
async function serveStatic(req, res, pathname) {
  const paths = { '/': 'index.html', '/app.js': 'app.js', '/app.css': 'app.css' };
  const file = paths[pathname];
  if (!file) bad(404, 'Not found');
  const body = await fsp.readFile(path.join(WEB, file));
  res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(req.method === 'HEAD' ? undefined : body);
}
async function cleanupUploads() {
  const now = Date.now();
  for (const name of await fsp.readdir(UPLOADS)) {
    const file = path.join(UPLOADS, name);
    try { if (now - (await fsp.stat(file)).mtimeMs > SESSION_TTL) await fsp.rm(file, { force: true }); }
    catch { /* concurrent removal */ }
  }
  for (const [id, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL && session.state !== 'receiving') sessions.delete(id);
  }
}
async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  if (pathname === '/healthz') {
    await fsp.access(PRIVATE, fs.constants.W_OK);
    return json(res, 200, { ok: true });
  }
  if (req.method === 'GET' && pathname === '/update/winclaw2/latest.yml') return serveManifest(res, url);
  if (!pathname.startsWith('/api/v2/')) {
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);
    bad(404, 'Not found');
  }
  if (req.method === 'GET' && pathname === '/api/v2/releases') return json(res, 200, { releases: await listReleases(), baseUrl: BASE_URL });
  if (req.method === 'GET' && pathname === '/api/v2/channels') return json(res, 200, {
    stable: await getChannel('stable'), preview: await getChannel('preview') });
  if (req.method === 'POST' && pathname === '/api/v2/uploads') {
    const meta = validateRelease(await readBody(req));
    const id = crypto.randomUUID();
    sessions.set(id, { meta, state: 'created', createdAt: Date.now(), file: path.join(UPLOADS, `${id}.part`) });
    return json(res, 201, { uploadId: id, releaseId: releaseId(meta.version) });
  }
  const uploadMatch = pathname.match(/^\/api\/v2\/uploads\/([0-9a-f-]{36})\/(installer|complete)$/);
  if (uploadMatch) {
    const session = sessions.get(uploadMatch[1]);
    if (!session) bad(404, '上传会话不存在或已失效');
    if (uploadMatch[2] === 'installer' && req.method === 'PUT') return json(res, 200, { size: await receiveInstaller(req, session) });
    if (uploadMatch[2] === 'complete' && req.method === 'POST') return json(res, 200, await commitUpload(session));
  }
  const channelMatch = pathname.match(/^\/api\/v2\/channels\/(stable|preview)\/(publish|restore)$/);
  if (channelMatch && req.method === 'POST') {
    const body = await readBody(req);
    if (!body || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) bad(400, 'expectedRevision 无效');
    const [channel, action] = channelMatch.slice(1);
    const old = await getChannel(channel);
    return json(res, 200, await changeChannel(channel, body.expectedRevision,
      action === 'restore' ? old.previousReleaseId : body.releaseId, action));
  }
  const releaseMatch = pathname.match(/^\/api\/v2\/releases\/(2\.[0-9]+\.[0-9]+-windows-x64)$/);
  if (releaseMatch && req.method === 'DELETE') return json(res, 200, await deleteRelease(releaseMatch[1]));
  bad(404, 'Not found');
}

async function repairReadyPackagePermissions() {
  for (const name of await fsp.readdir(RELEASES)) {
    if (!name.endsWith('.json')) continue;
    const raw = await readJsonFile(path.join(RELEASES, name));
    if (!raw) continue;
    const meta = validateRelease(raw);
    if (name !== releaseId(meta.version) + '.json') continue;
    // 旧版提交保留了暂存文件的 0600，重启时修复已发布包的 Nginx 读取权限。
    try { await fsp.chmod(packagePath(meta), 0o644); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

async function main() {
  for (const dir of [PUBLIC, PRIVATE, UPLOADS, RELEASES, CHANNELS]) await fsp.mkdir(dir, { recursive: true });
  await repairReadyPackagePermissions();
  await cleanupUploads();
  setInterval(() => { void cleanupUploads().catch(console.error); }, 60 * 60 * 1000).unref();
  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (!error.status || error.status >= 500) console.error(error);
      if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : '服务器内部错误' });
      else res.destroy();
    });
  });
  server.requestTimeout = 60 * 60 * 1000;
  server.timeout = 10 * 60 * 1000;
  server.listen(PORT, '0.0.0.0', () => console.log(`WinClaw2 update admin listening on ${PORT}`));
}
if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { validateRelease, manifestYaml, main };
