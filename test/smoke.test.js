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

// 宿主对工具的校验：output 里必须同时有 schema 与 render，缺一个就 warn 级拒收。
// 这种失败最阴——插件加载成功、日志只有一行警告，工具一个都调不到。
test('每个工具都声明 output.schema 与 output.render（宿主拒收的形状）', () => {
  const ctx = makeCtx()
  host.apply(ctx)
  assert.ok(ctx.__.tools.length >= 2)
  for (const t of ctx.__.tools) {
    assert.ok(t.output && typeof t.output === 'object', `${t.name} 缺 output`)
    assert.equal(typeof t.output.schema, 'object', `${t.name} 的 output.schema 不是对象`)
    assert.equal(typeof t.output.render, 'function', `${t.name} 的 output.render 不是函数`)
  }
})

test('工具的 render 返回内容块数组，不是裸字符串', async () => {
  const ctx = makeCtx()
  host.apply(ctx)
  for (const t of ctx.__.tools) {
    const ok = t.output.render({}, { ok: true, sessions: [], enabled: true, thresholdPercent: 85 })
    assert.ok(Array.isArray(ok), `${t.name} 的 render 没返回数组`)
    assert.equal(ok[0].type, 'text')
    assert.equal(typeof ok[0].text, 'string')
  }
})

test('successor_handoff 的 render 会标出失败与降级', () => {
  const ctx = makeCtx()
  host.apply(ctx)
  const t = ctx.__.tools.find((x) => x.name === 'successor_handoff')
  assert.match(t.output.render({}, { ok: false, message: '炸了' })[0].text, /✗/)
  assert.match(t.output.render({}, { ok: true, sessionId: 's-1' })[0].text, /s-1/)
  assert.match(t.output.render({}, { ok: true, degraded: true })[0].text, /降级/)
})

test('logger 是工厂函数时也能取到（cordis 的实际形态）', () => {
  const made = []
  const ctx = makeCtx()
  const lines = []
  ctx.logger = (name) => {
    made.push(name)
    return { info: (m) => lines.push(m), warn: () => {}, debug: () => {} }
  }
  assert.doesNotThrow(() => host.apply(ctx))
  assert.ok(made.length > 0, '应当用插件名调用工厂')
  assert.ok(lines.some((l) => l.includes('就绪')), '应当走到 log.info')
})

test('logger 缺失时回落到 console，不炸', () => {
  const ctx = makeCtx()
  delete ctx.logger
  assert.doesNotThrow(() => host.apply(ctx))
})
