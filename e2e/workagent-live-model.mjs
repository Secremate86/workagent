import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const baseUrl = (process.env.WORKAGENT_URL ?? "http://127.0.0.1:30141").replace(/\/$/, "");
const timeoutMs = 120_000;
const expectedArtifacts = ["differences.csv", "differences.xlsx", "report.md"];
const message = "本地验收：核对内置两份CSV，调用office_reconcile，勿修改源文件，不用其他工具。请以“编号”为主键，完成后根据工具返回报告真实差异数量。";

async function requestJson(path, init) {
  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(15_000),
      headers: { ...(init?.headers ?? {}), ...(init?.body ? { "content-type": "application/json" } : {}) },
    });
  } catch {
    throw new Error(`Request failed for ${path}`);
  }
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error(`${path} returned invalid JSON`);
  }
}

async function getSession(sessionId) {
  return requestJson(`/api/sessions/${encodeURIComponent(sessionId)}?tail=100`);
}

function messagesOf(session) {
  return Array.isArray(session?.context?.messages) ? session.context.messages : [];
}

function findToolExecution(messages, toolName) {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (let blockIndex = message.content.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const call = message.content[blockIndex];
      if (call?.type !== "toolCall" || call.toolName !== toolName || !call.toolCallId) continue;
      const result = messages.find(candidate => candidate?.role === "toolResult"
        && candidate.toolCallId === call.toolCallId
        && (!candidate.toolName || candidate.toolName === toolName));
      return result ? { call, result } : null;
    }
  }
  return null;
}

