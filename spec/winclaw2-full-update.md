# WinClaw2 全量更新服务契约

本仓库仅服务正式版 WinClaw2 的 Windows x64 完整 NSIS 更新。`preview` 是正式产品内的投放通道；独立 Preview 身份不更新。

## 发布事实

- 不可变 release：`schemaVersion=1`、`product=winclaw2`、`appId=cn.hoardsun.winclaw2`、`version=2.x.y`、`platform=windows`、`arch=x64`、`packageType=nsis-full`、EXE 文件名、size、sha512（Base64）、unpackedSize、buildCommit、builtAt、releaseNotes。`releaseId=<version>-windows-x64`。
- 当前通道唯一事实：`private/channels/{stable|preview}.json`，包含 `revision`、`releaseId`、`previousReleaseId`、`publishedAt`。release 元数据和 EXE 不可变，YAML 只从两者生成。
- 同版同内容重复提交是幂等操作；同版不同 hash 返回 409。release 不含 channel，因此同一文件可从 preview 提升 stable。
- 写操作由单一 admin 进程串行提交。先持久化 EXE，最后提交 ready 元数据；仅 ready release 可发布。通道指针用同目录临时文件、fsync 与 rename 原子替换。发布、撤回都递增 revision；CAS 不符返回 409。

## API

管理写请求使用 `Authorization: Bearer <WINCLAW_ADMIN_TOKEN>`，未配置 token 则拒绝写操作。

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| POST | `/api/v2/uploads` | 收 release.json，创建短期上传会话 |
| PUT | `/api/v2/uploads/{id}/installer` | 流式收一个完整 EXE，边写边算 SHA512 |
| POST | `/api/v2/uploads/{id}/complete` | 验证后提交 ready release |
| GET | `/api/v2/releases` | 列出已就绪版本及通道引用 |
| GET | `/api/v2/channels` | 返回当前指针与 revision |
| POST | `/api/v2/channels/{channel}/publish` | `{releaseId,expectedRevision}` 发布 |
| POST | `/api/v2/channels/{channel}/restore` | `{expectedRevision}` 撤回到 previous |
| DELETE | `/api/v2/releases/{releaseId}` | 删除无通道引用且过保留期的资产 |

客户端读取 `/update/winclaw2/latest.yml?platform=windows-x86_64&channel=1|3`。缺省参数选择 Windows x64/stable；未知参数返回 400。无通道指针返回 404；指针损坏或文件缺失返回 503。客户端包 URL 为绝对 `/update/winclaw2/releases/<releaseId>/<exe>` 地址，SHA512 输出 Base64。

## 分发与失败

- Nginx 仅公开 `public/winclaw2/releases/` 下完整 EXE，精确代理 `latest.yml` 到 Node，保留查询参数。清单 no-store，EXE immutable 长缓存，HEAD 和标准 Range 由 Nginx 承担。
- private 中的暂存、release 元数据、指针、审计及旧版归档不得被 HTTP 静态路径访问。
- 上传不发布；断开、大小/哈希不符、空间不足不能形成 ready。失败暂存 24 小时后清理。一次上传会话只接收一次 PUT；complete 重试可幂等。
- 发布与删除冲突必须保护 current、previous 及离开引用后至少 30 天的历史版本。首期删除只允许管理员显式执行。
- 回切通道不使已安装客户端降级。已安装坏版本通过更高的 `2.x.y` 完整包修复。
- 单包限制 2 GiB，Nginx 与 Node 统一。Node 流式收包，不把整个 EXE 放进内存。

## 验收

验证原子发布、并发 CAS、上传中断及进程重启、同版哈希冲突、错误 query、私有文件不可达、完整 EXE 的 GET/HEAD/Range，以及 preview 到 stable 同包提升。用真实 Windows 客户端验证完整包下载与安装，不接受 `.blockmap` 或补丁包。
