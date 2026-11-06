// 冒烟测试：用 mock ctx 真实调用 apply()，验证宿主半边能挂起来（路由 / 工具 / 服务 / 事件）。
// 这一步能抓住「语法对但 apply 里报错」的问题。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'as-smoke-'))
process.env.DSH_AUTO_SUCCESSOR_HOME = DIR

const host = await import('../src/host.js')

test.after(() => { rmSync(DIR, { recursive: true, force: true }) })

function makeCtx() {
  const routes = []
  const tools = []
  const services = {}
  const effects = []
  const listeners = []
  return {
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    get: () => undefined,
    provide: (name, value) => { services[name] = value },
    effect: (fn, label) => { effects.push({ label, off: fn() }) },
    on: (event, fn) => { listeners.push({ event, fn }); return () => {} },
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    tools: { register: (tool) => { tools.push(tool); return () => {} } },
    agents: { get: () => undefined },
    sessions: { get: () => undefined, list: () => [] },
    llm: { stream: async function* () {} },
    timer: { interval: () => () => {} },
    __: { routes, tools, services, effects, listeners },
  }
}

test('apply() 挂载成功：路由 / 工具 / 服务 / 事件全就位', () => {
  const ctx = makeCtx()
  assert.doesNotThrow(() => host.apply(ctx))

  const paths = ctx.__.routes.map((r) => `${r.path}`)
  assert.ok(paths.includes('/auto-successor/api/status'), '要有 status 路由')
  assert.ok(paths.includes('/auto-successor/api/log'), '要有 log 路由')
  assert.ok(paths.includes('/auto-successor/api/config'), '要有 config 路由')
  assert.ok(paths.includes('/auto-successor/api/handoff'), '要有 handoff 路由')

  const toolNames = ctx.__.tools.map((t) => t.name)
  assert.ok(toolNames.includes('successor_handoff'))
  assert.ok(toolNames.includes('successor_status'))

  assert.ok(ctx.__.services.autoSuccessor, '要对外提供服务')
  assert.equal(typeof ctx.__.services.autoSuccessor.handoffNow, 'function')

  const ev = ctx.__.listeners.find((l) => l.event === 'session/event')
  assert.ok(ev, '要监听 session/event')
})

test('status 路由返回可用 JSON（无会话时不炸）', async () => {
  const ctx = makeCtx()
  host.apply(ctx)
  const route = ctx.__.routes.find((r) => r.path === '/auto-successor/api/status')
  let body = ''
  const res = {
    writeHead: () => {},
    end: (s) => { body = s },
  }
  await route.handler({ method: 'GET', url: route.path }, res)
  const j = JSON.parse(body)
  assert.equal(j.ok, true)
  assert.equal(typeof j.thresholdPercent, 'number')
  assert.deepEqual(j.sessions, [])
})

test('successor_status 工具可执行', async () => {
  const ctx = makeCtx()
  host.apply(ctx)
  const tool = ctx.__.tools.find((t) => t.name === 'successor_status')
  const r = await tool.execute({})
  assert.equal(r.ok, true)
  assert.ok(Array.isArray(r.sessions))
})
