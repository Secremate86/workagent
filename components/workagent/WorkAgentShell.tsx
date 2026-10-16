"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ChatWindow } from "@/components/ChatWindow";
import type { ChatInputHandle } from "@/components/ChatInput";
import { SettingsPanel } from "@/components/SettingsPanel";
import { ProjectTrustDialog, type ProjectTrustFailure } from "@/components/ProjectTrustDialog";
import type { ProjectTrustStatus } from "@/lib/api-types";
import { useI18n } from "@/hooks/useI18n";
import { useTheme } from "@/hooks/useTheme";
import { useFontPreferences } from "@/hooks/useFontPreferences";
import { useViewportHeight } from "@/hooks/useViewportHeight";
import type { SessionInfo } from "@/lib/types";
import type { SettingsSection } from "@/lib/settings-navigation";
import { encodeFilePathForApi, getFileName } from "@/lib/file-paths";
import { Brand, Icon } from "./Icons";
import { OutputPanel } from "./OutputPanel";
import { QuickModelSetup } from "./QuickModelSetup";
import { ExecutionCenter, type ExecutionMode, type ExecutionPolicy } from "./ExecutionCenter";
import { SubagentViewer } from "@/components/SubagentViewer";
import { openStackedDialog } from "@/lib/stacked-dialog";

type Artifact = { path: string; name: string; mime?: string; size?: number; modified?: string };
type Bootstrap = { cwd: string; officeReady: boolean; exampleInputs?: string[]; upstream: { name: string; version: string; commit: string } };
type Page = "home" | "tasks" | "capabilities" | "library";
const templates = [
  { icon: "table", color: "green", title: "让表格自己对上账", category: "数据处理", description: "比对两份数据，找出差异和重复项", prompt: "请先查看工作区中的两份示例 CSV，使用 office_reconcile 按首列主键核对，输出差异表和核对报告。明确指出重复键和无法匹配的数据，不修改源文件。" },
  { icon: "folder", color: "amber", title: "给文件做一次整理", category: "文件管理", description: "梳理目录，生成一份清晰的资料清单", prompt: "请使用 office_inventory 梳理当前工作区，生成文件清单与 Markdown 报告，按类型汇总。先只生成清单，不移动、删除或覆盖源文件。" },
  { icon: "file", color: "blue", title: "把想法变成文档", category: "内容创作", description: "从零散信息到结构完整的可编辑文档", prompt: "请帮我整理一份工作报告。先询问我报告主题、已有材料和面向的读者，确认信息后使用 office_report 生成 Markdown 和 Word 文档。不要编造数据。" },
  { icon: "globe", color: "purple", title: "研究一个新课题", category: "探索研究", description: "读资料、理思路，沉淀有依据的结论", prompt: "我想研究一个新课题。请先询问研究主题、范围和交付格式，再检查当前可用的搜索或 MCP 工具；如果没有联网检索工具，请明确说明并使用我提供的资料。" },
];

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `请求失败 (${response.status})`);
  return data as T;
}
const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const titleOf = (s: SessionInfo) => s.name || s.firstMessage?.slice(0, 50) || "新任务";

