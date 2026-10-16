# Docker 部署

在仓库根目录执行，需要 Docker Engine 和 Compose：

```sh
cp .env.example .env
# 编辑 .env，为 PI_WEB_PASSWORD 填入长且唯一的密码
docker compose up -d --build
docker compose ps
docker compose logs --tail 100 workagent
```

访问 http://127.0.0.1:30142 ，使用 `.env` 中的密码登录。在头像菜单中自行配置模型服务地址、模型 ID、协议和 API Key。容器中的 `127.0.0.1` 指向容器自身；外部模型服务必须提供容器可访问的地址。

默认只向本机发布端口。远程访问可使用 SSH 端口转发：

```sh
ssh -L 30142:127.0.0.1:30142 user@your-server
```

也可自行配置带 HTTPS 的反向代理。不要提交 `.env`、模型凭据或运行数据。

数据保存在 Docker 命名卷 `workagent-data` 对应的 `/app/.workagent`。首次启动从空数据目录初始化，内置示例从源码安装。不附带模型密钥、历史聊天、记忆或定时任务。

停止服务用 `docker compose down`；不要加 `-v`，该选项会删除数据卷。升级前请先停服备份数据卷及 `.env`，再重建镜像。镜像构建需要访问 Node、Python、Debian 和 uv 的依赖源。可通过 `--build-arg DEBIAN_MIRROR=deb.debian.org` 选择 Debian 官方源。

本次公开化调整后的 Docker 镜像需在可联网的 Docker 环境中重新构建验证；原部署包的验收结果不代表此配置已通过验收。
