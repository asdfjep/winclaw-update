# WinClaw 自动更新体系

WinClaw 桌面智能体的**自动更新分发**，含客户端拉取、服务器分发、Web 管理端、打包规范四部分。
与知识库（hs-rag，8080）**完全解耦**。内网部署：服务器 `10.233.129.67`，对外唯一端口 **8091**。

```
[客户端 WinClaw] --每24h拉-->  [nginx :8091]
                                ├─ /update/ --ro-- [命名卷 winclaw-update]
                                └─ /（UI + /api）--> [update-admin 容器内 :8091] --rw-- 同一命名卷
                                                        (上传/选定发布/删除/回滚)
```

## 组成

| 目录 | 内容 |
|------|------|
| `admin/` | 更新管理端：零依赖 Node 服务（`http`/`fs`/`crypto`/`zlib`，无 package.json）+ 原生单页前端 |
| `server/` | 服务器部署：独立 compose、nginx 配置（烤进镜像）、部署运维文档 |
| `client/` | 客户端侧参考：更新服务代码、构建/清单脚本（`build_installer.bat`、`gen_update_manifest.ps1`） |
| `spec/` | **发布包打包规范**（唯一权威）+ 内置技能 `release-package-skill` |

## 核心机制

- **客户端只认 `winclaw-update.json`**：`{version, url, sha256, notes, mandatory, publishedAt, runtimes}`。
  "选定发布" = 管理端把该版本清单原子写进卷根，客户端在下一检查周期拉取**内容更新**；
  `runtimes[]` 指向共享环境包（`/update/runtimes/runtime-python-<stamp>.zip`），登录时缺失才下载。
- 上传发布包 zip 后管理端**自动分流**环境包到 `/runtimes/`（同 stamp 去重），安装包只保留程序内容。
- 也可在管理端**单独上传** `runtime-python-<stamp>.zip`（`POST /api/runtimes`）；若已有发布版本，会立刻刷新清单里的 `runtimes[]`。
- **回滚 = 重新发布旧版本**；当前发布版本受删除保护。
- **离线可构建**：服务器无法访问外网（Docker Hub 超时），admin 仅用 Node 内建模块、
  根镜像（`node:22-alpine`/`nginx:alpine`）命中本地缓存，`compose build` 只 COPY 不联网。

## 快速开始

```bash
# 1) 服务器上部署分发栈（snap-Docker：命名卷 + 配置烤进镜像）
docker compose -f server/docker-compose.update.yml up -d --build

# 2) 打包（在 WinClaw 产品仓库）：
#    VERSION 升版 → build_installer.bat → 产出瘦安装包 + runtimes/环境包 + winclaw-update.json
#    →（可选）打成含 runtimes/ 的标准 zip

# 3) 浏览器打开 http://10.233.129.67:8091
#    拖拽 zip（或裸 exe）→「设为发布」→ 客户端 24h 内自动更新
```

部署、验证、易错点见 [`server/DEPLOY.md`](server/DEPLOY.md)。

## 维护注意

- 发布包/zip 打包方式、字段要求、自检清单见 [`spec/发布包打包规范.md`](spec/发布包打包规范.md)。
- 服务器部署细节与历史易错点见 [`server/DEPLOY.md`](server/DEPLOY.md)。
- 客户端更新逻辑参考 [`client/UpdateService.cs`](client/UpdateService.cs) 与 `client/` 构建脚本。

> 供之后 WinClaw 对话 LLM：用户提到「打发布包/打包/发布版本/生成安装包」时，
> 按 `spec/` 里的规范执行（也可作为技能 `release-package-skill` 挂到客户端技能目录）。
