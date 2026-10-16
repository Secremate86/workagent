"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icons";
import { openStackedDialog } from "@/lib/stacked-dialog";

export type ExecutionMode = "review" | "auto" | "plan";
export type PolicyAudit = { id: string; at: string; sessionId?: string; toolName: string; decision: "allowed" | "denied" | "blocked" | "auto"; reason: string; summary: string };
export type ExecutionPolicy = { mode: ExecutionMode; updatedAt: string; audit: PolicyAudit[] };
type Tab = "approval" | "schedule" | "memory" | "subagents";

type ScheduleTask = { id: string; name: string; schedule: string; prompt: string; type: string; createdAt: string; lastRunAt?: string; nextRunAt?: string; recurring: boolean; maxAgeDays: number };
type ScheduleState = { tasks: ScheduleTask[]; total: number; truncated: boolean; runtime: RuntimeState };
type RuntimeState = { status: "active" | "offline" | "plan" | "error"; ownerSessionId?: string; error?: string; delivery: "active-session-only"; timeZone: string };
type MemoryEntry = { id: string; target: "long_term" | "daily"; date?: string; content: string };
type MemoryState = { status: { storage: "ready" | "empty"; search: "disabled" }; files: { longTerm: string; scratchpad: string; daily: Array<{ date: string; content: string }> }; entries: MemoryEntry[]; truncated?: boolean };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  let body: Record<string, unknown> = {};
  try { body = await response.json() as Record<string, unknown>; } catch { /* retain the HTTP status below */ }
  if (!response.ok) {
    const code = typeof body.code === "string" ? body.code : "";
    const message = typeof body.error === "string" ? body.error : `请求失败 (${response.status})`;
    throw new Error(code === "PLAN_MODE_BLOCKED" ? `计划模式下不能修改：${message}` : message);
  }
  return body as T;
}

const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const dateTime = (value?: string) => value ? new Date(value).toLocaleString("zh-CN") : "尚无";
const runtimeLabels: Record<RuntimeState["status"], string> = { active: "运行中", offline: "当前离线", plan: "计划模式", error: "运行异常" };

