# 更新服务器部署说明（运维视角）

更新服务器 == 知识库 web 登录服务器 `hsai-workstation-01` = **`10.233.129.67:8080`**
（内网还有 Git 服务器 `10.233.129.65:8800`，勿混用）。

> 本机是 **snap 安装的 Docker**：守护进程对宿主机路径的 bind mount 受限（`/opt`、`/var`、`/tmp`
> 都只读），因此更新卷必须是**命名卷**。普通 Docker 主机可改用 `./winclaw-update` bind mount。

## 一卷两挂

| 容器 | 挂载 | 说明 |
|------|------|------|
| nginx（8080） | `winclaw-update:/data/winclaw-update:ro` | 只读供客户端拉取 |
| update-admin（8091） | `winclaw-update:/data/winclaw-update:rw` | 读写管理 |

**发布 = 管理端把该版本清单原子写进卷根的 `winclaw-update.json`**，nginx 对外路径不变（`/update/`）。
回滚 = 重新发布旧版本。

## 常用操作

```bash
# 查更新卷真实名字（snap 下 compose 命名卷带 hs-rag_ 前缀，易错！）
docker inspect hsrag-nginx --format '{{range .Mounts}}{{if eq .Destination "/data/winclaw-update"}}{{.Name}}{{end}}{{end}}'
# 预期输出：hs-rag_winclaw-update（字面 winclaw-update 会挂到另一个空卷→nginx 404）

# 手工放文件进命名卷（shell 直写宿主机路径权限不够，用容器中转）
VOL=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data/winclaw-update"}}{{.Name}}{{end}}{{end}}' hsrag-nginx)
docker run -d --rm --name upd-helper -v $VOL:/d alpine sleep 3600
docker cp ~/Hs-WinClaw-Setup-x.y.z.exe upd-helper:/d/
docker rm -f upd-helper

# 重建 nginx（nginx.conf 在镜像里，必须 --build 才会带进新配置）
docker compose up -d --build nginx
```

## 管理端（update-admin，8081 已被宿主 python 占用——**统一用 8091**）

```bash
docker compose up -d --build update-admin
curl -s http://127.0.0.1:8091/healthz       # ok
curl -s http://127.0.0.1:8091/api/releases   # 列出版本 + active 标记
curl -s 放行：sudo ufw allow 8091/tcp        # 若不放开，外网 8091 访问不通
```

改端口/服务段后若要生效：compose 是 skip-worktree 的，`git pull` 不会更新它——
要么 `sudo git update-index --no-skip-worktree docker-compose.yml && git checkout docker-compose.yml`
采用仓库版，要么直接 `sudo sed -i 's/8081:8081/8091:8091/' docker-compose.yml` 就地改后
`docker compose up -d --force-recreate update-admin`。

## 客户端更新流程

1. 客户端每 24h（首启动约 8s）拉 `http://10.233.129.67:8080/update/winclaw-update.json`。
2. 清单 `version` 高于本地 → 提示更新 → 下载 exe → **SHA256 校验** → 静默重装 → 拉起新版本。
3. 数据在安装目录外（`~/.hs-winclaw`、`%APPDATA%\HsWinClaw`），重装不丢。

## 易错点（历史踩坑）

- 清单 `url`/客户端 `ManifestUrl` 曾误写 `10.233.129.65`（Git 服务器）→ 更新 404。源码已统一 `.67`。
- 已内置 `.65` 的旧安装包：新版本覆盖升级，或手动改安装目录 `appsettings.json`。
- 「发布包」必须标准 zip / 裸 exe，`Hs-WinClaw-Setup-*-update-package.zip` 不是 zip，上传会解析失败。
- 打包/发布规范见 `../spec/发布包打包规范.md`。