"""SQLite 存储层。

- data/mesh.db                 控制面：agents / settings / projects
- data/agents/<agent_id>.db    每个 agent 用户【独立的数据库】
"""
from __future__ import annotations

import json
import sqlite3
import time
import uuid
from pathlib import Path

BASE = Path(__file__).resolve().parent
DATA = BASE / "data"
AGENT_DIR = DATA / "agents"
CONTEXT_DIR = DATA / "agent_context"
DATA.mkdir(exist_ok=True)
AGENT_DIR.mkdir(exist_ok=True)
CONTEXT_DIR.mkdir(exist_ok=True)
MESH_DB = DATA / "mesh.db"

# 权限属于目标资源，不属于 agent 本身。path 使用 glob 语法。
DEFAULT_PERMS = {"targets": [{"path": "**", "read": True, "write": False, "execute": False}]}

def normalize_permissions(value: dict | None) -> dict:
    value = value or {}
    if isinstance(value.get("targets"), list):
        return {"targets": value["targets"]}
    # 兼容旧数据：旧的 agent 级权限转换为“所有目标”的规则。
    return {"targets": [{"path": "**", **{k: bool(value.get(k, False)) for k in ("read", "write", "execute")}}]}


def _conn(path: Path) -> sqlite3.Connection:
    c = sqlite3.connect(path)
    c.row_factory = sqlite3.Row
    return c


# ---------------------------------------------------------------- config ----
def default_config() -> dict:
    return {
        # 本地计算（vllm-metal）
        "local": {
            "base_url": "http://127.0.0.1:8000/v1",
            "api_key": "",
            "model": "mlx-community/Qwen3.5-9B-MLX-4bit",
            "allowed_extensions": [".md"],
        },
        # Root Agent 的导入接口（可切到外部 API）
        "root": {
            "use_external": False,
            "base_url": "https://api.deepseek.com",
            "api_key": "",
            "model": "deepseek-flash",
            "allowed_extensions": [".md"],
        },
    }


def init() -> None:
    with _conn(MESH_DB) as c:
        c.execute(
            """CREATE TABLE IF NOT EXISTS agents(
                id TEXT PRIMARY KEY, name TEXT, enabled INTEGER, role TEXT,
                permissions TEXT, api TEXT, created_at REAL)"""
        )
        c.execute(
            "CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT)"
        )
        c.execute(
            """CREATE TABLE IF NOT EXISTS projects(
                id TEXT PRIMARY KEY, name TEXT, created_at REAL)"""
        )
    if not get_agents():
        _seed_agents()
    if get_setting("config") is None:
        set_setting("config", default_config())
    if not get_projects():
        add_project("默认项目")


def _seed_agents() -> None:
    rows = [
        ("root", "Root Agent", True, "root", {"read": True, "write": False, "execute": False}, None),
        ("a", "name A", True, "agent", {"read": True, "write": True, "execute": True}, None),
        ("b", "name B", False, "agent", {"read": True, "write": False, "execute": False}, None),
        ("c", "name C", True, "agent", {"read": True, "write": False, "execute": False}, None),
    ]
    with _conn(MESH_DB) as c:
        for i, (aid, name, en, role, perm, api) in enumerate(rows):
            c.execute(
                "INSERT OR REPLACE INTO agents VALUES(?,?,?,?,?,?,?)",
                (aid, name, 1 if en else 0, role, json.dumps(perm), json.dumps(api), time.time() + i),
            )


# ---------------------------------------------------------------- agents ----
def _row_to_agent(r: sqlite3.Row) -> dict:
    aid = r["id"]
    c = _agent_db(aid)
    pr = c.execute("SELECT value FROM agent_meta WHERE key='permissions'").fetchone()
    c.close()
    stored_permissions = json.loads(pr["value"]) if pr else None
    # 旧控制库中的权限只用于一次性迁移，之后权限以 agent 私库为准。
    legacy = json.loads(r["permissions"] or "{}")
    if stored_permissions is None:
        stored_permissions = normalize_permissions(legacy)
        set_agent_permissions(aid, stored_permissions)
    return {
        "id": aid,
        "name": r["name"],
        "enabled": bool(r["enabled"]),
        "role": r["role"],
        "permissions": stored_permissions,
        "api": json.loads(r["api"]) if r["api"] else None,
    }


def get_agents() -> list[dict]:
    with _conn(MESH_DB) as c:
        return [_row_to_agent(r) for r in c.execute("SELECT * FROM agents ORDER BY created_at")]


def get_agent(aid: str) -> dict | None:
    with _conn(MESH_DB) as c:
        r = c.execute("SELECT * FROM agents WHERE id=?", (aid,)).fetchone()
        return _row_to_agent(r) if r else None


