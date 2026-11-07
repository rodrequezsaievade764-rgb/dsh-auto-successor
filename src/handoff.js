// 接力执行：收集旧会话记录 → 摘要 → 建新会话 → 注入交接稿 → 归档旧会话。
// 全部通过注入的宿主句柄操作，便于 mock 测试。

import { askModel } from './llm.js'
import {
  SUMMARY_SYSTEM,
  buildSummaryUser,
  buildSeedText,
  extractText,
  estimateTurns,
  nextHandoffTitle,
  fallbackBrief,
} from './core.js'

const MAX_ENTRIES = 40        // 交给摘要模型的对话条数
const MAX_ENTRY_CHARS = 1500  // 单条截断

/**
 * 把交接稿挂到新会话的系统提示词侧，不消耗一轮对话。
 * 宿主没这个能力就返回 false，由调用方回落 followup —— seedMode 不再是个只写不读的假开关。
 */
async function trySystemPromptSeed(agent, sc, seed) {
  try {
    if (agent && typeof agent.setSystemPromptAppend === 'function') {
      await agent.setSystemPromptAppend(seed)
      return true
    }
    if (agent && typeof agent.setSystemPrompt === 'function') {
      await agent.setSystemPrompt(seed)
      return true
    }
    if (sc && typeof sc.setSystemPromptAppend === 'function') {
      await sc.setSystemPromptAppend({ sessionId: agent?.session?.id, text: seed })
      return true
    }
  } catch {}
  return false
}

/** 收集旧会话最近对话：优先宿主 sessionController.readEvent，拿不到就退回 session log 投影。 */
export async function collectEntries(handles, session, { max = MAX_ENTRIES } = {}) {
  const events = []
  try {
    const sc = handles.controller?.()
    if (sc && typeof sc.readEvent === 'function') {
      // 读最近一段事件窗口；接口不认就静默放弃，走兜底
      const win = await sc.readEvent({ sessionId: session.id, tail: 400 })
      const list = Array.isArray(win?.events) ? win.events : Array.isArray(win) ? win : []
      for (const ev of list) {
        const role = ev?.type === 'user/message' ? 'user' : ev?.type === 'assistant/message' ? 'assistant' : null
        if (!role) continue
        const text = extractText(ev?.data?.message?.content ?? ev?.data?.content)
        if (!text) continue
        if (ev?.data?.interrupted) continue
        events.push({ role, text })
      }
    }
  } catch {}
  // 兜底：session.log 事件投影（DSH session 对象带 events 可迭代接口时）
  if (!events.length && typeof session?.events === 'function') {
    try {
      for (const ev of session.events()) {
        const role = ev?.type === 'user/message' ? 'user' : ev?.type === 'assistant/message' ? 'assistant' : null
        if (!role) continue
        const text = extractText(ev?.data?.message?.content ?? ev?.data?.content)
        if (text) events.push({ role, text })
      }
    } catch {}
  }
  const trimmed = events
    .map((e) => ({ role: e.role, text: e.text.replace(/\s+\n/g, '\n').slice(0, MAX_ENTRY_CHARS) }))
  return trimmed.slice(-max)
}

/** 生成交接稿；模型失败时降级为原始记录截取。 */
export async function makeBrief(handles, dsh, cfg, { session, title, entries, turns, percent }) {
  if (!entries.length) throw new Error('会话里没有可交接的对话记录')
  let brief = ''
  let degraded = false
  let error = ''
  try {
    brief = await askModel(dsh, {
      system: SUMMARY_SYSTEM,
      text: buildSummaryUser(entries, { title, turns, percent }),
      maxTokens: 2000,
      reasoningEffort: 'low',
      cfg,
    })
    if (!brief) throw new Error('模型返回空')
  } catch (e) {
    degraded = true
    error = String(e && e.message || e)
    brief = fallbackBrief(entries, { title })
  }
  return { brief, degraded, error }
}

