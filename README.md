# WorkAgent

WorkAgent 是 [agegr/pi-web](https://github.com/agegr/pi-web) 的独立 fork，保留 MIT 许可证和原作者版权。上游介绍见 [Pi Web README](docs/PI_WEB_README.md)。

WorkAgent 是建立在 Pi Web 上的本地办公工作台。以 WorkBuddy 的功能和工作流程为参考，保留绿色品牌与清爽界面，支持 OpenAI 兼容模型、真实文件交付、权限审批、计划模式、子代理、轻量定时任务和显式长期记忆。

## 启动

需要 Node.js 22.19 或更新版本、pnpm、Python 3.12 或更新版本和 uv。在仓库根目录执行：

```sh
pnpm install
uv sync --locked
pnpm workagent
```

打开 [http://127.0.0.1:30141](http://127.0.0.1:30141)。服务默认只绑定本机回环地址。办公工具可以在没有模型密钥的情况下运行；聊天协作需要先配置模型。

WorkAgent 使用项目内的独立数据目录：

- `.workagent/agent`：本项目的 Pi 会话、模型配置和服务端凭据，与用户全局 Pi 配置隔离。
- `.workagent/workspace`：默认工作区、复制到工作区的匿名 CSV 示例和生成的文件。办公产物写入 `outputs/` 下各自的操作目录。
- `.workagent/uv-cache`：本项目启动脚本使用的 Python 依赖缓存。
- `.workagent/memory`：显式保存的记忆及删除恢复记录；不自动总结聊天，不启用 qmd。

## 配置模型

点击右上角的圆形头像打开快速配置。填写服务商提供的 API 地址、模型 ID、API Key，并选择 `Chat Completions` 或 `Responses` 协议，然后保存并使用。表单初始地址为 `https://api.openai.com/v1`，兼容服务商应替换为其实际地址和模型 ID。

API Key 由本机服务端写入 `.workagent/agent/auth.json`，不会保存到浏览器存储；模型地址、协议和模型 ID 保存在同目录的 Pi 配置中。快速配置还提供连接测试入口。已有完整的 Pi 模型设置仍可从“其他服务商与高级设置”打开。

首次启动不附带任何模型服务配置、API Key 或历史会话。请自行填写服务商信息。

## 本地办公工具

能力中心提供三个不依赖模型的操作：

- **生成文件清单**：清点默认工作区文件，生成 CSV 和 Markdown，不移动源文件。
- **核对示例表格**：按首列主键核对两份匿名 CSV，生成差异 XLSX、可预览的 CSV 和 Markdown 报告；会指出新增、缺失、修改和重复键。
- **生成示例文档**：按明确给出的标题和正文生成 Markdown 与 Word 文档，不补造业务信息。

成果面板可预览 CSV 和 Markdown、下载文件、在文件间开标签，并可全屏或拖动调整面板宽度。完整的 Pi 开发工作台保留在 `/advanced`，可手动输入地址访问；前端不再提供直接跳转按钮。

## 当前范围

顶栏“执行与自动化”管理执行模式、审批历史、定时任务与显式记忆。安全审查默认开启，高风险工具申请一次批准；默认放行需用户明确选择。计划模式阻止修改、系统命令和产物创建，定时与记忆的写入也由服务端阻止。

定时任务保存在默认工作区，只有已加载的活跃 Pi 会话负责投递；有待执行任务时该会话保持在线。仅启动 Web 服务不保证有调度会话，服务关闭期间不运行，恢复后可能补触发。界面显示实际调度状态与时区；触发时间不能当作任务成功完成的证明。

记忆只保存明确要求保留的偏好、事实和决策，支持新增、查看和按条删除；旧格式正文可读，语义搜索未启用。项目资料库、通用 Word/Excel 编辑及独立系统后台调度仍未实现。早期设计文档仅作方向参考，不代表其中所有功能都已批准或实现。


部署方法见 [Docker 部署](docs/deployment.md)，公开范围见 [发布说明](docs/public-release.md)。

### WorkAgent 目录与入口

项目配置、扩展、技能、MCP 和定时任务统一从 `.workagent` 读取；本项目服务端数据目录为 `.workagent/agent`。内置办公技能随源码放在 `resources/workagent-office`，启动后安装到工作区的 `.workagent/skills`。首次启动会迁移原项目配置、会话和定时任务，并在 `.workagent/migration-backups` 保留原目录备份；不会覆盖冲突的新文件，也不会再次恢复已删除的旧任务。聊天正文不会被改写。

首页和子代理详情不再提供跳转 `/advanced` 的入口；`/advanced` 路由保留，可手动输入地址访问。子代理详情在当前页面弹窗中查看。依赖包名称、模型协议和内部 SDK 标识保留兼容，目录探测使用真实的新路径。

SDK 配置适配在 `scripts/workagent-sdk-hooks.mjs` 中，按固定版本的配置契约加载，不修改 `node_modules`。使用 `pnpm workagent` 或 `pnpm dev` 启动；独立运行涉及 SDK 的测试时加上 `node --import ./scripts/workagent-sdk-hooks.mjs --test …`。
