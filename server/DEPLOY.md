# HoardSunAI 更新服务部署与迁移

更新服务与知识库分离，对外使用 `8091`。部署由管理员在目标服务器执行；开发和测试不执行发布或上传。

## 上线前备份

先确认现有 `server_winclaw-update` 命名卷及旧版当前清单，完整备份该卷和当前 Compose 配置。旧 WinClaw 1.x 的清单、安装包、运行包及元数据只做离线归档；新 Nginx 配置不再对外提供旧版更新 URL，也不会把旧安装包重定向到 HoardSunAI。

目标服务器使用 snap Docker，保留固定命名卷名 `server_winclaw-update`；`node:22-alpine` 与 `nginx:alpine` 镜像应已在本地缓存。管理页面和 API 不要求 Token，因此必须在网络边界将 `8091` 限制到可信设备。

## 部署

1. 备份旧卷，暂停旧 update-admin 写入进程，确保同一卷只有一个管理员写进程。
2. 构建并启动 `server/docker-compose.update.yml`；离线构建只复制仓库文件，不调用 npm。
3. 检查 `/healthz`、管理页面、无 Token 的 `/api/v2/releases` 返回 200，以及 `/update/` 下旧版路径返回 404。
4. 验证新清单精确代理与 query 参数；发布前 stable/preview 均应显示暂无版本。
5. 上传完整包到 preview，在真实 Windows 安装客户端验证，再提升同一包到 stable。

## 分发路径与缓存

- `GET /update/winclaw2/latest.yml?platform=windows-x86_64&channel=1|3` 经 Nginx 代理到 Node，`Cache-Control: no-store`。
- `GET/HEAD /update/winclaw2/releases/<releaseId>/<exe>` 经 Nginx 直接读取 `public/winclaw2/releases/`，支持标准 Range；不可变文件可长缓存。
- `private/` 与 `legacy-archive/` 不在任何公开 alias 中。上传暂存 24 小时后清理。
- 单包上限 2 GiB，Nginx 与 Node 都执行限制。根据实际完整包和解包体积评估卷、上传暂存及客户端空间。

## 运维与恢复

- 发布和撤回需要最新 revision，冲突返回 409；刷新管理页面后重新确认目标版本。
- 撤回只更换通道指针，不会卸载已升级的客户端。修复已安装版本时发布更高 `2.x.y` 完整包。
- 代码部署故障可恢复旧镜像与备份配置；数据卷恢复必须与对应程序版本和指针结构配套，避免覆盖新发布事实。
- 历史完整 EXE 在离开所有通道引用后至少保留 30 天；当前及 previous 引用始终禁止删除。删除由管理员显式执行。
- 健康检查和审计分别位于 `/healthz` 与私有 `audit.jsonl`；审计用于追踪操作，通道 pointer 才是当前发布事实。

上线验证应覆盖：完整上传失败不改指针、preview 与 stable 隔离、同版异内容拒绝、Nginx GET/HEAD/Range、错误参数不落到 stable、撤回后旧版本仍保留，以及实际 Windows 客户端的全量下载安装。
