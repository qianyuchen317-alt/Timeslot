import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  api,
  streamChat,
  type Agent,
  type ApiSource,
  type Config,
  type Project,
  type ApprovalMode,
} from "./api";

// ---------------------------------------------------------------- helpers ----

function initial(name: string, role: string): string {
  if (role === "root") return "R";
  const m = name.match(/[A-Za-z0-9\u4e00-\u9fa5]/);
  return m ? m[0].toUpperCase() : "?";
}

function hue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

function modelSupportsVision(model: string): boolean {
  const m = model.toLowerCase();
  return m.includes("vision") || m.includes("vl") || m.includes("qwen3.5") || m.includes("deepseek-flash");
}

type FeedMsg = {
  key: string;
  agentId: string;
  agentName: string;
  role: "user" | "assistant";
  content: string;
  thinking: string;
  isRoot: boolean;
  error?: string;
};

// ------------------------------------------------------------------- app -----
export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [config, setConfig] = useState<Config | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [mode, setMode] = useState<"admin" | "root">("admin");
  const [approvalModes, setApprovalModes] = useState<Record<"admin" | "root", ApprovalMode>>({ admin: "approval", root: "approval" });
  const [feeds, setFeeds] = useState<Record<"admin" | "root", FeedMsg[]>>({ admin: [], root: [] });
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [agentDirectoryOpen, setAgentDirectoryOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [modelReady, setModelReady] = useState(false);
  const [loadProgress, setLoadProgress] = useState(8);
  const feed = feeds[mode];
  const fileRef = useRef<HTMLInputElement>(null);
  const projectFileRef = useRef<HTMLInputElement>(null);
  const [projectImportTarget, setProjectImportTarget] = useState<Project | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void (async () => {
      const [a, c, p] = await Promise.all([api.agents(), api.settings(), api.projects()]);
      setAgents(a);
      setConfig(c);
      setProjects(p);
      setLoadProgress(55);
      for (let i = 0; i < 90; i += 1) {
        const status = await api.modelStatus().catch(() => ({ ready: false, model: "", stage: "loading" }));
        if (status.ready) { setModelReady(true); setLoadProgress(100); break; }
        setLoadProgress(Math.min(94, 55 + Math.floor(i / 2)));
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    })();
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [feed]);

  const enabledCount = useMemo(() => agents.filter((a) => a.enabled).length, [agents]);

  if (!config) return <div className="boot-screen"><div className="boot-card"><h2>vllm Mesh</h2><p>正在读取项目配置…</p><div className="progress-track"><div className="progress-value" style={{ width: `${loadProgress}%` }} /></div></div></div>;

  const updateFeed = (fn: (f: FeedMsg[]) => FeedMsg[]) =>
    setFeeds((all) => ({ ...all, [mode]: fn(all[mode]) }));
  const patchMsg = (key: string, fn: (m: FeedMsg) => FeedMsg) =>
    updateFeed((f) => f.map((m) => (m.key === key ? fn(m) : m)));

  async function toggleAgent(id: string, enabled: boolean) {
    setAgents((list) => list.map((a) => (a.id === id ? { ...a, enabled } : a)));
    const updated = await api.patchAgent(id, { enabled });
    setAgents((list) => list.map((a) => (a.id === id ? updated : a)));
  }

  async function renameAgent(a: Agent) {
    const name = window.prompt("重命名 agent 用户", a.name);
    if (!name || name === a.name) return;
    const updated = await api.patchAgent(a.id, { name });
    setAgents((list) => list.map((x) => (x.id === a.id ? updated : x)));
  }

  async function addAgentContext(a: Agent, file: File) {
    const image = /\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(file.name);
    const model = a.api?.model || config?.local.model || "";
    if (image && !modelSupportsVision(model)) {
      window.alert(`「${a.name}」当前模型不支持图片，已跳过：${file.name}`);
      return;
    }
    try { await api.addContext(a.id, file); window.alert(`已为「${a.name}」导入只读上下文：${file.name}`); }
    catch (e) { window.alert(`上下文导入失败：${String(e)}`); }
  }

  async function removeAgent(a: Agent) {
    if (!window.confirm(`删除 agent 用户「${a.name}」及其独立数据库？`)) return;
    await api.deleteAgent(a.id);
    setAgents((list) => list.filter((x) => x.id !== a.id));
  }

  async function addAgent() {
    const name = window.prompt("新 agent 用户名称", "name D");
    if (!name) return;
    const created = await api.createAgent(name);
    setAgents((list) => [...list, created]);
  }

  async function addProject() {
    const name = window.prompt("新项目名称", "新项目");
    if (!name) return;
    const created = await api.createProject(name);
    setProjects((list) => [...list, created]);
  }

  function importToProject(project: Project) {
    setProjectImportTarget(project);
    projectFileRef.current?.click();
  }

  function onProjectFile(e: React.ChangeEvent<HTMLInputElement>) {
    const names = Array.from(e.target.files ?? []).map((f) => f.name);
    if (names.length && projectImportTarget) {
      setDraft((d) => `${d}${d ? " " : ""}[项目「${projectImportTarget.name}」导入文件：${names.join("、")}]`);
    }
    e.target.value = "";
  }

  const mkPlaceholder = (a: Agent, base: number): FeedMsg => ({
    key: `a-${base}-${a.id}`,
    agentId: a.id,
    agentName: a.name,
    role: "assistant",
    content: "",
    thinking: "",
    isRoot: a.role === "root",
  });

  async function send() {
    const text = draft.trim();
    if (!text || sending || !config) return;
    const base = Date.now();
    setDraft("");
    updateFeed((f) => [
      ...f,
      {
        key: `u-${base}`,
        agentId: "admin",
        agentName: "管理员",
        role: "user",
        content: text,
        thinking: "",
        isRoot: false,
      },
    ]);
    setSending(true);
    try {
      if (mode === "admin") {
        // 管理员模式：只有 Root Agent 与管理员直接对话
        const root = agents.find((a) => a.enabled && a.role === "root");
        if (!root) {
          window.alert("管理员模式需要启用 Root Agent");
          return;
        }
        const ph = mkPlaceholder(root, base);
        updateFeed((f) => [...f, ph]);
        await runAgent(root, text, ph.key);
      } else {
        // Root 模式：Root Agent 分配任务 -> 各 agent 用户执行并汇报
        const root = agents.find((a) => a.enabled && a.role === "root");
        const workers = agents.filter((a) => a.enabled && a.role !== "root");
        if (!root && workers.length === 0) {
          window.alert("没有已启用的 agent 用户");
          return;
        }
        let assignment = "";
        if (root) {
          const ph = mkPlaceholder(root, base);
          updateFeed((f) => [...f, ph]);
          assignment = await runAgent(
            root,
            `作为 Root Agent，请把下面的指令拆解并分配给各 agent 用户，说明每个 agent 负责的子任务：\n\n${text}`,
            ph.key,
          );
        }
        if (workers.length) {
          const phs = workers.map((w) => mkPlaceholder(w, base));
          updateFeed((f) => [...f, ...phs]);
          await Promise.all(
            workers.map((w, i) => {
              const msg = assignment
                ? `Root Agent 的任务分配：\n\n${assignment}\n\n请找出分配给你「${w.name}」的子任务并执行，然后向 Root Agent 汇报进度。`
                : text;
              return runAgent(w, msg, phs[i].key);
            }),
          );
        }
      }
    } finally {
      setSending(false);
    }
  }

  async function runAgent(agent: Agent, text: string, key: string): Promise<string> {
    let full = "";
    try {
      await streamChat(agent.id, text, mode, approvalModes[mode], (ev) => {
        if (ev.delta) {
          full += ev.delta;
          patchMsg(key, (m) => ({ ...m, content: m.content + ev.delta }));
        }
        if (ev.reasoning)
          patchMsg(key, (m) => ({ ...m, thinking: m.thinking + ev.reasoning }));
        if (ev.error) patchMsg(key, (m) => ({ ...m, error: ev.error }));
      });
    } catch (e) {
      patchMsg(key, (m) => ({ ...m, error: String(e) }));
    }
    return full;
  }

  function onImport() {
    fileRef.current?.click();
  }

  function onFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    const targets = mode === "admin"
      ? agents.filter((a) => a.enabled && a.role === "root")
      : agents.filter((a) => a.enabled && a.role !== "root");
    const unsupported = files.filter((file) => {
      const ext = file.name.includes(".") ? `.${file.name.split(".").pop()!.toLowerCase()}` : "";
      return targets.some((a) => {
        const allowed = a.api?.allowed_extensions || config?.local.allowed_extensions || [".md"];
        return !allowed.map((x) => x.toLowerCase()).includes(ext);
      });
    });
    if (unsupported.length) {
      const names = unsupported.map((f) => f.name).join("、");
      window.alert(`提示：当前 agent 用户配置的模型可能不支持这些文件格式：${names}\n文件仍会导入，但模型可能无法正确读取。你可以在设置中调整允许格式或更换模型。`);
    }
    const names = files.map((f) => f.name);
    if (names.length) setDraft((d) => `${d}${d ? " " : ""}[已导入文件：${names.join("、")}]`);
    e.target.value = "";
  }

  function onMic() {
    const SR = (window as unknown as { webkitSpeechRecognition?: new () => any })
      .webkitSpeechRecognition;
    if (!SR) {
      window.alert("当前浏览器不支持语音识别（建议用 Chromium）");
      return;
    }
    const rec = new SR();
    rec.lang = "zh-CN";
    rec.onresult = (ev: any) => setDraft((d) => d + ev.results[0][0].transcript);
    rec.start();
  }

  return (
    <div className="app">
      {sidebarOpen && <div className="backdrop" onClick={() => setSidebarOpen(false)} />}
      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="brand">
          <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden>
            <path
              d="M12 2.5 20.5 7.5v9L12 21.5 3.5 16.5v-9z"
              fill="none"
              stroke="#5b5bd6"
              strokeWidth="1.8"
              strokeLinejoin="round"
            />
            <circle cx="12" cy="12" r="2.6" fill="#5b5bd6" />
          </svg>
          <span>vllm Mesh</span>
        </div>

        <div className="side-scroll">
          <div className="section-head">
            <span>agent 用户</span>
            <button className="mini" onClick={addAgent} title="新增 agent 用户">
              ＋
            </button>
          </div>
          <button className="agent-directory-entry" onClick={() => setAgentDirectoryOpen(true)}>
            <span>查看全部 Agent 用户</span>
            <span>{agents.length} 个 ›</span>
          </button>

          <div className="section-head">
            <span>项目:</span>
            <button className="mini" onClick={addProject} title="新增项目">
              ＋
            </button>
          </div>
          <ul className="project-list">
            {projects.map((p) => (
              <li key={p.id}><span>{p.name}</span><button className="project-import" title="向此项目导入文件" onClick={() => importToProject(p)}>›</button></li>
            ))}
          </ul>
        </div>

        <button className="settings-btn" onClick={() => setSettingsOpen(true)}>
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
            <path
              d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
            />
            <path
              d="M19.4 13a7.7 7.7 0 0 0 0-2l2-1.5-2-3.4-2.3 1a7.6 7.6 0 0 0-1.7-1l-.3-2.5h-4l-.3 2.5a7.6 7.6 0 0 0-1.7 1l-2.3-1-2 3.4 2 1.5a7.7 7.7 0 0 0 0 2l-2 1.5 2 3.4 2.3-1a7.6 7.6 0 0 0 1.7 1l.3 2.5h4l.3-2.5a7.6 7.6 0 0 0 1.7-1l2.3 1 2-3.4z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
          </svg>
          settings
        </button>
      </aside>

      <main className="main">
        <header className="topbar">
          <button className="hamburger" onClick={() => setSidebarOpen((s) => !s)}>
            ☰
          </button>
          <div className="model-hint">
            {config ? `${config.local.model}` : "…"}
            <span className={`model-status ${modelReady ? "ready" : "loading"}`}>{modelReady ? "模型就绪" : "模型加载中"}</span>
            <span className="dot-sep">·</span>
            {mode === "admin" ? "管理员 ↔ Root Agent" : "Root Agent ↔ agent 用户"}
            <span className="dot-sep">·</span>
            {enabledCount} 个已启用
          </div>
          <select className="approval-select" value={approvalModes[mode]} onChange={(e) => setApprovalModes((all) => ({ ...all, [mode]: e.target.value as ApprovalMode }))} title="当前对话权限">
            <option value="approval">请求批准</option>
            <option value="low_risk">低风险直通</option>
            <option value="autonomous">全自动不审批</option>
          </select>
          <div className="seg">
            <button
              className={mode === "admin" ? "active" : ""}
              onClick={() => setMode("admin")}
            >
              管理员
            </button>
            <button
              className={mode === "root" ? "active" : ""}
              onClick={() => setMode("root")}
            >
              Root
            </button>
          </div>
        </header>

        <div className="messages" ref={scrollRef}>
          {feed.length === 0 && (
            <div className="empty">
              <h2>vllm Mesh</h2>
              {mode === "admin" ? (
                <p>
                  管理员模式：你正在与 <strong>Root Agent</strong> 直接对话。
                </p>
              ) : (
                <p>
                  Root 模式：Root Agent 向各 agent 用户<strong>分配任务</strong>并汇总进度。
                </p>
              )}
              <p className="sub">共 {enabledCount} 个 agent 已启用</p>
            </div>
          )}
          {feed.map((m) => (
            <div
              key={m.key}
              className={`msg ${m.role === "user" ? "right" : "left"} ${
                m.isRoot ? "root" : ""
              }`}
            >
              <div
                className="avatar"
                style={{
                  background:
                    m.role === "user"
                      ? "linear-gradient(135deg,#7a7af0,#5b5bd6)"
                      : `hsl(${hue(m.agentId)} 60% 55%)`,
                }}
              >
                {m.role === "user" ? "管" : initial(m.agentName, m.isRoot ? "root" : "agent")}
              </div>
              <div className="bubble">
                <div className="meta">{m.role === "user" ? "管理员" : m.agentName}</div>
                {m.thinking && (
                  <details className="thinking">
                    <summary>思考过程</summary>
                    <div>{m.thinking}</div>
                  </details>
                )}
                <div className="text">
                  {m.content || (m.error ? "" : <span className="typing">···</span>)}
                </div>
                {m.error && <div className="err">⚠ {m.error}</div>}
              </div>
            </div>
          ))}
        </div>

        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <button type="button" className="icon" onClick={onImport} title="导入文件">
            ＋
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={onFiles}
          />
          <input ref={projectFileRef} type="file" multiple hidden onChange={onProjectFile} />
          <textarea
            rows={1}
            value={draft}
            placeholder="输入消息，Enter 发送 / Shift+Enter 换行"
            onChange={(e) => {
              setDraft(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = e.target.scrollHeight + "px";
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button type="button" className="icon" onClick={onMic} title="语音输入">
            🎙
          </button>
          <button type="submit" className="icon send" title="发送" disabled={sending}>
            ➤
          </button>
        </form>
      </main>

      {settingsOpen && config && (
        <SettingsModal
          config={config}
          agents={agents}
          onAgentsChange={setAgents}
          onClose={() => setSettingsOpen(false)}
          onSave={async (cfg) => {
            const saved = await api.saveSettings(cfg);
            setConfig(saved);
            setSettingsOpen(false);
          }}
        />
      )}
      {agentDirectoryOpen && (
        <AgentDirectoryModal
          agents={agents}
          onClose={() => setAgentDirectoryOpen(false)}
          onAdd={addAgent}
          onToggle={toggleAgent}
          onRename={renameAgent}
          onRemove={removeAgent}
          onContext={addAgentContext}
        />
      )}
    </div>
  );
}

function AgentDirectoryModal({
  agents, onClose, onAdd, onToggle, onRename, onRemove, onContext,
}: {
  agents: Agent[];
  onClose: () => void;
  onAdd: () => void | Promise<void>;
  onToggle: (id: string, enabled: boolean) => void | Promise<void>;
  onRename: (agent: Agent) => void | Promise<void>;
  onRemove: (agent: Agent) => void | Promise<void>;
  onContext: (agent: Agent, file: File) => void | Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const visible = agents.filter((a) => `${a.name} ${a.id} ${a.role}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal agent-directory" onClick={(e) => e.stopPropagation()}>
        <header><h3>Agent 用户目录</h3><button className="x" onClick={onClose}>×</button></header>
        <div className="directory-toolbar">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索用户、ID 或角色" />
          <button className="primary" onClick={() => void onAdd()}>＋ 新增</button>
        </div>
        <div className="directory-list">
          {visible.map((a) => (
            <div className={`directory-card ${a.enabled ? "" : "disabled"}`} key={a.id}>
              <div className="directory-card-main"><strong>{a.name}</strong>{a.role === "root" && <em className="root-mark">ROOT</em>}<small>{a.id} · {a.enabled ? "已启用" : "已禁用"}</small></div>
              <div className="directory-actions"><label className="tag context-button">导入上下文<input type="file" accept=".md,.txt,.json,.csv,.png,.jpg,.jpeg,.gif,.webp" hidden onChange={(e) => { const file = e.target.files?.[0]; if (file) void onContext(a, file); e.target.value = ""; }} /></label><button className="tag" onClick={() => void onToggle(a.id, !a.enabled)}>{a.enabled ? "禁用" : "启用"}</button><button className="tag" onClick={() => void onRename(a)}>重命名</button>{a.role !== "root" && <button className="del" onClick={() => void onRemove(a)}>×</button>}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// -------------------------------------------------------------- settings -----
function SettingsModal({
  config,
  agents,
  onAgentsChange,
  onClose,
  onSave,
}: {
  config: Config;
  agents: Agent[];
  onAgentsChange: Dispatch<SetStateAction<Agent[]>>;
  onClose: () => void;
  onSave: (cfg: Partial<Config>) => void | Promise<void>;
}) {
  const [local, setLocal] = useState<ApiSource>({ ...config.local });
  const [root, setRoot] = useState<Config["root"]>({ ...config.root });
  const [modelOptions, setModelOptions] = useState<Record<string, string[]>>({});
  const [loadingModels, setLoadingModels] = useState<string | null>(null);
  const [agentDrafts, setAgentDrafts] = useState<Record<string, ApiSource>>(
    Object.fromEntries(
      agents.map((a) => [a.id, { ...(a.api || config.local), allowed_extensions: a.api?.allowed_extensions || [".md"] }]),
    ),
  );
  const [permissionDrafts, setPermissionDrafts] = useState<Record<string, string>>(
    Object.fromEntries(agents.map((a) => [a.id, (a.permissions.targets || []).map((r) => `${r.path}|${r.read ? "r" : ""}${r.write ? "w" : ""}${r.execute ? "x" : ""}`).join("\n")])),
  );

  const updateAgentDraft = (id: string, patch: Partial<ApiSource>) =>
    setAgentDrafts((all) => ({ ...all, [id]: { ...all[id], ...patch } }));

  const discoverModels = async (key: string, source: ApiSource) => {
    setLoadingModels(key);
    try {
      const result = await api.models(source);
      setModelOptions((all) => ({ ...all, [key]: result.models }));
    } catch (e) {
      window.alert(`模型列表获取失败：${String(e)}`);
    } finally {
      setLoadingModels(null);
    }
  };

  const save = async () => {
    for (const a of agents) {
      const draft = agentDrafts[a.id];
      if (draft) {
        const permissions = (permissionDrafts[a.id] || "").split("\n").map((line) => {
          const [path, flags = ""] = line.split("|");
          return { path: path.trim() || "**", read: flags.includes("r"), write: flags.includes("w"), execute: flags.includes("x") };
        }).filter((r) => r.path);
        const updated = await api.patchAgent(a.id, { api: draft, permissions: { targets: permissions } });
        onAgentsChange((list) => list.map((x) => (x.id === updated.id ? updated : x)));
      }
    }
    await onSave({ local, root });
  };

  const field = (
    label: string,
    value: string,
    onChange: (v: string) => void,
    type = "text",
    placeholder = "",
  ) => (
    <label className="field">
      <span>{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );

  const modelField = (key: string, value: string, source: ApiSource, onChange: (v: string) => void) => (
    <>
      {field("模型", value, onChange)}
      <button type="button" className="ghost" disabled={loadingModels === key} onClick={() => void discoverModels(key, source)}>
        {loadingModels === key ? "获取中…" : "根据 API Key 获取模型"}
      </button>
      {(modelOptions[key] || []).length > 0 && (
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          {modelOptions[key].map((model) => <option key={model} value={model}>{model}</option>)}
        </select>
      )}
    </>
  );

  const effortField = (source: ApiSource, onChange: (v: ApiSource["reasoning_effort"]) => void) => (
    <label className="field"><span>思考强度</span><select value={source.reasoning_effort || "high"} onChange={(e) => onChange(e.target.value as ApiSource["reasoning_effort"])}>
      <option value="none">关闭思考</option><option value="low">低</option><option value="high">高</option><option value="max">最大</option>
    </select></label>
  );

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h3>设置</h3>
          <button className="x" onClick={onClose}>
            ×
          </button>
        </header>

        <section>
          <h4>本地计算 · vllm-metal</h4>
          {field("接口地址", local.base_url, (v) => setLocal({ ...local, base_url: v }))}
          {modelField("local", local.model, local, (v) => setLocal({ ...local, model: v }))}
          {effortField(local, (v) => setLocal({ ...local, reasoning_effort: v }))}
          {field("API Key（可选）", local.api_key, (v) => setLocal({ ...local, api_key: v }), "password")}
        </section>

        <section className="highlight">
          <h4>
            Root Agent 导入
            <span className="badge">外置模型 API</span>
          </h4>
          <label className="switch">
            <input
              type="checkbox"
              checked={root.use_external}
              onChange={(e) => setRoot({ ...root, use_external: e.target.checked })}
            />
            <span>Root Agent 使用外置 API（关闭则用本地计算）</span>
          </label>
          <div className={root.use_external ? "" : "dim"}>
            {field("接口地址", root.base_url, (v) => setRoot({ ...root, base_url: v }))}
            {modelField("root", root.model, root, (v) => setRoot({ ...root, model: v }))}
            {effortField(root, (v) => setRoot({ ...root, reasoning_effort: v }))}
            {field("API Key", root.api_key, (v) => setRoot({ ...root, api_key: v }), "password")}
          </div>
          <p className="note">
            导入后，Root Agent 的对话与汇报将通过该外置接口执行；其余 agent 用户仍走本地模型。
          </p>
        </section>

        <section>
          <h4>Agent 用户独立接口与文件格式</h4>
          <p className="note">每个 agent 可单独指定 OpenAI 兼容接口、模型，以及允许导入的文件扩展名（逗号分隔，例如 .md,.txt,.pdf）。</p>
          {agents.filter((a) => a.role !== "root").map((a) => {
            const draft = agentDrafts[a.id];
            return (
              <div className="agent-config" key={a.id}>
                <strong>{a.name}</strong>
                {field("接口地址", draft.base_url, (v) => updateAgentDraft(a.id, { base_url: v }))}
                {modelField(a.id, draft.model, draft, (v) => updateAgentDraft(a.id, { model: v }))}
                {effortField(draft, (v) => updateAgentDraft(a.id, { reasoning_effort: v }))}
                {field("API Key", draft.api_key, (v) => updateAgentDraft(a.id, { api_key: v }), "password")}
                {field("允许格式", (draft.allowed_extensions || [".md"]).join(","), (v) =>
                  updateAgentDraft(a.id, { allowed_extensions: v.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean) }),
                )}
                <label className="field">
                  <span>目标文件权限</span>
                  <textarea
                    rows={2}
                    value={permissionDrafts[a.id] || ""}
                    placeholder="路径规则|权限，例如：data/**/*.md|rw"
                    onChange={(e) => setPermissionDrafts((all) => ({ ...all, [a.id]: e.target.value }))}
                  />
                </label>
              </div>
            );
          })}
        </section>

        <footer>
          <button className="ghost" onClick={onClose}>
            取消
          </button>
          <button className="primary" onClick={() => void save()}>
            保存
          </button>
        </footer>
      </div>
    </div>
  );
}
