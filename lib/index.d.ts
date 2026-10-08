import z from "schemastery";
import { Context } from "@deepseek-ai/cordis";
//#region src/index.d.ts
/** Plugin name: used for logs, diagnostics, and Fiber identity. */
declare const name = "dsh-auto-work";
declare const inject: string[];
/** Model-facing announcement: plugin presence, capabilities, and limits. */
declare const AUTO_WORK_GUIDANCE = "本机已安装 dsh-auto-work 插件（DSH 定时任务引擎，host 常驻）：60 秒 ticker 在 dsh web 服务进程内常驻运行，dsh web 服务启动即生效（GUI 页面关闭也照常触发）。任务台账存于 ~/.dsh/auto-work/jobs.json。任务分两类：kind=agent（默认，AI Agent 任务）到点通过真实 agent 会话执行 prompt；kind=command（普通任务）不经过 AI，直接 spawn command+args 执行脚本，不消耗 API 额度。任务支持 5 段 cron（如 0 9 * * *）；agent 任务可指定项目 workdir（任务会话在该目录运行并加载其 AGENTS.md）、可指定已有会话 session（每次触发继续该对话，具备上下文连续性）；两者都留空则每次触发在默认工作空间新建会话发起新对话；command 任务只需标题、命令、参数与定时器（workdir 作为进程工作目录，超时同样生效，退出码非 0 记为失败并保留输出尾部）。对话中可用 auto_work 工具直接 create/list/update/pause/resume/remove/run 定时任务（create/update 支持 kind/command/args 参数）；Web GUI 侧边栏「定时任务」面板管理同一批任务。定时执行无人在场，agent 任务的 prompt 必须自包含、不可提问。用户提到「定时任务 / 定时器 / cron」时即指本插件，请据此协作。";
/** Settings namespace of the plugin's capability (lowercase hyphenated id). */
declare const AUTO_WORK_SETTINGS_NAMESPACE = "auto-work";
/** Plugin config, validated by the same-named schemastery schema. */
interface Config {
  /** When true (default), a system-prompt section announces the plugin. */
  announceToAgent?: boolean;
  /** Master switch for the plugin (ticker + tool + routes). */
  enabled?: boolean;
}
declare const Config: z<Config>;
/**
 * Mount the engine: ticker + runner, tool, routes, announcement.
 * @param ctx - host plugin context (webServer/tools/systemPrompt/agents).
 * @param config - resolved plugin config.
 */
declare function apply(ctx: Context, config?: Config): void;
//#endregion
export { AUTO_WORK_GUIDANCE, AUTO_WORK_SETTINGS_NAMESPACE, Config, apply, inject, name };