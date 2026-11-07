# CHANGELOG

## 0.2.1

**两个工具从来没在真实宿主里挂上过。**

宿主对工具的校验是 `output` 里必须同时有 `schema` 与 `render`，缺一个就拒收，且只报 warn 级：

```
warn auto-successor: 工具 successor_handoff 挂不上：
tool "successor_handoff" must declare output { schema, render, presentationMeta? }
```

插件照常加载、启动日志一切正常，但 `successor_handoff` / `successor_status` 一个都调不到。0.2.0 的单元测试用自建替身，所以全绿也没发现。

- 两个工具都补上 `output.schema` 与 `output.render`，render 返回内容块数组而不是裸字符串。
- `successor_status` 的 render 把会话列表、接力层数、上次接力时间排成人看的文本；execute 补回 `chainDepth` 字段。
- 测试加三条锁住工具形状（形状不对就红），另加两条 logger 形态用例：工厂函数形态要按插件名调用、完全没有 logger 时要回落 console。28 → 33 个用例。

## 0.2.0

一轮以「静默失效」为目标的清理。这一版没有加花活，修的全是「看起来能用、其实没生效」的地方。

### 修

- **logger 取法错误会导致整个插件挂不上**：`ctx.logger` 在 cordis 里是工厂函数，原实现 `ctx.logger ?? console` 直接当对象调 `.info()`，一旦宿主真按函数的形态给，apply 第一行就抛错。新增 `resolveLogger()` 三种形态都吃（工厂函数 / 现成对象 / 都没有时回落 console）。
- **依赖声明里多了一个根本不用的服务**：`inject` 声明了 `timer`，但全仓只用原生 `setTimeout`。多声明一个依赖就多一种「宿主缺这个服务 → apply 整块不跑」的挂法。已移除。
- **`seedMode` 是只写不读的假开关**：配置里有 `followup` / `system-prompt` 两项、校验也认，但接力代码从来没看过它，选 `system-prompt` 实际仍走 followup。现在真的实现了系统提示词注入路径，宿主不支持就回落 followup，并在 steps 与日志里写明降级原因。
- **进程重启后轮数归零**：手动接力的轮数取自进程内观察值，冷启动时是 0，于是交接稿里写「已完成轮数：约 0」，下一个会话据此误判这是个刚开的新会话。现在拿不到实时值就按对话条数估算。
- **接力会套娃**：接力出的新会话水位涨满后又接力，标题滚成「接力 · 接力 · 接力 · X」，永不停止。新增 `maxChainDepth`（默认 3 代）：到上限停自动接力，手动仍可触发；标题只保留一层前缀，不再滚雪球。
- **死代码与重复实现**：`watch.js` 里 `extractText` 是死 import；`measure()` 里有个空 if 块探测了模型元数据却什么都不做（现改为真的从元数据缓存取上下文窗口）；`host.js` 手写了一份 `saveStateSafe` 与 `store.saveState` 重复（已合并）。

### 加

- 面板状态页新增接力层数，能直接看出哪些会话是接力出来的、套到第几代。
- 日志条目记录 `seedMode` 与估算后的轮数，排查时不用猜这次走的是哪条路。
- 新增 8 个用例（20 → 28），覆盖轮数估算、接力链层数与标题、两种 seedMode（含回落路径）。

## 0.1.0

首个版本。

- 会话水位监控：监听 `session/event` 的 `turn/end`，用宿主 `tokenMeter` 算上下文占用
- 自动接力：水位到阈值且轮数够时，摘要旧会话 → 建新会话 → 注入交接稿 → 归档旧会话
- 交接稿五节结构（任务背景 / 已完成 / 进行中 / 下一步 / 注意），路径命令原文照抄
- 摘要失败自动降级为「原始记录截取」版交接稿，接力不中断
- 冷静期（默认 10 分钟）防连环接力；排除标题正则可跳过特定会话
- 面板三页：状态（水位条 / 手动接力）、规则、日志
- 全局工具 `successor_handoff` / `successor_status`
- 对外服务 `ctx.autoSuccessor`（`handoffNow` / `snapshot` / `config`）
- 规则热生效，改完不用重启
- 20 个测试（纯函数单测 + 端到端 mock 全链路）
