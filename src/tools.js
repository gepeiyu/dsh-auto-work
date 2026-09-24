import { defineTool } from '@deepseek-ai/dsh-tools'

function identityOf(auth) {
  const identity = auth?.currentIdentity?.()
  if (!identity) throw Object.assign(new Error('authenticated WorkOS identity is required'), { code: 'AUTH_REQUIRED', status: 401 })
  return identity
}

export function registerAutoWorkTool(tools, { auth, engine }) {
  return tools.register(defineTool({
    name: 'auto_work',
    description: '管理当前登录用户自己的自动工作任务。支持创建、查看、立即运行、暂停、恢复和删除；任务只能使用当前用户有权访问的会话或工作空间。',
    timeoutMs: 15_000,
    parameters: {
      action: { type: 'string', description: 'create、list、run、pause、resume 或 remove。' },
      job_id: { type: 'string', description: '已有任务 ID。' },
      title: { type: 'string', description: '任务标题。' },
      kind: { type: 'string', description: '执行模式：agent 或 command。command 模式不使用大模型。' },
      prompt: { type: 'string', description: 'Agent 任务提示词，必须自包含。' },
      command: { type: 'string', description: 'command 模式要执行的本地命令。' },
      args: { type: 'string', description: 'command 模式的命令参数。' },
      cron: { type: 'string', description: '五段 cron 表达式，例如 0 9 * * *。' },
      interval_minutes: { type: 'number', description: '从触发时刻开始计算的固定间隔分钟数。' },
      run_at: { type: 'number', description: '一次性执行的毫秒时间戳。' },
      target: { type: 'json', description: '目标：{ sessionId?, workspaceId?, workdir? }。只能填写当前用户有权访问的值。' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args) {
      const identity = identityOf(auth)
      switch (args.action) {
        case 'list': return { kind: 'list', jobs: await engine.list(identity) }
        case 'create': return { kind: 'created', job: await engine.create({
          title: args.title, kind: args.kind, prompt: args.prompt, command: args.command, args: args.args, cron: args.cron,
          intervalMinutes: args.interval_minutes, runAt: args.run_at, target: args.target,
        }, identity) }
        case 'run': return { kind: 'run', ok: await engine.run(args.job_id, identity, args.prompt ?? '') }
        case 'pause': return { kind: 'paused', job: await engine.update(args.job_id, { enabled: false }, identity) }
        case 'resume': return { kind: 'resumed', job: await engine.update(args.job_id, { enabled: true }, identity) }
        case 'remove': return { kind: 'removed', ok: await engine.remove(args.job_id, identity) }
        default: return { kind: 'error', error: 'unsupported action' }
      }
    },
  }))
}
