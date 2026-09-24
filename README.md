# dsh-auto-work

面向 DeepSeek Harness（DSH）的自动工作插件。它在 DSH 宿主进程内调度任务，支持 Agent 任务和本地命令任务，并提供 Web 看板、模型工具和 HTTP API 三种管理入口。

## 功能

- Agent 任务：按计划向新的或指定的 DSH 会话发送自包含提示词。
- 命令任务：按计划在指定工作目录执行本地命令，并保存输出和退出码。
- 调度方式：一次性时间、固定间隔和五段 cron 表达式。
- 任务控制：创建、查看、立即运行、暂停、恢复、编辑和删除。
- 执行记录：保存每次执行的开始时间、结束时间、结果、错误信息和输出。
- 目标选择：从宿主提供的当前用户可见工作空间和会话中选择执行目标。
- 宿主调度：任务由 DSH 服务进程调度，浏览器关闭不会停止已配置的任务。
- 中央看板：从 DSH 侧栏进入，在会话中栏管理任务，不改变宿主的会话路由。

插件本身不实现身份认证或租户资源管理。它通过 DSH 注入的身份和租户策略服务校验当前请求，并在创建、修改和执行任务前重新检查目标权限。需要在已经提供这些服务的 DSH profile 中加载；当前配套部署使用 `dsh-workos-tenant` 提供身份和资源策略。

## 环境要求

- Node.js 22 或更高版本
- DSH `>=0.1.5-rc.1 <0.2.0`
- Web profile
- 可注入的 `webServer`、`tools`、`agents`、`workosAuth`、`tenantPolicy` 和 `systemPrompt` 服务

## 安装

在 GitHub 创建公开仓库后，在 DSH profile 中直接从 GitHub 安装：

```bash
npx @deepseek-ai/dsh plugin --profile web add "git+https://github.com/gepeiyu/dsh-auto-work.git"
```

仓库需要包含 `package.json`、`src` 和已构建的 `lib/client.js`。

本地开发链接：

```bash
cd /path/to/dsh-auto-work
npm install
npm run build:client
npx @deepseek-ai/dsh plugin --profile web add "link:/path/to/dsh-auto-work"
```

确认 profile 同时加载身份与租户策略服务，然后重启 DSH：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-workos-tenant",
        "dsh-auto-work"
      ]
    }
  }
}
```

## 任务类型

### Agent 任务

Agent 任务需要 `title` 和 `prompt`，可选目标包括已有会话、工作空间和工作目录。没有指定会话时，插件会创建新的 Agent 会话。提示词应包含完整任务要求，因为执行时可能没有人在场回答追问。

### 命令任务

命令任务需要 `title`、`command` 和可选的 `args`、`target.workdir`。命令由 DSH 进程以当前系统用户权限执行，输出尾部和退出码会写入执行记录。只应配置已经审查过、适合无人值守运行的命令。

### 调度

```text
一次性：runAt / run_at，使用毫秒时间戳
固定间隔：intervalMinutes / interval_minutes
cron：五段表达式，例如 30 14 * * *
```

cron 使用本地时间。错过的时间点不会补发；运行中的任务不会重复触发；一次性任务在触发后归档。

## 模型工具

插件注册 `auto_work` 工具，支持以下操作：

| action | 作用 |
| --- | --- |
| `create` | 创建 Agent 或命令任务 |
| `list` | 列出当前用户的任务 |
| `run` | 立即运行指定任务 |
| `pause` | 暂停任务调度 |
| `resume` | 恢复任务调度 |
| `remove` | 删除任务 |

创建任务时常用参数包括 `title`、`prompt`、`kind`、`command`、`args`、`cron`、`interval_minutes`、`run_at` 和 `target`。`target` 可包含 `sessionId`、`workspaceId` 和 `workdir`。

## HTTP API

所有接口都使用当前 DSH 请求身份：

```text
GET    /api/dsh-auto-work/jobs
POST   /api/dsh-auto-work/jobs
PATCH  /api/dsh-auto-work/jobs?id=<job-id>
DELETE /api/dsh-auto-work/jobs?id=<job-id>
POST   /api/dsh-auto-work/jobs/run?id=<job-id>
GET    /api/dsh-auto-work/targets
```

`/targets` 返回当前请求可访问的工作空间和会话，并提供用于界面展示的名称。任务 API、模型工具和 Web 看板共用同一套任务引擎与权限校验。

## 数据存储

默认任务台账：

```text
~/.dsh/auto-work/jobs.json
```

可以通过插件配置覆盖 `storePath`。台账使用临时文件替换写入，进程内写操作串行化；每条任务包含所属身份、调度配置、当前状态和执行记录。任务数据不会写入浏览器本地存储。

## 插件配置

```js
{
  enabled: true,
  storePath: undefined,
  announceToAgent: true
}
```

- `enabled`：设为 `false` 时不启动任务引擎和管理入口。
- `storePath`：自定义任务台账路径。
- `announceToAgent`：是否向 Agent 系统提示注入 `auto_work` 能力说明。

## 开发与验证

```bash
npm install
npm run build:client
npm test
```

测试覆盖调度计算、任务台账、目标策略校验、Agent 执行、命令执行、Cordis 注入和 Web 客户端入口。

## 许可

MIT
