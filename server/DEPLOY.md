# 更新服务器部署说明（运维视角）

更新分发独立栈部署在 `hsai-workstation-01` = **`10.233.129.67:8091`**，与知识库 hs-rag（`8080`）**完全解耦**。
（内网还有 Git 服务器 `10.233.129.65:8800`，勿混用；注册中心占用 `8092`，勿混用。）

> 本机是 **snap 安装的 Docker**：守护进程对宿主机路径的 bind mount 受限（`/opt`、`/var`、`/tmp`
> 都只读），因此更新卷必须是**命名卷**、nginx.conf 必须烤进镜像。
> 服务器拉不到 Docker Hub：helper 容器用已缓存的 `node:22-alpine`，别用 `alpine`。

## 架构（独立栈，本仓库 `server/`）

| 容器 | 端口 | 挂载 | 职责 |
|------|------|------|------|
| `hsrag-update-nginx` | 宿主机 **8091** → 容器 80 | 卷 `server_winclaw-update:/data/winclaw-update:ro`；nginx.conf 烤进镜像（Dockerfile.nginx） | `/update/` 静态分发；`/` 代理到管理端（UI + API 同址） |
| `hsrag-update-admin` | 仅容器内 8091（不映射宿主机） | 卷 `server_winclaw-update:/data/winclaw-update:rw` | 上传/设为发布/删除/回滚 |

对外只有一个口：`http://10.233.129.67:8091`
- `/update/winclaw-update.json`、`/update/Hs-WinClaw-Setup-*.exe`、`/update/runtimes/*` → 客户端拉更新与环境包
- `/`（含 `/api/*`）→ 管理端 Web 控制台

**发布 = 管理端把该版本清单原子写进卷根的 `winclaw-update.json`**（清单 `url` 前缀 = `http://10.233.129.67:8091/update`）。
回滚 = 重新发布旧版本。

> 卷名注意：compose 顶层已显式 `name: server_winclaw-update`（见 `docker-compose.update.yml`），
> 无论从哪个目录起栈都能命中同一数据卷。旧 `hs-rag_winclaw-update` 卷是历史遗留，
> 数据已迁完，跑稳后可 `docker volume rm` 清理。

## 部署 / 更新栈

```bash
# 0) 拿仓库（首次）
git clone http://10.233.129.65:8800/yizhi.wang/winclaw-update.git /opt/winclaw-update

# 1) 起栈 / 改配置后重建（nginx.conf 烤进镜像，改完必须 --build）
cd /opt/winclaw-update && git pull
cd server && docker compose -f docker-compose.update.yml up -d --build

# 2) 验证
curl -i http://127.0.0.1:8091/update/winclaw-update.json   # 200 + Cache-Control: no-cache，body 以 {"version": 开头
curl -s  http://127.0.0.1:8091/healthz                     # ok（经 nginx 代理到管理端）
curl -s  http://127.0.0.1:8091/api/releases | head -c 300  # 列出版本，active 标记正确
```

> 改过 `WINCLAW_UPDATE_BASE_URL`（清单 url 前缀）后，已发布的清单里还是旧前缀，
> 需要重新点「设为发布」或：`curl -X POST http://127.0.0.1:8091/api/releases/<版本>/publish`。

## 灌数据（新版本发布包）

推荐：浏览器打开 `http://10.233.129.67:8091`。
- 内容更新：拖入标准发布包 zip（瘦 exe + `winclaw-update.json`，可选 `runtimes/`）→「设为发布」。
- **只补环境包**：把 `runtime-python-<stamp>.zip` 拖到「环境包仓库」区域即可，不必再带安装包。
  若当前已有发布版本，清单 `runtimes[]` 会立刻更新；客户端下次登录就能下载。
- **取回安装包**：发布列表每行版本号旁的「下载安装包」直接下载卷内的
  `Hs-WinClaw-Setup-<版本>.exe`（等价 `curl -O http://127.0.0.1:8091/update/Hs-WinClaw-Setup-<版本>.exe`），
  与是否「已发布」无关。

容器中转（宿主机有文件副本时）：

```bash
docker run -d --rm --name upd-helper -v server_winclaw-update:/d node:22-alpine sleep 3600
docker cp ~/Hs-WinClaw-Setup-x.y.z.exe upd-helper:/d/
docker rm -f upd-helper
curl -X POST http://127.0.0.1:8091/api/releases/x.y.z/publish
```

## 与知识库（hs-rag，8080）的关系

完全解耦：hs-rag 自己的 compose 只起 qdrant/backend/frontend/nginx（8080），不含任何更新分发组件；
更新栈也不代理任何知识库流量。WinClaw 客户端知识库接口仍指向 hs-rag 的
`http://10.233.129.67:8080`；更新清单指向本栈 `http://10.233.129.67:8091/update/...`。

## 客户端更新流程

1. 客户端每 24h（首启动约 8s）拉 `http://10.233.129.67:8091/update/winclaw-update.json`。
2. 清单 `version` 高于本地 → 提示更新 → 下载**瘦** exe → **SHA256 校验** → 静默重装 → 拉起新版本。
3. **每次登录**检查本地 Python 等环境；缺失则按清单 `runtimes[]` 下载 `/update/runtimes/runtime-python-<stamp>.zip`，不随内容更新重复下载。
4. 数据在安装目录外（`~/.hs-winclaw`、`%APPDATA%\HsWinClaw`），重装不丢。

## 易错点（历史踩坑）

- **卷前缀**：字面 `winclaw-update` 会挂到一个空的新卷 → nginx 404。compose 顶层已 `name: server_winclaw-update` 固定，不要手动改名。旧 `hs-rag_winclaw-update` 只作迁移源。
- **端口**：8080 = 知识库 hs-rag；8091 = 更新栈；8092 = 注册中心。三者互不相干，别混。
- **离线环境**：服务器拉不到 Docker Hub。helper 容器统一 `node:22-alpine`；
  compose 构建只 COPY 不联网，前提是 `nginx:alpine`/`node:22-alpine` 已在本地镜像缓存。
- 清单 `url`/客户端 `ManifestUrl` 曾误写 `10.233.129.65`（Git 服务器）→ 更新 404。源码已统一 `.67`。
- 已内置旧地址的旧安装包：新版本覆盖升级，或手动改安装目录 `appsettings.json`。
- 「发布包」必须标准 zip / 裸 exe，`Hs-WinClaw-Setup-*-update-package.zip` 不是 zip，上传会解析失败。
- 打包/发布规范见 `../spec/发布包打包规范.md`。