function SchedulePanel({ planMode }: { planMode: boolean }) {
  const [data, setData] = useState<ScheduleState | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [schedule, setSchedule] = useState("");
  const [prompt, setPrompt] = useState("");
  const [recurring, setRecurring] = useState(true);
  const [maxAgeDays, setMaxAgeDays] = useState(7);
  const controller = useRef<AbortController | null>(null);
  const loadSequence = useRef(0);

  async function load(signal: AbortSignal) {
    if (signal.aborted) return;
    const sequence = ++loadSequence.current;
    setLoading(true);
    try {
      const next = await api<ScheduleState>("/api/workagent/schedules", { signal });
      if (!signal.aborted && sequence === loadSequence.current) { setData(next); setLoadError(null); }
    } catch (e) { if (!signal.aborted && sequence === loadSequence.current) setLoadError((e as Error).message); }
    finally { if (!signal.aborted && sequence === loadSequence.current) setLoading(false); }
  }
  useEffect(() => {
    const abort = new AbortController();
    controller.current = abort;
    void load(abort.signal);
    const timer = window.setInterval(() => { if (!document.hidden) void load(abort.signal); }, 5000);
    return () => { window.clearInterval(timer); abort.abort(); controller.current = null; };
  }, []);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    const signal = controller.current?.signal;
    if (!signal || signal.aborted) return;
    setBusy(true); setMutationError(null);
    try {
      await api("/api/workagent/schedules", { ...post({ name: name.trim(), schedule: schedule.trim(), prompt: prompt.trim(), recurring, maxAgeDays }), signal });
      if (signal.aborted) return;
      setName(""); setSchedule(""); setPrompt(""); setRecurring(true); setMaxAgeDays(7);
      await load(signal);
    } catch (e) { if (!signal.aborted) setMutationError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function remove(id: string) {
    if (!window.confirm("删除这个定时任务？")) return;
    const signal = controller.current?.signal;
    if (!signal || signal.aborted) return;
    setBusy(true); setMutationError(null);
    try { await api("/api/workagent/schedules", { ...post({ id }), method: "DELETE", signal }); if (!signal.aborted) await load(signal); }
    catch (e) { if (!signal.aborted) setMutationError((e as Error).message); }
    finally { setBusy(false); }
  }
  const runtime = data?.runtime;
  const writesBlocked = planMode || runtime?.status === "plan";
  return <section className="wa-automation-panel" aria-labelledby="wa-schedule-title">
    <div className="wa-automation-heading"><div><h3 id="wa-schedule-title">定时任务</h3><p>管理默认办公工作区的任务。</p></div><button type="button" className="wa-refresh-button" onClick={() => { const signal = controller.current?.signal; if (signal) void load(signal); }} disabled={loading}>刷新</button></div>
    <div className={`wa-runtime-state ${runtime?.status ?? "loading"}`} role="status">
      <strong>{runtime ? runtimeLabels[runtime.status] : loading ? "正在读取运行状态…" : "状态暂不可用"}</strong>
      <span>按 {runtime?.timeZone ?? "本地时区"} 执行；需要有活跃任务会话，服务关闭时不会运行，恢复后可能补触发。</span>
      {runtime?.ownerSessionId && <a href={`/?session=${encodeURIComponent(runtime.ownerSessionId)}`}>打开任务会话</a>}
      {runtime?.error && <span className="wa-inline-error">{runtime.error}</span>}
    </div>
    <p className="wa-automation-note">最近触发/投递时间只表示任务已投递，不代表执行成功。高风险操作仍需人工确认；一次性任务可能提前最多 90 秒，重复任务可能延后。</p>
    {loadError && <div className="wa-automation-error" role="alert">{loadError}<button type="button" onClick={() => { const signal = controller.current?.signal; if (signal) void load(signal); }}>重试</button></div>}
    {mutationError && <div className="wa-automation-error" role="alert">{mutationError}</div>}
    {data?.truncated && <p className="wa-truncated-note" role="status">任务列表只显示部分结果。</p>}
    <form className="wa-automation-form" onSubmit={create}>
      <label>任务名称<input required maxLength={120} value={name} onChange={e => setName(e.target.value)} /></label>
      <label>执行时间（cron）<input required maxLength={120} placeholder="例如 0 9 * * 1-5" value={schedule} onChange={e => setSchedule(e.target.value)} /></label>
      <label>任务内容<textarea required maxLength={4000} rows={3} value={prompt} onChange={e => setPrompt(e.target.value)} /></label>
      <label className="wa-checkbox-label"><input type="checkbox" checked={recurring} onChange={e => setRecurring(e.target.checked)} />重复执行</label>
      <label>未触发过期天数<input type="number" min={0} max={3650} disabled={!recurring} value={maxAgeDays} onChange={e => setMaxAgeDays(Number(e.target.value))} /><small>{recurring ? "连续未触发的天数，0 表示不过期" : "一次性任务投递后删除"}</small></label>
      {writesBlocked && <p className="wa-disabled-reason">计划模式下不能新建或删除任务。</p>}
      <button className="wa-primary" type="submit" disabled={busy || writesBlocked}>{busy ? "正在保存…" : "创建任务"}</button>
    </form>
    <div className="wa-automation-list-heading"><h4>已保存任务</h4><span>{data?.total ?? 0} 项</span></div>
    {loading && !data ? <div className="wa-execution-empty">正在读取任务…</div> : !data?.tasks.length ? <div className="wa-execution-empty">还没有定时任务。</div> : <ul className="wa-automation-list">{data.tasks.map(task => <li key={task.id}>
      <div className="wa-automation-task-head"><strong>{task.name}</strong><button type="button" className="wa-danger-button" disabled={busy || writesBlocked} onClick={() => void remove(task.id)}>删除</button></div>
      <p>{task.prompt}</p><small>{task.schedule} · {task.recurring ? "重复" : "一次性"} · 最近触发/投递：{dateTime(task.lastRunAt)}{task.nextRunAt ? ` · 下次 ${dateTime(task.nextRunAt)}` : ""}</small>
    </li>)}</ul>}
  </section>;
}

function MemoryPanel({ planMode }: { planMode: boolean }) {
  const [data, setData] = useState<MemoryState | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const loadSequence = useRef(0);
  async function load(signal: AbortSignal) {
    if (signal.aborted) return;
    const sequence = ++loadSequence.current;
    setLoading(true);
    try {
      const next = await api<MemoryState>("/api/workagent/memory", { signal });
      if (!signal.aborted && sequence === loadSequence.current) { setData(next); setLoadError(null); }
    } catch (e) { if (!signal.aborted && sequence === loadSequence.current) setLoadError((e as Error).message); }
    finally { if (!signal.aborted && sequence === loadSequence.current) setLoading(false); }
  }
  useEffect(() => {
    const abort = new AbortController(); controller.current = abort;
    void load(abort.signal);
    const timer = window.setInterval(() => { if (!document.hidden) void load(abort.signal); }, 5000);
    return () => { window.clearInterval(timer); abort.abort(); controller.current = null; };
  }, []);
  async function add(event: React.FormEvent) {
    event.preventDefault();
    const signal = controller.current?.signal;
    if (!signal || signal.aborted) return;
    setBusy(true); setMutationError(null);
    try { await api("/api/workagent/memory", { ...post({ content: content.trim() }), signal }); if (signal.aborted) return; setContent(""); await load(signal); }
    catch (e) { if (!signal.aborted) setMutationError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function remove(entry: MemoryEntry) {
    if (!window.confirm("从记忆中删除这条内容？本机仍保留恢复记录。")) return;
    const signal = controller.current?.signal;
    if (!signal || signal.aborted) return;
    setBusy(true); setMutationError(null);
    try {
      const body = { id: entry.id, target: entry.target, ...(entry.date ? { date: entry.date } : {}) };
      await api("/api/workagent/memory", { ...post(body), method: "DELETE", signal });
      if (!signal.aborted) await load(signal);
    } catch (e) { if (!signal.aborted) setMutationError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="wa-automation-panel" aria-labelledby="wa-memory-title">
    <div className="wa-automation-heading"><div><h3 id="wa-memory-title">长期记忆</h3><p>只保存你明确要求保留的内容，不会自动记下聊天。</p></div><button type="button" className="wa-refresh-button" onClick={() => { const signal = controller.current?.signal; if (signal) void load(signal); }} disabled={loading}>刷新</button></div>
    <div className="wa-runtime-state active"><strong>{data?.status.storage === "ready" ? "本机记忆可用" : data ? "暂无记忆内容" : "正在读取…"}</strong><span>语义搜索已关闭。历史格式正文可阅读，但只能删除带有明确条目标记的内容。</span></div>
    {loadError && <div className="wa-automation-error" role="alert">{loadError}<button type="button" onClick={() => { const signal = controller.current?.signal; if (signal) void load(signal); }}>重试</button></div>}
    {mutationError && <div className="wa-automation-error" role="alert">{mutationError}</div>}
    {data?.truncated && <p className="wa-truncated-note" role="status">当前显示范围受限，刷新后仍可能看不到全部内容。</p>}
    <form className="wa-automation-form" onSubmit={add}>
      <label>明确保存一条记忆<textarea required maxLength={8000} rows={3} value={content} onChange={e => setContent(e.target.value)} placeholder="输入要长期保留的偏好、事实或决定" /></label>
      {planMode && <p className="wa-disabled-reason">计划模式下不能新增或删除记忆。</p>}
      <button className="wa-primary" type="submit" disabled={busy || planMode}>{busy ? "正在保存…" : "保存到长期记忆"}</button>
    </form>
    <div className="wa-memory-files">
      <h4>记忆正文</h4>
      <MemoryFile title="长期记忆" value={data?.files.longTerm ?? ""} open={expanded === "longTerm"} onToggle={() => setExpanded(expanded === "longTerm" ? null : "longTerm")} />
      <MemoryFile title="临时记忆" value={data?.files.scratchpad ?? ""} open={expanded === "scratchpad"} onToggle={() => setExpanded(expanded === "scratchpad" ? null : "scratchpad")} />
      {data?.files.daily.map(day => <MemoryFile key={day.date} title={`每日记录 · ${day.date}`} value={day.content} open={expanded === day.date} onToggle={() => setExpanded(expanded === day.date ? null : day.date)} />)}
    </div>
    <div className="wa-automation-list-heading"><h4>可单独管理的记忆条目</h4><span>{data?.entries.length ?? 0} 项</span></div>
    {!data?.entries.length ? <div className="wa-execution-empty">没有带条目标记的记忆。</div> : <ul className="wa-automation-list">{data.entries.map(entry => <li key={entry.id}>
      <div className="wa-automation-task-head"><strong>{entry.target === "long_term" ? "长期记忆" : `每日记录${entry.date ? ` · ${entry.date}` : ""}`}</strong><button type="button" className="wa-danger-button" disabled={busy || planMode} onClick={() => void remove(entry)}>删除</button></div><p className="wa-memory-entry">{entry.content}</p>
    </li>)}</ul>}
  </section>;
}

function MemoryFile({ title, value, open, onToggle }: { title: string; value: string; open: boolean; onToggle: () => void }) {
  return <details className="wa-memory-file" open={open}>
    <summary onClick={event => { event.preventDefault(); onToggle(); }}>{title}<span>{value ? `${value.length} 字符` : "空"}</span></summary>
    {value ? <pre>{value}</pre> : <p>暂无内容</p>}
  </details>;
}

export const MODE_LABELS: Record<ExecutionMode, string> = { review: "安全审查", auto: "默认放行", plan: "计划模式" };

export function ExecutionCenter({ policy, onModeChange, modeError, onClose, onOpenSubagents }: {
  policy: ExecutionPolicy | null;
  onModeChange: (mode: ExecutionMode) => void;
  modeError?: string | null;
  onClose: () => void;
  onOpenSubagents: () => void;
}) {
  const [tab, setTab] = useState<Tab>("approval");
  const dialogRef = useRef<HTMLElement>(null);
  const planMode = policy?.mode === "plan";
  useEffect(() => openStackedDialog(document, dialogRef.current, onClose), [onClose]);
  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: "approval", label: "权限审批", icon: "shield" },
    { id: "schedule", label: "定时任务", icon: "clock" },
    { id: "memory", label: "长期记忆", icon: "sparkle" },
    { id: "subagents", label: "子代理", icon: "chat" },
  ];
  return <div className="wa-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <section ref={dialogRef} tabIndex={-1} className="wa-execution-dialog" role="dialog" aria-modal="true" aria-labelledby="wa-execution-title">
      <header className="wa-execution-header"><div><span className="wa-eyebrow">WORKAGENT CONTROL</span><h2 id="wa-execution-title">执行与自动化</h2></div><button className="wa-icon-button" aria-label="关闭" onClick={onClose}><Icon name="close" /></button></header>
      <nav className="wa-execution-tabs" aria-label="执行与自动化"><div>{tabs.map(item => <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}><Icon name={item.icon} size={15} />{item.label}</button>)}</div></nav>
      <div className="wa-execution-body">
        {tab === "approval" && <>
          <div className="wa-mode-card"><div><span className="wa-eyebrow">当前执行方式</span><h3>{policy ? MODE_LABELS[policy.mode] : "正在读取策略…"}</h3><p>此设置作用于工作台内所有会话与子代理。已经弹出的审批仍需由你回答。</p></div><label className="wa-mode-select-label" htmlFor="wa-execution-mode">执行模式<select id="wa-execution-mode" value={policy?.mode ?? "review"} disabled={!policy} onChange={e => onModeChange(e.target.value as ExecutionMode)}><option value="review">安全审查</option><option value="auto">默认放行</option><option value="plan">计划模式</option></select></label></div>
          {modeError && <div className="wa-automation-error" role="alert">{modeError}</div>}
          <div className="wa-mode-explanations"><p><strong>安全审查</strong> · 工具操作按策略检查，需要审批时由 WorkAgent 内置审批对话框接管。</p><p><strong>默认放行</strong> · 明确允许工具操作自动执行。</p><p><strong>计划模式</strong> · 仅分析和规划，不执行写操作。定时任务和记忆的修改入口会停用。</p></div>
          <div className="wa-audit-heading"><div><h3>审批记录</h3><p>最近的工具权限决策</p></div>{policy && <small>更新于 {new Date(policy.updatedAt).toLocaleString("zh-CN")}</small>}</div>
          {!policy ? <div className="wa-execution-empty">正在载入权限策略…</div> : policy.audit.length === 0 ? <div className="wa-execution-empty"><span className="wa-empty-icon"><Icon name="shield" size={23} /></span><strong>还没有审批记录</strong><span>工具权限决策会显示在这里。</span></div> : <ol className="wa-audit-list">{policy.audit.map(item => <li key={item.id}><div><strong>{item.toolName}</strong><span className={`wa-audit-decision ${item.decision}`}>{({ allowed: "已允许", denied: "已拒绝", blocked: "已拦截", auto: "自动放行" })[item.decision]}</span></div><p>{item.summary || item.reason}</p><small>{new Date(item.at).toLocaleString("zh-CN")}{item.sessionId ? ` · 会话 ${item.sessionId}` : ""}</small></li>)}</ol>}
        </>}
        {tab === "schedule" && <SchedulePanel planMode={planMode} />}
        {tab === "memory" && <MemoryPanel planMode={planMode} />}
        {tab === "subagents" && <div className="wa-execution-placeholder"><span className="wa-template-icon blue"><Icon name="chat" size={22} /></span><h3>专家与子代理</h3><p>工作台复用 WorkAgent 的专家配置、子代理开关与并发设置。</p><button className="wa-primary" onClick={onOpenSubagents}>打开子代理设置<Icon name="arrow" size={14} /></button></div>}
      </div>
      <footer className="wa-execution-footer"><span><span className="wa-local-dot" />设置保存在本机</span><button onClick={onClose}>完成</button></footer>
    </section>
  </div>;
}
