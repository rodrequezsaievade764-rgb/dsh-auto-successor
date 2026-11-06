// 单元测试：核心纯函数（水位判断 / 文本提取 / 提示词构建 / 配置合并校验）。全部离线。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  extractText, extractTokens, extractContextWindow, percentOf,
  shouldHandoff, isExcluded, buildSummaryUser, buildSeedText, fallbackBrief,
} from '../src/core.js'
import { mergeConfig, validateConfig, DEFAULT_CONFIG } from '../src/config.js'

test('extractText 抽纯文本', () => {
  const c = [{ type: 'text', text: '你好' }, { type: 'image', data: 'x' }, { type: 'text', text: '世界' }]
  assert.equal(extractText(c), '你好\n世界')
  assert.equal(extractText(null), '')
  assert.equal(extractText('not array'), '')
})

test('extractTokens 认全常见形态', () => {
  assert.equal(extractTokens({ tokens: 123 }), 123)
  assert.equal(extractTokens({ used: 45 }), 45)
  assert.equal(extractTokens({ usage: { total_tokens: 789 } }), 789)
  assert.equal(extractTokens({ input: 100, output: 50 }), 150)
  assert.equal(extractTokens(null), null)
  assert.equal(extractTokens({ tokens: 0 }), null)
})

test('extractContextWindow 认全常见形态并有下限', () => {
  assert.equal(extractContextWindow({ contextWindow: 128000 }), 128000)
  assert.equal(extractContextWindow({ limits: { contextWindow: 200000 } }), 200000)
  assert.equal(extractContextWindow({ contextWindow: 100 }), null) // 太小不认
  assert.equal(extractContextWindow(null), null)
})

test('percentOf 基本计算与封顶', () => {
  assert.equal(percentOf(64000, 128000), 50)
  assert.equal(percentOf(200000, 128000), 100)
  assert.equal(percentOf(null, 128000), null)
  assert.equal(percentOf(100, null), null)
})

test('shouldHandoff：阈值/轮数/冷静期/手动', () => {
  const base = { percent: 90, turns: 10, thresholdPercent: 85, minTurns: 6 }
  assert.equal(shouldHandoff(base).yes, true)
  assert.equal(shouldHandoff({ ...base, percent: 50 }).yes, false)
  assert.equal(shouldHandoff({ ...base, turns: 2 }).yes, false)
  assert.equal(shouldHandoff({ ...base, percent: null }).yes, false)
  assert.equal(
    shouldHandoff({ ...base, cooldownUntil: Date.now() + 60_000 }).yes, false)
  assert.equal(shouldHandoff({ ...base, cooldownUntil: Date.now() - 1 }).yes, true)
  // 手动触发：轮数不够、测不出水位都放行
  assert.equal(shouldHandoff({ ...base, percent: null, turns: 0, force: true }).yes, true)
  // 冷静期连手动都挡（防连环接力打爆）——设计如此，面板触发要等冷却过
})

test('isExcluded 正则匹配', () => {
  assert.equal(isExcluded('QQ · 私聊会话', ['^QQ ']), true)
  assert.equal(isExcluded('写个爬虫', ['^QQ ']), false)
  assert.equal(isExcluded('anything', ['[']), false) // 非法正则静默跳过
})

test('buildSummaryUser 固定结构', () => {
  const t = buildSummaryUser(
    [{ role: 'user', text: '帮我写爬虫' }, { role: 'assistant', text: '写好了' }],
    { title: '爬虫会话', turns: 8, percent: 88 }
  )
  assert.ok(t.includes('会话标题：爬虫会话'))
  assert.ok(t.includes('U：帮我写爬虫'))
  assert.ok(t.includes('A：写好了'))
})

test('buildSeedText 带指令头', () => {
  const t = buildSeedText('## 任务背景\n写爬虫', { fromTitle: '旧会话', percent: 91, reason: '水位 91%' })
  assert.ok(t.includes('【会话接力】'))
  assert.ok(t.includes('91%'))
  assert.ok(t.includes('已接上'))
  assert.ok(t.includes('## 任务背景'))
})

test('fallbackBrief 截取最近条目', () => {
  const entries = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: '消息' + i }))
  const t = fallbackBrief(entries, { title: '长会话' })
  assert.ok(t.includes('消息19'))
  assert.ok(!t.includes('消息5\n')) // 只留最近 12 条
})

test('mergeConfig 深合并', () => {
  const merged = mergeConfig(DEFAULT_CONFIG, { thresholdPercent: 90, model: { provider: 'p' } })
  assert.equal(merged.thresholdPercent, 90)
  assert.equal(merged.model.provider, 'p')
  assert.equal(merged.model.model, undefined)
  assert.equal(merged.enabled, true)
})

test('validateConfig 拦非法值', () => {
  const ok = { thresholdPercent: 85, minTurns: 6, cooldownMinutes: 10, defaultContextWindow: 128000, seedMode: 'followup', excludeTitleRegex: [] }
  assert.equal(validateConfig(ok), '')
  assert.notEqual(validateConfig({ ...ok, thresholdPercent: 200 }), '')
  assert.notEqual(validateConfig({ ...ok, seedMode: 'nope' }), '')
  assert.notEqual(validateConfig({ ...ok, excludeTitleRegex: ['['] }), '')
  assert.equal(validateConfig({ ...ok, excludeTitleRegex: ['^QQ '] }), '')
})
