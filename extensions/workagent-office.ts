import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeOffice, type OfficeOperation } from "../lib/workagent/office";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export default function workagentOffice(pi: ExtensionAPI) {
  const tools: { operation: OfficeOperation; label: string; description: string }[] = [
    { operation: "inventory", label: "整理文件清单", description: "扫描 WorkAgent 工作区并生成可下载的文件清单；inputs 可传一个工作区内相对目录，默认扫描整个工作区。只读扫描，不移动或修改输入。" },
    { operation: "reconcile", label: "核对两份表格", description: "核对工作区内两份 CSV/XLSX，保留输入，生成差异表与汇总。inputs 为相对路径；省略时使用两份演示样例。options.key 指定主键字段。" },
    { operation: "report", label: "生成办公报告", description: "将 options.title 和 options.content 转成实际 Markdown/DOCX 报告文件。先读取并总结用户材料，把有来源的报告正文放入 options.content；本工具不自动读取 inputs。" },
  ];
  for (const tool of tools) {
    pi.registerTool({
      name: `office_${tool.operation}`, label: tool.label, description: tool.description,
      promptSnippet: tool.description,
      parameters: Type.Object({
        inputs: Type.Optional(Type.Array(Type.String(), { maxItems: tool.operation === "inventory" ? 1 : 20, description: tool.operation === "inventory" ? "工作区内待扫描目录的相对路径，默认 ." : "工作区内文件的相对路径" })),
        options: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      }),
      annotations: { destructiveHint: false, openWorldHint: false },
      executionMode: "parallel",
      async execute(_id, params, signal, _onUpdate, ctx) {
        const result = await executeOffice({ operation: tool.operation, ...params }, { root, cwd: ctx.cwd, signal });
        return { content: [{ type: "text", text: `${result.summary}\n${result.artifacts.map((artifact) => `[${artifact.name}](${artifact.path.replace(/\\/g, "/")})`).join("\n")}\n${JSON.stringify(result.details)}` }], details: result };
      },
    });
  }
}
