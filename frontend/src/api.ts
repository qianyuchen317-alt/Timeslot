export type TargetPermission = { path: string; read: boolean; write: boolean; execute: boolean };
export type Permission = { targets: TargetPermission[] };

export type ApiSource = {
  base_url: string;
  api_key: string;
  model: string;
  allowed_extensions?: string[];
  reasoning_effort?: "none" | "low" | "high" | "max";
};

export type Agent = {
  id: string;
  name: string;
  enabled: boolean;
  role: "root" | "agent";
  permissions: Permission;
  api: ApiSource | null;
};

export type Config = {
  local: ApiSource;
  root: { use_external: boolean } & ApiSource;
};

export type Project = { id: string; name: string };

export type StreamEvent = {
  delta?: string;
  reasoning?: string;
  error?: string;
  done?: boolean;
};
export type ApprovalMode = "approval" | "low_risk" | "autonomous";

export const API_BASE = "http://127.0.0.1:8100";

async function j<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(API_BASE + url, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!r.ok) throw new Error(await r.text());
  return (await r.json()) as T;
}

export const api = {
  modelStatus: () => j<{ ready: boolean; model: string; stage: string }>("/api/model-status"),
  models: (source: { base_url: string; api_key: string }) =>
    j<{ models: string[] }>("/api/models", { method: "POST", body: JSON.stringify(source) }),
  agents: () => j<Agent[]>("/api/agents"),
  createAgent: (name: string) =>
    j<Agent>("/api/agents", { method: "POST", body: JSON.stringify({ name }) }),
  patchAgent: (
    id: string,
    patch: {
      name?: string;
      enabled?: boolean;
      permissions?: Permission;
      api?: ApiSource | null;
    },
  ) => j<Agent>(`/api/agents/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteAgent: (id: string) => j(`/api/agents/${id}`, { method: "DELETE" }),
  settings: () => j<Config>("/api/settings"),
  saveSettings: (cfg: Partial<Config>) =>
    j<Config>("/api/settings", { method: "PUT", body: JSON.stringify(cfg) }),
  projects: () => j<Project[]>("/api/projects"),
  createProject: (name: string) =>
    j<Project>("/api/projects", { method: "POST", body: JSON.stringify({ name }) }),
  deleteProject: (id: string) => j(`/api/projects/${id}`, { method: "DELETE" }),
  addContext: async (id: string, file: File) => {
    const r = await fetch(`${API_BASE}/api/agents/${id}/context/${encodeURIComponent(file.name)}`, { method: "PUT", body: file });
    if (!r.ok) throw new Error(await r.text());
    return (await r.json()) as { name: string; immutable: boolean };
  },
};

/** 以 SSE 方式与某个 agent 流式对话 */
export async function streamChat(
  agentId: string,
  message: string,
  mode: string,
  approvalMode: ApprovalMode,
  onEvent: (ev: StreamEvent) => void,
): Promise<void> {
  const resp = await fetch(API_BASE + "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent_id: agentId, message, mode, approval_mode: approvalMode }),
  });
  if (!resp.ok || !resp.body) throw new Error(await resp.text());
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = raw.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      try {
        onEvent(JSON.parse(line.slice(5).trim()) as StreamEvent);
      } catch {
        /* ignore malformed frame */
      }
    }
  }
}
