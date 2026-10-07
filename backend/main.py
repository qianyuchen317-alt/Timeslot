"""vllm Mesh 后端。

职责：
- 管理 agent 用户（增删 / 启用禁用 / 权限分级 / 独立数据库）
- 管理配置：本地模型 + Root Agent 的外置 API 导入接口
- /api/chat：把消息流式转发给上游模型（本机 vllm-metal 或外部 API），SSE 返回

启动：uvicorn main:app --host 127.0.0.1 --port 8100
"""
from __future__ import annotations

import json
import httpx
from typing import AsyncIterator

from fastapi import FastAPI, HTTPException, Request
from pathlib import Path
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

import db
import upstream

app = FastAPI(title="vllm Mesh", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _startup() -> None:
    db.init()


# ----------------------------------------------------------------- models ----
class AgentCreate(BaseModel):
    name: str
    role: str = "agent"
    permissions: dict | None = None


class AgentPatch(BaseModel):
    name: str | None = None
    enabled: bool | None = None
    role: str | None = None
    permissions: dict | None = None
    api: dict | None = None


class ChatRequest(BaseModel):
    agent_id: str
    message: str
    mode: str = "admin"  # admin | root
    approval_mode: str = "approval"  # approval | low_risk | autonomous

class ModelsRequest(BaseModel):
    base_url: str
    api_key: str = ""


# ------------------------------------------------------------------ agents ---
@app.get("/api/health")
def health() -> dict:
    return {"ok": True}

@app.get("/api/model-status")
async def model_status() -> dict:
    cfg = db.get_setting("config", db.default_config())
    source = cfg.get("local") or {}
    url = source.get("base_url", "").rstrip("/") + "/models"
    try:
        async with httpx.AsyncClient(timeout=1.5) as client:
            resp = await client.get(url)
        ready = resp.status_code < 400
    except httpx.HTTPError:
        ready = False
    return {"ready": ready, "model": source.get("model", ""), "stage": "ready" if ready else "loading"}

@app.post("/api/models")
async def list_models(body: ModelsRequest) -> dict:
    """发现 OpenAI 兼容接口的模型列表，不保存 API Key。"""
    url = body.base_url.rstrip("/") + "/models"
    headers = {"Authorization": f"Bearer {body.api_key}"} if body.api_key else {}
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.get(url, headers=headers)
        if resp.status_code >= 400:
            raise HTTPException(resp.status_code, resp.text[:300])
        data = resp.json().get("data", [])
        return {"models": sorted([x.get("id") for x in data if x.get("id")])}
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"模型列表请求失败: {exc}") from exc


@app.get("/api/agents")
def list_agents() -> list[dict]:
    return db.get_agents()


@app.post("/api/agents")
def create_agent(body: AgentCreate) -> dict:
    return db.create_agent(body.name, body.role, body.permissions)


@app.patch("/api/agents/{aid}")
def patch_agent(aid: str, body: AgentPatch) -> dict:
    patch = {k: v for k, v in body.model_dump().items() if v is not None}
    # enabled=False 是合法值，需要单独保留
    if body.enabled is not None:
        patch["enabled"] = body.enabled
    agent = db.update_agent(aid, patch)
    if agent is None:
        raise HTTPException(404, "agent not found")
    return agent


@app.delete("/api/agents/{aid}")
def remove_agent(aid: str) -> dict:
    db.delete_agent(aid)
    return {"ok": True}


@app.get("/api/agents/{aid}/messages")
def agent_messages(aid: str) -> list[dict]:
    return db.get_messages(aid)

@app.get("/api/agents/{aid}/context")
def agent_context(aid: str) -> list[str]:
    if db.get_agent(aid) is None:
        raise HTTPException(404, "agent not found")
    return db.context_files(aid)

@app.put("/api/agents/{aid}/context/{filename}")
async def add_agent_context(aid: str, filename: str, request: Request) -> dict:
    if db.get_agent(aid) is None:
        raise HTTPException(404, "agent not found")
    safe = Path(filename).name
    if safe != filename or Path(safe).suffix.lower() not in {".md", ".txt", ".json", ".csv", ".png", ".jpg", ".jpeg", ".gif", ".webp"}:
        raise HTTPException(400, "不支持的上下文文件格式")
    try:
        db.add_context_file(aid, safe, await request.body())
    except FileExistsError:
        raise HTTPException(409, "上下文文件已存在且不可覆盖")
    return {"name": safe, "immutable": True}


@app.delete("/api/agents/{aid}/messages")
def agent_messages_clear(aid: str) -> dict:
    db.clear_messages(aid)
    return {"ok": True}


# ---------------------------------------------------------------- settings ---
@app.get("/api/settings")
def get_settings() -> dict:
    return db.get_setting("config", db.default_config())


@app.put("/api/settings")
def put_settings(body: dict) -> dict:
    cfg = db.get_setting("config", db.default_config())
    for section in ("local", "root"):
        if section in body and isinstance(body[section], dict):
            cfg.setdefault(section, {}).update(body[section])
    db.set_setting("config", cfg)
    return cfg


# ---------------------------------------------------------------- projects ---
@app.get("/api/projects")
def list_projects() -> list[dict]:
    return db.get_projects()


@app.post("/api/projects")
def create_project(body: dict) -> dict:
    name = (body.get("name") or "").strip() or "未命名项目"
    return db.add_project(name)


@app.delete("/api/projects/{pid}")
def remove_project(pid: str) -> dict:
    db.delete_project(pid)
    return {"ok": True}


