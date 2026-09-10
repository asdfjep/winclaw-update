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
const RUNTIME_FILE_RE = /^runtime-([a-zA-Z0-9]+)-(.+)\.zip$/i;

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

function runtimeStoreDir() {
  return path.join(DIR, 'runtimes');
}

function parseRuntimeFileName(name) {
  const base = path.basename(String(name || ''));
  const m = RUNTIME_FILE_RE.exec(base);
  return m ? { id: m[1].toLowerCase(), stamp: m[2], file: base } : null;
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
      runtimes: Array.isArray(meta.runtimes) ? meta.runtimes : [],
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

function posixName(name) {
  return String(name || '').replace(/\\/g, '/');
}

function buildStoredZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(posixName(f.name).replace(/^\/+/, ''), 'utf8');
    const data = f.data;
    const crc = zlib.crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralStart = offset;
  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...localParts, centralBuf, eocd]);
}

function runtimeMetaFromBuffer(file, data) {
  const parsed = parseRuntimeFileName(file);
  if (!parsed) return null;
  return {
    id: parsed.id,
    stamp: parsed.stamp,
    file: parsed.file,
    sha256: crypto.createHash('sha256').update(data).digest('hex'),
    size: data.length,
  };
}

function collectPythonOfflineFiles(buf, entries) {
  const files = [];
  for (const e of entries) {
    const n = posixName(e.name);
    if (n.endsWith('/')) continue;
    const marker = 'python-offline/';
    const idx = n.toLowerCase().indexOf(marker);
    if (idx < 0) continue;
    const rel = n.slice(idx + marker.length);
    if (!rel || rel.endsWith('/')) continue;
    files.push({ name: rel, data: extractEntry(buf, e) });
  }
  return files;
}

function listRuntimeStore() {
  const dir = runtimeStoreDir();
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    const parsed = parseRuntimeFileName(f);
    if (!parsed) continue;
    const p = path.join(dir, f);
    let size = 0;
    let sha256 = null;
    try {
      size = fs.statSync(p).size;
      const metaSidecar = path.join(dir, `${f}.sha256`);
      if (fs.existsSync(metaSidecar)) {
        sha256 = fs.readFileSync(metaSidecar, 'utf8').trim();
      }
    } catch { /* ignore */ }
    out.push({
      id: parsed.id,
      stamp: parsed.stamp,
      file: parsed.file,
      size,
      sha256,
      url: `${BASE_URL}/runtimes/${parsed.file}`,
    });
  }
  out.sort((a, b) => String(b.stamp).localeCompare(String(a.stamp)));
  return out;
}

function ensureRuntimeSha(entry) {
  if (entry.sha256) return entry;
  const p = path.join(runtimeStoreDir(), entry.file);
  if (!fs.existsSync(p)) return entry;
  const sha = crypto.createHash('sha256');
  sha.update(fs.readFileSync(p));
  entry.sha256 = sha.digest('hex');
  try {
    fs.writeFileSync(path.join(runtimeStoreDir(), `${entry.file}.sha256`), entry.sha256 + '\n');
  } catch { /* ignore */ }
  return entry;
}

function writeRuntimePack(file, data) {
  const parsed = parseRuntimeFileName(file);
  if (!parsed) throw new Error(`环境包文件名不合法：${file}`);
  const dir = runtimeStoreDir();
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, parsed.file);
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');
  let overwritten = false;
  if (fs.existsSync(dest)) {
    const existing = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
    if (existing === sha256) {
      return { ...parsed, sha256, size: data.length, reused: true, overwritten: false };
    }
    overwritten = true;
  }
  fs.writeFileSync(dest, data);
  fs.writeFileSync(path.join(dir, `${parsed.file}.sha256`), sha256 + '\n');
  return { ...parsed, sha256, size: data.length, reused: false, overwritten };
}

