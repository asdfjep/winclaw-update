# HoardSunAI 全量自动更新服务

本仓库向正式版 HoardSunAI 分发 **Windows x64 完整 NSIS 安装器**。预览与正式是同一产品的两个投放通道；独立安装的 WinClaw Preview 不通过本服务自动更新。

服务仍使用离线可构建的 Node 22 管理端、Nginx 静态分发和端口 `8091`。详细协议见 [HoardSunAI 全量更新服务契约](spec/winclaw2-full-update.md)；发布规范见 [发布包打包规范](spec/发布包打包规范.md)。

```text
客户端 ── GET /update/winclaw2/latest.yml?platform=windows-x86_64&channel=1|3
       └─ GET /update/winclaw2/releases/<releaseId>/<完整 EXE>
管理端 ── /api/v2/uploads、/api/v2/releases、/api/v2/channels
```

更新安装包从 `D:\winclaw2\winclaw2` 的 `scripts/winclaw-package-update.mjs` 生成。管理端先接收 `release.json` 与完整 EXE，校验后由管理员明确发布到 preview；验收后将同一不可变文件提升至 stable。上传本身不会更改客户端清单。服务不会生成、存储或提供 `.blockmap`、Web 安装器及补丁包。

管理页面打开后直接显示发布工作区，管理 API 不要求 Token。能访问 `8091` 的客户端都能操作发布，请在网络边界仅允许可信设备访问该端口。清单由通道指针即时生成，完整 EXE 由 Nginx 提供。私有指针、上传暂存和审计文件不在可下载目录内。

部署与迁移步骤见 [DEPLOY.md](server/DEPLOY.md)。本仓库原有的 WinClaw 1.x 代码已从活跃服务移除；迁移前先备份原命名卷，不把旧版安装包转发给 HoardSunAI 客户端。
