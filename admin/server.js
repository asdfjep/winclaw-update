#!/usr/bin/env node
'use strict';

// WinClaw 自动更新管理端 —— 零依赖 Node HTTP 服务（端口 8091）。
// 读写挂载与 nginx 相同的更新卷：列出/上传/发布/删除 Hs-WinClaw-Setup-*.exe，
// "发布" = 把该版本清单原子写入 winclaw-update.json（客户端契约不变）。
//
// 只用 Node 内建模块（http/fs/path/crypto/zlib），无 package.json / npm，
// 因此可在无法访问外网的 snap-Docker 服务器上离线构建。

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const DIR = process.env.WINCLAW_UPDATE_DIR || '/data/winclaw-update';
const BASE_URL = (process.env.WINCLAW_UPDATE_BASE_URL || 'http://10.233.129.67:8091/update').replace(/\/+$/, '');
const PORT = Number(process.env.WINCLAW_ADMIN_PORT || 8091);
const ADMIN_TOKEN = process.env.WINCLAW_ADMIN_TOKEN || ''; // 空 = 不鉴权；设置后所有写操作要求 Bearer token
const PUB_DIR = path.join(__dirname, 'public');
const MAX_UPLOAD = 900 * 1024 * 1024; // ~900MB 上传上限
const EXE_RE = /^(Hs-WinClaw-Setup-)(.+)(\.exe)$/i;
const VERSION_RE = /^[0-9a-zA-Z][0-9a-zA-Z._-]*$/;

// ---------- 小工具 ----------

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function sendText(res, code, text, type) {
  res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > MAX_UPLOAD) {
        reject(new Error('上传超过大小上限'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function atomicWriteJson(file, obj) {
  const tmp = `${file}.tmp.${process.pid}`;
  const data = JSON.stringify(obj, null, 2) + '\n';
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, file); // 覆盖式 rename，避免 nginx 读到半截文件
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const s = fs.createReadStream(p);
    s.on('error', reject);
    s.on('data', (d) => hash.update(d));
    s.on('end', () => resolve(hash.digest('hex')));
  });
}

function safeVersion(v) {
  return VERSION_RE.test(v) ? v : null;
}

function exeFileName(version) {
  return `Hs-WinClaw-Setup-${version}.exe`;
}

function metaFile(version) {
  return path.join(DIR, `release-${version}.json`);
}

function versionFromFilename(name) {
  const m = EXE_RE.exec(name);
  return m ? m[2] : null;
}

// ---------- 卷内数据 ----------

function readActive() {
  const p = path.join(DIR, 'winclaw-update.json');
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function readMeta(version) {
  try {
    return JSON.parse(fs.readFileSync(metaFile(version), 'utf8'));
  } catch {
    return null;
  }
}

function listReleases() {
  const active = readActive();
  const releases = [];
  let files;
  try {
    files = fs.readdirSync(DIR);
  } catch {
    files = [];
  }
  for (const f of files) {
    const version = versionFromFilename(f);
    if (!version) continue;
    const exePath = path.join(DIR, f);
    let size = 0;
    try {
      size = fs.statSync(exePath).size;
    } catch { /* stat 失败按 0 处理 */ }
    const meta = readMeta(version) || {};
    releases.push({
      version,
      filename: f,
      exeSize: size,
      sha256: meta.sha256 || null,
      notes: meta.notes || '',
      mandatory: !!meta.mandatory,
      uploadedAt: meta.uploadedAt || null,
      publishedAt: active && active.version === version ? active.publishedAt || null : null,
      active: !!(active && active.version === version),
    });
  }
  // 版本号数字排序，新的在前
  releases.sort((a, b) => cmpVersions(b.version, a.version));
  return releases;
}

function cmpVersions(a, b) {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return String(a).localeCompare(String(b));
}

// ---------- 极简 zip 读取（仅 stored / deflate，非 zip64） ----------

function zipEntries(buf) {
  let eocd = -1;
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 文件');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('zip 中央目录损坏');
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const usize = buf.readUInt32LE(off + 24);
    const fnameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const locOff = buf.readUInt32LE(off + 42);
    if (csize === 0xffffffff || usize === 0xffffffff) throw new Error('暂不支持 zip64 压缩包');
    const name = buf.subarray(off + 46, off + 46 + fnameLen).toString('utf8');
    entries.push({ name, method, csize, usize, locOff });
    off += 46 + fnameLen + extraLen + commentLen;
  }
  return entries;
}

function extractEntry(buf, entry) {
  if (buf.readUInt32LE(entry.locOff) !== 0x04034b50) throw new Error('zip 本地文件头损坏');
  const fnameLen = buf.readUInt16LE(entry.locOff + 26);
  const extraLen = buf.readUInt16LE(entry.locOff + 28);
  const data = buf.subarray(entry.locOff + 30 + fnameLen + extraLen, entry.locOff + 30 + fnameLen + extraLen + entry.csize);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return zlib.inflateRawSync(data);
  throw new Error(`不支持的 zip 压缩方式 (${entry.method})`);
}

