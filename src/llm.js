// 宿主模型直连（不进会话）：交接稿摘要用。
// 兼容层写法：默认模型探测 + reasoningEffort 先探测后传、被拒重试。

export function defaultModel(dsh, cfg) {
  if (cfg?.model?.provider && cfg?.model?.model) return { provider: cfg.model.provider, model: cfg.model.model }
  try {
    const svc = dsh.get('agentDefaultModel')
    const sel = svc && typeof svc.currentSelection === 'function' ? svc.currentSelection() : null
    if (sel && sel.provider && sel.model) return { provider: sel.provider, model: sel.model }
  } catch {}
  return null
}

const REASONING_TTL = 10 * 60_000
const reasoningCache = new Map()

function cacheReasoning(provider, model, value) {
  reasoningCache.set(`${provider}::${model}`, { at: Date.now(), value })
}

async function modelReasoning(dsh, provider, model) {
  const key = `${provider}::${model}`
  const hit = reasoningCache.get(key)
  if (hit && Date.now() - hit.at < REASONING_TTL) return hit.value
  let value = null
  try {
    const llm = dsh.llm || dsh.get('llm')
    if (llm && typeof llm.resolveModelInfo === 'function') {
      const info = await llm.resolveModelInfo(provider, model)
      const r = info && info.reasoning
      if (r && Array.isArray(r.efforts) && r.efforts.length) {
        value = {
          efforts: r.efforts.map((e) => String(e && e.id ? e.id : e)).filter(Boolean),
          ...(r.defaultEffort ? { default: String(r.defaultEffort) } : {}),
        }
        if (!value.efforts.length) value = null
      }
    }
  } catch {
    value = null
  }
  cacheReasoning(provider, model, value)
  return value
}

const isUnsupportedEffort = (error) =>
  /UNSUPPORTED_REASONING_EFFORT|does not support reasoning effort|reasoning effort/i.test(
    String((error && (error.message || error.code)) || '')
  )

async function runStream(llm, params) {
  let out = ''
  for await (const chunk of llm.stream(params)) {
    if (!chunk) continue
    if (chunk.type === 'text-delta') out += chunk.text
    if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
      const f = chunk.reason.failure || {}
      const error = new Error('模型报错：' + (f.message || f.code || '未知'))
      if (f.code) error.code = f.code
      throw error
    }
  }
  return out.trim()
}

/**
 * @param {object} dsh 宿主 ctx
 * @param {{system:string, text:string, maxTokens?:number, temperature?:number, reasoningEffort?:string, cfg?:object}} o
 * @returns {Promise<string>}
 */
export async function askModel(dsh, o) {
  const llm = dsh.llm || dsh.get('llm')
  if (!llm || typeof llm.stream !== 'function') throw new Error('宿主没有 llm 服务')
  const t = defaultModel(dsh, o.cfg)
  if (!t) throw new Error('拿不到默认模型（DSH 里先选一个模型）')
  const base = {
    provider: t.provider,
    model: t.model,
    system: o.system || '',
    messages: [{ role: 'user', content: [{ type: 'text', text: o.text }] }],
    maxTokens: o.maxTokens || 2000,
    temperature: o.temperature ?? 0.3,
  }
  let effort = await modelReasoning(dsh, t.provider, t.model).then((r) => {
    if (!r) return undefined
    const w = String(o.reasoningEffort || '')
    if (w && r.efforts.includes(w)) return w
    return r.default && r.efforts.includes(r.default) ? r.default : undefined
  })
  for (let attempt = 0; ; attempt++) {
    try {
      return await runStream(llm, effort ? { ...base, reasoningEffort: effort } : base)
    } catch (error) {
      if (attempt === 0 && effort && isUnsupportedEffort(error)) {
        cacheReasoning(t.provider, t.model, null)
        effort = undefined
        continue
      }
      throw error
    }
  }
}