function encodeAbsolutePathForFilesApi(filePath) {
  return filePath.replace(/\\/g, "/").split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

async function readPathOverHttp(filePath, filename, { expectedText = [], binary = false } = {}) {
  const fileRequestType = binary ? "download" : "read";
  const path = `/api/files/${encodeAbsolutePathForFilesApi(filePath)}?type=${fileRequestType}`;
  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new Error(`Artifact ${filename} could not be read over HTTP`);
  }
  if (!response.ok) throw new Error(`Artifact ${filename} returned HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.ok(bytes.byteLength > 0, `Artifact ${filename} was empty over HTTP`);
  if (binary) {
    assert.equal(bytes[0], 0x50, `${filename} download is missing the ZIP signature`);
    assert.equal(bytes[1], 0x4b, `${filename} download is missing the ZIP signature`);
  } else {
    let preview;
    try { preview = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw new Error(`Artifact ${filename} returned an invalid text preview`); }
    assert.equal(typeof preview.content, "string", `Artifact ${filename} did not return readable text`);
    assert.ok(preview.content.length > 0, `Artifact ${filename} had an empty text preview`);
    for (const text of expectedText) assert.ok(preview.content.includes(text), `Artifact ${filename} is missing expected text`);
    return preview.content;
  }
}

function artifactsFromToolResult(execution, expectedNames, startedAt) {
  assert.ok(execution, "Session history is missing the expected office tool call or tool result");
  assert.notEqual(execution.result.isError, true, "Office tool result reports an error");
  const artifacts = execution.result.details?.artifacts;
  assert.ok(Array.isArray(artifacts), "Tool result did not persist details.artifacts");
  const selected = expectedNames.map(name => {
    const artifact = artifacts.find(item => item?.name === name);
    assert.ok(artifact?.path, `Tool result details.artifacts is missing ${name}`);
    assert.ok(Date.parse(artifact.modified) >= startedAt - 2_000, `Tool result artifact ${name} is not from this operation`);
    return artifact;
  });
  assert.equal(new Set(selected.map(item => item.path.replace(/[\\/][^\\/]+$/, ""))).size, 1,
    "Tool result artifacts were not created by one operation");
  return selected;
}

async function postPrompt(sessionId, prompt) {
  const path = `/api/agent/${encodeURIComponent(sessionId)}`;
  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "prompt", message: prompt }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error("Prompt request failed before an HTTP response");
  }
  let body = {};
  try { body = await response.json(); } catch { /* Keep diagnostics bounded to HTTP metadata. */ }
  const code = typeof body.code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(body.code) ? body.code : null;
  const errorText = typeof body.error === "string" ? body.error.toLowerCase() : "";
  const errorCategory = /timeout|timed out/.test(errorText) ? "timeout"
    : /api.?key|unauthori[sz]ed|authentication|\b401\b/.test(errorText) ? "auth_error"
      : /fetch|econn|network|socket/.test(errorText) ? "network_error"
        : /abort|cancel/.test(errorText) ? "aborted"
          : errorText ? "server_error" : null;
  return {
    success: response.ok && body.success === true,
    status: response.status,
    accepted: body.accepted === true,
    code,
    errorCategory,
  };
}

async function waitForSessionIdle(sessionId, expectedUserCount) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [running, state, session] = await Promise.all([
      requestJson("/api/agent/running"),
      requestJson(`/api/sessions/${encodeURIComponent(sessionId)}/state`),
      getSession(sessionId),
    ]);
    const active = [...(running.runningSessionIds ?? []), ...(running.awaitingInputSessionIds ?? [])].includes(sessionId)
      || state.running === true && (state.state?.isPromptRunning === true || state.state?.isStreaming === true);
    const messages = messagesOf(session);
    const users = messages.filter(message => message?.role === "user");
    const lastUserIndex = messages.map(message => message?.role).lastIndexOf("user");
    const lastAssistant = messages.slice(lastUserIndex + 1).findLast(message => message?.role === "assistant");
    if (!active && users.length >= expectedUserCount && lastAssistant?.stopReason && lastAssistant.stopReason !== "toolUse") return session;
    await new Promise(resolve => setTimeout(resolve, 750));
  }
  throw new Error("Session did not become idle with a completed assistant reply within 120 seconds");
}

function assertPromptSettled(action, response) {
  if (response.success) return;
  if (response.status >= 400) {
    console.warn(`WARN persisted-session-result=${action} http=${response.status} accepted=${response.accepted} code=${response.code ?? "none"} error=${response.errorCategory ?? "unclassified"}; HTTP submission did not pass`);
    return;
  }
  throw new Error(`${action} prompt returned HTTP ${response.status} without success`);
}

async function readExampleHashes(cwd, exampleInputs) {
  const hashes = new Map();
  for (const filename of exampleInputs.slice(0, 2)) {
    const absolutePath = `${cwd.replace(/[\\/]$/, "")}/${filename}`;
    const preview = await readPathOverHttp(absolutePath, filename);
    hashes.set(filename, createHash("sha256").update(preview).digest("hex"));
  }
  return hashes;
}

async function main() {
  const bootstrap = await requestJson("/api/workagent/bootstrap");
  assert.equal(bootstrap.officeReady, true, "Office worker is not ready");
  assert.ok(bootstrap.cwd && Array.isArray(bootstrap.exampleInputs) && bootstrap.exampleInputs.length >= 2,
    "WorkAgent bootstrap did not provide a workspace and two example CSV files");
  if (bootstrap.needsTrust || bootstrap.projectTrust?.trusted !== true) {
    throw new Error("Project trust is missing for the WorkAgent workspace; no trust setting was changed.");
  }

  const models = await requestJson(`/api/models?cwd=${encodeURIComponent(bootstrap.cwd)}`);
  const model = models.defaultModel;
  assert.ok(model?.provider && model?.modelId, "There is no default model configured for the WorkAgent workspace");
  assert.ok(Array.isArray(models.modelList)
    && models.modelList.some(candidate => candidate.provider === model.provider && candidate.id === model.modelId),
  "The configured default model is not available in the WorkAgent model list");
  const sampleHashesBefore = await readExampleHashes(bootstrap.cwd, bootstrap.exampleInputs);

  const startedAt = Date.now();
  let currentSessionId = process.env.WORKAGENT_SESSION_ID ?? null;
  let latestSession = null;
  if (currentSessionId) {
    latestSession = await getSession(currentSessionId);
    latestSession = await waitForSessionIdle(currentSessionId, messagesOf(latestSession).filter(message => message?.role === "user").length);
    assert.ok(findToolExecution(messagesOf(latestSession), "office_reconcile"),
      "WORKAGENT_SESSION_ID does not contain a persisted office_reconcile call and result");
  } else {
    const before = await requestJson("/api/agent/running");
    const runningBefore = new Set([...(before.runningSessionIds ?? []), ...(before.awaitingInputSessionIds ?? [])]);
    const deadline = Date.now() + timeoutMs;
    const promptRequest = requestJson("/api/agent/new", {
      method: "POST",
      body: JSON.stringify({
        cwd: bootstrap.cwd,
        type: "prompt",
        provider: model.provider,
        modelId: model.modelId,
        message,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // The route replies after prompt() settles. Meanwhile runningSessionIds lets us
    // inspect the new session's live state and history over the regular APIs.
    let created = null;
    let promptResponse = null;
    let promptError = null;
    void promptRequest.then(value => { promptResponse = value; }).catch(() => { promptError = "Prompt request failed"; });

    while (Date.now() < deadline) {
      if (promptError) throw new Error(promptError);
      if (promptResponse) {
        created = promptResponse;
        currentSessionId = created.sessionId;
      }

      try {
        const running = await requestJson("/api/agent/running");
        if (!currentSessionId) {
          currentSessionId = [...(running.runningSessionIds ?? []), ...(running.awaitingInputSessionIds ?? [])]
            .find(id => !runningBefore.has(id)) ?? null;
        }
        if (currentSessionId) {
          const [state, session] = await Promise.all([
            requestJson(`/api/sessions/${encodeURIComponent(currentSessionId)}/state`),
            getSession(currentSessionId),
          ]);
          latestSession = session;
          const reconcileExecution = findToolExecution(messagesOf(session), "office_reconcile");
          const isStillRunning = (running.runningSessionIds ?? []).includes(currentSessionId)
            || (running.awaitingInputSessionIds ?? []).includes(currentSessionId)
            || state.running === true && state.state?.isPromptRunning === true;
          if (reconcileExecution && !isStillRunning && promptResponse) break;
        }
      } catch {
        // A just-created session may not have a persisted row on its first poll.
      }
      await new Promise(resolve => setTimeout(resolve, 750));
    }

    created ??= promptResponse;
    currentSessionId = created?.sessionId ?? currentSessionId;
    if (!created || !currentSessionId) throw new Error("Prompt did not create a session before the 120 second deadline");
    assert.equal(created.success, true, "Prompt route did not report success");
    assert.equal(created.model?.provider, model.provider, "New session used a different provider than the configured default");
    assert.equal(created.model?.modelId, model.modelId, "New session used a different model than the configured default");
  }

  latestSession ??= await getSession(currentSessionId);
  let messages = messagesOf(latestSession);
  const reconcile = findToolExecution(messages, "office_reconcile");
  assert.ok(reconcile, "Session history does not contain an office_reconcile tool call and result");
  const reconcileArtifacts = artifactsFromToolResult(reconcile, expectedArtifacts,
    process.env.WORKAGENT_SESSION_ID ? 0 : startedAt);
  for (const artifact of reconcileArtifacts) {
    await readPathOverHttp(artifact.path, artifact.name, { binary: artifact.name.endsWith(".xlsx") });
  }

  const reconcileDetails = reconcile.result.details?.details;
  const differenceCount = [reconcileDetails?.added, reconcileDetails?.missing, reconcileDetails?.modified]
    .reduce((total, count) => total + (typeof count === "number" ? count : 0), 0);
  assert.ok(Number.isInteger(differenceCount), "Reconcile tool result is missing numeric difference counts");

  latestSession = await getSession(currentSessionId);
  messages = messagesOf(latestSession);
  const inventoryStartedAt = Date.now();
  const inventoryPrompt = "本地验收续聊：请调用 office_inventory，只清点 WorkAgent 默认工作区根目录（inputs 使用 [\".\"] 或省略），生成文件清单；只读，不移动、修改或删除任何文件。请用工具结果说明清点文件数。";
  let inventory = findToolExecution(messages, "office_inventory");
  let inventoryArtifactStartedAt = 0;
  if (!inventory) {
    const usersBefore = messages.filter(message => message?.role === "user").length;
    const inventoryResponse = await postPrompt(currentSessionId, inventoryPrompt);
    latestSession = await waitForSessionIdle(currentSessionId, usersBefore + 1);
    assertPromptSettled("office_inventory", inventoryResponse);
    messages = messagesOf(latestSession);
    inventory = findToolExecution(messages, "office_inventory");
    inventoryArtifactStartedAt = inventoryStartedAt;
  }
  assert.ok(inventory, "Session history does not contain an office_inventory tool call and result");
  const inventoryInputs = inventory.call.input?.inputs;
  assert.ok(inventoryInputs === undefined || (Array.isArray(inventoryInputs)
    && inventoryInputs.length === 1 && inventoryInputs[0] === "."),
  "office_inventory did not target only the default workspace root");
  assert.equal(typeof inventory.result.details?.details?.fileCount, "number", "Inventory tool result has no real file count");
  const inventoryArtifacts = artifactsFromToolResult(inventory, ["inventory.csv", "inventory.md"], inventoryArtifactStartedAt);
  for (const artifact of inventoryArtifacts) await readPathOverHttp(artifact.path, artifact.name);

  const reportTitle = "DeepSeek Flash 联调验收";
  const reportBody = "这是一份本地联调测试文档，不包含业务结论。";
  const reportStartedAt = Date.now();
  const reportPrompt = `本地验收续聊：调用 office_report 生成 Markdown 和 DOCX。options.title 必须逐字为“${reportTitle}”，options.content 必须逐字为“${reportBody}”。不要添加业务结论。`;
  let report = findToolExecution(messages, "office_report");
  let reportArtifactStartedAt = 0;
  if (!report || report.call.input?.options?.title !== reportTitle || report.call.input?.options?.content !== reportBody) {
    const usersBefore = messages.filter(message => message?.role === "user").length;
    const reportResponse = await postPrompt(currentSessionId, reportPrompt);
    latestSession = await waitForSessionIdle(currentSessionId, usersBefore + 1);
    assertPromptSettled("office_report", reportResponse);
    messages = messagesOf(latestSession);
    report = findToolExecution(messages, "office_report");
    reportArtifactStartedAt = reportStartedAt;
  }
  assert.ok(report, "Session history does not contain an office_report tool call and result");
  assert.equal(report.call.input?.options?.title, reportTitle, "office_report used the wrong title");
  assert.equal(report.call.input?.options?.content, reportBody, "office_report used the wrong body");
  assert.equal(report.result.details?.details?.title, reportTitle, "Report tool result confirms a different title");
  const reportArtifacts = artifactsFromToolResult(report, ["report.md", "report.docx"], reportArtifactStartedAt);
  const reportMarkdown = reportArtifacts.find(artifact => artifact.name === "report.md");
  const reportDocx = reportArtifacts.find(artifact => artifact.name === "report.docx");
  await readPathOverHttp(reportMarkdown.path, reportMarkdown.name, { expectedText: [reportTitle, reportBody] });
  await readPathOverHttp(reportDocx.path, reportDocx.name, { binary: true });

  const usersBeforeFollowup = messages.filter(candidate => candidate?.role === "user").length;
  const followupResponse = await postPrompt(currentSessionId,
    "请只回答上一次 office_reconcile 工具结果中 added、missing、modified 三类差异条目总数，只输出数字，不要调用工具。");
  latestSession = await waitForSessionIdle(currentSessionId, usersBeforeFollowup + 1);
  assertPromptSettled("difference-count", followupResponse);
  messages = messagesOf(latestSession);
  const latestAssistant = [...messages].reverse().find(candidate => candidate?.role === "assistant");
  const answer = Array.isArray(latestAssistant?.content)
    ? latestAssistant.content.filter(block => block?.type === "text").map(block => block.text).join("").trim()
    : "";
  assert.ok(!latestAssistant?.content?.some(block => block?.type === "toolCall"), "Difference-count follow-up unexpectedly called a tool");
  assert.equal(answer, String(differenceCount), "Follow-up did not answer with the real difference count only");

  const sampleHashesAfter = await readExampleHashes(bootstrap.cwd, bootstrap.exampleInputs);
  assert.deepEqual([...sampleHashesAfter], [...sampleHashesBefore], "An original sample CSV changed during acceptance");

  console.log(`PASS model=${model.provider}/${model.modelId}`);
  console.log(`PASS session=${currentSessionId}`);
  console.log("PASS tools=office_reconcile,office_inventory,office_report with persisted tool results");
  console.log(`PASS reconcile=${expectedArtifacts.join(", ")}; inventory=inventory.csv,inventory.md; report=report.md,report.docx (HTTP readable)`);
  console.log(`PASS follow-up difference count=${differenceCount}; source CSV hashes unchanged`);
}

main().catch(error => {
  // Keep failures bounded and avoid printing server response bodies, headers,
  // model configuration, or credential-bearing URLs.
  console.error(`FAIL ${error instanceof Error ? error.message : "Live model acceptance failed"}`);
  process.exitCode = 1;
});