// 发布包 zip 约定：内含 Hs-WinClaw-Setup-<ver>.exe + winclaw-update.json（取其 version/notes）。
function extractReleaseZip(buf) {
  const entries = zipEntries(buf);
  let exe = null;
  let manifest = null;
  for (const e of entries) {
    if (e.name.endsWith('/')) continue;
    const base = path.posix.basename(e.name);
    if (EXE_RE.test(base) && !exe) exe = { base, data: extractEntry(buf, e) };
    else if (base === 'winclaw-update.json' && !manifest) {
      try {
        manifest = JSON.parse(extractEntry(buf, e).toString('utf8'));
      } catch { /* 内嵌清单不可解析则忽略 */ }
    }
  }
  if (!exe) throw new Error('zip 中未找到 Hs-WinClaw-Setup-<ver>.exe');
  const fromName = versionFromFilename(exe.base);
  const innerVersion = manifest && manifest.version;
  const version = innerVersion || fromName;
  if (!version || !safeVersion(version)) {
    throw new Error('无法从 zip 推断版本号（内嵌清单缺失或文件名不规范）');
  }
  return {
    version,
    data: exe.data,
    notes: (manifest && manifest.notes) || '',
    mandatory: !!(manifest && manifest.mandatory),
  };
}

// ---------- 上传处理 ----------

async function handleUpload(req, res, url) {
  let filename = url.searchParams.get('filename') || '';
  filename = path.basename(filename).trim();
  if (!filename) return sendJson(res, 400, { error: '缺少 filename 参数' });

  const body = await readBody(req);
  if (body.length === 0) return sendJson(res, 400, { error: '上传内容为空' });

  let version, exeData, notes = '', mandatory = false;

  if (filename.toLowerCase().endsWith('.zip')) {
    let extracted;
    try {
      extracted = extractReleaseZip(body);
    } catch (e) {
      return sendJson(res, 400, { error: `zip 解析失败：${e.message}` });
    }
    version = extracted.version;
    exeData = extracted.data;
    notes = extracted.notes;
    mandatory = extracted.mandatory;
  } else if (filename.toLowerCase().endsWith('.exe')) {
    version = versionFromFilename(filename);
    if (!version || !safeVersion(version)) {
      return sendJson(res, 400, { error: 'exe 文件名必须形如 Hs-WinClaw-Setup-<版本>.exe' });
    }
    exeData = body;
  } else {
    return sendJson(res, 400, { error: '仅支持 .zip 或 .exe 文件' });
  }

  const targetExe = path.join(DIR, exeFileName(version));
  if (fs.existsSync(targetExe)) {
    return sendJson(res, 409, { error: `版本 ${version} 已存在（${exeFileName(version)}），如需覆盖请先删除旧版本` });
  }

  const uploadedAt = new Date().toISOString();
  const sha256 = crypto.createHash('sha256').update(exeData).digest('hex');
  fs.writeFileSync(targetExe, exeData);
  atomicWriteJson(metaFile(version), {
    version,
    filename: exeFileName(version),
    exeSize: exeData.length,
    sha256,
    notes,
    mandatory,
    uploadedAt,
  });

  sendJson(res, 201, {
    version,
    filename: exeFileName(version),
    exeSize: exeData.length,
    sha256,
    notes,
    mandatory,
    uploadedAt,
    active: false,
  });
}

// ---------- 发布 / 说明 / 删除 ----------

async function handlePublish(res, url) {
  const version = url.pathname.split('/')[3];
  if (!safeVersion(version)) return sendJson(res, 400, { error: '版本号不合法' });
  const exePath = path.join(DIR, exeFileName(version));
  if (!fs.existsSync(exePath)) return sendJson(res, 404, { error: `版本 ${version} 的安装包不存在` });

  const exeSize = fs.statSync(exePath).size;
  const sha256 = await sha256File(exePath);
  const meta = readMeta(version) || {};
  const notes = meta.notes || '';
  const mandatory = !!meta.mandatory;

  const manifest = {
    version,
    url: `${BASE_URL}/${exeFileName(version)}`,
    sha256,
    notes,
    mandatory,
    publishedAt: today(),
  };
  atomicWriteJson(path.join(DIR, 'winclaw-update.json'), manifest);
  atomicWriteJson(metaFile(version), { ...meta, version, filename: exeFileName(version), exeSize, sha256, mandatory });

  sendJson(res, 200, { ok: true, manifest });
}

async function handleNotes(req, res, url) {
  const version = url.pathname.split('/')[3];
  if (!safeVersion(version)) return sendJson(res, 400, { error: '版本号不合法' });
  if (!fs.existsSync(path.join(DIR, exeFileName(version)))) {
    return sendJson(res, 404, { error: `版本 ${version} 的安装包不存在` });
  }
  let input;
  try {
    input = JSON.parse((await readBody(req)).toString('utf8') || '{}');
  } catch {
    return sendJson(res, 400, { error: '请求体不是合法 JSON' });
  }
  const meta = readMeta(version) || {};
  if (typeof input.notes === 'string') meta.notes = input.notes;
  if (typeof input.mandatory === 'boolean') meta.mandatory = input.mandatory;
  meta.version = version;
  meta.filename = exeFileName(version);
  atomicWriteJson(metaFile(version), meta);

  // 若该版本是当前发布，同步刷新客户端清单里的 notes / mandatory，保持展示一致
  const active = readActive();
  if (active && active.version === version) {
    active.notes = meta.notes;
    active.mandatory = meta.mandatory;
    atomicWriteJson(path.join(DIR, 'winclaw-update.json'), active);
  }

  sendJson(res, 200, { ok: true, notes: meta.notes, mandatory: meta.mandatory });
}