function catalogRuntimes() {
  return listRuntimeStore().map(ensureRuntimeSha).map((r) => ({
    id: r.id,
    stamp: r.stamp,
    file: r.file,
    url: `${BASE_URL}/runtimes/${r.file}`,
    sha256: r.sha256,
    size: r.size,
  }));
}

function syncPublishedManifestRuntimes() {
  const active = readActive();
  if (!active || !active.version) return false;
  active.runtimes = catalogRuntimes();
  atomicWriteJson(path.join(DIR, 'winclaw-update.json'), active);
  return true;
}

function offlineRelName(name) {
  const n = posixName(name);
  const marker = 'python-offline/';
  const idx = n.toLowerCase().indexOf(marker);
  return (idx >= 0 ? n.slice(idx + marker.length) : n).replace(/^\/+/, '');
}

function assertPythonRuntimePack(file, data) {
  const parsed = parseRuntimeFileName(file);
  if (!parsed || parsed.id !== 'python') return;
  let entries;
  try {
    entries = zipEntries(data);
  } catch (e) {
    throw new Error(`环境包 ${file} 不是有效 zip：${e.message}`);
  }
  const names = entries.map((e) => offlineRelName(e.name)).filter((n) => n && !n.endsWith('/'));
  if (!names.length) throw new Error(`环境包 ${file} 是空 zip`);
  const hasStamp = names.includes('stamp');
  const hasEmbed = names.some((n) => /^python-[\d.]+-embed-amd64\.zip$/i.test(path.posix.basename(n)));
  if (!hasStamp || !hasEmbed) {
    throw new Error(`Python 环境包内容不完整，需要 stamp 和 python-*-embed-amd64.zip（${file}）`);
  }
  const stampEntry = entries.find((e) => offlineRelName(e.name) === 'stamp');
  if (!stampEntry) return;
  const stamp = extractEntry(data, stampEntry).toString('utf8').trim();
  if (stamp && stamp !== parsed.stamp) {
    throw new Error(`环境包 stamp 不一致：文件名是 ${parsed.stamp}，包内 stamp 是 ${stamp}`);
  }
}

function extractRuntimeUploads(filename, buf) {
  const out = [];
  const seen = new Set();
  const pushPack = (file, data) => {
    const parsed = parseRuntimeFileName(file);
    if (!parsed || seen.has(parsed.file)) return;
    assertPythonRuntimePack(parsed.file, data);
    seen.add(parsed.file);
    out.push({ file: parsed.file, data });
  };

  const direct = parseRuntimeFileName(filename);
  if (direct) {
    pushPack(direct.file, buf);
    return out;
  }

  const entries = zipEntries(buf);
  for (const e of entries) {
    if (e.name.endsWith('/')) continue;
    const base = path.posix.basename(posixName(e.name));
    if (!parseRuntimeFileName(base)) continue;
    pushPack(base, extractEntry(buf, e));
  }

  const offlineFiles = collectPythonOfflineFiles(buf, entries);
  if (offlineFiles.length && !out.some((x) => parseRuntimeFileName(x.file).id === 'python')) {
    const stampFile = offlineFiles.find((f) => posixName(f.name) === 'stamp');
    const stamp = stampFile ? stampFile.data.toString('utf8').trim() : '3.12.10-1';
    const file = `runtime-python-${stamp}.zip`;
    pushPack(file, buildStoredZip(offlineFiles));
  }

  if (!out.length) {
    throw new Error('未找到环境包。请上传 runtime-<id>-<stamp>.zip，或内含该文件 / python-offline/ 的 zip');
  }
  return out;
}

function ingestRuntimePacks(packs) {
  const written = packs.map((p) => writeRuntimePack(p.file, p.data));
  const published = syncPublishedManifestRuntimes();
  return { written, published, runtimes: catalogRuntimes() };
}

