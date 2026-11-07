// 自动接力 · 宿主半边：会话事件挂载 + 面板 API + 全局工具 + 服务。

import { join } from 'node:path'
import {
  dataDir, loadConfig, mergeConfig, saveConfig,
} from './config.js'
import { createWatcher } from './watch.js'
import { handoff } from './handoff.js'
import { readLog, appendLog, saveState } from './store.js'
import { shouldHandoff } from './core.js'

export const name = 'auto-successor'
// timer 不在依赖里：本插件自己用 setTimeout/setInterval，不经过宿主 timer 服务。
// 少声明一个依赖，就少一种「宿主没这个服务 → apply 干脆不跑」的挂法。
export const inject = ['webServer', 'llm', 'sessions', 'agents']

const PREFIX = '/auto-successor/api'

/**
 * 取 logger。
 * cordis 的 ctx.logger 是工厂函数（ctx.logger(name) → 实例）；测试替身常直接给对象。
 * 两种形态都要吃，否则 log.info 会 undefined 抛错、整个插件挂不上。
 */
export function resolveLogger(ctx, name = 'auto-successor') {
  const raw = ctx && ctx.logger
  if (typeof raw === 'function') {
    try {
      const made = raw(name)
      if (made && typeof made.info === 'function') return made
    } catch {}
    return console
  }
  if (raw && typeof raw.info === 'function') return raw
  return console
}

