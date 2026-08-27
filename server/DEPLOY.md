# 更新服务器部署说明（运维视角）

更新服务器 == 知识库 web 登录服务器 `hsai-workstation-01` = **`10.233.129.67:8080`**
（内网还有 Git 服务器 `10.233.129.65:8800`，勿混用）。

> 本机是 **snap 安装的 Docker**：守护进程对宿主机路径的 bind mount 受限（`/opt`、`/var`、`/tmp`
> 都只读），因此更新卷必须是**命名卷**。普通 Docker 主机可改用 `./winclaw-update` bind mount。

## 架构（独立栈，本仓库 `server/`）

| 容器 | 端口 | 挂载/网络 | 职责 |
|------|------|-----------|------|
| `hsrag-update-nginx` | 8080 | 卷 `server_winclaw-update:/data/winclaw-update:ro`；nginx.conf 烤进镜像（Dockerfile.nginx）；外部网络 `hs-rag_default` | `/update/` 静态分发 + 其余路径代理到 hs-rag（知识库 Web 登录/API） |
| `hsrag-update-admin` | 8091 | 卷 `server_winclaw-update:/data/winclaw-update:rw` | 上传/设为发布/删除/回滚 |

**8080 唯一入口**：`/update/` 走静态卷；`/api/`、`/_next/` 及其余路径按服务名
`backend:5000` / `frontend:3000` 代理进 hs-rag 的 compose 网络。
因此**起本栈前必须停掉 hs-rag 的 `hsrag-nginx`**（它原来占着 8080），否则端口冲突。

**发布 = 管理端把该版本清单原子写进卷根的 `winclaw-update.json`**，nginx 对外路径不变（`/update/`）。
回滚 = 重新发布旧版本。

> 卷名注意：snap-Docker 下命名卷带 compose 项目前缀。本栈项目名 = `server`
> （compose 文件所在目录名），卷实际叫 **`server_winclaw-update`**；
> 旧 hs-rag 项目的卷叫 `hs-rag_winclaw-update`。两卷数据不互通，迁移见下。

## 从 /opt/hs-rag 现状迁移到独立栈

```bash
# 0) 拿仓库
git clone http://10.233.129.65:8800/yizhi.wang/winclaw-update.git /opt/winclaw-update

# 1) 确认 hs-rag 网络名（compose 里 external network 要一致）
docker network ls | grep hs-rag        # 预期 hs-rag_default；不同就改 docker-compose.update.yml

# 2) 停旧容器，让出 8080/8091
docker rm -f hsrag-nginx hsrag-update-admin

# 3) 起独立栈（admin/nginx 镜像均只 COPY，命中本地缓存可离线构建）
cd /opt/winclaw-update/server
docker compose -f docker-compose.update.yml up -d --build

# 4) 灌数据（二选一）：
#    A) 推荐：浏览器打开 http://10.233.129.67:8091，拖入标准发布包 zip
#       （WinClaw-<版本>-发布包.zip，内含 exe + winclaw-update.json）→「设为发布」。
#       管理端自己算 SHA256、写清单，一步到位。
#    B) 容器中转（旧 admin 容器还活着、或宿主机有文件副本时）：
docker run -d --rm --name upd-migrate -v server_winclaw-update:/dst node:22-alpine sleep 3600
docker cp hsrag-update-admin:/data/winclaw-update/. upd-migrate:/dst/   # 旧容器层导出；或 cp 宿主机路径
#   旧卷若有数据一并合并：docker run --rm -v hs-rag_winclaw-update:/src:ro -v server_winclaw-update:/dst node:22-alpine cp -a /src/. /dst/
docker exec upd-migrate ls -l /dst     # 确认有 Hs-WinClaw-Setup-<ver>.exe
docker rm -f upd-migrate
#    B 方式灌完裸文件后还需「设为发布」：curl -X POST http://127.0.0.1:8091/api/releases/<版本>/publish

# 5) 验证
curl -i http://127.0.0.1:8080/update/winclaw-update.json   # 200 + Cache-Control: no-cache，body 以 {"version": 开头
curl -s  http://127.0.0.1:8080/api/knowledge-bases | head -c 200   # hs-rag 的 JSON/401，不能是 nginx 404 或 HTML
curl -s  http://127.0.0.1:8091/healthz                     # ok
curl -s  http://127.0.0.1:8091/api/releases | head -c 300  # 列出版本，active 标记正确
```