function runtimeUploadResponse(result) {
  return {
    kind: 'runtime',
    split: result.written.length,
    published: result.published,
    uploaded: result.written.map((r) => ({
      id: r.id,
      stamp: r.stamp,
      file: r.file,
      sha256: r.sha256,
      size: r.size,
      reused: !!r.reused,
      overwritten: !!r.overwritten,
      url: `${BASE_URL}/runtimes/${r.file}`,
    })),
    runtimes: result.runtimes,
  };
}

async function handleRuntimeUpload(req, res, url) {
  let filename = path.basename((url.searchParams.get('filename') || '').trim());
  if (!filename) return sendJson(res, 400, { error: '缺少 filename 参数' });
  if (!filename.toLowerCase().endsWith('.zip')) {
    return sendJson(res, 400, { error: '环境包仅支持 .zip' });
  }
  const body = await readBody(req);
  if (body.length === 0) return sendJson(res, 400, { error: '上传内容为空' });
  let packs;
  try {
    packs = extractRuntimeUploads(filename, body);
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
  sendJson(res, 201, runtimeUploadResponse(ingestRuntimePacks(packs)));
}

// 发布包 zip 约定：Hs-WinClaw-Setup-<ver>.exe + winclaw-update.json
// + 可选 runtimes/runtime-<id>-<stamp>.zip（或根目录同名）+ 可选 python-offline/ 目录。
function extractReleaseZip(buf) {
  const entries = zipEntries(buf);
  let exe = null;
  let manifest = null;
  const runtimeBuffers = [];
  for (const e of entries) {
    if (e.name.endsWith('/')) continue;
    const base = path.posix.basename(posixName(e.name));
    if (EXE_RE.test(base) && !exe) exe = { base, data: extractEntry(buf, e) };
    else if (base === 'winclaw-update.json' && !manifest) {
      try {
        manifest = JSON.parse(extractEntry(buf, e).toString('utf8'));
      } catch { /* 内嵌清单不可解析则忽略 */ }
    } else if (parseRuntimeFileName(base)) {
      runtimeBuffers.push({ file: base, data: extractEntry(buf, e) });
    }
  }
  if (!exe) throw new Error('zip 中未找到 Hs-WinClaw-Setup-<ver>.exe');
  const fromName = versionFromFilename(exe.base);
  const innerVersion = manifest && manifest.version;
  const version = innerVersion || fromName;
  if (!version || !safeVersion(version)) {
    throw new Error('无法从 zip 推断版本号（内嵌清单缺失或文件名不规范）');
  }

  const runtimes = runtimeBuffers.map((r) => runtimeMetaFromBuffer(r.file, r.data)).filter(Boolean);
  const runtimeData = {};
  for (const r of runtimeBuffers) runtimeData[r.file] = r.data;

  const offlineFiles = collectPythonOfflineFiles(buf, entries);
  if (offlineFiles.length && !runtimes.some((x) => x.id === 'python')) {
    const stampFile = offlineFiles.find((f) => posixName(f.name) === 'stamp');
    const stamp = stampFile ? stampFile.data.toString('utf8').trim() : '3.12.10-1';
    const file = `runtime-python-${stamp}.zip`;
    const packed = buildStoredZip(offlineFiles);
    runtimeData[file] = packed;
    runtimes.push(runtimeMetaFromBuffer(file, packed));
  }

  if (Array.isArray(manifest && manifest.runtimes)) {
    for (const declared of manifest.runtimes) {
      const file = declared && (declared.file || path.basename(declared.url || ''));
      if (!file || !parseRuntimeFileName(file)) continue;
      if (runtimes.some((x) => x.file === file)) continue;
    }
  }

  return {
    version,
    data: exe.data,
    notes: (manifest && manifest.notes) || '',
    mandatory: !!(manifest && manifest.mandatory),
    runtimes,
    runtimeData,
  };
}

// ---------- 上传处理 ----------

async function handleUpload(req, res, url) {
  let filename = url.searchParams.get('filename') || '';
  filename = path.basename(filename).trim();
  if (!filename) return sendJson(res, 400, { error: '缺少 filename 参数' });

  const body = await readBody(req);
  if (body.length === 0) return sendJson(res, 400, { error: '上传内容为空' });

  const tryRuntimeOnly = () => {
    const packs = extractRuntimeUploads(filename, body);
    return sendJson(res, 201, runtimeUploadResponse(ingestRuntimePacks(packs)));
  };

  if (parseRuntimeFileName(filename)) {
    try {
      return tryRuntimeOnly();
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  let version, exeData, notes = '', mandatory = false, splitRuntimes = [];

  if (filename.toLowerCase().endsWith('.zip')) {
    let extracted;
    try {
      extracted = extractReleaseZip(body);
    } catch (e) {
      try {
        return tryRuntimeOnly();
      } catch {
        return sendJson(res, 400, { error: `zip 解析失败：${e.message}` });
      }
    }
    version = extracted.version;
    exeData = extracted.data;
    notes = extracted.notes;
    mandatory = extracted.mandatory;
    for (const rt of extracted.runtimes || []) {
      const data = extracted.runtimeData && extracted.runtimeData[rt.file];
      if (!data) continue;
      splitRuntimes.push(writeRuntimePack(rt.file, data));
    }
    if (splitRuntimes.length) syncPublishedManifestRuntimes();
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
  const runtimeMeta = splitRuntimes.map((r) => ({
    id: r.id,
    stamp: r.stamp,
    file: r.file,
    sha256: r.sha256,
    size: r.size,
    url: `${BASE_URL}/runtimes/${r.file}`,
  }));
  fs.writeFileSync(targetExe, exeData);
  atomicWriteJson(metaFile(version), {
    version,
    filename: exeFileName(version),
    exeSize: exeData.length,
    sha256,
    notes,
    mandatory,
    uploadedAt,
    runtimes: runtimeMeta,
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
    runtimes: runtimeMeta,
    split: runtimeMeta.length,
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
  const runtimes = catalogRuntimes();

  const manifest = {
    version,
    url: `${BASE_URL}/${exeFileName(version)}`,
    sha256,
    notes,
    mandatory,
    publishedAt: today(),
    runtimes,
  };
  atomicWriteJson(path.join(DIR, 'winclaw-update.json'), manifest);
  atomicWriteJson(metaFile(version), { ...meta, version, filename: exeFileName(version), exeSize, sha256, mandatory, runtimes: meta.runtimes || runtimes });

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
      const runtimes = listRuntimeStore();
      return sendJson(res, 200, {
        baseUrl: BASE_URL,
        dir: DIR,
        authRequired: !!ADMIN_TOKEN,
        active,
        orphan: active ? !fs.existsSync(path.join(DIR, exeFileName(active.version))) : false,
        runtimes,
        runtimeMissing: runtimes.length === 0,
      });
    }
    if (req.method === 'GET' && p === '/api/releases') return sendJson(res, 200, { baseUrl: BASE_URL, active: readActive(), releases: listReleases() });
    if (req.method === 'GET' && p === '/api/runtimes') {
      return sendJson(res, 200, { runtimes: catalogRuntimes() });
    }
    if (req.method === 'POST' && p === '/api/runtimes') {
      if (!requireAuth(req, res)) return;
      return await handleRuntimeUpload(req, res, url);
    }

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
  fs.mkdirSync(runtimeStoreDir(), { recursive: true });
} catch (e) {
  console.error(`[winclaw-admin] 无法创建更新目录 ${DIR}: ${e.message}`);
}

server.listen(PORT, () => {
  console.log(`[winclaw-admin] listening on :${PORT}`);
  console.log(`[winclaw-admin] update dir = ${DIR}`);
  console.log(`[winclaw-admin] manifest base url = ${BASE_URL}`);
  console.log(`[winclaw-admin] auth = ${ADMIN_TOKEN ? 'on' : 'off'}`);
});