/** 完整接力：返回结果对象（成功/失败都带 message）。 */
export async function handoff(handles, dsh, cfg, { session, agent, reason = '', percent = null, title = '', turns = 0 }) {
  const log = handles.log || console
  const result = { ok: false, steps: [] }
  const step = (s) => { result.steps.push(s); log.info('自动接力：' + s) }

  // 1. 收集旧会话内容
  step('收集旧会话记录')
  const entries = await collectEntries(handles, session)
  if (!entries.length) {
    result.message = '会话里没有可交接的记录，跳过'
    return result
  }

  // 2. 摘要（turns 拿不到真值时按对话条数估算，别写「约 0」进交接稿）
  step('生成交接稿')
  const realTurns = Number(turns) > 0 ? Number(turns) : estimateTurns(entries)
  const { brief, degraded, error } = await makeBrief(handles, dsh, cfg, {
    session, title, entries, turns: realTurns, percent,
  })
  result.degraded = degraded
  result.turns = realTurns
  if (degraded) step(`摘要失败，降级为原始记录：${error}`)

  // 3. 建新会话（同 workspace、同 preset）
  step('创建新会话')
  const sc = handles.controller?.()
  if (!sc || typeof sc.create !== 'function') {
    result.message = '宿主没有 sessionController.create，接力不了'
    return result
  }
  const createArgs = { ...(handles.workspaceId ? { workspaceId: handles.workspaceId } : {}), ...(handles.preset ? { agentPreset: handles.preset } : {}) }
  const created = await sc.create(createArgs)
  const newId = String(created?.sessionId ?? created?.id ?? '')
  if (!newId) {
    result.message = '建新会话失败：宿主没返回 sessionId'
    return result
  }
  result.newSessionId = newId
  try {
    const seedTitle = nextHandoffTitle(title)
    if (typeof sc.rename === 'function') await sc.rename({ sessionId: newId, title: seedTitle })
    step(`新会话 ${newId.slice(-8)}（${seedTitle}）`)
  } catch {}

  // 4. 注入交接稿
  const seed = buildSeedText(brief, { fromTitle: title, percent, reason })
  const newAgent = await handles.resolveAgent(newId)

  // seedMode='system-prompt'：挂系统提示词侧，省掉「已接上」那一轮空转。
  // 宿主不给这个能力就老老实实回落 followup，并在 steps 里写明降级原因 —— 不静默。
  if (cfg.seedMode === 'system-prompt') {
    const ok = await trySystemPromptSeed(newAgent, sc, seed)
    if (ok) {
      step('交接稿已挂到新会话系统提示词（省一轮）')
      result.seedMode = 'system-prompt'
      result.seedText = seed
    } else {
      step('宿主不支持系统提示词注入，回落 followup')
    }
  }

  if (result.seedMode !== 'system-prompt') {
    step('注入交接稿')
    if (!newAgent || typeof newAgent.followup !== 'function') {
      result.message = '新会话拿到了但没法投递交接稿（没有 followup）'
      result.seedText = seed
      return result
    }
    try {
      if (handles.settleTurn) await handles.settleTurn(newAgent, seed)
      else await newAgent.followup({ role: 'user', content: [{ type: 'text', text: seed }] })
      step('交接稿已送达新会话')
      result.seedMode = 'followup'
    } catch (e) {
      result.message = '交接稿投递失败：' + String(e && e.message || e)
      result.seedText = seed
      return result
    }
  }

  // 5. 归档旧会话
  if (cfg.autoArchive !== false) {
    step('归档旧会话')
    try {
      await handles.archiveSession(session.id)
      result.archived = true
    } catch (e) {
      result.archived = false
      step('归档失败（旧会话保留）：' + String(e && e.message || e))
    }
  }

  result.ok = true
  result.message = `已接力到新会话 ${newId.slice(-8)}${degraded ? '（降级交接稿）' : ''}`
  return result
}
