// 纯函数核心：水位判断、文本提取、提示词构建。不碰宿主，全部可单测。

/** 从 content 块数组里抽出纯文本。 */
export function extractText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

/** 从 tokenMeter.measure() 的返回值里抠出总 token 数；抠不出返回 null。 */
export function extractTokens(measurement) {
  if (!measurement) return null
  const tries = [
    measurement.tokens,
    measurement.total,
    measurement.used,
    measurement.usedTokens,
    measurement.count,
    measurement.estimate,
    measurement.usage?.total_tokens,
    measurement.usage?.total,
  ]
  for (const v of tries) {
    const n = Number(v)
    if (Number.isFinite(n) && n > 0) return n
  }
  // 形如 { input: 1200, output: 800 }
  const inp = Number(measurement.input)
  const out = Number(measurement.output)
  if (Number.isFinite(inp) && Number.isFinite(out) && inp + out > 0) return inp + out
  return null
}

/** 从测量值 / 模型元数据里抠出上下文窗口；抠不出返回 null。 */
export function extractContextWindow(info) {
  if (!info) return null
  const tries = [
    info.contextWindow,
    info.context_window,
    info.limits?.contextWindow,
    info.maxContextTokens,
    info.window,
  ]
  for (const v of tries) {
    const n = Number(v)
    if (Number.isFinite(n) && n > 4000) return n
  }
  return null
}

export function percentOf(tokens, window) {
  const t = Number(tokens)
  const w = Number(window)
  if (!Number.isFinite(t) || !Number.isFinite(w) || t <= 0 || w <= 0) return null
  return Math.min(100, Math.round((t / w) * 100))
}

/**
 * 接力决策。返回 { yes, why }；force 时只挡「正在接力」以外的都放行。
 * 入参 percent 可为 null（测不出水位）：自动模式不放行，手动 force 放行。
 */
export function shouldHandoff({ percent, turns = 0, thresholdPercent, minTurns, cooldownUntil = 0, now = Date.now(), force = false }) {
  if (cooldownUntil && now < cooldownUntil) {
    return { yes: false, why: `冷静期还剩 ${Math.ceil((cooldownUntil - now) / 60000)} 分钟` }
  }
  if (force) return { yes: true, why: '手动触发' }
  if (turns < minTurns) return { yes: false, why: `轮数不够（${turns}/${minTurns}）` }
  if (percent == null) return { yes: false, why: '测不出水位' }
  if (percent < thresholdPercent) return { yes: false, why: `水位 ${percent}% 未到 ${thresholdPercent}%` }
  return { yes: true, why: `水位 ${percent}% ≥ ${thresholdPercent}%` }
}

/**
 * 从对话条数粗估轮数。
 * 一条用户消息 + 一条助手回复 ≈ 一轮，所以按条数一半取整。
 * 用于「进程重启后 observed 计数丢失、但会话其实跑了很多轮」的场景——
 * 否则交接稿会写「已完成轮数：约 0」，下一个会话据此误判这是个刚开的会话。
 */
export function estimateTurns(entries) {
  if (!Array.isArray(entries) || !entries.length) return 0
  return Math.max(1, Math.round(entries.length / 2))
}

// ---------- 接力链 ----------

// 判前缀用不含尾空格的核心（否则标题正好等于「接力 · 」时剥不掉，会拼出「接力 · 接力 · 」）；
// 拼标题时再补上尾空格。
const TITLE_CORE = '接力 ·'

export const HANDOFF_TITLE_PREFIX = TITLE_CORE + ' '

/**
 * 标题里的接力层数。
 * 接力出来的会话标题是「接力 · 原标题」，它自己再接力就会变成「接力 · 接力 · 原标题」。
 * 层数用来挡「接力生接力」无限套娃 —— 一个长任务连环接力五层，说明接力本身没解决问题。
 */
export function handoffChainDepth(title) {
  let t = String(title || '').replace(/\s+/g, ' ').trim()
  let n = 0
  while (t.startsWith(TITLE_CORE)) {
    n += 1
    t = t.slice(TITLE_CORE.length).trim()
  }
  return n
}

/**
 * 下一代会话的标题：固定只留一层前缀，不滚雪球。
 * 60 字截断是宿主的标题上限，先剥前缀再截，防止长前缀把真实标题挤掉。
 */
export function nextHandoffTitle(title, { prefix = HANDOFF_TITLE_PREFIX, max = 60 } = {}) {
  let base = String(title || '').replace(/\s+/g, ' ').trim()
  while (base.startsWith(TITLE_CORE)) base = base.slice(TITLE_CORE.length).trim()
  if (!base) base = '会话'
  return (prefix + base).slice(0, max)
}

/** 标题是否命中排除正则。 */
export function isExcluded(title, patterns) {
  const t = String(title || '')
  for (const p of patterns || []) {
    try {
      if (new RegExp(String(p)).test(t)) return true
    } catch {}
  }
  return false
}

// ---------- 提示词 ----------

export const SUMMARY_SYSTEM = `你是一名任务交接编辑。用户给你一个 AI 编程助手会话的最近对话记录（按顺序，U=用户，A=助手），以及会话标题。
请输出一份交接稿（Markdown，≤500 字），让下一个全新会话能无缝接手。固定结构：

## 任务背景
（这个会话在干什么，1-3 句）

## 已完成
（列关键结果与决定，含关键文件路径 / 命令 / 参数原文）

## 进行中
（现在做到哪一步，有什么半成品）

## 下一步
（接下来该做什么，按顺序列 1-5 条）

## 注意
（坑、约束、用户偏好；没有就省略本节）

要求：只用记录里出现的事实，不编造；路径、命令、参数、报错原文照抄；简体中文。直接给交接稿，不要开场白。`

export function buildSummaryUser(entries, { title = '', turns = 0, percent = null } = {}) {
  const head = [`会话标题：${title || '（无）'}`, `已完成轮数：约 ${turns}`, percent != null ? `上下文水位：约 ${percent}%` : null]
    .filter(Boolean)
    .join('\n')
  const body = entries
    .map((e) => `${e.role === 'user' ? 'U' : 'A'}：${e.text}`)
    .join('\n---\n')
  return `${head}\n\n以下是最近对话记录：\n\n${body}`
}

/** 摘要失败时的兜底交接稿：直接截取最近的用户消息和助手回复。 */
export function fallbackBrief(entries, { title = '' } = {}) {
  const lines = [`## 任务背景`, `（自动摘要在本次失败了，下面是原始记录截取。会话：${title || '（无）'}）`, '', `## 最近对话`]
  for (const e of entries.slice(-12)) {
    lines.push(`**${e.role === 'user' ? '用户' : '助手'}**：${e.text.slice(0, 400)}`)
  }
  return lines.join('\n')
}

export function buildSeedText(brief, { fromTitle = '', percent = null, reason = '' } = {}) {
  const head = [
    '【会话接力】',
    `上一个会话${percent != null ? `（上下文水位约 ${percent}%）` : ''}已交接到这里。${reason ? `触发原因：${reason}。` : ''}`,
    fromTitle ? `原会话标题：${fromTitle}。` : '',
    '下面是交接稿。请先记住它；本轮只回复一句「已接上」，不要调用任何工具，不要展开新工作。',
  ]
    .filter(Boolean)
    .join('\n')
  return `${head}\n\n---\n\n${brief}\n\n---`
}
