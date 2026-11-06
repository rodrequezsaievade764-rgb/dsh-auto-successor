// 端到端测试：mock 宿主（agents/sessions/tokenMeter/sessionController/workspaceRegistry/llm），
// 跑通 watch → handoff 全链路。全程离线，数据目录指到临时目录。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'as-e2e-'))
process.env.DSH_AUTO_SUCCESSOR_HOME = DIR

const { mergeConfig, DEFAULT_CONFIG } = await import('../src/config.js')
const { createWatcher } = await import('../src/watch.js')
const { handoff } = await import('../src/handoff.js')
const { readLog } = await import('../src/store.js')

test.after(() => { rmSync(DIR, { recursive: true, force: true }) })

// ---------- mock 宿主 ----------
function makeDsh({ llmText = '## 任务背景\n在写爬虫，文件在 src/spider.js' } = {}) {
  const agents = new Map()
  const sessions = new Map()
  const archived = []
  const created = []
  const seeds = []
  let idSeq = 0
  return {
    agents: { get: (id) => agents.get(String(id)) },
    sessions: { get: (id) => sessions.get(String(id)), list: () => [...sessions.values()] },
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      if (name === 'tokenMeter') return { measure: (session) => session.__tokens != null ? { tokens: session.__tokens } : null }
      if (name === 'llm') {
        return {
          stream: async function* () {
            yield { type: 'text-delta', text: llmText }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
          resolveModelInfo: async () => null,
        }
      }
      if (name === 'sessionController') {
        return {
          create: async () => {
            const id = 'session-new-' + (++idSeq)
            created.push(id)
            const s = { id, title: '' }
            sessions.set(id, s)
            return { sessionId: id }
          },
          rename: async ({ sessionId, title }) => { const s = sessions.get(sessionId); if (s) s.title = title },
          resolveAgent: async (sessionId) => {
            if (!agents.has(sessionId)) agents.set(sessionId, makeAgent(sessionId))
            return { agent: agents.get(sessionId) }
          },
          readEvent: async () => ({ events: [] }),
        }
      }
      if (name === 'workspaceRegistry') {
        return { list: () => [], create: async () => ({ id: 'ws1' }), archiveSession: async (sid) => { archived.push(sid); return { ok: true } } }
      }
      return undefined
    },
    __state: { agents, sessions, archived, created, seeds },
  }

  function makeAgent(sessionId) {
    return {
      id: sessionId,
      session: { id: sessionId },
      followup: async (msg) => {
        const text = (msg?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
        seeds.push({ sessionId, text })
      },
    }
  }
}

function makeHandles(dsh, extra = {}) {
  return {
    log: { info: () => {}, warn: () => {}, debug: () => {} },
    controller: () => dsh.get('sessionController'),
    workspaceId: 'ws1',
    preset: null,
    async resolveAgent(sessionId) {
      const live = dsh.agents.get(sessionId)
      if (live) return live
      const r = await dsh.get('sessionController').resolveAgent(sessionId)
      return r?.agent || null
    },
    async archiveSession(sessionId) {
      return dsh.get('workspaceRegistry').archiveSession(sessionId)
    },
    async handoff(opts) {
      return handoff(this, dsh, opts.__cfg || cfg, opts)
    },
    ...extra,
  }
}

function makeSession(id, tokens) {
  return { id, title: '测试会话', __tokens: tokens, events: () => [] }
}

function makeEvents(session) {
  // 供 collectEntries 的 session.events() 兜底路径消费
  session.events = () => ([
    { type: 'user/message', data: { message: { content: [{ type: 'text', text: '帮我写一个爬虫' }] } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '写好了，文件在 src/spider.js' }] } } },
    { type: 'user/message', data: { message: { content: [{ type: 'text', text: '跑一下' }] } } },
  ])
  return session
}

const cfg = mergeConfig(DEFAULT_CONFIG, { thresholdPercent: 85, minTurns: 2, cooldownMinutes: 0, defaultContextWindow: 1000, autoArchive: true })

