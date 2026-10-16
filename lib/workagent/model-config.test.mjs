import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
const jiti = createJiti(import.meta.url, { interopDefault: true });
const { parseQuickModel, saveQuickModel } = await jiti.import("./model-config.ts");
const base = { baseUrl: "http://127.0.0.1:59999/v1/", modelId: "test-fixture", apiKey: "!literal-$HOME-that-must-never-execute", api: "openai-completions" };
test("quick model stores a literal credential outside models.json and Pi resolves it", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "workagent-model-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "settings.json"), JSON.stringify({ enabledModels: ["other-provider/*"], defaultThinkingLevel: "medium" }));
  const saved = await saveQuickModel(base, dir);
  const configText = await readFile(path.join(dir, "models.json"), "utf8");
  assert.ok(!configText.includes(base.apiKey));
  const runtime = await ModelRuntime.create({ authPath: path.join(dir, "auth.json"), modelsPath: path.join(dir, "models.json"), refreshOnCreate: false });
  assert.equal(runtime.getError(), undefined);
  const model = runtime.getModel(saved.provider, base.modelId);
  assert.ok(model);
  assert.equal((await runtime.getAuth(model)).auth.apiKey, base.apiKey);
  assert.ok((await runtime.getAvailable()).some(model => model.provider === saved.provider && model.id === base.modelId));
  const settings = JSON.parse(await readFile(path.join(dir, "settings.json"), "utf8"));
  assert.equal(settings.defaultProvider, saved.provider);
  assert.equal(settings.defaultModel, base.modelId);
  assert.equal(settings.defaultThinkingLevel, "medium");
  assert.ok(settings.enabledModels.includes("other-provider/*"));
  assert.ok(settings.enabledModels.includes(`${saved.provider}/${base.modelId}`));
  assert.equal(parseQuickModel(base).baseUrl, "http://127.0.0.1:59999/v1");
});
test("adding a second endpoint preserves the first service's model, protocol and credential", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "workagent-model-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = await saveQuickModel(base, dir);
  const second = await saveQuickModel({ ...base, baseUrl: "http://127.0.0.1:59998/v1", modelId: "second-fixture", api: "openai-responses", apiKey: "second-literal-key" }, dir);
  assert.notEqual(first.provider, second.provider);
  const runtime = await ModelRuntime.create({ authPath: path.join(dir, "auth.json"), modelsPath: path.join(dir, "models.json"), refreshOnCreate: false });
  const firstModel = runtime.getModel(first.provider, base.modelId);
  const secondModel = runtime.getModel(second.provider, "second-fixture");
  assert.equal(firstModel.api, "openai-completions");
  assert.equal(firstModel.baseUrl, "http://127.0.0.1:59999/v1");
  assert.equal((await runtime.getAuth(firstModel)).auth.apiKey, base.apiKey);
  assert.equal(secondModel.api, "openai-responses");
  assert.equal((await runtime.getAuth(secondModel)).auth.apiKey, "second-literal-key");
});
test("quick model refuses malformed URLs, protocols, keys and missing model ids", () => {
  for (const override of [{ baseUrl: "file:///secrets" }, { baseUrl: "https://user:password@example.com" }, { api: "other" }, { apiKey: "" }, { apiKey: "a\nb" }, { modelId: "" }]) {
    assert.throws(() => parseQuickModel({ ...base, ...override }));
  }
});