> ⚠️ 顺序注意：若旧 admin 容器层里还有要保留的数据（它历史上没挂卷），
> 必须在第 2 步删容器**之前**用 B 方式 docker cp 导出，删了就找不回来了。

旧卷 `hs-rag_winclaw-update` 先留着当备份，独立栈跑稳后再 `docker volume rm` 清理。
`/opt/hs-rag` 的 compose 里仍留有 nginx/update-admin 的服务定义，**不要再在那里 `up` 这两个服务**
（会抢 8080/8091）；想干净就编辑掉对应段落。

## 常用操作

```bash
# 查更新卷真实名字（别想当然写字面名）
docker inspect hsrag-update-nginx --format '{{range .Mounts}}{{if eq .Destination "/data/winclaw-update"}}{{.Name}}{{end}}{{end}}'

# 手工放文件进命名卷（shell 直写宿主机路径权限不够，用容器中转）
VOL=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data/winclaw-update"}}{{.Name}}{{end}}{{end}}' hsrag-update-nginx)
docker run -d --rm --name upd-helper -v $VOL:/d node:22-alpine sleep 3600
docker cp ~/Hs-WinClaw-Setup-x.y.z.exe upd-helper:/d/
docker rm -f upd-helper

# 改 nginx.conf：snap-Docker 不能 bind mount，配置烤进镜像，改完必须重建
docker compose -f docker-compose.update.yml up -d --build nginx

# 改 admin 代码/环境：需要重建镜像
docker compose -f docker-compose.update.yml up -d --build update-admin
```

## 管理端（update-admin，8081 已被宿主 python 占用——**统一用 8091**）

```bash
curl -s http://127.0.0.1:8091/healthz       # ok
curl -s http://127.0.0.1:8091/api/releases   # 列出版本 + active 标记
curl -s 放行：sudo ufw allow 8091/tcp        # 若不放开，外网 8091 访问不通
```

## 客户端更新流程

1. 客户端每 24h（首启动约 8s）拉 `http://10.233.129.67:8080/update/winclaw-update.json`。
2. 清单 `version` 高于本地 → 提示更新 → 下载 exe → **SHA256 校验** → 静默重装 → 拉起新版本。
3. 数据在安装目录外（`~/.hs-winclaw`、`%APPDATA%\HsWinClaw`），重装不丢。

## 易错点（历史踩坑）

- **卷前缀**：字面 `winclaw-update` 会挂到一个空的新卷 → nginx 404。必须用 `docker volume ls` 看到的带前缀真名。
- **离线环境**：服务器拉不到 Docker Hub（`alpine:latest` 会超时）。helper 容器统一用已缓存的
  `node:22-alpine`；compose 构建只 COPY 不联网，前提是 `nginx:alpine`/`node:22-alpine` 已在本地镜像缓存。
- **8080 冲突**：独立栈 nginx 与 hs-rag 的 `hsrag-nginx` 只能活一个。
- **网络名**：compose 里 `hsrag` external 网络写死 `hs-rag_default`，hs-rag 项目名变了要同步改。
- 清单 `url`/客户端 `ManifestUrl` 曾误写 `10.233.129.65`（Git 服务器）→ 更新 404。源码已统一 `.67`。
- 已内置 `.65` 的旧安装包：新版本覆盖升级，或手动改安装目录 `appsettings.json`。
- 「发布包」必须标准 zip / 裸 exe，`Hs-WinClaw-Setup-*-update-package.zip` 不是 zip，上传会解析失败。
- 打包/发布规范见 `../spec/发布包打包规范.md`。
