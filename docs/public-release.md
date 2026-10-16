# 公开发布范围

WorkAgent 基于 [agegr/pi-web](https://github.com/agegr/pi-web)，上游基线为 `ac54e0153277d09a38ec1ef116a9f1f1c788765c`。保留上游基线提交、Git 继承关系与 MIT 许可证；本地输入仓库为浅克隆。WorkAgent 的功能扩展由本 fork 维护；上游贡献规则和介绍仅供了解上游，请向本 fork 报告 WorkAgent 问题。

公开版本包含应用源码、测试、匿名 CSV 示例、内置办公技能、Python worker、锁文件及通用 Docker 配置。

未导出部署包中的数据快照、聊天与子代理会话、模型与认证配置、记忆、定时任务、办公产物、测试记录、服务器操作脚本、交接与部署记录、导出清单和本机路径。依赖忽略规则防止运行数据被后续误提交；`.env.example` 只提供空密码字段。

源代码中的本机回环地址、临时测试路径和虚构凭据属于功能实现或测试夹具。扫描命中须结合上下文复核，不能仅凭字符串形状判断为真实凭据。

原部署环境的历史验证记录未作为公开版本验收证据。检查命令：

```sh
pnpm install --frozen-lockfile
uv sync --frozen
pnpm typecheck
pnpm lint
pnpm test
```

涉及真实模型的端到端验收需要自行配置模型和登录态。开发服务运行时不要在同一目录执行生产构建。
