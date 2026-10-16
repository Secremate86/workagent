# 公开副本检查记录

检查日期：2026-10-16。环境：Windows、Node.js 24.21.0，临时复用本机开发副本的已安装依赖，未重新安装锁文件依赖。依赖目录与日志均不提交。

| 检查 | 结果 |
| --- | --- |
| TypeScript `tsc --noEmit` | 通过，退出码 0 |
| Python `unittest discover -s workers/office/tests` | 10 项通过 |
| ESLint | 17 个错误，全部为 `react-hooks/preserve-manual-memoization` |
| JavaScript 全量测试 | 已运行，出现失败后长时间未完成，人工中止；没有完整通过结论 |
| Docker 构建与浏览器验收 | 当前环境未执行 |

Lint 错误分布：`components/ChatInput.tsx` 6 个、`components/ChatMinimap.tsx` 5 个、`components/SkillsConfig.tsx` 1 个、`hooks/useAgentSession.ts` 5 个。这四个文件与输入源码内容一致，未在公开化过程中修改。

JavaScript 失败包含 Windows 绝对路径作为 ESM URL 导入时的 `ERR_UNSUPPORTED_ESM_URL_SCHEME`，以及 MCP、配置读写和界面断言失败。尚未逐项定位，不能将所有失败归因于环境，也不能将原部署环境的测试结果替代本次检查。

公开化只处理文件范围、文档、项目元数据与通用部署配置。现有代码问题仍需后续独立修复。
