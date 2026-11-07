// 水位监控：盯所有会话的 turn/end，算水位，到点触发接力。
// 监控 ≠ 执行：watch 只做判断和节流，真正的接力交给 handoff.js。

import { percentOf, shouldHandoff, isExcluded, extractTokens, extractContextWindow, handoffChainDepth } from './core.js'
import { loadState, saveState, appendLog } from './store.js'

export function createWatcher({ dsh, cfg, handles, log = console }) {
  // 每个 session 的运行时观察值：{ turns, lastPercent, lastAt }
  const observed = new Map()
  // 正在接力的 session（防重入）
  const handing = new Set()
  // 最近一次尝试过自动接力但被拒的 session：{ until }，冷却内不再重复打日志
  const quiet = new Map()

  const state = loadState()

  function observedOf(sessionId) {
    let o = observed.get(sessionId)
    if (!o) {
      o = { turns: 0, lastPercent: null, lastAt: 0 }
      observed.set(sessionId, o)
    }
    return o
  }

  /**
   * 量水位。拿不到 tokenMeter 返回 null。
   * window 优先取测量值自带的窗口（最准），其次取会话当前模型的元数据缓存，最后兜底配置值。
   * 早期版本这里有个空 if —— 探测了 agent 当前模型却什么都不做，白拿一次 sel 就扔。现在把
   * 缓存里的窗口用上：宿主 llm 服务如果已经把模型信息缓存过，同步路径就能直接读到。
   */
  function measure(session, agent) {
    try {
      const tm = dsh.get?.('tokenMeter') || dsh.tokenMeter
      if (!tm || typeof tm.measure !== 'function') return null
      const m = tm.measure(session)
      const tokens = extractTokens(m)
      if (!tokens) return null
      let window = extractContextWindow(m) || cachedWindowOfModel(agent) || cfg.defaultContextWindow
      return { tokens, window, percent: percentOf(tokens, window) }
    } catch {
      return null
    }
  }

  /** 从会话当前模型的元数据缓存里同步读上下文窗口。读不到返回 null，绝不抛。 */
  function cachedWindowOfModel(agent) {
    try {
      const sel = agent?.ctx?.model?.current?.()
      if (!sel) return null
      // 常见两形：{ contextWindow } 直接给，或 { info: { contextWindow } }
      return extractContextWindow(sel) || extractContextWindow(sel.info)
    } catch {
      return null
    }
  }

  /** turn/end 的处理入口。 */
  async function onTurnEnd(session, event) {
    const sid = String(session?.id || '')
    if (!sid || handing.has(sid)) return
    const o = observedOf(sid)
    o.turns += 1
    o.lastAt = Date.now()

    const data = event?.data || {}
    if (data.reason && data.reason.kind !== 'completed') return // 半途而废的轮次不算

    let agent = null
    try { agent = dsh.agents?.get(sid) || dsh.agents?.get('session-' + sid) } catch {}
    const m = measure(session, agent)
    if (m) o.lastPercent = m.percent

    // 自动接力判断（enabled=false 时只记录不动作）
    if (!cfg.enabled) return
    const title = safeTitle(session)
    if (isExcluded(title, cfg.excludeTitleRegex)) return
    // 防接力套娃：标题层数到顶就停自动接力，否则长任务会「接力生接力」无限滚下去
    const depth = handoffChainDepth(title)
    if (depth >= (cfg.maxChainDepth ?? 3)) {
      const q = quiet.get(sid)
      if (!q || Date.now() > q) {
        quiet.set(sid, Date.now() + 30 * 60_000)
        log.info(`自动接力：会话 ${sid.slice(-8)} 已是第 ${depth} 代接力，到上限不再自动接（手动仍可）`)
      }
      return
    }
    const decision = shouldHandoff({
      percent: m?.percent ?? null,
      turns: o.turns,
      thresholdPercent: cfg.thresholdPercent,
      minTurns: cfg.minTurns,
      cooldownUntil: state.cooldownUntil || 0,
    })
    if (!decision.yes) {
      // 水位很高但被轮数/冷静期挡住：低频记日志（每 5 分钟最多一条）
      if (m?.percent != null && m.percent >= cfg.thresholdPercent) {
        const q = quiet.get(sid)
        if (!q || Date.now() > q) {
          quiet.set(sid, Date.now() + 5 * 60_000)
          log.info(`自动接力：会话 ${sid.slice(-8)} 水位 ${m.percent}% 但${decision.why}`)
        }
      }
      return
    }

    // 触发接力（fire-and-forget：接力失败只记日志）
    handing.add(sid)
    try {
      log.info(`自动接力：会话 ${sid.slice(-8)} ${decision.why}，开始交接`)
      const r = await handles.handoff({
        session,
        agent,
        reason: decision.why,
        percent: m?.percent ?? null,
        title,
        turns: o.turns,
      })
      appendLog({
        kind: 'auto',
        sessionId: sid,
        title,
        percent: m?.percent ?? null,
        turns: o.turns,
        ok: r.ok,
        message: r.message,
        newSessionId: r.newSessionId,
        degraded: r.degraded || false,
        seedMode: r.seedMode,
        steps: r.steps,
      })
      if (r.ok) {
        state.lastHandoffAt = Date.now()
        state.lastNewSessionId = r.newSessionId
        state.cooldownUntil = Date.now() + cfg.cooldownMinutes * 60_000
        saveState(state)
        observed.delete(sid) // 旧会话的观察值清掉
        log.info(`自动接力：完成 —— ${r.message}`)
      } else {
        log.warn(`自动接力：失败 —— ${r.message}`)
      }
    } catch (e) {
      appendLog({ kind: 'auto', sessionId: sid, title, ok: false, message: String(e && e.message || e) })
      log.warn('自动接力：异常 —— ' + String(e && e.message || e))
    } finally {
      handing.delete(sid)
    }
  }

  /** 面板 / 工具用的快照。 */
  function snapshot() {
    const out = []
    try {
      for (const session of dsh.sessions?.list?.() || []) {
        const sid = String(session.id)
        const o = observed.get(sid)
        let agent = null
        try { agent = dsh.agents?.get(sid) || dsh.agents?.get('session-' + sid) } catch {}
        const m = measure(session, agent)
        out.push({
          sessionId: sid,
          title: safeTitle(session),
          percent: m?.percent ?? o?.lastPercent ?? null,
          tokens: m?.tokens ?? null,
          window: m?.window ?? null,
          turns: o?.turns || 0,
          chainDepth: handoffChainDepth(safeTitle(session)),
          excluded: isExcluded(safeTitle(session), cfg.excludeTitleRegex),
          handing: handing.has(sid),
        })
      }
    } catch {}
    out.sort((a, b) => (b.tokens || 0) - (a.tokens || 0))
    return out
  }

  function safeTitle(session) {
    try { return String(session?.title || '') } catch { return '' }
  }

  return { onTurnEnd, snapshot, observed, state }
}
