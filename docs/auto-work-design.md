# dsh-auto-work 产品设计

## 目标

为一个 DSH 宿主提供可持续运行的自动工作任务。任务由当前登录用户创建，绑定到自己的会话或工作空间，按一次性时间、固定间隔或五段 cron 触发，并通过真实 Agent 会话执行。

第一阶段的完成标准：

1. 未认证请求无法读取或修改任何任务。
2. 用户只能看到、运行、修改和删除自己的任务。
3. 任务绑定的会话、工作空间和目录在创建、修改、运行前都要经过租户策略校验。
4. DSH 宕机或浏览器关闭后，任务仍由宿主进程继续调度。
5. 一次性任务只消耗一次；重复触发不会产生重复执行记录。
6. Agent 会话的结束事件能够闭合任务执行状态。

## 运行边界

插件依赖已启用的 WorkOS 租户服务：

- `ctx.workosAuth` 提供已验证身份和请求身份上下文；
- `ctx.tenantPolicy` 提供 Session、Workspace 和目录授权；
- `ctx.agents` 提供创建、恢复和驱动 Agent 会话。

任务插件不解析浏览器 Token，不接受请求体中的用户身份，不把全局 workspace registry 当作用户资源列表。

## 数据模型

```ts
interface JobRecord {
  id: string
  owner: { organizationId: string; userId: string }
  title: string
  prompt: string
  target: { sessionId?: string; workspaceId?: string; workdir?: string }
  schedule: {
    enabled: boolean
    cron?: string
    intervalMinutes?: number
    nextRunAt?: number
    lastTriggeredAt?: number
  }
  status: 'idle' | 'running' | 'done' | 'failed' | 'archived'
  executions: ExecutionRecord[]
}
```

任务台账位于 DSH home 下的独立 JSON 文件。写入使用临时文件加替换，进程内写操作通过 Promise 队列串行化。所有读取先解析和过滤无效记录；损坏文件不会阻止宿主启动。

## 请求流程

```text
HTTP / Tool request
        ↓
WorkOS request identity
        ↓
owner = organizationId + userId
        ↓
tenantPolicy 校验 session/workspace/workdir
        ↓
owner-scoped job store
```

后台调度再次执行同样的目标校验。任务创建成功不代表未来永远拥有权限；用户被禁用或资源归属变化后，下一次执行必须失败并记录原因。

## 调度语义

- cron 使用本地时间的五段表达式；错过的时间点不补发，只计算未来最近一次。
- interval 从上次触发点计算，避免宿主重启造成漂移。
- runAt 是一次性任务；任务启动时消耗时间点，执行结束后归档。
- 同一个任务处于 `running` 时跳过新的触发。
- 每次触发先原子地把任务置为 `running`，再启动 Agent，保证单进程内至多一次。

## 执行语义

固定会话目标优先复用正在运行的 Agent，否则恢复已有会话。没有固定会话时创建新会话，并将目标目录传给 Agent。Agent 的用户消息使用独立消息 ID；收到对应的 `user/message` 和 `turn/end` 事件后，执行记录才会闭合。

执行失败包括：目标权限失效、会话恢复失败、Agent 创建失败和 turn 错误。失败结果只影响当前执行记录，周期任务仍保留后续时间点；一次性任务则归档。

## API 与工具

宿主 API：

- `GET /api/dsh-auto-work/jobs`
- `POST /api/dsh-auto-work/jobs`
- `PATCH /api/dsh-auto-work/jobs?id=...`
- `DELETE /api/dsh-auto-work/jobs?id=...`
- `POST /api/dsh-auto-work/jobs/run?id=...`
- `GET /api/dsh-auto-work/targets`

模型工具 `auto_work` 复用同一套引擎和台账。API 和工具不会拥有不同的权限规则。

## 实现阶段

当前版本完成宿主引擎、文件台账、租户校验、Agent 执行、HTTP API、模型工具、标准 Web 任务面板和核心测试。执行详情、超时取消、失败重试和通知仍按后续迭代推进；这些功能必须复用现有 API，不得在浏览器另建任务状态源。

## Web 页面规格

任务页面采用侧栏入口和中央看板的布局。入口在宿主重新渲染后自动恢复；打开看板时只接管会话中栏，侧栏和会话数据仍由宿主维护。点击会话或工作空间行会自动返回会话视图。

- 看板顶部：页面标题、当前账号提示、搜索框、新建任务、刷新和返回会话。
- 状态标签：全部、待机、运行中、成功、失败、已归档，并显示每类数量。
- 响应式任务卡片：状态、标题、提示词摘要、下次执行时间、目标和执行次数。
- 详情弹层：展示执行目标、完整提示词和执行历史，并提供立即运行、暂停/恢复、编辑和删除。
- 新建/编辑表单：标题、提示词、cron 和服务端过滤后的目标选择器。
- 视觉规范：使用宿主主题变量，保持紧凑的边框、间距、状态色和弹层层级；用户输入通过 DOM 文本节点写入，不直接拼接用户内容。
- 权限规范：目标选择器只显示 `/api/dsh-auto-work/targets` 返回的当前用户资源，页面本身不承担授权职责。
