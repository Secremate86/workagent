import { join } from "node:path";
import { createHash } from "node:crypto";
import { getAgentDir, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { readModelsConfig, writeModelsConfig } from "../models-config-store";
import { storeProviderCredential } from "../provider-credential-store";
import { writeDefaultPreferences } from "../default-preferences";
import { buildEnabledModelsInput, writeEnabledModels } from "../enabled-models-runtime";
import { setModelsEnabled } from "../enabled-models";
import { invalidateModelsCache } from "../models-cache";
import { OfficeError } from "./workspace";

export const QUICK_PROVIDER = "workagent-openai";
export type QuickModelInput = { baseUrl: string; modelId: string; apiKey: string; api: "openai-completions" | "openai-responses" };
export function quickProviderId(input: Pick<QuickModelInput, "baseUrl" | "api">) {
  return `${QUICK_PROVIDER}-${createHash("sha256").update(`${input.api}\0${new URL(input.baseUrl).toString()}`).digest("hex").slice(0, 12)}`;
}

export function parseQuickModel(value: unknown): QuickModelInput {
  if (!value || typeof value !== "object") throw new OfficeError("INVALID_REQUEST", "请填写模型配置信息");
  const body = value as Record<string, unknown>;
  const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim().replace(/\/+$/, "") : "";
  const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new OfficeError("INVALID_URL", "请输入完整 API 地址，例如 https://api.example.com/v1"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new OfficeError("INVALID_URL", "API 地址须为 HTTP 或 HTTPS，不包含密码、查询参数或片段");
  if (!modelId || modelId.length > 200 || /[\u0000-\u001f]/.test(modelId)) throw new OfficeError("INVALID_MODEL", "请填写有效的模型 ID");
  if (!apiKey || apiKey.length > 4096 || /[\r\n\0]/.test(apiKey)) throw new OfficeError("INVALID_KEY", "请填写有效的 API Key");
  if (body.api !== "openai-completions" && body.api !== "openai-responses") throw new OfficeError("INVALID_API", "请选择 Chat Completions 或 Responses 协议");
  return { baseUrl, modelId, apiKey, api: body.api };
}

/** Keep the literal credential in auth.json, never as executable config syntax in models.json. */
export async function saveQuickModel(value: unknown, agentDir = getAgentDir()) {
  const input = parseQuickModel(value);
  const providerId = quickProviderId(input);
  const modelsPath = join(agentDir, "models.json");
  // Read before touching auth: an unreadable model config must never be replaced.
  readModelsConfig(modelsPath);
  // Pi resolves config syntax inside auth.json too: escape user input as data.
  const literalKey = input.apiKey.split("$").join("$$").replace(/^!/, "$!");
  await storeProviderCredential(providerId, { type: "api_key", key: literalKey }, join(agentDir, "auth.json"));
  const config = readModelsConfig(modelsPath);
  const providers = config.providers && typeof config.providers === "object" && !Array.isArray(config.providers) ? config.providers as Record<string, unknown> : {};
  const old = providers[providerId];
  const provider = old && typeof old === "object" && !Array.isArray(old) ? old as Record<string, unknown> : {};
  const models = Array.isArray(provider.models) ? provider.models.filter(model => model && typeof model === "object" && (model as { id?: unknown }).id !== input.modelId) : [];
  // Deliberately omit estimated prices/context sizes. Pi owns provider defaults.
  const { apiKey: _oldConfigKey, ...rest } = provider;
  void _oldConfigKey;
  writeModelsConfig({ ...config, providers: { ...providers, [providerId]: { ...rest, name: new URL(input.baseUrl).host, baseUrl: input.baseUrl, api: input.api, models: [...models, { id: input.modelId, name: input.modelId }] } } }, modelsPath);
  const settings = SettingsManager.create(process.cwd(), agentDir);
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath, refreshOnCreate: false });
  if (runtime.getError()) throw new OfficeError("MODEL_CONFIG", "WorkAgent 无法读取已保存的模型，请检查高级模型设置", 422);
  const enabledInput = await buildEnabledModelsInput(settings.getGlobalSettings().enabledModels, await runtime.getAvailable());
  const edit = setModelsEnabled(enabledInput, [`${providerId}/${input.modelId}`], true);
  if (edit.ok && edit.changed) await writeEnabledModels(settings, edit.patterns);
  await writeDefaultPreferences(settings, { model: { provider: providerId, modelId: input.modelId } });
  invalidateModelsCache();
  return { success: true, provider: providerId, modelId: input.modelId, baseUrl: input.baseUrl, api: input.api };
}
