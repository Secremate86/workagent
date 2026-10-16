"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { FileViewer } from "@/components/FileViewer";
import { FileExplorer } from "@/components/FileExplorer";
import { encodeFilePathForApi, getFileName } from "@/lib/file-paths";
import { Icon } from "./Icons";

interface Props {
  cwd: string | null;
  sessionId?: string;
  file: string | null;
  tab: "artifacts" | "files";
  artifactCount: number;
  refreshKey: number;
  children: ReactNode;
  onTabChange: (tab: "artifacts" | "files") => void;
  onOpenFile: (path: string) => void;
  onCloseFile: () => void;
  onClose: () => void;
  onMention: (path: string) => void;
}

export function OutputPanel({ cwd, sessionId, file, tab, artifactCount, refreshKey, children, onTabChange, onOpenFile, onCloseFile, onClose, onMention }: Props) {
  const [files, setFiles] = useState<string[]>(() => file ? [file] : []);
  const [fullscreen, setFullscreen] = useState(false);
  const [width, setWidth] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const origin = useRef({ x: 0, width: 0 });
  const maxWidth = useRef(1000);
  useEffect(() => { if (file) setFiles(current => current.includes(file) ? current : [...current, file]); }, [file]);
  useEffect(() => {
    if (!fullscreen) return;
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") setFullscreen(false); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [fullscreen]);
  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => setWidth(Math.max(320, Math.min(maxWidth.current, origin.current.width + origin.current.x - e.clientX)));
    const stop = () => setDragging(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
    window.addEventListener("pointercancel", stop, { once: true });
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); window.removeEventListener("pointercancel", stop); };
  }, [dragging]);
  useEffect(() => {
    const container = panel.current?.parentElement;
    if (!container) return;
    const resize = () => {
      maxWidth.current = Math.max(320, Math.min(1000, container.getBoundingClientRect().width - 480));
      setWidth(current => current === null ? current : Math.min(current, maxWidth.current));
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);
  function closeFile(path: string) {
    const next = files.filter(item => item !== path);
    setFiles(next);
    if (file === path) { if (next.length) onOpenFile(next.at(-1)!); else onCloseFile(); }
  }
  const download = file ? `/api/files/${encodeFilePathForApi(file)}?type=download` : "";
  return <aside ref={panel} className={`wa-output-panel${fullscreen ? " fullscreen" : ""}${dragging ? " dragging" : ""}`} style={width && !fullscreen ? { width } : undefined} aria-label="成果与文件预览">
    <div className="wa-panel-resizer" role="separator" aria-label="调整成果面板宽度" aria-orientation="vertical" aria-valuemin={320} aria-valuemax={maxWidth.current} aria-valuenow={Math.round(width ?? 480)} tabIndex={0} onKeyDown={e => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); const delta = e.key === "ArrowLeft" ? 24 : -24; setWidth(Math.max(320, Math.min(maxWidth.current, (panel.current?.getBoundingClientRect().width ?? 480) + delta))); } }} onPointerDown={e => { origin.current = { x: e.clientX, width: panel.current?.getBoundingClientRect().width ?? 480 }; e.preventDefault(); setDragging(true); }} />
    <div className="wa-panel-tabs">
      <button className={tab === "artifacts" ? "active" : ""} onClick={() => onTabChange("artifacts")}>成果<span>{artifactCount}</span></button>
      <button className={tab === "files" ? "active" : ""} onClick={() => onTabChange("files")}>工作区文件</button>
      <div className="wa-panel-window-controls"><button className="wa-icon-button" aria-label={fullscreen ? "退出全屏预览" : "全屏预览"} onClick={() => setFullscreen(v => !v)}><Icon name={fullscreen ? "restore" : "maximize"} size={15} /></button><button className="wa-icon-button" aria-label="关闭成果面板" onClick={onClose}><Icon name="close" size={17} /></button></div>
    </div>
    {tab === "files" ? cwd && <div className="wa-explorer"><FileExplorer cwd={cwd} onOpenFile={onOpenFile} refreshKey={refreshKey} changesCollapsed={false} onAtMention={onMention} /></div> : <div className={`wa-artifact-list${file ? " has-preview" : ""}`}>{children}</div>}
    {files.length > 0 && <div className="wa-file-tabs" role="tablist" aria-label="已打开的文件">{files.map(path => <div className={file === path ? "active" : ""} key={path}><button role="tab" aria-selected={file === path} title={path} onClick={() => onOpenFile(path)}><Icon name="file" size={13} /><span>{getFileName(path)}</span></button><button aria-label={`关闭 ${getFileName(path)}`} onClick={() => closeFile(path)}><Icon name="close" size={12} /></button></div>)}</div>}
    {file && <div className="wa-preview">
      <div className="wa-preview-title"><span title={file}><Icon name="file" size={16} />{getFileName(file)}</span><a aria-label="下载文件" href={download} download><Icon name="download" size={16} /></a><button aria-label="关闭预览" onClick={() => closeFile(file)}><Icon name="close" size={15} /></button></div>
      {/\.xlsx?$/i.test(file) ? <div className="wa-empty"><span className="wa-empty-icon"><Icon name="table" size={29} /></span><h3>Excel 工作簿已生成</h3><p>下载工作簿查看所有工作表；对应的 CSV 差异表可在此直接预览。</p><a className="wa-primary" href={download} download>下载工作簿<Icon name="download" size={15} /></a></div> : <FileViewer key={file} filePath={file} cwd={cwd ?? undefined} sourceSessionId={sessionId} initialDisplayMode="preview" onOpenFile={onOpenFile} gitRefreshKey={refreshKey} />}
    </div>}
  </aside>;
}
