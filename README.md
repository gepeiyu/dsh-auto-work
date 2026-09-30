# dsh-auto-work

DSH Web GUI 的常驻定时任务插件，运行在 DSH Web 宿主进程中，提供定时任务存储、Agent 会话执行、普通命令执行和 Web GUI 管理入口。

## 功能

- Cron、固定间隔和一次性任务
- Agent 会话任务与普通命令任务
- 继续已有会话或指定工作目录
- 暂停、恢复、归档、重启、删除和立即执行
- 执行状态与历史记录
- Web GUI 任务面板
- `auto_work` 模型工具
- 回环 HTTP API
- 持久化任务台账：`~/.dsh/auto-work/jobs.json`

## 环境要求

- Node.js `>=22`
- pnpm
- DSH `0.1.5-rc.2` 或兼容版本
- DSH Web profile

## 安装

从 Git 仓库安装：

```bash
pnpm install
dsh plugin --profile web add git+https://github.com/gepeiyu/dsh-auto-work.git
dsh web
```

本地开发或测试时，也可以使用目录链接：

```bash
dsh plugin --profile web add link:/path/to/dsh-auto-work
```

安装后重启 DSH Web 服务。

## 开发命令

```bash
pnpm install
pnpm run typecheck
pnpm run build
pnpm test
```

构建产物位于 `lib/`：

- `lib/index.js`：宿主插件入口
- `lib/client.js`：浏览器端插件包
- `lib/style.css`：客户端样式
- `lib/*.d.ts`：类型声明

## 配置

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

常用参数：

- `name`：任务标题
- `prompt`：Agent 任务提示词
- `schedule`：5 段 Cron 表达式
- `interval_minutes`：固定间隔分钟数
- `run_at`：一次性执行时间
- `kind`：`agent` 或 `command`
- `command` / `args`：普通命令及参数
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

## 目录

```text
lib/       构建产物
scripts/   构建辅助脚本
src/core/  任务、调度和状态模型
src/host/  宿主存储、执行器、工具和路由
src/client/浏览器端任务面板
tests/     行为测试
```

## 注意事项

- 定时执行依赖 DSH Web 宿主进程保持运行
- 宿主停止期间不会触发任务
- Agent 任务在无人值守环境中执行，提示词应完整且不能依赖即时追问
- 普通命令任务以当前用户权限执行，应只配置经过确认的命令