function handleDelete(res, url) {
  const version = url.pathname.split('/')[3];
  if (!safeVersion(version)) return sendJson(res, 400, { error: '版本号不合法' });
  const active = readActive();
  if (active && active.version === version) {
    return sendJson(res, 409, { error: `版本 ${version} 是当前发布版本，不可删除。请先发布其他版本` });
  }
  const exePath = path.join(DIR, exeFileName(version));
  if (!fs.existsSync(exePath)) return sendJson(res, 404, { error: `版本 ${version} 的安装包不存在` });
  fs.unlinkSync(exePath);
  try {
    if (fs.existsSync(metaFile(version))) fs.unlinkSync(metaFile(version));
  } catch { /* 元数据缺失/删除失败不阻断 */ }
  sendJson(res, 200, { ok: true });
}

// ---------- 鉴权钩子（默认关） ----------

function isAuthorized(req) {
  if (!ADMIN_TOKEN) return true;
  return req.headers['authorization'] === `Bearer ${ADMIN_TOKEN}`;
}

function requireAuth(req, res) {
  if (isAuthorized(req)) return true;
  sendJson(res, 401, { error: '未授权（需要 Bearer token）' });
  return false;
}

// ---------- 静态文件 ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  rel = path.normalize(rel).replace(/^([.][.][\\/])+/, '');
  const file = path.join(PUB_DIR, rel);
  if (!file.startsWith(PUB_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return sendText(res, 404, 'Not Found', 'text/plain; charset=utf-8');
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

// ---------- 路由 ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    if (req.method === 'GET' && p === '/healthz') return sendText(res, 200, 'ok');
    if (req.method === 'GET' && p === '/api/config') {
      const active = readActive();
      return sendJson(res, 200, {
        baseUrl: BASE_URL,
        dir: DIR,
        authRequired: !!ADMIN_TOKEN,
        active,
        orphan: active ? !fs.existsSync(path.join(DIR, exeFileName(active.version))) : false,
      });
    }
    if (req.method === 'GET' && p === '/api/releases') return sendJson(res, 200, { baseUrl: BASE_URL, active: readActive(), releases: listReleases() });

    if (req.method === 'POST' && p === '/api/upload') {
      if (!requireAuth(req, res)) return;
      return await handleUpload(req, res, url);
    }
    if (req.method === 'POST' && /^\/api\/releases\/[^/]+\/publish$/.test(p)) {
      if (!requireAuth(req, res)) return;
      return await handlePublish(res, url);
    }
    if (req.method === 'POST' && /^\/api\/releases\/[^/]+\/notes$/.test(p)) {
      if (!requireAuth(req, res)) return;
      return await handleNotes(req, res, url);
    }
    if (req.method === 'DELETE' && /^\/api\/releases\/[^/]+$/.test(p)) {
      if (!requireAuth(req, res)) return;
      return handleDelete(res, url);
    }

    // 更新包静态文件分发：/update/* 直接从更新目录返回（供客户端 + 管理端历史上传文件）
    if (req.method === 'GET' && p.startsWith('/update/')) {
      const rel = p.slice('/update/'.length);
      const file = path.normalize(path.join(DIR, rel));
      if (!file.startsWith(DIR)) return sendText(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        const ext = path.extname(file).toLowerCase();
        res.writeHead(200, { 'Content-Type': (ext === '.json' ? 'application/json; charset=utf-8' : 'application/octet-stream'), 'Cache-Control': 'no-cache' });
        return fs.createReadStream(file).pipe(res);
      }
      return sendText(res, 404, 'Not Found', 'text/plain; charset=utf-8');
    }

    if (req.method === 'GET' && (p === '/' || !p.startsWith('/api/'))) return serveStatic(req, res, p);

    sendJson(res, 404, { error: `未找到 ${req.method} ${p}` });
  } catch (e) {
    sendJson(res, 500, { error: `服务器错误：${e.message}` });
  }
});

// ---------- 启动 ----------

try {
  fs.mkdirSync(DIR, { recursive: true });
} catch (e) {
  console.error(`[winclaw-admin] 无法创建更新目录 ${DIR}: ${e.message}`);
}

server.listen(PORT, () => {
  console.log(`[winclaw-admin] listening on :${PORT}`);
  console.log(`[winclaw-admin] update dir = ${DIR}`);
  console.log(`[winclaw-admin] manifest base url = ${BASE_URL}`);
  console.log(`[winclaw-admin] auth = ${ADMIN_TOKEN ? 'on' : 'off'}`);
});