export function apply(ctx) {
  const log = resolveLogger(ctx)
  let cfg = loadConfig()

  // ---------- 宿主句柄：watch 与 handoff 共用，测试可整包替换 ----------
  const handles = {
    log,
    controller: () => ctx.get('sessionController'),
    workspaceId: null, // 由 ensureWorkspace 填
    preset: null,      // 接力会话继承：不指定 = DSH 默认 preset
    async resolveAgent(sessionId) {
      const live = ctx.agents?.get(sessionId) || ctx.agents?.get('session-' + sessionId)
      if (live) return live
      const sc = handles.controller()
      const r = await sc?.resolveAgent?.(sessionId)
      return r?.agent || null
    },
    async archiveSession(sessionId) {
      const reg = ctx.workspaceRegistry || ctx.get('workspaceRegistry')
      if (!reg || typeof reg.archiveSession !== 'function') throw new Error('宿主没有 workspaceRegistry.archiveSession')
      return reg.archiveSession(sessionId)
    },
    /** 交接稿投递 + 等这一轮落稳（供测试覆盖；生产走 agent.followup 自然返回）。 */
    async settleTurn(agent, seedText) {
      await agent.followup({
        role: 'user',
        content: [{ type: 'text', text: seedText }],
        source: { kind: 'plugin', plugin: 'auto-successor' },
      })
    },
  }

  // 接力会话落在它自己的专用工作区里，不污染用户工作区。
  async function ensureWorkspace() {
    if (handles.workspaceId) return handles.workspaceId
    const reg = ctx.workspaceRegistry || ctx.get('workspaceRegistry')
    if (!reg) throw new Error('宿主没有 workspaceRegistry')
    const TITLE = 'Auto Successor'
    const existing = (reg.list?.() || []).find((w) => w.title === TITLE || String(w.path || '').endsWith('auto-successor'))
    if (existing) {
      handles.workspaceId = existing.id
      return existing.id
    }
    const dir = join(dataDir(), 'workspace')
    const ws = await reg.create(dir, TITLE)
    handles.workspaceId = ws.id
    log.info('自动接力：建好工作区 ' + dir)
    return ws.id
  }

  // ---------- watch ----------
  const watcher = createWatcher({
    dsh: ctx,
    cfg,
    handles: {
      ...handles,
      async handoff(opts) {
        await ensureWorkspace()
        return handoff(handles, ctx, cfg, opts)
      },
    },
    log,
  })

  ctx.effect(() => {
    const off = ctx.on('session/event', (session, event) => {
      try {
        if (event?.type === 'turn/end') watcher.onTurnEnd(session, event)
      } catch (e) {
        log.warn('自动接力：事件处理出错 —— ' + String(e && e.message || e))
      }
    })
    return () => { try { if (typeof off === 'function') off() } catch {} }
  }, 'auto-successor: 盯会话事件')

  // ---------- 手动 / 工具触发 ----------
  async function handoffNow(sessionId, { reason = '手动触发' } = {}) {
    const target = sessionId ? String(sessionId) : currentSessionOf(ctx)
    if (!target) return { ok: false, message: '找不到要接力的会话' }
    const session = ctx.sessions?.get?.(target)
    if (!session) return { ok: false, message: `会话 ${target} 不存在或不在内存里` }
    let agent = null
    try { agent = ctx.agents?.get(target) || ctx.agents?.get('session-' + target) } catch {}
    const m = watcher.snapshot().find((s) => s.sessionId === target)
    await ensureWorkspace()
    // turns 不传 0：0 会被当成「真的零轮」写进交接稿。传 null 让 handoff 按对话条数估算，
    // 这样进程重启后的手动接力不会在交接稿里写「已完成轮数：约 0」。
    const r = await handoff(handles, ctx, cfg, {
      session, agent, reason, percent: m?.percent ?? null, title: m?.title || '', turns: m?.turns || null,
    })
    appendLog({ kind: 'manual', sessionId: target, title: m?.title || '', percent: m?.percent ?? null, ok: r.ok, message: r.message, newSessionId: r.newSessionId, degraded: r.degraded || false, turns: r.turns ?? null, seedMode: r.seedMode, steps: r.steps })
    if (r.ok) {
      watcher.state.lastHandoffAt = Date.now()
      watcher.state.lastNewSessionId = r.newSessionId
      watcher.state.cooldownUntil = Date.now() + cfg.cooldownMinutes * 60_000
      saveState(watcher.state)
    }
    return r
  }

  function currentSessionOf(ctx) {
    try {
      const initiator = ctx.get?.('agents')?.currentInitiator?.()
      if (initiator) return String(initiator.session?.id || initiator.id || '')
    } catch {}
    return ''
  }

  // ---------- 面板 API ----------
  const answer = async (res, fn) => {
    try {
      const v = await fn()
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(v ?? { ok: true }))
    } catch (e) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, message: String(e && e.message || e) }))
    }
  }

  const route = (method, path, handler) =>
    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: PREFIX + path,
        handler: (req, res) => {
          if (req.method !== method) { res.writeHead(405); res.end(); return }
          answer(res, () => handler(req, res))
        },
      }),
      `auto-successor: ${method} ${path}`)

  function readBody(req) {
    return new Promise((resolve) => {
      let buf = ''
      req.on('data', (c) => { buf += c })
      req.on('end', () => { try { resolve(JSON.parse(buf || '{}')) } catch { resolve({}) } })
      req.on('error', () => resolve({}))
    })
  }

  route('GET', '/status', async () => ({
    ok: true,
    version: '0.1.0',
    enabled: cfg.enabled,
    thresholdPercent: cfg.thresholdPercent,
    minTurns: cfg.minTurns,
    cooldownMinutes: cfg.cooldownMinutes,
    cooldownUntil: watcher.state.cooldownUntil || 0,
    seedMode: cfg.seedMode,
    autoArchive: cfg.autoArchive !== false,
    sessions: watcher.snapshot(),
    state: {
      lastHandoffAt: watcher.state.lastHandoffAt || null,
      lastNewSessionId: watcher.state.lastNewSessionId || null,
    },
  }))

  route('GET', '/log', async (req) => ({ ok: true, entries: readLog({ limit: 80 }) }))

  route('GET', '/config', async () => ({ ok: true, config: cfg }))

  route('POST', '/config', async (req) => {
    const body = await readBody(req)
    const next = mergeConfig(cfg, body || {})
    saveConfig(next)
    // 热生效：watcher 与工具闭包都持有 cfg 这个引用，原地覆盖字段而不是换对象
    for (const k of Object.keys(cfg)) delete cfg[k]
    Object.assign(cfg, next)
    return { ok: true, config: cfg }
  })

  route('POST', '/handoff', async (req) => {
    const body = await readBody(req)
    return handoffNow(body?.sessionId, { reason: body?.reason || '面板触发' })
  })

  // ---------- 全局工具 ----------
  // 宿主要求每个工具的 output 里同时有 schema 与 render，缺一个就 warn 级拒收：
  // 插件照常加载，工具却一个都调不到。render 返回内容块数组，不是裸字符串。
  ctx.effect(() => ctx.tools.register({
    name: 'successor_handoff',
    description: '立即触发「自动接力」：把当前会话（或不填 sessionId 时的调用方会话）摘要成交接稿、开新会话接手、归档旧会话。上下文快满或想换新会话时用。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '要接力的会话 id；不填 = 当前会话' },
        reason: { type: 'string', description: '触发原因（写进交接稿）' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            value && value.ok === false
              ? '✗ 接力失败：' + ((value && value.message) || '未知原因')
              : '✓ 已接力' + (value && value.sessionId ? ' → ' + value.sessionId : '') + (value && value.degraded ? '（降级交接稿）' : ''),
        },
      ],
    },
    async execute(args) {
      return handoffNow(args?.sessionId, { reason: args?.reason || '工具触发' })
    },
  }), 'auto-successor: tool successor_handoff')

  ctx.effect(() => ctx.tools.register({
    name: 'successor_status',
    description: '看「自动接力」的状态：各会话上下文水位、轮数、最近接力记录。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => {
        const v = value || {}
        const lines = [
          (v.enabled === false ? '自动接力：关' : '自动接力：开') +
            (v.thresholdPercent != null ? '，阈值 ' + v.thresholdPercent + '%' : ''),
        ]
        const list = Array.isArray(v.sessions) ? v.sessions : []
        if (!list.length) lines.push('还没有观测到活跃会话')
        for (const s of list) {
          lines.push(
            '- ' + (s.title || '(无标题)') + '：' + (s.percent == null ? '测不到' : s.percent + '%') +
              (s.turns != null ? '，' + s.turns + ' 轮' : '') +
              (s.chainDepth ? '，第 ' + s.chainDepth + ' 代接力' : '') +
              (s.handing ? '，接力中' : ''),
          )
        }
        if (v.lastHandoffAt) lines.push('上次接力：' + new Date(v.lastHandoffAt).toLocaleString())
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute() {
      const sessions = watcher.snapshot().slice(0, 15)
      return {
        ok: true,
        enabled: cfg.enabled,
        thresholdPercent: cfg.thresholdPercent,
        sessions: sessions.map((s) => ({
          title: s.title,
          percent: s.percent,
          turns: s.turns,
          handing: s.handing,
          chainDepth: s.chainDepth,
        })),
        lastHandoffAt: watcher.state.lastHandoffAt || null,
      }
    },
  }), 'auto-successor: tool successor_status')

  // ---------- 服务 ----------
  try {
    if (typeof ctx.provide === 'function') {
      ctx.provide('autoSuccessor', {
        version: '0.1.0',
        handoffNow,
        snapshot: () => watcher.snapshot(),
        config: () => cfg,
      })
    }
  } catch {}

  log.info('自动接力：就绪（阈值 ' + cfg.thresholdPercent + '%，数据目录 ' + dataDir() + '）')
}
