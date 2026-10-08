import { JobStore } from './store.js'
import { AutoWorkEngine } from './engine.js'
import { makeRoutes } from './routes.js'
import { registerAutoWorkTool } from './tools.js'

export const name = 'dsh-auto-work'
export const inject = ['webServer', 'tools', 'agents', 'workosAuth', 'tenantPolicy', 'systemPrompt']

export const Config = {
  enabled: true,
  storePath: undefined,
  announceToAgent: true,
}

export const AUTO_WORK_GUIDANCE = '当前用户可使用 auto_work 管理自己的自动工作任务。任务会在宿主进程内按计划触发，并且每次访问会话、工作空间和执行目标前都会重新校验当前用户权限。自动任务提示词必须自包含，不能等待人工回答。'

export function apply(ctx, config = {}) {
  ctx.inject(inject, services => {
    if (config.enabled === false) return
    const auth = services.workosAuth
    const tenant = services.tenantPolicy
    if (!auth || !tenant) throw new Error('dsh-auto-work requires workosAuth and tenantPolicy')
    const store = new JobStore(config.storePath)
    const resources = {
      workspaceRegistry: ctx.get?.('workspaceRegistry', false),
      agentDefaultModel: ctx.get?.('agentDefaultModel', false),
      agentPresets: ctx.get?.('agentPresets', false),
      sessions: ctx.get?.('sessions', false),
      sessionPersistence: ctx.get?.('sessionPersistence', false),
      sessionQuery: ctx.get?.('sessionQuery', false),
      sessionController: ctx.get?.('sessionController', false),
    }
    const engine = new AutoWorkEngine({ ctx: { ...services, ...resources }, auth, tenant, store })
    engine.start()
    const routeDisposers = makeRoutes({ auth, tenant, engine, resources }).map(route => services.webServer.register(route))
    const toolDisposer = registerAutoWorkTool(services.tools, { auth, engine })
    let sectionDisposer
    if (config.announceToAgent !== false && services.systemPrompt?.section) {
      sectionDisposer = services.systemPrompt.section({ name: 'plugin:auto-work', order: 220, text: AUTO_WORK_GUIDANCE })
    }
    ctx.effect?.(() => () => {
      void engine.dispose()
      toolDisposer?.()
      for (const dispose of routeDisposers) dispose?.()
      sectionDisposer?.()
    }, 'dsh-auto-work')
  })
}

export default apply