export function WorkAgentShell() {
  const params = useSearchParams();
  const { setLocale } = useI18n();
  useTheme();
  useFontPreferences();
  useViewportHeight();
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [selected, setSelected] = useState<SessionInfo | null>(null);
  const [running, setRunning] = useState<string[]>([]);
  const [awaiting, setAwaiting] = useState<string[]>([]);
  const [archived, setArchived] = useState<string[]>([]);
  const [page, setPage] = useState<Page>("home");
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settings, setSettings] = useState<SettingsSection | null>(null);
  const [executionOpen, setExecutionOpen] = useState(false);
  const [policy, setPolicy] = useState<ExecutionPolicy | null>(null);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [settingsVersion, setSettingsVersion] = useState(0);
  const [modelSetup, setModelSetup] = useState(false);
  const [chatKey, setChatKey] = useState("initial");
  const [draftKey, setDraftKey] = useState("workagent:new:initial");
  const [filesVersion, setFilesVersion] = useState(0);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelTab, setPanelTab] = useState<"artifacts" | "files">("artifacts");
  const [file, setFile] = useState<string | null>(null);
  const [subagent, setSubagent] = useState<{ sessionId: string; label: string } | null>(null);
  const subagentDialogRef = useRef<HTMLElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [officeBusy, setOfficeBusy] = useState(false);
  const [officeSummary, setOfficeSummary] = useState<string | null>(null);
  const [quoteSelectionEnabled, setQuoteSelectionEnabled] = useState(false);
  const [renameTarget, setRenameTarget] = useState<SessionInfo | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [cwdDialog, setCwdDialog] = useState(false);
  const [cwdValue, setCwdValue] = useState("");
  const [trust, setTrust] = useState<ProjectTrustStatus | null>(null);
  const [trustOpen, setTrustOpen] = useState(false);
  const [trustBusy, setTrustBusy] = useState(false);
  const [trustError, setTrustError] = useState<ProjectTrustFailure | null>(null);
  const input = useRef<ChatInputHandle | null>(null);
  const initialId = useRef(params.get("session"));
  const currentDraft = useRef<string | null>(draftKey);
  currentDraft.current = selected ? null : draftKey;
  const cwd = selected?.cwd ?? workspace;

  const refreshPolicy = useCallback(async () => {
    const data = await request<ExecutionPolicy>("/api/workagent/policy");
    setPolicy(data);
  }, []);

  useEffect(() => {
    let active = true;
    const refresh = () => { if (document.visibilityState === "visible") void refreshPolicy().catch(e => { if (active) setError((e as Error).message); }); };
    refresh();
    const timer = window.setInterval(refresh, 5000);
    window.addEventListener("focus", refresh);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [refreshPolicy]);

  const changeExecutionMode = useCallback(async (mode: ExecutionMode) => {
    try {
      const updated = await request<ExecutionPolicy>("/api/workagent/policy", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }) });
      setPolicy(updated);
      setPolicyError(null);
    } catch (e) { setPolicyError((e as Error).message); setError((e as Error).message); }
  }, []);
  const closeExecutionCenter = useCallback(() => setExecutionOpen(false), []);
  const closeSubagent = useCallback(() => setSubagent(null), []);
  useEffect(() => {
    if (!subagent) return;
    return openStackedDialog(document, subagentDialogRef.current, closeSubagent);
  }, [subagent, closeSubagent]);
  const viewKey = `${page}:${selected?.id ?? draftKey}:${cwd}`;
  const currentView = useRef(viewKey);
  currentView.current = viewKey;

  const refresh = useCallback(async () => {
    const [data, ui] = await Promise.all([
      request<{ sessions: SessionInfo[]; runningSessionIds: string[]; awaitingInputSessionIds: string[] }>("/api/sessions?summary=1"),
      request<{ state: { sessions: Record<string, { archivedAt?: number }> } }>("/api/sessions/ui-state"),
    ]);
    setSessions(data.sessions.filter(s => s.relation?.kind !== "subagent"));
    setRunning(data.runningSessionIds);
    setAwaiting(data.awaitingInputSessionIds);
    setArchived(Object.entries(ui.state.sessions).filter(([, v]) => v.archivedAt != null).map(([id]) => id));
    if (initialId.current) {
      const found = data.sessions.find(s => s.id === initialId.current);
      initialId.current = null;
      if (found) { setSelected(found); setChatKey(found.id); setPage("home"); }
    }
  }, []);

  useEffect(() => {
    let live = true;
    try { if (!localStorage.getItem("pi-locale")) setLocale("zh-CN"); } catch { /* use browser locale */ }
    try { setQuoteSelectionEnabled(localStorage.getItem("pi-quote-selection-enabled") === "true"); } catch { /* storage is optional */ }
    void request<Bootstrap>("/api/workagent/bootstrap").then(data => { if (live) { setBootstrap(data); setWorkspace(data.cwd); } }).catch(e => { if (live) setError(e.message); });
    void refresh().catch(e => { if (live) setError(e.message); });
    const timer = setInterval(() => { if (!document.hidden) void refresh().catch(() => {}); }, 6000);
    return () => { live = false; clearInterval(timer); };
  }, [refresh, setLocale]);

  useEffect(() => {
    let live = true;
    setTrust(null);
    if (cwd) void request<ProjectTrustStatus>(`/api/project-trust?cwd=${encodeURIComponent(cwd)}`).then(data => { if (live) setTrust(data); }).catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [cwd]);

  useEffect(() => {
    let live = true;
    setArtifacts([]);
    if (cwd && cwd === bootstrap?.cwd) void request<{ artifacts: Artifact[] }>(`/api/workagent/artifacts?cwd=${encodeURIComponent(cwd)}`).then(data => { if (live) setArtifacts(data.artifacts); }).catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [cwd, bootstrap?.cwd, filesVersion]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPage("tasks"); setSidebarOpen(false); setTimeout(() => document.getElementById("wa-search")?.focus(), 0); }
      if (e.key === "Escape") { setSidebarOpen(false); setRenameTarget(null); setCwdDialog(false); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  function select(s: SessionInfo) {
    setSelected(s); setChatKey(s.id); setPage("home"); setSidebarOpen(false); setFile(null);
    window.history.replaceState(null, "", `/?session=${encodeURIComponent(s.id)}`);
  }
  function newTask() {
    // Public HTTP pages lack randomUUID. This is a local draft key, matching
    // the fallback used by AppShell before a server session exists.
    const draftId = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    const key = `workagent:new:${draftId}`;
    setSelected(null); setChatKey(key); setDraftKey(key); setPage("home"); setSidebarOpen(false); setFile(null); setPanelOpen(false); setError(null);
    window.history.replaceState(null, "", "/");
  }
  function openFile(path: string) { setFile(path); setPanelOpen(true); }
  function insertTemplate(prompt: string) {
    if (selected) newTask();
    setPage("home");
    setTimeout(() => input.current?.insertText(prompt), 100);
  }
  function changed() { setFilesVersion(v => v + 1); void refresh().catch(e => setError(e.message)); }
  function handleSessionCreated(s: SessionInfo, sourceDraftKey: string) {
    setRunning(ids => [...new Set([...ids, s.id])]);
    if (currentDraft.current === sourceDraftKey) {
      setSelected(s);
      window.history.replaceState(null, "", `/?session=${encodeURIComponent(s.id)}`);
    }
    changed();
  }
  function changeQuoteSelection(enabled: boolean) {
    setQuoteSelectionEnabled(enabled);
    try { localStorage.setItem("pi-quote-selection-enabled", String(enabled)); } catch { /* retain current tab setting */ }
  }
  async function archive(s: SessionInfo, value: boolean) {
    try { await request("/api/sessions/ui-state", json({ action: "set", ids: [s.id], archived: value })); await refresh(); } catch (e) { setError((e as Error).message); }
  }
  async function runOffice(operation: "inventory" | "reconcile" | "report") {
    const originView = currentView.current;
    setOfficeBusy(true); setError(null); setOfficeSummary(null);
    try {
      const result = await request<{ ok: boolean; summary: string; artifacts: Artifact[] }>("/api/workagent/office", json({ operation, ...(operation === "reconcile" ? { inputs: bootstrap?.exampleInputs } : {}), ...(operation === "report" ? { options: { title: "WorkAgent 本地办公验证", content: "本文档由本地办公执行器生成，用于验证 Markdown 与 Word 文件的生成和交付。\n\n这是一份示例文档，不包含业务数据或模型生成的结论。" } } : {}) }));
      setOfficeSummary(result.summary); changed();
      const preview = result.artifacts.find(a => a.name.endsWith(".csv")) ?? result.artifacts.find(a => a.name.endsWith(".md"));
      if (currentView.current === originView) {
        setPanelTab("artifacts"); setPanelOpen(true);
        if (preview) setFile(preview.path);
      }
    } catch (e) { setError((e as Error).message); } finally { setOfficeBusy(false); }
  }
  async function confirmTrust() {
    setTrustBusy(true); setTrustError(null);
    try { const status = await request<ProjectTrustStatus>("/api/project-trust", json({ cwd })); setTrust(status); setTrustOpen(false); setSettingsVersion(v => v + 1); setChatKey(`reload:${selected?.id ?? draftKey}:${Date.now()}`); }
    catch (e) { setTrustError({ error: (e as Error).message }); }
    finally { setTrustBusy(false); }
  }
  const visibleSessions = sessions.filter(s => archived.includes(s.id) === showArchived && `${titleOf(s)} ${s.cwd}`.toLowerCase().includes(query.toLowerCase()));
  const navigate = (next: Page) => { setPage(next); setSidebarOpen(false); };
  const taskState = (id: string) => awaiting.includes(id) ? "等待确认" : running.includes(id) ? "运行中" : "历史任务";
  const taskRows = (items: SessionInfo[], compact = false) => items.map(s => <div key={s.id} className={`wa-task-row${selected?.id === s.id ? " selected" : ""}${compact ? " compact" : ""}`}>
    <button className="wa-task-select" onClick={() => select(s)}><span className={`wa-state-dot${running.includes(s.id) ? " running" : awaiting.includes(s.id) ? " awaiting" : ""}`} /><span><strong>{titleOf(s)}</strong>{!compact && <small>{new Date(s.modified).toLocaleDateString("zh-CN")} · {taskState(s.id)}</small>}</span></button>
    <div className="wa-task-actions"><button aria-label={`重命名 ${titleOf(s)}`} onClick={() => { setRenameTarget(s); setRenameValue(titleOf(s)); }}><Icon name="edit" size={14} /></button><button aria-label={archived.includes(s.id) ? "取消归档" : "归档任务"} onClick={() => void archive(s, !archived.includes(s.id))}><Icon name="archive" size={14} /></button></div>
  </div>);

  return <div className="wa-app">
    {sidebarOpen && <button className="wa-sidebar-scrim" aria-label="关闭导航" onClick={() => setSidebarOpen(false)} />}
    <aside className={`wa-sidebar${sidebarOpen ? " open" : ""}`}>
      <button className="wa-brand" onClick={newTask}><Brand /><span>WorkAgent<small>你的 AI 工作搭子</small></span></button>
      <button className="wa-new-task" onClick={newTask}><Icon name="plus" />新建任务<span>＋</span></button>
      <nav aria-label="主导航">
        <button className={page === "home" ? "active" : ""} onClick={() => navigate("home")}><Icon name="home" />工作台</button>
        <button className={page === "tasks" ? "active" : ""} onClick={() => navigate("tasks")}><Icon name="search" />全部任务<kbd>Ctrl K</kbd></button>
        <button className={page === "capabilities" ? "active" : ""} onClick={() => navigate("capabilities")}><Icon name="grid" />能力中心</button>
        <button className={page === "library" ? "active" : ""} onClick={() => navigate("library")}><Icon name="folder" />成果文件</button>
      </nav>
      <div className="wa-sidebar-separator" />
      <div className="wa-recent-heading"><span>最近任务</span><button aria-label="查看全部任务" onClick={() => navigate("tasks")}><Icon name="clock" size={15} /></button></div>
      <div className="wa-recent-tasks">{sessions.filter(s => !archived.includes(s.id)).slice(0, 12).length ? taskRows(sessions.filter(s => !archived.includes(s.id)).slice(0, 12), true) : <p className="wa-sidebar-empty">从一个想法开始，<br />你的任务会出现在这里。</p>}</div>
      <div className="wa-sidebar-bottom">
        <button className="wa-workspace" onClick={() => { setCwdValue(cwd ?? ""); setCwdDialog(true); }}><span className="wa-workspace-icon"><Icon name="folder" /></span><span>本地工作空间<small title={cwd ?? ""}>{cwd ? getFileName(cwd) : "正在准备…"}</small></span><Icon name="chevron" size={13} /></button>
        <button className="wa-settings-link" onClick={() => setSettings("general")}><Icon name="settings" />设置<span className="wa-local-dot" />本地运行</button>
      </div>
    </aside>
    <main className="wa-main">
      <header className="wa-topbar"><div className="wa-topbar-left"><button className="wa-mobile-toggle wa-icon-button" aria-label="打开导航" onClick={() => setSidebarOpen(true)}><Icon name="menu" /></button><span>{page === "home" ? selected ? titleOf(selected) : "工作台" : page === "tasks" ? "全部任务" : page === "capabilities" ? "能力中心" : "成果文件"}</span>{selected && page === "home" && <span className={`wa-status-pill${running.includes(selected.id) ? " running" : ""}`}>{taskState(selected.id)}</span>}</div><div className="wa-topbar-actions"><label className="wa-topbar-mode" title="设置工作台所有会话与子代理的执行方式"><span>执行模式</span><select aria-label="执行模式" value={policy?.mode ?? "review"} disabled={!policy} onChange={e => void changeExecutionMode(e.target.value as ExecutionMode)}><option value="review">安全审查</option><option value="auto">默认放行</option><option value="plan">计划模式</option></select></label><button className="wa-execution-button" onClick={() => { void refreshPolicy().catch(e => setError((e as Error).message)); setExecutionOpen(true); }}><Icon name="shield" size={15} />执行与自动化</button><button className="wa-icon-button" aria-label={panelOpen ? "收起成果面板" : "打开成果面板"} onClick={() => setPanelOpen(v => !v)}><Icon name="panel" /></button><button className="wa-avatar" aria-label="模型与账号设置" onClick={() => setModelSetup(true)}>W</button></div></header>
      {error && <div className="wa-banner error" role="alert"><span>{error}</span><button aria-label="关闭错误" onClick={() => setError(null)}><Icon name="close" size={15} /></button></div>}
      {officeSummary && <div className="wa-banner success" role="status"><Icon name="check" size={17} /><span>{officeSummary}</span><button aria-label="关闭结果提示" onClick={() => setOfficeSummary(null)}><Icon name="close" size={15} /></button></div>}
      {trust?.requiresTrust && !trust.trusted && <div className="wa-trust-banner"><Icon name="plug" size={16} /><span>办公技能和插件等待启用。请先查看并信任工作空间。</span><button onClick={() => { setTrustError(null); setTrustOpen(true); }}>查看并启用<Icon name="arrow" size={14} /></button></div>}
      <div className="wa-body">
        <section className={`wa-content${page === "home" && !selected ? " wa-home" : ""}`}>
          <div className="wa-chat-host" style={{ display: page === "home" ? "flex" : "none" }}>
            {cwd ? <ChatWindow key={chatKey} session={selected} sessionRunning={selected ? running.includes(selected.id) : false} newSessionCwd={selected ? null : workspace} newSessionDraftKey={draftKey} chatInputRef={input} modelsRefreshKey={settingsVersion} soundEnabled={false} onOpenSettings={setSettings} onOpenFile={openFile} onFilesUploaded={changed} onToolEnd={changed} onAgentEnd={changed} onSessionForked={id => { initialId.current = id; void refresh().catch(e => setError(e.message)); }} onOpenSubagent={(sessionId, label) => setSubagent({ sessionId, label })} onSessionCreated={handleSessionCreated} quoteSelectionEnabled={quoteSelectionEnabled} newSessionContextBar={<div className="wa-welcome"><div className="wa-welcome-eyebrow"><span />从想法，到成果</div><h1>今天，有什么想一起完成？<span className="wa-title-spark">✦</span></h1><p>把繁琐交给我，留点时间给更重要的事。</p><div className="wa-prompt-chips"><button onClick={() => insertTemplate(templates[0].prompt)}><Icon name="table" size={15} />表格分析</button><button onClick={() => insertTemplate(templates[1].prompt)}><Icon name="folder" size={15} />文件整理</button><button onClick={() => insertTemplate(templates[2].prompt)}><Icon name="file" size={15} />文档写作</button><button onClick={() => setSettings("skills")}><Icon name="sparkle" size={15} />更多技能</button></div></div>} /> : <div className="wa-loading"><Brand /><p>{error ? "工作空间准备失败，请检查上方错误后刷新。" : "正在准备你的工作空间…"}</p></div>}
            {!selected && cwd && <div className="wa-discover"><div className="wa-section-heading"><h2>一点灵感，即刻开工</h2><button onClick={() => setPage("capabilities")}>探索全部能力<Icon name="arrow" size={14} /></button></div><div className="wa-template-grid">{templates.map(t => <button className="wa-template" key={t.title} onClick={() => insertTemplate(t.prompt)}><span className={`wa-template-icon ${t.color}`}><Icon name={t.icon} size={22} /></span><small>{t.category}</small><strong>{t.title}</strong><p>{t.description}</p><span className="wa-template-arrow"><Icon name="arrow" size={16} /></span></button>)}</div><div className="wa-home-foot"><span><span className="wa-local-dot" />文件与任务保存在本机</span><button onClick={() => setModelSetup(true)}>配置模型，开始协作<Icon name="arrow" size={13} /></button></div></div>}
          </div>
          {page === "tasks" && <div className="wa-page"><div className="wa-page-heading"><div><span className="wa-eyebrow">YOUR WORK, IN ONE PLACE</span><h1>每一份进展，都在这里</h1><p>继续上次的思路，或开始一件新鲜的事。</p></div><button className="wa-primary" onClick={newTask}><Icon name="plus" />新建任务</button></div><div className="wa-list-toolbar"><label className="wa-search"><Icon name="search" /><input id="wa-search" placeholder="搜索任务或工作空间…" value={query} onChange={e => setQuery(e.target.value)} /></label><button className={showArchived ? "wa-filter selected" : "wa-filter"} onClick={() => setShowArchived(v => !v)}><Icon name="archive" size={15} />{showArchived ? "已归档" : "查看归档"}</button></div><div className="wa-full-task-list">{visibleSessions.length ? taskRows(visibleSessions) : <Empty icon="chat" title={query ? "没有找到匹配的任务" : "还没有任务"} description="新建一个任务，把你的想法告诉 WorkAgent。" />}</div></div>}
          {page === "capabilities" && <div className="wa-page"><div className="wa-page-heading"><div><span className="wa-eyebrow">A LITTLE HELP. A LOT DONE.</span><h1>找到适合你的工作方式</h1><p>从常用办公场景开始，连接更多工具与专业能力。</p></div></div><div className="wa-capability-grid">{templates.map(t => <button className="wa-capability-card" key={t.title} onClick={() => insertTemplate(t.prompt)}><span className={`wa-template-icon ${t.color}`}><Icon name={t.icon} size={24} /></span><span><small>{t.category}</small><h2>{t.title}</h2><p>{t.description}</p></span><Icon name="arrow" /></button>)}</div><div className="wa-section-heading"><h2>让工作台更懂你</h2></div><div className="wa-resource-grid">{([{ section: "models", icon: "sparkle", title: "模型", text: "接入服务商，配置模型和 API Key" }, { section: "skills", icon: "grid", title: "技能", text: "查看、安装和管理可复用的工作方法" }, { section: "plugins", icon: "plug", title: "插件", text: "扩展 WorkAgent 的工具与工作流" }, { section: "mcp", icon: "globe", title: "连接器", text: "通过 MCP 连接外部服务" }, { section: "agents", icon: "chat", title: "专家与子代理", text: "配置专业角色与并行协作" }] as const).map(c => <button key={c.section} className="wa-resource-card" onClick={() => setSettings(c.section)}><Icon name={c.icon} size={21} /><h3>{c.title}</h3><p>{c.text}</p><span>管理<Icon name="chevron" size={12} /></span></button>)}</div><div className="wa-office-lab"><div><span className="wa-eyebrow">本地办公工具</span><h2>先试试，让文件真正跑起来</h2><p>无需模型密钥。使用内置匿名样例核对两表，或生成当前默认工作区的文件清单。</p></div><div className="wa-lab-buttons"><button disabled={officeBusy || !bootstrap} onClick={() => void runOffice("reconcile")}><Icon name="table" />{officeBusy ? "正在处理…" : "核对示例表格"}</button><button disabled={officeBusy || !bootstrap} onClick={() => void runOffice("inventory")}><Icon name="folder" />生成文件清单</button><button disabled={officeBusy || !bootstrap} onClick={() => void runOffice("report")}><Icon name="file" />生成示例文档</button></div></div></div>}
          {page === "library" && <div className="wa-page"><div className="wa-page-heading"><div><span className="wa-eyebrow">MADE WITH WORKAGENT</span><h1>好想法，值得被留下</h1><p>默认工作空间中生成的办公文件，可以预览、下载并继续加工。</p></div><button className="wa-filter" onClick={() => { setPanelTab("files"); setPanelOpen(true); }}>浏览工作区<Icon name="folder" size={15} /></button></div>{artifacts.length ? <div className="wa-artifact-grid">{artifacts.map(a => <ArtifactCard key={a.path} artifact={a} onOpen={openFile} />)}</div> : <Empty icon="file" title="第一份成果，从这里开始" description="去能力中心运行本地办公工具，或让 Agent 在工作空间的 outputs 目录生成文件。" action={<button className="wa-primary" onClick={() => setPage("capabilities")}>探索办公能力<Icon name="arrow" size={15} /></button>} />}</div>}
        </section>
        {panelOpen && <OutputPanel key={`${chatKey}:${cwd}`} cwd={cwd} sessionId={selected?.id} file={file} tab={panelTab} artifactCount={artifacts.length} refreshKey={filesVersion} onTabChange={setPanelTab} onOpenFile={openFile} onCloseFile={() => setFile(null)} onClose={() => setPanelOpen(false)} onMention={path => { setPage("home"); input.current?.insertText(`@${path} `); }}>{artifacts.length ? artifacts.map(a => <ArtifactCard key={a.path} artifact={a} onOpen={openFile} />) : <Empty icon="file" title="成果会在这里集合" description={cwd === bootstrap?.cwd ? "生成后的办公文件可以直接预览和下载。" : "当前为自选工作区，请在文件页签查看生成的文件。"} />}</OutputPanel>}
      </div>
    </main>
    {modelSetup && <QuickModelSetup onClose={() => setModelSetup(false)} onSaved={() => { setModelSetup(false); setSettingsVersion(v => v + 1); setOfficeSummary("模型配置已保存，现在可以开始新任务。"); }} onAdvanced={() => { setModelSetup(false); setSettings("models"); }} />}
    {executionOpen && <ExecutionCenter policy={policy} modeError={policyError} onModeChange={mode => void changeExecutionMode(mode)} onClose={closeExecutionCenter} onOpenSubagents={() => { setExecutionOpen(false); setSettings("agents"); }} />}
    {subagent && <div className="wa-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) closeSubagent(); }}><section ref={subagentDialogRef} tabIndex={-1} className="wa-modal" role="dialog" aria-modal="true" aria-label="子代理任务" style={{ width: "min(900px, 94vw)", height: "min(760px, 88vh)", display: "flex", flexDirection: "column", padding: 0, overflow: "hidden" }}><header style={{ display: "flex", justifyContent: "flex-end", padding: "8px 12px", borderBottom: "1px solid var(--border)" }}><button type="button" aria-label="关闭子代理任务" onClick={closeSubagent}><Icon name="close" size={16} /></button></header><div style={{ flex: 1, minHeight: 0 }}><SubagentViewer sessionId={subagent.sessionId} fallbackLabel={subagent.label} running={running.includes(subagent.sessionId)} onOpenFile={path => { closeSubagent(); openFile(path); }} /></div></section></div>}
    {settings && <SettingsPanel key={`${settings}:${cwd}`} cwd={cwd} sessionId={selected?.id ?? null} initialSection={settings} onClose={() => { setSettings(null); setSettingsVersion(v => v + 1); }} onSessionReloaded={() => setChatKey(`reload:${Date.now()}`)} quoteSelectionEnabled={quoteSelectionEnabled} onQuoteSelectionChange={changeQuoteSelection} projectTrust={trust} onOpenTrustDialog={() => { setTrustError(null); setTrustOpen(true); }} onProjectTrustChanged={(_, status) => setTrust(status)} />}
    {trustOpen && cwd && <ProjectTrustDialog cwd={cwd} busy={trustBusy} error={trustError} onCancel={() => { if (!trustBusy) setTrustOpen(false); }} onConfirm={() => void confirmTrust()} onStatus={setTrust} />}
    {renameTarget && <div className="wa-modal-backdrop"><form className="wa-modal" role="dialog" aria-modal="true" aria-labelledby="wa-rename-title" onSubmit={async e => { e.preventDefault(); try { await request(`/api/sessions/${encodeURIComponent(renameTarget.id)}`, { ...json({ name: renameValue }), method: "PATCH" }); if (selected?.id === renameTarget.id) setSelected(s => s ? { ...s, name: renameValue } : s); setRenameTarget(null); await refresh(); } catch (e) { setError((e as Error).message); } }}><h2 id="wa-rename-title">给任务一个名字</h2><input autoFocus aria-label="任务名称" required maxLength={120} value={renameValue} onChange={e => setRenameValue(e.target.value)} /><div><button type="button" onClick={() => setRenameTarget(null)}>取消</button><button className="wa-primary" type="submit">保存</button></div></form></div>}
    {cwdDialog && <div className="wa-modal-backdrop"><form className="wa-modal" role="dialog" aria-modal="true" aria-labelledby="wa-cwd-title" onSubmit={async e => { e.preventDefault(); try { const result = await request<{ cwd: string }>("/api/cwd/validate", json({ cwd: cwdValue })); setWorkspace(result.cwd); newTask(); setCwdDialog(false); } catch (e) { setError((e as Error).message); } }}><h2 id="wa-cwd-title">选择本地工作空间</h2><p>输入服务器上的目录绝对路径。新任务将在此目录读取和生成文件；已有任务继续使用原目录。</p><input autoFocus aria-label="工作空间绝对路径" required value={cwdValue} onChange={e => setCwdValue(e.target.value)} /><button type="button" className="wa-text-button" onClick={() => setCwdValue(bootstrap?.cwd ?? "")}>使用默认办公工作区</button><div><button type="button" onClick={() => setCwdDialog(false)}>取消</button><button className="wa-primary" type="submit">使用此目录</button></div></form></div>}
  </div>;
}

function Empty({ icon, title, description, action }: { icon: string; title: string; description: string; action?: React.ReactNode }) {
  return <div className="wa-empty"><span className="wa-empty-icon"><Icon name={icon} size={29} /></span><h3>{title}</h3><p>{description}</p>{action}</div>;
}
function ArtifactCard({ artifact, onOpen }: { artifact: Artifact; onOpen: (path: string) => void }) {
  const ext = artifact.name.split(".").pop()?.toUpperCase() ?? "FILE";
  return <div className="wa-artifact-card"><button onClick={() => onOpen(artifact.path)}><span className={`wa-file-badge${["CSV", "XLSX"].includes(ext) ? " green" : ""}`}><Icon name={["CSV", "XLSX"].includes(ext) ? "table" : "file"} size={20} /><small>{ext}</small></span><span><strong>{artifact.name}</strong><small>{artifact.size != null ? `${Math.max(1, Math.round(artifact.size / 1024))} KB` : "办公成果"}{artifact.modified ? ` · ${new Date(artifact.modified).toLocaleDateString("zh-CN")}` : ""}</small></span></button><a aria-label={`下载 ${artifact.name}`} href={`/api/files/${encodeFilePathForApi(artifact.path)}?type=download`} download><Icon name="download" size={16} /></a></div>;
}
