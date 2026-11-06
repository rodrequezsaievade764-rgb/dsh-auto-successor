// 数据存取：接力史（log.jsonl，每行一条）。单进程低频写，JSONL 追加即可。

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from './config.js'

function logFile() {
  const dir = dataDir()
  mkdirSync(dir, { recursive: true })
  return join(dir, 'log.jsonl')
}

export function appendLog(entry) {
  try {
    appendFileSync(logFile(), JSON.stringify({ at: Date.now(), ...entry }) + '\n', 'utf8')
  } catch {}
}

export function readLog({ limit = 50 } = {}) {
  const file = logFile()
  if (!existsSync(file)) return []
  let lines = []
  try {
    lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
  const out = []
  for (const line of lines.slice(-limit)) {
    try { out.push(JSON.parse(line)) } catch {}
  }
  return out.reverse()
}

/** 读写内存外的轻量状态（冷静期要跨重启）。返回 { cooldownUntil }。 */
const STATE_KEYS = ['cooldownUntil', 'lastHandoffAt', 'lastNewSessionId']

export function loadState() {
  const file = join(dataDir(), 'state.json')
  if (!existsSync(file)) return {}
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const out = {}
    for (const k of STATE_KEYS) if (raw[k] !== undefined) out[k] = raw[k]
    return out
  } catch {
    return {}
  }
}

export function saveState(state) {
  const file = join(dataDir(), 'state.json')
  const out = {}
  for (const k of STATE_KEYS) if (state[k] !== undefined) out[k] = state[k]
  try {
    mkdirSync(dataDir(), { recursive: true })
    writeFileSync(file, JSON.stringify(out, null, 2), 'utf8')
  } catch {}
}