def create_agent(name: str, role: str = "agent", permissions: dict | None = None) -> dict:
    aid = uuid.uuid4().hex[:8]
    perms = normalize_permissions(permissions or DEFAULT_PERMS)
    with _conn(MESH_DB) as c:
        c.execute(
            "INSERT INTO agents VALUES(?,?,?,?,?,?,?)",
            (aid, name, 1, role, json.dumps(perms), None, time.time()),
        )
    set_agent_permissions(aid, perms)
    return get_agent(aid)  # type: ignore[return-value]


def update_agent(aid: str, patch: dict) -> dict | None:
    fields, values = [], []
    for key in ("name", "enabled", "role"):
        if key in patch:
            fields.append(f"{key}=?")
            values.append(1 if (key == "enabled" and patch[key]) else patch[key])
    if "permissions" in patch:
        set_agent_permissions(aid, normalize_permissions(patch["permissions"]))
    for key in ("api",):
        if key in patch:
            fields.append(f"{key}=?")
            values.append(json.dumps(normalize_permissions(patch[key])) if patch[key] is not None else None)
    if fields:
        values.append(aid)
        with _conn(MESH_DB) as c:
            c.execute(f"UPDATE agents SET {', '.join(fields)} WHERE id=?", values)
    return get_agent(aid)


def delete_agent(aid: str) -> None:
    with _conn(MESH_DB) as c:
        c.execute("DELETE FROM agents WHERE id=?", (aid,))
    p = AGENT_DIR / f"{aid}.db"
    if p.exists():
        p.unlink()
    cp = CONTEXT_DIR / aid
    if cp.exists():
        import shutil
        shutil.rmtree(cp)


def context_files(aid: str) -> list[str]:
    folder = CONTEXT_DIR / aid
    folder.mkdir(parents=True, exist_ok=True)
    return sorted(p.name for p in folder.iterdir() if p.is_file())


def add_context_file(aid: str, name: str, content: bytes) -> None:
    folder = CONTEXT_DIR / aid
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / name
    if path.exists():
        raise FileExistsError(name)
    path.write_bytes(content)


def context_text(aid: str, max_chars: int = 30000) -> str:
    folder = CONTEXT_DIR / aid
    parts = []
    for path in sorted(folder.glob("*")):
        if path.is_file() and path.suffix.lower() in {".md", ".txt", ".json", ".csv"}:
            parts.append(f"\n--- 上下文文件：{path.name} ---\n{path.read_text(errors='ignore')}")
    return "".join(parts)[:max_chars]


# --------------------------------------------------- per-agent database ----
def _agent_db(aid: str) -> sqlite3.Connection:
    c = _conn(AGENT_DIR / f"{aid}.db")
    c.execute(
        """CREATE TABLE IF NOT EXISTS messages(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            role TEXT, content TEXT, created_at REAL)"""
    )
    c.execute("CREATE TABLE IF NOT EXISTS agent_meta(key TEXT PRIMARY KEY, value TEXT)")
    return c


def set_agent_permissions(aid: str, permissions: dict) -> None:
    c = _agent_db(aid)
    with c:
        c.execute(
            "INSERT OR REPLACE INTO agent_meta(key,value) VALUES('permissions',?)",
            (json.dumps(normalize_permissions(permissions)),),
        )
    c.close()


def add_message(aid: str, role: str, content: str) -> None:
    c = _agent_db(aid)
    with c:
        c.execute(
            "INSERT INTO messages(role,content,created_at) VALUES(?,?,?)",
            (role, content, time.time()),
        )
    c.close()


def get_messages(aid: str, limit: int = 40) -> list[dict]:
    c = _agent_db(aid)
    rows = c.execute(
        "SELECT role,content FROM messages ORDER BY id DESC LIMIT ?", (limit,)
    ).fetchall()
    c.close()
    return [{"role": r["role"], "content": r["content"]} for r in reversed(rows)]


def clear_messages(aid: str) -> None:
    c = _agent_db(aid)
    with c:
        c.execute("DELETE FROM messages")
    c.close()


# -------------------------------------------------------------- settings ----
def get_setting(key: str, default=None):
    with _conn(MESH_DB) as c:
        r = c.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return json.loads(r["value"]) if r else default


def set_setting(key: str, value) -> None:
    with _conn(MESH_DB) as c:
        c.execute(
            "INSERT OR REPLACE INTO settings VALUES(?,?)", (key, json.dumps(value))
        )


# -------------------------------------------------------------- projects ----
def get_projects() -> list[dict]:
    with _conn(MESH_DB) as c:
        return [
            {"id": r["id"], "name": r["name"]}
            for r in c.execute("SELECT id,name FROM projects ORDER BY created_at")
        ]


def add_project(name: str) -> dict:
    pid = uuid.uuid4().hex[:8]
    with _conn(MESH_DB) as c:
        c.execute("INSERT INTO projects VALUES(?,?,?)", (pid, name, time.time()))
    return {"id": pid, "name": name}


def delete_project(pid: str) -> None:
    with _conn(MESH_DB) as c:
        c.execute("DELETE FROM projects WHERE id=?", (pid,))
