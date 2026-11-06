// 自动接力 · 网页半边：侧栏入口 + 面板（状态 / 规则 / 日志 三页）。
// 只读写宿主半边的 /auto-successor/api/*；视觉沿用 DSH 主题变量。

window.__ModuleLoader__.load({
  id: 'dsh-auto-successor',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')
    const { useState, useEffect, useRef } = React
    const h = React.createElement
    const inject = ['slots']
    const PANEL_ID = 'auto-successor'
    const API = '/auto-successor/api'

    const get = (p) => fetch(API + p, { cache: 'no-store' }).then((r) => r.json()).catch((e) => ({ ok: false, message: '连不上插件：' + e.message }))
    const post = (p, body) =>
      fetch(API + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
        .then((r) => r.json())
        .catch((e) => ({ ok: false, message: '连不上插件：' + e.message }))
    const clone = (o) => JSON.parse(JSON.stringify(o))
    const timeAgo = (t) => {
      if (!t) return '—'
      const s = Math.round((Date.now() - t) / 1000)
      if (s < 60) return '刚刚'
      if (s < 3600) return Math.floor(s / 60) + ' 分钟前'
      if (s < 86400) return Math.floor(s / 3600) + ' 小时前'
      return new Date(t).toLocaleString()
    }
    const cx = (...a) => a.filter(Boolean).join(' ')

    const CSS = `
.as-root{--as-accent:#2563eb;--as-accent-soft:rgba(37,99,235,.12);
  --as-text:var(--dsw-alias-label-primary,#1f2328);--as-sub:var(--dsw-alias-label-secondary,#57606a);--as-dim:var(--dsw-alias-label-tertiary,#8b949e);
  --as-bg:var(--dsw-alias-bg-base,#fff);--as-card:var(--dsw-alias-bg-layer-1,#fff);--as-card-2:var(--dsw-alias-bg-layer-2,#f6f8fa);
  --as-line:var(--dsw-alias-border-l1,rgba(0,0,0,.08));--as-line-2:var(--dsw-alias-border-l2,rgba(0,0,0,.12));
  --as-ok:var(--dsw-alias-state-success-primary,#1a7f37);--as-warn:var(--dsw-alias-state-warn-primary,#bf8700);--as-err:var(--dsw-alias-state-error-primary,#cf222e);
  --as-hover:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04));
  height:100%;overflow:auto;background:var(--as-bg);color:var(--as-text);font-size:13px;line-height:1.7;
  padding:var(--dsh-frame-top-clearance,24px) 0 60px;box-sizing:border-box;font-family:var(--dsh-font-family-ui,inherit)}
body[data-ds-dark-theme] .as-root{--as-accent:#6ea8ff}
.as-wrap{max-width:900px;margin:0 auto;padding:0 28px}
.as-hero{display:flex;align-items:center;gap:14px;padding:16px 20px;border-radius:16px;border:1px solid var(--as-line);
  background:linear-gradient(120deg,var(--as-accent-soft),transparent 70%),var(--as-card)}
.as-hero .ico{width:42px;height:42px;flex:none}
.as-hero h1{margin:0;font-size:19px;font-weight:650}
.as-hero .sub{color:var(--as-sub);font-size:12.5px;margin-top:2px}
.as-nav{display:flex;gap:2px;margin:14px 0;border:1px solid var(--as-line);border-radius:12px;background:var(--as-card);padding:4px}
.as-tab{border:0;background:transparent;color:var(--as-sub);padding:7px 14px;border-radius:9px;font:inherit;font-size:13px;cursor:pointer}
.as-tab.on{background:var(--as-accent-soft);color:var(--as-accent);font-weight:600}
.as-card{background:var(--as-card);border:1px solid var(--as-line);border-radius:14px;padding:16px 18px;margin-bottom:14px}
.as-card h3{margin:0 0 8px;font-size:14px;font-weight:620}
.as-btn{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--as-line-2);border-radius:9px;background:var(--as-card);color:var(--as-text);padding:6px 14px;font:inherit;font-size:13px;cursor:pointer}
.as-btn:hover{background:var(--as-hover)}
.as-btn.primary{background:var(--as-accent);border-color:var(--as-accent);color:#fff}
.as-btn.primary:hover{filter:brightness(1.06)}
.as-btn:disabled{opacity:.5;cursor:default}
.as-btn.sm{padding:3px 10px;font-size:12px}
.as-switch{width:34px;height:19px;border-radius:999px;background:var(--as-line-2);border:0;position:relative;cursor:pointer;flex:none;transition:background .15s}
.as-switch:after{content:"";position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;background:#fff;transition:left .15s}
.as-switch.on{background:var(--as-accent)}
.as-switch.on:after{left:17px}
.as-row{display:flex;align-items:center;gap:10px;padding:10px 0;border-top:1px solid var(--as-line)}
.as-row:first-child{border-top:0}
.as-row.set{align-items:flex-start}
.as-label{flex:0 0 170px;font-weight:560}
.as-label small{display:block;color:var(--as-dim);font-weight:400;font-size:11.5px;margin-top:2px}
.as-ctl{flex:1;min-width:0;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.as-input,.as-select{border:1px solid var(--as-line-2);border-radius:8px;padding:6px 10px;background:var(--as-card);color:var(--as-text);font:inherit;outline:none;min-width:0}
.as-input:focus,.as-select:focus{border-color:var(--as-accent);box-shadow:0 0 0 3px var(--as-accent-soft)}
.as-meter{flex:1;min-width:120px;height:8px;border-radius:999px;background:var(--as-card-2);overflow:hidden;border:1px solid var(--as-line)}
.as-meter i{display:block;height:100%;border-radius:999px;transition:width .4s,background .4s}
.as-sess{padding:10px 0;border-top:1px solid var(--as-line)}
.as-sess:first-of-type{border-top:0}
.as-sess .t{font-weight:560;display:flex;align-items:center;gap:8px}
.as-sess .m{color:var(--as-dim);font-size:11.5px;margin-top:2px}
.as-badge{font-size:10.5px;border-radius:999px;padding:1px 8px;border:1px solid var(--as-line-2);color:var(--as-dim)}
.as-badge.warn{color:var(--as-warn);border-color:var(--as-warn)}
.as-badge.hot{color:var(--as-err);border-color:var(--as-err)}
.as-badge.ok{color:var(--as-ok);border-color:var(--as-ok)}
.as-log{padding:9px 0;border-top:1px solid var(--as-line);font-size:12.5px}
.as-log:first-of-type{border-top:0}
.as-log .head{display:flex;gap:8px;align-items:center}
.as-log .msg{color:var(--as-sub);margin-top:2px;word-break:break-all}
.as-log.fail .head b{color:var(--as-err)}
.as-log.okk .head b{color:var(--as-ok)}
.as-empty{padding:36px 20px;text-align:center;color:var(--as-dim)}
.as-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1f2328;color:#fff;border-radius:10px;padding:9px 18px;font-size:13px;z-index:99;box-shadow:0 8px 24px rgba(0,0,0,.25)}
.as-toast.err{background:var(--as-err)}
.as-kbd{border:1px solid var(--as-line-2);border-bottom-width:2px;border-radius:5px;padding:0 5px;font-size:11px;background:var(--as-card-2)}
@media (max-width:640px){.as-row.set{flex-direction:column;align-items:flex-start}.as-wrap{padding:0 14px}}
`
    let cssDone = false
    function ensureCss() {
      if (cssDone || typeof document === 'undefined') return
      cssDone = true
      const el = document.createElement('style')
      el.textContent = CSS
      document.head.appendChild(el)
    }

    const RelayIcon = ({ className }) =>
      h('svg', { className, viewBox: '0 0 24 24', fill: 'none', stroke: 'var(--as-accent)', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('rect', { x: 3, y: 3, width: 8, height: 8, rx: 2 }),
        h('rect', { x: 13, y: 13, width: 8, height: 8, rx: 2 }),
        h('path', { d: 'M11 7h5a3 3 0 0 1 3 3v3M13 17H8a3 3 0 0 1-3-3v-3' }))

    function Switch({ on, onChange, title }) {
      return h('button', { className: 'as-switch' + (on ? ' on' : ''), onClick: () => onChange(!on), title, 'aria-pressed': on })
    }

    function meterColor(p, threshold) {
      if (p == null) return 'var(--as-dim)'
      if (p >= threshold) return 'var(--as-err)'
      if (p >= threshold - 10) return 'var(--as-warn)'
      return 'var(--as-ok)'
    }

    // ================= 状态页 =================
    function StatusTab({ st, reload, toast }) {
      const [busy, setBusy] = useState('')
      const handoff = async (sessionId) => {
        setBusy(sessionId || 'current')
        const r = await post('/handoff', { sessionId: sessionId || undefined, reason: '面板触发' })
        setBusy('')
        toast(r.ok ? r.message : (r.message || '没成功'), r.ok ? 'ok' : 'err')
        reload()
      }
      const sessions = st.sessions || []
      return h('div', null,
        h('div', { className: 'as-card' },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 } },
            h('div', { style: { flex: 1 } },
              h('div', { style: { fontWeight: 600 } }, '各会话上下文水位'),
              h('div', { style: { color: 'var(--as-sub)', fontSize: 12 } },
                `阈值 ${st.thresholdPercent}% · 至少 ${st.minTurns} 轮 · ` +
                (st.cooldownUntil && Date.now() < st.cooldownUntil ? `冷静期至 ${new Date(st.cooldownUntil).toLocaleTimeString()}` : '无冷静期'))),
            h('button', { className: 'as-btn primary', onClick: () => handoff(''), disabled: Boolean(busy) }, busy === 'current' ? '接力中…' : '接力当前会话')),
          sessions.length === 0 && h('div', { className: 'as-empty' }, '现在没有活跃会话'),
          sessions.map((s) =>
            h('div', { key: s.sessionId, className: 'as-sess' },
              h('div', { className: 't' },
                h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 420 } }, s.title || '(无标题)'),
                s.excluded && h('span', { className: 'as-badge' }, '排除'),
                s.handing && h('span', { className: 'as-badge warn' }, '接力中'),
                h('span', { className: 'as-badge' }, '#' + s.sessionId.slice(-6))),
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 } },
                h('div', { className: 'as-meter' }, h('i', { style: { width: (s.percent ?? 0) + '%', background: meterColor(s.percent, st.thresholdPercent) } })),
                h('span', { style: { fontVariantNumeric: 'tabular-nums', color: meterColor(s.percent, st.thresholdPercent), minWidth: 64, textAlign: 'right' } },
                  s.percent != null ? s.percent + '%' : '测不到'),
                h('span', { className: 'as-badge' }, s.turns + ' 轮'),
                h('button', { className: 'as-btn sm', onClick: () => handoff(s.sessionId), disabled: Boolean(busy) || s.handing }, busy === s.sessionId ? '…' : '接力'))))))
    }

    // ================= 规则页 =================
    function RulesTab({ st, reload, toast }) {
      const [cfg, setCfg] = useState(null)
      const [dirty, setDirty] = useState(false)
      const [busy, setBusy] = useState(false)
      useEffect(() => { get('/config').then((r) => { if (r.ok) setCfg(r.config) }) }, [])
      if (!cfg) return h('div', { className: 'as-empty' }, '加载中…')
      const patch = (p) => { setCfg({ ...cfg, ...p }); setDirty(true) }
      const save = async () => {
        setBusy(true)
        const r = await post('/config', cfg)
        setBusy(false)
        if (r.ok) { toast('保存好了，立即生效'); setDirty(false); reload() } else toast(r.message, 'err')
      }
      return h('div', null,
        h('div', { className: 'as-card' },
          h('div', { className: 'as-row set' },
            h('span', { className: 'as-label' }, '总开关', h('small', null, '关了只记录水位，不自动接力')),
            h('div', { className: 'as-ctl' }, h(Switch, { on: cfg.enabled, onChange: (v) => patch({ enabled: v }) }))),
          h('div', { className: 'as-row set' },
            h('span', { className: 'as-label' }, '水位阈值', h('small', null, '占上下文窗口百分比，30-99')),
            h('div', { className: 'as-ctl' },
              h('input', { className: 'as-input', type: 'number', min: 30, max: 99, value: cfg.thresholdPercent, onChange: (e) => patch({ thresholdPercent: Number(e.target.value) }), style: { width: 90 } }),
              h('input', { type: 'range', min: 50, max: 95, value: cfg.thresholdPercent, onChange: (e) => patch({ thresholdPercent: Number(e.target.value) }), style: { flex: 1 } }))),
          h('div', { className: 'as-row set' },
            h('span', { className: 'as-label' }, '最少轮数', h('small', null, '会话跑过这么多轮才允许自动接力')),
            h('div', { className: 'as-ctl' }, h('input', { className: 'as-input', type: 'number', min: 0, max: 200, value: cfg.minTurns, onChange: (e) => patch({ minTurns: Number(e.target.value) }), style: { width: 90 } }))),
          h('div', { className: 'as-row set' },
            h('span', { className: 'as-label' }, '接力后冷静期', h('small', null, '新会话在这么长时间内不再自动接力（分钟）')),
            h('div', { className: 'as-ctl' }, h('input', { className: 'as-input', type: 'number', min: 0, max: 1440, value: cfg.cooldownMinutes, onChange: (e) => patch({ cooldownMinutes: Number(e.target.value) }), style: { width: 90 } }))),
          h('div', { className: 'as-row set' },
            h('span', { className: 'as-label' }, '兜底上下文窗口', h('small', null, '拿不到模型窗口元数据时按这个算（token）')),
            h('div', { className: 'as-ctl' }, h('input', { className: 'as-input', type: 'number', min: 4000, value: cfg.defaultContextWindow, onChange: (e) => patch({ defaultContextWindow: Number(e.target.value) }), style: { width: 130 } }))),
          h('div', { className: 'as-row set' },
            h('span', { className: 'as-label' }, '交接后归档旧会话', h('small', null, '关了就只建新会话，旧的留着')),
            h('div', { className: 'as-ctl' }, h(Switch, { on: cfg.autoArchive !== false, onChange: (v) => patch({ autoArchive: v }) }))),
          h('div', { className: 'as-row set' },
            h('span', { className: 'as-label' }, '排除的会话标题', h('small', null, '正则，一行一条；命中的会话不自动接力')),
            h('div', { className: 'as-ctl' },
              h('textarea', { className: 'as-input', rows: 3, style: { width: '100%', resize: 'vertical' },
                value: (cfg.excludeTitleRegex || []).join('\n'),
                onChange: (e) => patch({ excludeTitleRegex: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) }) }))),
          h('div', { style: { marginTop: 12, display: 'flex', gap: 8 } },
            h('button', { className: 'as-btn primary', onClick: save, disabled: !dirty || busy }, busy ? '保存中…' : '保存规则'),
            dirty && h('button', { className: 'as-btn', onClick: () => get('/config').then((r) => { if (r.ok) { setCfg(r.config); setDirty(false) } }) }, '撤销'))))
    }

    // ================= 日志页 =================
    function LogTab({ toast }) {
      const [log, setLog] = useState(null)
      useEffect(() => { get('/log').then((r) => { if (r.ok) setLog(r.entries) }) }, [])
      if (!log) return h('div', { className: 'as-empty' }, '加载中…')
      if (!log.length) return h('div', { className: 'as-empty' }, '还没有接力记录。水位到阈值或手动触发后这里会记一条。')
      return h('div', { className: 'as-card' },
        log.map((e, i) =>
          h('div', { key: i, className: cx('as-log', e.ok ? 'okk' : 'fail') },
            h('div', { className: 'head' },
              h('b', null, e.ok ? '✓ 接力成功' : '✗ 失败'),
              h('span', { className: 'as-badge' }, e.kind === 'auto' ? '自动' : '手动'),
              h('span', { style: { color: 'var(--as-dim)', fontSize: 11.5 } }, timeAgo(e.at)),
              e.percent != null && h('span', { className: 'as-badge' }, e.percent + '%'),
              e.degraded && h('span', { className: 'as-badge warn' }, '降级交接稿')),
            h('div', { className: 'msg' }, (e.title ? `「${e.title}」 ` : '') + (e.message || '')),
            e.newSessionId && h('div', { className: 'msg' }, '新会话 #' + String(e.newSessionId).slice(-6)))))
    }

    // ================= 主页面 =================
    function AutoSuccessorPage() {
      ensureCss()
      const [tab, setTab] = useState('status')
      const [st, setSt] = useState(null)
      const [toastMsg, setToastMsg] = useState(null)
      const toast = (text, kind) => {
        setToastMsg({ text, kind: kind || 'ok' })
        setTimeout(() => setToastMsg(null), 2800)
      }
      const reload = () => get('/status').then(setSt)
      useEffect(() => {
        reload()
        const t = setInterval(reload, 15000)
        return () => clearInterval(t)
      }, [])

      if (!st) return h('div', { className: 'as-root' }, h('div', { className: 'as-wrap' }, h('div', { className: 'as-empty' }, '加载中…')))
      const enabledCount = (st.sessions || []).filter((s) => s.percent != null && s.percent >= st.thresholdPercent).length
      return h('div', { className: 'as-root' },
        h('div', { className: 'as-wrap' },
          h('div', { className: 'as-hero' },
            h(RelayIcon, { className: 'ico' }),
            h('div', null,
              h('h1', null, '自动接力'),
              h('div', { className: 'sub' },
                (st.enabled ? '已开启 · ' : '已暂停 · ') + `水位到 ${st.thresholdPercent}% 自动换新会话` +
                (enabledCount ? ` · ${enabledCount} 个会话在阈值上方` : '')))),
          h('div', { className: 'as-nav' },
            h('button', { className: 'as-tab' + (tab === 'status' ? ' on' : ''), onClick: () => setTab('status') }, '状态'),
            h('button', { className: 'as-tab' + (tab === 'rules' ? ' on' : ''), onClick: () => setTab('rules') }, '规则'),
            h('button', { className: 'as-tab' + (tab === 'log' ? ' on' : ''), onClick: () => setTab('log') }, '日志')),
          tab === 'status' && h(StatusTab, { st, reload, toast }),
          tab === 'rules' && h(RulesTab, { st, reload, toast }),
          tab === 'log' && h(LogTab, { toast })),
        toastMsg && h('div', { className: cx('as-toast', toastMsg.kind === 'err' && 'err') }, toastMsg.text))
    }

    const PanelIcon = () =>
      h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('rect', { x: 3, y: 3, width: 8, height: 8, rx: 2 }),
        h('rect', { x: 13, y: 13, width: 8, height: 8, rx: 2 }),
        h('path', { d: 'M11 7h5a3 3 0 0 1 3 3v3M13 17H8a3 3 0 0 1-3-3v-3' }))

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, AutoSuccessorPage))
      slots.inject('sidebar.panellist', () => slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 22, label: () => '自动接力' }, PanelIcon))
    }

    exports.apply = apply
    exports.inject = inject
    exports.AutoSuccessorPage = AutoSuccessorPage
    return module.exports
  },
})
