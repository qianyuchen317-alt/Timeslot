# vllm Mesh · 启动接口与维护原则

> **当前状态：实验性版本**
>
> 本项目目前仍弱于主流 Agent 产品，存在破坏性更新和不稳定行为。暂不接受 Issue 或兼容性承诺；使用者需自行跟进更新、迁移数据并承担升级风险。请勿将当前版本直接用于生产环境。

## 核心思想

vllm Mesh 是一个按需调度专家 Agent 的本地 Agent Runtime：Root Agent 负责理解任务、选择专家、拆分依赖、并行执行和结果验证；Agent 只在需要时启动，并拥有独立的状态、模型、工具、权限和经验。系统目标不是堆叠 Agent 数量，而是以少量高相关上下文和可验证经验完成任务闭环。

## 启动接口

唯一入口：`./start.sh`

| 命令 | 作用 |
| --- | --- |
| `./start.sh start` | 启动全部服务（已在运行的自动跳过） |
| `./start.sh stop` | 停止全部服务 |
| `./start.sh restart` | 重启 |
| `./start.sh status` | 查看状态 |
| `./start.sh logs` | 跟踪日志 |

端口约定：`vLLM=8000` · `后端=8100` · `前端=5173`。
日志目录：`logs/`。

---

## 维护原则

1. **单一入口**：所有进程只能由 `start.sh` 启停，禁止手工起服务。
2. **幂等**：`start` 先探测端口，已在运行则跳过；重复执行必须安全。
3. **端口固定**：端口改动只允许发生在 `start.sh`，并由前端 `src/api.ts` 同步。
4. **配置与代码分离**：模型、接口地址、密钥一律存于 SQLite 配置（`backend/db.py` 的 `default_config`），代码只读配置、不写死默认值。
5. **凭据不入库**：API Key 仅存本机 `backend/data/`，不得写入仓库或日志。
6. **数据隔离**：每个 agent 一张独立数据库 `backend/data/agents/<id>.db`；只能经 `db.py` 访问，禁止跨库直连。
7. **依赖锁定**：后端以 `requirements.txt`、前端以 `package.json` 为唯一来源；升级依赖必须同时更新锁文件。
8. **上游单一抽象**：一切模型调用只走 `backend/upstream.py`；新增或更换模型不得绕开它。
9. **目标权限**：权限属于目标文件/路径，不属于 agent 本身；每条规则包含 `path`（glob）与 `read / write / execute`，只能新增规则，不得改变既有含义。
10. **前端契约**：组件与后端只通过 `src/api.ts` 通信，禁止在组件内拼接 URL。
11. **日志集中**：所有输出统一落在 `logs/`，排障先读日志再改代码。
12. **变更最小化**：一次只动一层（模型层 / 后端 / 前端），改完必须能 `./start.sh restart` 自愈。

---

## 架构理念：Agent Runtime / Learning Agent Runtime

本项目不是“多个聊天机器人并排工作”，而是一个面向任务的 Agent Runtime。Agent 的完整定义是：

```text
Agent = Identity + Model + Role + Tools + State + Permissions + Runtime + Evaluation
```

### 任务执行闭环

```text
用户 / API
  → Intent / Task Manager
  → Planner / Orchestrator
  → Task Dependency Graph
  → 按需选择专家 Agent
  → 并行执行独立任务
  → Shared State / Artifacts / Provenance
  → Verifier / Critic
  → Pass：Synthesis / Final Output
  → Fail：Re-plan / Retry / Escalation
```

Root Agent 是 Planner / Orchestrator，负责决定“做什么、由谁做、先后顺序和验收标准”，但不能把未经验证的草稿当成最终事实。简单任务应由单个强 Agent 完成，只有确实需要拆分时才启动 Multi-Agent Graph。

### Agent Pool 与生命周期

专家 Agent 以 Agent Pool 形式存在，不默认同时启动全部用户。Root Agent 需要先识别任务领域，再按需唤起少量合适的专家；独立任务可以并行，有依赖关系的任务必须分阶段执行。Agent 的启用、暂停、恢复、资源、预算、超时、重试和审计属于 Runtime 的一等状态。

目标不是制造无意义的并发，而是在模型、GPU、上下文和接口限制内提高有效利用率；完成任务后释放不再需要的 Agent。

### Control Plane 与 Runtime

Control Plane 负责：

- Agent Identity、Role 和生命周期
- 目标文件权限与当前对话审批策略
- 模型选择、资源预算、调度和限流
- 人工批准、审计、追踪和评估

Runtime 负责：

- Agent Scheduler、Task Queue 和 Parallel Executor
- State Manager、Message Bus 和 Tool Gateway
- 文件、浏览器、代码、MCP / A2A 等工具接入
- Sandbox、超时、重试和故障隔离

### Context、Memory 与 Experience 必须分离

```text
Context    当前任务、当前对话、当前目标
Memory     稳定事实、用户偏好、项目环境
Experience 工作方法、成功/失败记录、策略和验证结果
```

Agent 的固定上下文文件属于 Context，不应与长期经验混为一谈。历史对话也不能全部塞回上下文；每次启动只检索少量高相关内容，避免上下文膨胀、成本上升和注意力稀释。

### 可验证经验闭环

```text
Agent 执行任务
  → Candidate Experience
  → Evaluator / Validator
  → Approved Experience
  → Experience Store
  → 下次启动时检索少量相关经验
```

经验至少分为 `Knowledge / Procedure / Failure / Strategy` 四类，并记录来源任务、创建时间、使用次数、成功次数、失败次数、置信度、适用范围和最近验证时间。Agent 自己产生的经验不能直接成为事实，必须经过验证；经验也允许从 `HIGH` 降级为 `MEDIUM`、`LOW` 或 `ARCHIVED`，防止错误经验自我强化。

最终目标是从“让很多 Agent 同时工作”演进为“让 Agent 在工作中积累可验证的经验，并以极低上下文成本复用”，形成：

```text
Experience → Execution → Evaluation → Experience
```
