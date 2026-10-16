"use client";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icons";

export function QuickModelSetup({ onClose, onSaved, onAdvanced }: { onClose: () => void; onSaved: () => void; onAdvanced: () => void }) {
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [modelId, setModelId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [api, setApi] = useState("openai-completions");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  const payload = () => ({ baseUrl, modelId, apiKey, api });
  async function submit(testOnly: boolean) {
    setBusy(true); setError(null); setResult(null);
    try {
      const response = await fetch(testOnly ? "/api/models-config/test" : "/api/workagent/model", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(testOnly ? { providerName: "workagent-openai", provider: { baseUrl, api, apiKey: apiKey.split("$").join("$$").replace(/^!/, "$!") }, model: { id: modelId } } : payload()),
      });
      const data = await response.json();
      if (!response.ok || data.ok === false || data.error) throw new Error(data.error ?? "模型配置失败");
      if (testOnly) setResult(`连接成功 · ${data.latencyMs ?? "—"} ms`);
      else { setApiKey(""); onSaved(); }
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="wa-model-dialog" onCancel={e => { if (busy) e.preventDefault(); else onClose(); }} aria-labelledby="wa-model-title"><form onSubmit={e => { e.preventDefault(); void submit(false); }}>
    <div className="wa-model-header"><span className="wa-model-logo"><Icon name="sparkle" size={24} /></span><button type="button" className="wa-icon-button" aria-label="关闭模型配置" disabled={busy} onClick={onClose}><Icon name="close" /></button></div>
    <span className="wa-eyebrow">LET’S GET CONNECTED</span><h2 id="wa-model-title">连接你的 AI 模型</h2><p>支持 OpenAI 和兼容 OpenAI 的模型服务。填好连接信息，就可以开始协作。</p>
    <label>API 地址<input required type="url" value={baseUrl} onChange={e => { setBaseUrl(e.target.value); setResult(null); }} placeholder="https://api.example.com/v1" autoComplete="off" /></label>
    <div className="wa-model-form-row"><label>模型 ID<input required value={modelId} onChange={e => { setModelId(e.target.value); setResult(null); }} placeholder="服务商提供的模型 ID" autoComplete="off" /></label><label>接口协议<select aria-label="接口协议" value={api} onChange={e => { setApi(e.target.value); setResult(null); }}><option value="openai-completions">Chat Completions</option><option value="openai-responses">Responses</option></select></label></div>
    <label>API Key<input required type="password" value={apiKey} onChange={e => { setApiKey(e.target.value); setResult(null); }} placeholder="输入你的 API Key" autoComplete="new-password" spellCheck={false} /></label>
    <small className="wa-model-key-note"><Icon name="check" size={13} />密钥仅保存在本机服务端，不写入浏览器存储。</small>
    {error && <div className="wa-model-error" role="alert">{error}</div>}{result && <div className="wa-model-success" role="status"><Icon name="check" size={15} />{result}</div>}
    <div className="wa-model-footer"><button type="button" className="wa-text-button" disabled={busy} onClick={onAdvanced}>其他服务商与高级设置<Icon name="arrow" size={13} /></button><div><button type="button" className="wa-secondary" disabled={busy || !baseUrl || !modelId || !apiKey} onClick={() => void submit(true)}>{busy ? "连接中…" : "测试连接"}</button><button type="submit" className="wa-primary" disabled={busy}>{busy ? "处理中…" : "保存并使用"}</button></div></div>
  </form></dialog>;
}
