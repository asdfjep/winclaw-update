---
name: release-package-skill
description: "WinClaw 自动更新发布包打包规范。发布客户端新版本时按此准则生成安装包/清单/标准 zip 并上传管理端。triggers: 打发布包, 打包, 发布版本, 生成安装包, 更新包, 发布新版本, release package"
version: 1.0.0
author: WinClaw
triggers: keyword:发布包, keyword:打包, keyword:打发布包, keyword:发布版本, keyword:生成安装包, keyword:更新包, keyword:发布新版本, pattern:release.?package|pack.*release|打.*发布包|打包.*版本|发布.*版本|build.*installer|生成.*安装包.*zip, command:/打包, command:/发布包
tools_required: file_read, file_write, powershell, cmd_execute
---

# 发布包打包规范（WinClaw 自动更新）

被触发打包/发布版本时，**严格执行** `docs/发布包打包规范.md`（仓库根 `docs/` 下，先用 `file_read` 读全文），
下列为必守要点；与文档冲突时以 `docs/发布包打包规范.md` 为准。

## 必守要点

1. **发布包 = 两个文件**：`Hs-WinClaw-Setup-<版本>.exe`（Inno 安装包，`build_installer.bat` 产物）
   + `winclaw-update.json`（清单）。一律放在仓库 `installer/` 目录。

2. **文件名强制规范**：exe 必须叫 `Hs-WinClaw-Setup-<版本>.exe`；管理端靠它推版本号。

3. **严禁伪 zip**：`Hs-WinClaw-Setup-<版本>-update-package.zip` 不是 zip（文件名前缀+裸 exe，PK 头在偏移 512）。
   管理端上传会「zip 解析失败」。zip 必须是标准 zip（首 4 字节 `50 4B 03 04`），内放 exe + winclaw-update.json。

4. **清单字段**：`{ version, url, sha256, notes, mandatory, publishedAt }`
   - `url` 前缀**必须** = `http://10.233.129.67:8091/update`（`.67`，更新服务器；`.65` 是 Git 服务器，禁止混用）。
   - `sha256` = 对应 exe 的小写 SHA-256，客户端校验用；按 `build_installer.bat` 调 `tools/gen_update_manifest.ps1` 自动生成
     （自动算哈希、写 url、git 日志做 notes），不要手写。

5. **标准 zip 打包**（Windows）：
   ```powershell
   Compress-Archive -Path installer\Hs-WinClaw-Setup-<版本>.exe, installer\winclaw-update.json -DestinationPath installer\WinClaw-<版本>-发布包.zip -CompressionLevel Optimal
   ```
   打包后自检首 4 字节是否为 `PK\x03\x04`。

6. **发布/回滚（管理端 `http://10.233.129.67:8091`，端口 8091 非 8081）**：
   - 上传：拖拽标准 zip，或直接传裸 exe（自动按文件名推版本）；同名重复上传报冲突。
   - 「设为发布」→ 服务端原子写 `winclaw-update.json` → 客户端 24h 内自动更新。
   - 回滚 = 重发布旧版本；当前发布版本受删除保护。

7. **发布前自检**：exe 文件名规范 / zip 是标准 zip / 清单 version 与 exe 一致 / url 是 `.67` /
   sha256 与 exe 一致（`certutil -hashfile <exe> SHA256` 核对）/ 上传后
   `curl http://10.233.129.67:8091/update/winclaw-update.json` 返回新版本号。

8. **别把测试/半成品留在当前发布位置**：测完用正式版本重发布。

> 详细流程、示例与全部易错点见 `docs/发布包打包规范.md`。