# ------------------------------------------------------------------ chat -----
def _system_prompt(agent: dict, mode: str, approval_mode: str) -> str:
    rules = (agent.get("permissions") or {}).get("targets", [])
    perm_txt = "；".join(
        f"目标 {r.get('path', '**')}：" + "、".join(
            label for key, label in (("read", "可读"), ("write", "可写"), ("execute", "可执行")) if r.get(key)
        )
        for r in rules
    ) or "无目标权限"
    policy_txt = {
        "approval": "请求批准：任何写入、执行或有风险操作前必须先向管理员请求批准。",
        "low_risk": "低风险直通：只读和明确低风险操作可直接处理；写入、执行、删除、外部发送等操作仍需批准。",
        "autonomous": "全自动：在既有目标文件权限范围内自动执行，不逐项请求批准；遇到越权、危险或不可逆操作必须停下报告。",
    }.get(approval_mode, "请求批准：未知模式按请求批准处理。")
    if agent["role"] == "root":
        return (
            "你是 Root Agent（根代理）。你只有只读权限，不能直接修改数据。"
            "你的职责：接收管理员的指令，把任务拆解并分配给各个 agent 用户，"
            "汇总它们的汇报与进度。"
            "任务与权限分配必须遵守以下原则：最小权限原则，只授予完成当前子任务所必需的目标路径和操作；"
            "权限必须绑定到明确的绝对路径或 glob 目标，并区分 read、write、execute；"
            "不得自行提升、转授或绕过管理员未批准的权限；需要新增权限时，先向管理员提交申请，说明 agent、目标路径、操作类型和理由；"
            "只有收到明确批准后，才可以把该权限作为任务前提；任务完成后汇报实际操作、结果证据、失败原因和仍需的权限。"
            "你必须遵守多专家按需协作流程：先提炼任务目标、约束、交付物和验收标准；"
            "再从专家目录中识别所需领域，只选择真正需要的专家，不得默认启动全部 agent；"
            "为每个专家生成唯一子任务、输入、输出格式、目标文件范围和完成条件；"
            "独立任务并行执行，有依赖的任务分阶段执行；收集结果、证据、置信度和阻塞原因；"
            "发现冲突时安排复核专家，最后由你交叉校验、去重、补缺并汇总，不能把未经验证的草稿当成事实。"
            "分发时必须说明专家角色、子任务、输入、输出、权限、验收标准和状态。"
            "只在有足够独立工作时增加并发，并遵守模型、上下文、GPU和接口限额；禁止重复调用、空转或启动无关专家。"
            "优先让已启动专家持续处理明确任务，完成后释放资源。没有合适专家时必须报告能力缺口，不得假装具备该能力。"
            f"当前对话审批模式：{policy_txt}"
            f"当前模式：{'Root 汇报模式（面向 agent 用户）' if mode == 'root' else '管理员对话模式'}。"
            "回答简洁，用中文。"
        )
    return (
        f"你是 agent 用户「{agent['name']}」，拥有独立数据库与独立权限管理。"
        f"你对目标文件的权限规则：{perm_txt}。只能对匹配规则允许的目标执行读、写或执行操作。"
        "你只负责执行被分配的子任务，完成后向 Root Agent 汇报。回答简洁，用中文。"
    )


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"


def _resolve_source(agent: dict, cfg: dict) -> dict:
    """决定该 agent 走哪个上游：Root 外置 > agent 自带 api > 本地。"""
    if agent["role"] == "root" and (cfg.get("root") or {}).get("use_external"):
        return {**(cfg.get("root") or {}), "_kind": "external"}
    if agent.get("api"):
        return {**agent["api"], "_kind": "external"}
    return {**(cfg.get("local") or {}), "_kind": "local"}


@app.post("/api/chat")
async def chat(req: ChatRequest) -> StreamingResponse:
    agent = db.get_agent(req.agent_id)
    if agent is None:
        raise HTTPException(404, "agent not found")
    if not agent["enabled"]:
        raise HTTPException(400, "该 agent 用户已禁用")

    cfg = db.get_setting("config", db.default_config())
    src = _resolve_source(agent, cfg)

    history = db.get_messages(agent["id"], 20)
    system = _system_prompt(agent, req.mode, req.approval_mode)
    context = db.context_text(agent["id"])
    if context:
        system += "\n以下是该 agent 的只读固定上下文，只能引用，不能修改：" + context
    messages = [{"role": "system", "content": system}]
    messages += history
    messages.append({"role": "user", "content": req.message})
    db.add_message(agent["id"], "user", req.message)

    # 本机 Qwen 默认会输出思考过程，尝试关闭；失败则自动去掉该参数重试
    extra = None
    if src.get("_kind") == "local":
        extra = {"chat_template_kwargs": {"enable_thinking": False}}
    elif "deepseek.com" in src.get("base_url", ""):
        effort = src.get("reasoning_effort", "high")
        extra = {
            "thinking": {"type": "disabled" if effort == "none" else "enabled"},
            "reasoning_effort": effort,
        }

    async def gen() -> AsyncIterator[str]:
        collected: list[str] = []
        try:
            async for ev in _run(src, messages, extra):
                if "delta" in ev:
                    collected.append(ev["delta"])
                yield _sse(ev)
        except Exception as exc:  # noqa: BLE001
            yield _sse({"error": str(exc)})
        reply = "".join(collected).strip()
        if reply:
            db.add_message(agent["id"], "assistant", reply)
        yield _sse({"done": True})

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


async def _run(src: dict, messages: list[dict], extra: dict | None):
    try:
        async for ev in upstream.stream_completion(
            src.get("base_url", ""), src.get("api_key", ""), src.get("model", ""), messages, extra
        ):
            yield ev
    except upstream.UpstreamError as exc:
        if extra is not None and exc.status < 500:
            # 不支持 chat_template_kwargs 的上游，去掉后重试
            async for ev in upstream.stream_completion(
                src.get("base_url", ""), src.get("api_key", ""), src.get("model", ""), messages, None
            ):
                yield ev
        else:
            raise