test('端到端：水位到阈值 → 自动接力 → 新会话拿到交接稿 → 旧会话归档', async () => {
  const dsh = makeDsh()
  const handles = makeHandles(dsh)
  const watcher = createWatcher({ dsh, cfg, handles, log: { info: () => {}, warn: () => {} } })
  const session = makeEvents(makeSession('session-old-1', 900)) // 900/1000 = 90% ≥ 85%
  dsh.sessions.get('session-old-1') // 注册进 list
  dsh.sessions.list()
  dsh.__state.sessions.set('session-old-1', session)

  // 第一轮：水位 90%，但轮数 1 < minTurns 2 → 只记录
  await watcher.onTurnEnd(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  assert.equal(dsh.__state.created.length, 0)

  // 第二轮：轮数够了 → 触发接力
  await watcher.onTurnEnd(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  assert.equal(dsh.__state.created.length, 1, '应该建了新会话')
  const newId = dsh.__state.created[0]
  const seed = dsh.__state.seeds.find((s) => s.sessionId === newId)
  assert.ok(seed, '新会话应该收到交接稿')
  assert.ok(seed.text.includes('【会话接力】'))
  assert.ok(seed.text.includes('src/spider.js'), '交接稿应包含旧会话事实')
  assert.ok(dsh.__state.archived.includes('session-old-1'), '旧会话应该归档')
  assert.equal(sessionsTitle(dsh, newId), '接力 · 测试会话')

  // 日志
  const log = readLog({ limit: 10 })
  assert.ok(log.length >= 1)
  assert.equal(log[0].ok, true)
})

function sessionsTitle(dsh, id) {
  return dsh.sessions.get(id)?.title || ''
}

test('端到端：LLM 挂了 → 降级交接稿仍然接力成功', async () => {
  const dsh = makeDsh({ llmText: null })
  // 让 llm.stream 抛错
  dsh.get = ((orig) => (name) => {
    if (name === 'llm') return { stream: async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { message: '模拟故障' } } } } }
    return orig(name)
  })(dsh.get.bind(dsh))
  const handles = makeHandles(dsh)
  const session = makeEvents(makeSession('session-old-2', 950))
  dsh.__state.sessions.set('session-old-2', session)
  const r = await handoff(handles, dsh, { ...cfg, model: {} }, { session, reason: '测试', percent: 95, title: '测试会话', turns: 9 })
  assert.equal(r.ok, true)
  assert.equal(r.degraded, true)
  const seed = dsh.__state.seeds.find((s) => s.sessionId === r.newSessionId)
  assert.ok(seed.text.includes('模拟故障') === false) // 降级稿不含错误细节
  assert.ok(seed.text.includes('帮我写一个爬虫'))
})

test('端到端：手动 force 在轮数不足时也放行', async () => {
  const dsh = makeDsh()
  const handles = makeHandles(dsh)
  const watcher = createWatcher({ dsh, cfg, handles, log: { info: () => {}, warn: () => {} } })
  const session = makeSession('session-old-3', 100) // 10% 水位，远低于阈值
  dsh.__state.sessions.set('session-old-3', session)
  session.events = () => ([
    { type: 'user/message', data: { message: { content: [{ type: 'text', text: '就一句话的会话' }] } } },
  ])
  const r = await handoff(handles, dsh, cfg, { session, reason: '手动', percent: 10, title: '测试', turns: 1 })
  assert.equal(r.ok, true)
  assert.equal(dsh.__state.created.length, 1)
})

test('端到端：冷静期内不自动接力', async () => {
  const dsh = makeDsh()
  const handles = makeHandles(dsh)
  const watcher = createWatcher({ dsh, cfg, handles, log: { info: () => {}, warn: () => {} } })
  watcher.state.cooldownUntil = Date.now() + 10 * 60_000
  const session = makeSession('session-old-4', 990)
  dsh.__state.sessions.set('session-old-4', session)
  makeEvents(session)
  await watcher.onTurnEnd(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await watcher.onTurnEnd(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  assert.equal(dsh.__state.created.length, 0, '冷静期内不该建新会话')
})

test('端到端：排除标题的会话不接力', async () => {
  const dsh = makeDsh()
  const handles = makeHandles(dsh)
  const cfgX = mergeConfig(cfg, { excludeTitleRegex: ['^QQ '] })
  const watcher = createWatcher({ dsh, cfg: cfgX, handles, log: { info: () => {}, warn: () => {} } })
  const session = makeSession('session-old-5', 990)
  session.title = 'QQ · 私聊会话'
  dsh.__state.sessions.set('session-old-5', session)
  makeEvents(session)
  await watcher.onTurnEnd(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await watcher.onTurnEnd(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  assert.equal(dsh.__state.created.length, 0)
})

test('端到端：snapshot 汇总各会话水位', async () => {
  const dsh = makeDsh()
  const handles = makeHandles(dsh)
  const watcher = createWatcher({ dsh, cfg, handles, log: { info: () => {}, warn: () => {} } })
  dsh.__state.sessions.set('s1', makeSession('s1', 800))
  dsh.__state.sessions.set('s2', makeSession('s2', 100))
  const snap = watcher.snapshot()
  assert.equal(snap.length, 2)
  const s1 = snap.find((x) => x.sessionId === 's1')
  assert.equal(s1.percent, 80)
  assert.equal(s1.tokens, 800)
})
