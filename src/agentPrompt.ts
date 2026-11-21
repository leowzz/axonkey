export function buildAgentCliPrompt(cliPath?: string | null): string {
  const resolved = typeof cliPath === 'string' ? cliPath.trim() : ''
  return resolved
    ? `请先了解 axonkey-cli（${resolved}），再按我的需求查看和调整设备按键设置。`
    : '请先了解 axonkey-cli，再按我的需求查看和调整设备按键设置。'
}

export type AgentPromptScenario = {
  id: string
  title: string
  summary: string
  task: string
}

export const agentPromptScenarios: readonly AgentPromptScenario[] = [
  {
    id: 'preset-mouse',
    title: '套用飞鼠预制并微调',
    summary: '复制云端或内置预制方案，再按手感调整细节按键',
    task: '查看我当前遥控器可用的飞鼠预制配置，复制创建一套新配置，再列出按键映射供我按习惯微调。',
  },
  {
    id: 'app-profiles',
    title: '按应用自动切换配置',
    summary: '为常用应用绑定专属配置并开启自动切换',
    task: '查看当前可用前台应用和配置，为我常用应用建立并绑定专属配置，再开启按应用自动切换。',
  },
  {
    id: 'quick-prompt',
    title: '纯 Prompt 快捷交互窗',
    summary: '把常用 AI 指令写入纯文本提示词面板并绑定触发键',
    task: '新建一个纯 Prompt 模式的快捷交互配置，写入几条带短标题的常用 AI 提示词模板，并绑定到遥控器按键。',
  },
  {
    id: 'keymap-batch',
    title: '读取键位图批量定制',
    summary: '识别设备真实按键布局并先展示 --dry-run 预览确认',
    task: '先查看我的设备实例与键位图，梳理一套高效桌面控制按键方案，并用 --dry-run 预览后再执行写入。',
  },
]

export function buildAgentScenarioPrompt(task: string, cliPath?: string | null): string {
  const base = buildAgentCliPrompt(cliPath)
  const cleanTask = task.trim()
  return cleanTask ? `${base}\n具体需求：${cleanTask}` : base
}
