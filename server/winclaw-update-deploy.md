# WinClaw 自动更新分发（服务器侧）

WinClaw 客户端内置"应用内自动更新"：启动后定期拉取更新清单，发现新版本即提示用户下载并静默升级。
服务器侧只需通过 Nginx 提供两个静态文件，hs-rag 的 API 代码零改动。

## 端点

客户端默认请求（WinClaw `HsWinClaw.Update.ManifestUrl`）：

```
http://<hs-rag-host>:8080/update/winclaw-update.json
```

`nginx.conf` 已配置 `location /update/`，把请求映射到容器内 `/data/winclaw-update/`，
该目录由 `docker-compose.yml` 以只读方式挂载自宿主机 `./winclaw-update/`。

## 发布新版本

WinClaw 仓库执行 `build_installer.bat` 后会在 `installer/` 目录产出：

- `Hs-WinClaw-Setup-<版本>.exe` — 安装包
- `winclaw-update.json` — 更新清单（含版本号、下载 URL、SHA256、更新说明）

把这两个文件上传到服务器的 `winclaw-update/` 目录即可：

```bash
scp installer/Hs-WinClaw-Setup-*.exe installer/winclaw-update.json <server>:<hs-rag>/winclaw-update/
```

> `winclaw-update.json` 里的 `url` 字段默认指向
> `http://10.233.129.67:8080/update/Hs-WinClaw-Setup-<版本>.exe`，
> 部署地址不同时需要相应修改（gen_update_manifest.ps1 支持 `-BaseUrl` 参数）。

上传后无需重启容器，静态文件即时生效；manifest 响应带 `Cache-Control: no-cache`，客户端每次都会重新检查。

## 清单格式

```json
{
  "version": "1.3.1",
  "url": "http://<host>:8080/update/Hs-WinClaw-Setup-1.3.1.exe",
  "sha256": "<安装包 SHA256>",
  "notes": "- 更新说明（git log 自动生成）",
  "mandatory": false,
  "publishedAt": "2026-08-13"
}
```

| 字段 | 说明 |
|---|---|
| version | 新版本号 X.Y.Z，大于客户端当前版本才提示更新 |
| url | 安装包下载地址 |
| sha256 | 安装包哈希，客户端下载后强制校验，不一致即中止且不执行安装 |
| notes | 更新说明，显示在客户端横幅里 |
| mandatory | true 时横幅不可关闭（用于必须修复的严重问题） |

## 目录结构

```
winclaw-update/
├── winclaw-update.json          # 当前最新版本的清单
└── Hs-WinClaw-Setup-1.3.1.exe   # 对应的安装包
```

旧版本安装包可以保留在目录中（不影响分发），也可以定期清理——清单 `url` 指向哪个就下载哪个。

## 首次部署

```bash
cd <hs-rag>
mkdir -p winclaw-update
docker compose up -d --build nginx
```

验证：

```bash
curl -i http://127.0.0.1:8080/update/winclaw-update.json
# 期望 200 + Cache-Control: no-cache
```
