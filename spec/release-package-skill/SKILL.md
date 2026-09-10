---
name: release-package-skill
description: "WinClaw 自动更新发布包打包规范。发布客户端新版本时按此准则生成瘦安装包/环境包/清单/标准 zip 并上传管理端。triggers: 打发布包, 打包, 发布版本, 生成安装包, 更新包, 发布新版本, release package"
version: 1.1.0
author: WinClaw
triggers: keyword:发布包, keyword:打包, keyword:打发布包, keyword:发布版本, keyword:生成安装包, keyword:更新包, keyword:发布新版本, pattern:release.?package|pack.*release|打.*发布包|打包.*版本|发布.*版本|build.*installer|生成.*安装包.*zip, command:/打包, command:/发布包
tools_required: file_read, file_write, powershell, cmd_execute
---

# 发布包打包规范（WinClaw 自动更新）

被触发打包/发布版本时，**严格执行** `docs/发布包打包规范.md`（仓库根 `docs/` 下，先用 `file_read` 读全文），
下列为必守要点；与文档冲突时以 `docs/发布包打包规范.md` 为准。

## 必守要点

1. **发布包 = 三部分**：瘦安装包 `Hs-WinClaw-Setup-<版本>.exe`（**不含** python-offline）
   + `winclaw-update.json`（含 `runtimes[]`）
   + `runtimes/runtime-python-<stamp>.zip`。一律放在仓库 `installer/` 目录。
   **每次打包必须附带当前需要的环境包。**

2. **文件名强制规范**：exe 必须叫 `Hs-WinClaw-Setup-<版本>.exe`；环境包必须叫 `runtime-python-<stamp>.zip`。

3. **严禁伪 zip**：`Hs-WinClaw-Setup-<版本>-update-package.zip` 不是 zip。
   zip 必须是标准 zip（首 4 字节 `50 4B 03 04`），内放 exe + winclaw-update.json + `runtimes/`。

4. **清单字段**：`{ version, url, sha256, notes, mandatory, publishedAt, runtimes }`
   - `url` 前缀**必须** = `http://10.233.129.67:8091/update`
   - `runtimes[]` 必填，指向 `.../update/runtimes/runtime-python-<stamp>.zip`
   - 按 `build_installer.bat` → `tools/gen_update_manifest.ps1` 自动生成，不要手写。

5. **标准 zip 打包**（Windows）：
   ```powershell
   Compress-Archive -Path installer\Hs-WinClaw-Setup-<版本>.exe, installer\winclaw-update.json, installer\runtimes -DestinationPath installer\WinClaw-<版本>-发布包.zip -CompressionLevel Optimal
   ```
   打包后自检首 4 字节是否为 `PK\x03\x04`。

6. **发布（管理端 `http://10.233.129.67:8091`）**：
   - 也可单独把 `runtime-python-<stamp>.zip` 拖到管理端「环境包仓库」，不必和安装包打在一起。
   - 上传标准 zip 后，服务端**自动分流**环境包到共享 `/runtimes/`，安装包只保留内容。
   - 「设为发布」→ 原子写带 `runtimes` 的 `winclaw-update.json`。
   - 客户端更新只拉瘦 exe；登录时若环境缺失再下环境包。

7. **发布前自检**：瘦 exe / 环境包 zip 都在 / 清单含 runtimes / url 是 `.67:8091` /
   两个 sha256 分别对得上 / 上传后 curl 清单带新版本且带 runtimes。

> 详细流程、示例与全部易错点见 `docs/发布包打包规范.md`。
