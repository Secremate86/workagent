---
name: workagent-office
description: 当用户要求扫描文件、核对两份表格或根据材料生成办公报告时，使用 WorkAgent 的确定性办公工具并交付可下载文件。
---

1. 查看用户引用的工作区文件。需要选择两张表时，先确认主键与比较规则；用户明确要求运行演示时，可使用内置 CSV 样例并标明样例数据。
2. 文件清单使用 `office_inventory`；两表核对使用 `office_reconcile`，传入相对路径和 `options.key`；报告先读取材料，再将有来源的正文作为 `options.content`、标题作为 `options.title` 传给 `office_report`。工具保留原始资料，结果写入 `outputs/`。
3. 根据工具返回的真实统计说明差异、异常和限制。金额和行数以工具结果为准；缺少资料时说明未知。
4. 完成时列出实际生成文件的 Markdown 链接，说明用户如何查看结果。失败时报告工具错误及可采取的下一步；收到成功结果前保持任务未完成。
