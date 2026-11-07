// 配置：默认值 + 深合并 + 校验。
// 数据目录 %USERPROFILE%\.dsh\plugins-data\auto-successor\config.json。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function dataDir() {
  const dir = process.env.DSH_AUTO_SUCCESSOR_HOME || join(homedir(), '.dsh', 'plugins-data', 'auto-successor')
  mkdirSync(dir, { recursive: true })
  return dir
}

export const DEFAULT_CONFIG = {
  version: 1,
  enabled: true,             // 总开关：关了只记录水位，不自动接力
  thresholdPercent: 85,      // 水位阈值（占上下文窗口百分比）
  minTurns: 6,               // 会话至少跑过几轮才允许自动接力（防误伤新会话）
  cooldownMinutes: 10,       // 接力后新会话的冷静期（防连环接力）
  defaultContextWindow: 128000, // 拿不到模型窗口元数据时的兜底值
  seedMode: 'followup',      // followup = 交接稿作为首条消息跑一轮（耐重启）；system-prompt = 挂系统提示词侧（省一轮，宿主不支持时自动回落 followup）
  autoArchive: true,         // 交接完成后归档旧会话
  maxChainDepth: 3,          // 「接力 · 接力 · …」最多套几层；到顶就停自动接力（防套娃），手动仍可触发
  model: {},                 // 摘要用的模型 { provider, model }；不填 = DSH 默认模型
  excludeTitleRegex: [],     // 标题命中这些正则的会话不自动接力（字符串数组，如 '^QQ ·'）
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

export function mergeConfig(defaults, saved) {
  if (!isPlainObject(saved)) return structuredClone(defaults)
  const out = structuredClone(defaults)
  for (const [k, v] of Object.entries(saved)) {
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = mergeConfig(out[k], v)
    else if (v !== undefined) out[k] = structuredClone(v)
  }
  return out
}

export function validateConfig(cfg) {
  if (!cfg) return '配置为空'
  const t = Number(cfg.thresholdPercent)
  if (!Number.isFinite(t) || t < 30 || t > 99) return 'thresholdPercent 要在 30-99 之间'
  const m = Number(cfg.minTurns)
  if (!Number.isInteger(m) || m < 0 || m > 200) return 'minTurns 要在 0-200 之间'
  const c = Number(cfg.cooldownMinutes)
  if (!Number.isFinite(c) || c < 0 || c > 1440) return 'cooldownMinutes 要在 0-1440 之间'
  const w = Number(cfg.defaultContextWindow)
  if (!Number.isInteger(w) || w < 4000 || w > 10_000_000) return 'defaultContextWindow 要在 4000-10000000 之间'
  if (cfg.seedMode !== 'followup' && cfg.seedMode !== 'system-prompt') return "seedMode 只支持 'followup' / 'system-prompt'"
  const d = Number(cfg.maxChainDepth)
  if (!Number.isInteger(d) || d < 1 || d > 20) return 'maxChainDepth 要在 1-20 之间'
  if (!Array.isArray(cfg.excludeTitleRegex)) return 'excludeTitleRegex 要是字符串数组'
  for (const r of cfg.excludeTitleRegex) {
    try { new RegExp(String(r)) } catch { return `excludeTitleRegex 里有非法正则：${r}` }
  }
  return ''
}

export function loadConfig() {
  const file = join(dataDir(), 'config.json')
  let saved = {}
  try {
    saved = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    saved = {}
  }
  return mergeConfig(DEFAULT_CONFIG, saved)
}

export function saveConfig(cfg) {
  const err = validateConfig(cfg)
  if (err) throw new Error(err)
  writeFileSync(join(dataDir(), 'config.json'), JSON.stringify(cfg, null, 2), 'utf8')
  return cfg
}
