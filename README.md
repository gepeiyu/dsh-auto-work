# dsh-auto-work

DSH Web GUI 的常驻定时任务插件。插件运行在 DSH Web 宿主进程中，提供定时任务存储、Agent 会话执行、普通命令执行和 Web GUI 管理入口。

## 功能

- 5 段 Cron 定时执行
- 固定间隔任务
- 一次性任务
- Agent 会话任务
- 普通命令任务
- 继续已有会话或在指定工作目录创建新会话
- 任务暂停、恢复、归档、重启、删除和立即执行
- 执行状态与历史记录
- Web GUI 任务面板
- `auto_work` 模型工具
- 回环地址 HTTP API
- 任务台账持久化到 `~/.dsh/auto-work/jobs.json`

## 环境要求

- Node.js `>=22`
- pnpm
- DSH `0.1.5-rc.2` 或兼容版本
- DSH Web profile

## 安装

在项目目录执行：

```bash
pnpm install
pnpm run build
```

通过本地目录安装到 DSH Web profile：

```bash
dsh plugin --profile web add link:/Users/silverwing/.dsh/user-data/org_01M2EMBYTX6BFZJQYJQAQTF3DW/user_01M27J1PVNCGXZXPB2WF6XJBEA/dsh-auto-work
```

安装后重启 DSH Web 服务：

```bash
dsh web
```

## 构建与检查

```bash
pnpm install
pnpm run typecheck
pnpm run build
pnpm test
```

构建会生成 `lib/index.js`、`lib/client.js`、`lib/style.css` 和类型声明文件。

## 配置

插件配置：

```json
{
  "enabled": true,
  "announceToAgent": true
}
```

- `enabled`：启用或停用定时器、工具和路由
- `announceToAgent`：是否向 Agent 注入插件能力说明

## `auto_work` 工具

支持的操作：

```text
create  list  update  pause  resume  archive  restart  remove  run
```

常用创建参数：

- `name`：任务标题
- `prompt`：Agent 任务提示词
- `schedule`：5 段 Cron 表达式
- `interval_minutes`：固定间隔分钟数
- `run_at`：一次性任务执行时间
- `kind`：`agent` 或 `command`
- `command`：普通命令任务的可执行程序
- `args`：命令参数
- `workdir`：任务工作目录
- `session`：继续已有会话
- `preset`：Agent preset
- `timeout_minutes`：执行超时时间

示例：

```json
{
  "action": "create",
  "name": "每日检查",
  "prompt": "检查项目状态并整理结果",
  "schedule": "0 9 * * *"
}
```

## HTTP API

```text
/api/dsh-auto-work/jobs
/api/dsh-auto-work/jobs/run
/api/dsh-auto-work/workspaces
/api/dsh-auto-work/model-options
/api/dsh-auto-work/preset-options
```

API 仅允许回环请求，并由 Web GUI 使用。

## 目录说明

```text
lib/       构建产物
scripts/   构建辅助脚本
src/core/  任务、调度和状态模型
src/host/  宿主存储、执行器、工具和路由
src/client/浏览器端任务面板
```

## 运行限制

- 定时执行依赖 DSH Web 宿主进程保持运行
- 宿主停止期间不会触发任务
- Agent 任务在无人值守环境中执行，提示词应完整且不能依赖即时追问
- 普通命令任务以当前用户权限执行，应只配置经过确认的命令
