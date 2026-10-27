# Conversation Timeline 权威与历史兼容

> 状态：已裁决并实施。本文保留最终顺序、身份、历史兼容与验收合同；历史评审及分阶段执行记录通过 Git 追溯。

## 未裁决的持久事件日志

P5 的持久 `session_event` journal 仍是独立裁决项，不属于本文已实施范围，也不阻塞既有 transcript、持久 anchor 与输入账本。若采用，需先明确 per-session sequence allocator、durable/ephemeral 分界（流式 delta 不入库）、retention 和 message/part 双写一致性；全序与 replay 的收益不能替代对写放大和兼容性的评估。清理历史计划不代表本项已经实施。

## 2. 总体方案（对 15 号设计的采纳与修正）

采纳 15 号设计的分层，按评审修正三处：

```text
Persisted Facts（权威）：message / part / session metadata / goal（+ 内存事件日志仅作 live 加速）
        |
        v
Event Normalizer（唯一入口，P1 重心）
  live 事件与 cold 事实都归一为 typed semantic events
  三源合并 + 去重，废除 XOR 二选一
        |
        v
Semantic Ledger（P2）
  typed entities，entityId 全部由持久事实派生
        |
        v
Timeline Resolver（P2，弱化版）
  主序 = normalizedOrderKey 近乎全序（定义见下）
  + 有界 anchor 局部重挂（boundary 挂到目标 productTurn 尾，不做通用拓扑求解）
        |
        v
Materializer：兼容期继续输出 rows.window（带 entityId/productTurnId/visibility）
        |
        v
UI：按 resolver 结果渲染，删除 turnId+latestAssistantText 推断
```

**normalizedOrderKey 定义**（现状四套序号互不可比：message.sequence 是 session 内序、
part.sequence 是 message 内序、session_entry 无序号、event 序独立——必须先归一，
否则实现会退回 timestamp/append 猜测）：

```text
normalizedOrderKey = (
  branchEpoch,        # rewind/fork 换代，最外层
  hostMessageSeq,     # 事实所在或锚定的 message 的 session 内 sequence
  hostPartSeq,        # message 内 part sequence；message 级事实取 -1
  boundaryRank,       # 同宿主位置的 lane 序：trigger < assistantWork < turnTailBoundary
  lifecycleOrdinal,   # 同一实体生命周期内第 N 次状态变化
)
```

- 非 message 宿主的事实（session_entry goal verify、live 事件）先经 anchor 解析到
  宿主 message（`anchorMessageId` → 其 messageSeq）；解析失败 → 落到已知最后宿主
  之后 + diagnostics，不猜 timestamp。
- live 尚未持久化的 in-flight 输出排在全部已持久事实之后、按事件序内部排序；
  持久化落地后由 hostMessageSeq 接管（entityId 不变，仅权威源切换，位置不跳变）。

三处修正：

1. **重心从 constraint graph 移到 normalizer**（前审裁决）：排序骨架近乎全序，
   难点是把每条事实归一成「带稳定身份、带 anchor、带 visibility」的 typed entity。
2. **resolver 输出不落库**：`productTurnId/orderKey/lane/placement` 只可缓存（15 号设计已裁决，维持）。
3. **durable/ephemeral 切分**：streaming delta 永不进入持久事实层；
   若未来建持久 session_event journal（P5，独立裁决），只收 durable 事件。

## 3. 历史数据兼容原则（贯穿全部阶段的硬约束）

1. **历史行只读**：message/part/session_entry 的历史行一律不改写；禁止任何「重保存修复」
   ——在 P0 修好 on-conflict 之前，重保存 NULL-sequence 行会把它漂到队尾（`messages.ts:41-44`）。
2. **顺序确定性**：历史行沿用现读序 `sequence is null, sequence, time_created, rowid/id`，
   用 golden 钉死「同一 session 多次 hydrate 得到同一顺序」（含 NULL 混排、同毫秒时间戳 case）。
3. **缺字段由读取期推导**：缺 semantics/anchor 的老数据由 normalizer 推导 + 显式 fallback placement
   （按事实序落位 + diagnostics 标记），不得静默丢、不得崩。
4. **双源去重**：goal verify 跨 `session_entry`（legacy 主体，1,402 行）与
   `timeline/goal_verification` part（新写入）按 `targetId+iteration` 合并；
   fork 三条路径的产物差异（有/无 timeline part）都要能恢复。
5. **NULL sequence 增量 backfill 只做一次**：先封死写入源（P0），再幂等复跑 0014 的窗口函数
   backfill（仅 `where sequence is null`），留审计日志。
6. **老 fork child**：part 内嵌 anchor 指向父 id 的引用（`clonePartForFork` 未 remap，
   `steering.ts:60-65`）在 resolver 中降级为 originRef/diagnostics，不参与 placement。
7. **可见性不回归**：normalizer 以 semantics 为权威后，靠文本嗅探分类的老消息
   （compact summary、goal continuation、task notification、rewind notice、fork notice）
   可见性不得变化——用全类别分类 golden 锁定。
8. **协议兼容**：rows.window 形态保留，desktop/web 客户端不需要 lockstep 升级。
9. **影子重放验收**：提供 dev 命令对本机全量历史 session 过新管线，
   输出守恒失败清单与新旧投影 diff；上线门槛 = 守恒失败清单人工审查完毕、无静默丢弃。

## 5. 测试与验收基建

- L1/L2/L4 用例清单见各阶段验收项（与评审列表一一对应），accepted 语义回写
  case catalog 与 coverage matrix。
- **影子重放工具**（P1 交付，P2/P3/P4 复用）：dev 命令遍历本机历史 session，
  经新管线 hydrate，输出：守恒失败清单、diagnostics fallback 计数、与旧投影的结构 diff。
  每阶段上线门槛 = 全量重放无崩溃、无静默丢弃、失败清单审查完毕。
- 守恒失败在开发态暴露诊断、服务层记日志（15 号设计 §迁移建议 12，维持）。

## 6. 裁决结果（2026-07-07 用户拍板，全部落定）

1. **重启后不保留队列**：账本记 `discarded(session_resumed)` 留痕（P3）。
2. **modelChange 可见时机**：输入框切模型不进 timeline；只有切换后实际发送出去的轮
   才落「模型已切换」分隔（与现 R-17 语义一致，冻结）。
3. **fork 只在每轮结尾**：UI 不暴露中间 assistant 段的 fork；core 层强校验只允许
   轮尾最后一段完成态 assistant（P2/P4）。
4. **迟到变更 = dirty range / 懒 materialize**：resolver 不感知视觉区域，只维护完整
   timeline authority；窗口外 anchor 的迟到变更不立即渲染、不 append 尾部、不丢弃，
   publisher 记 dirty range / revision，客户端 materialize 对应 productTurn 时取最新结构（P4）。
5. **本轮 P0–P4 不建持久 session_event journal**：message/part/session_entry 继续是
   durable authority，内存 event log 只做 live 加速；normalizer/resolver/session_input
   修完后如仍需统一事件溯源，再把 session_event 作为 P5 独立方案评审。

## 7. 顺序与业务语义裁决表（2026-07-07 与用户逐项对齐，L1 golden 的规范来源）

诊断纠偏（用户确认）：「上一轮回复不见」的主体是 **assistant 回复整段消失**
（live 拒收闸 + cold 头部跳过，见 §1 表首行），折叠只是次要观感问题。两者都修，
分别对应 assistant 守恒与多段正文平铺。

| #   | 场景                                                                   | 裁决                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 影响面                                                |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| S1  | steer（guide 模式运行中注入）                                          | **内联不切轮，视觉工作段独立（2026-07-19 纠偏）**：气泡内联在注入点，前后 assistant 段同属一个 productTurn；每条 accepted guide 关闭前一 visual work segment 并开启新 segment，各自显示/折叠工时；仍只有一个 fork 入口（轮尾段）；编辑 steer 消息 = 回退整轮重跑。需要 delivery=steer/queue 双语义                                                                                                                                                                                                                                                                                    | 切分规则、账本 delivery 字段、turnHeader.workSegments |
| S2  | 同轮多段 assistant 正文（text→tool→text）                              | **row 全序优先**：renderer 必须按 CLI 下发的 row 全序渲染，同一 visual work segment 的早段 text、tool/reasoning/subagent/compact 不能被重新分桶排序；普通 segment 只有一个折叠控件，guide 边界按 S1 开新 segment/控件。轮尾最后一段 assistantText 作为最终正文外置，fork 只挂该 turn 最后一段，retry 只挂全时间线最后一条 assistantText row；轮尾段的复制 = 整轮全部 text 段合并                                                                                                                                                                                                      | UI render units                                       |
| S3  | 队列多条的消费粒度                                                     | **每条一轮**：runtime 改为一次只 drain 一条，队列项:回复:productTurn = 1:1:1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | runtime turn-loop、账本守恒                           |
| S4  | goal verify × 队列顺序                                                 | **队列优先（有界窗口）**：verify 调度点（上一轮 settle 时）之前已 admitted 的队列项先消费完再 verify；调度点之后新 admitted 的项进入下一个调度窗口（排在本次 verify/continuation 之后），防止持续追加导致 verify 无限饥饿。notSatisfied 的 continuation 排在本窗口用户输入之后。**补充（catalog BG03，accepted）**：任何 background 任务 running 时 verifier 推迟发请求，background 通知消费后 post-command goal loop 才重新验证——完整调度序 = drain 队列 → 等 background 通知消费 → verify → continuation                                                                            | continuation loop 调度                                |
| S5  | drain 拆轮后的「已工作 xx 秒」                                         | **按边界拆分**：各轮显示 trigger→下一边界时长，加和 = 总工时                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | turnHeader 计算                                       |
| S6  | 轮间自动 compact（新输入触发超阈值压缩）                               | **归下一轮首个活动**：叙事为「用户发送 → 压缩 → 开始干活」（轮内 compact 维持 assistant work 内活动裁决）                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | compact placement                                     |
| S7  | fork 后父时间线                                                        | **不显示 forkCreated**：fork 关系只在 sessions 树/列表体现；child 首部 forkNotice 保留                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 投影不产 row；rewind×fork 问题随之消解                |
| S8  | rewind/edit 截断含 fork 点的轮                                         | **随分支消失**：timeline 只反映当前分支；child 仍在 sessions 列表可达                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | branchEpoch 语义                                      |
| S9  | retry 痕迹                                                             | **不留痕**：旧轮整段替换；retryNotice 从投影移除（消除隐形行）；要留旧分支用 fork                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 投影不产 row                                          |
| S10 | goalSet 边界                                                           | **stateOnly lifecycle + visible user intent**：`goalSet` fact 本身不显示 timeline marker、由 goal 面板承载；每条用户 `sendGoalCommand` 仍生成 canonical visible real-user row，与 text query 共用 `editUserQuery` target，重发保持 goal intent                                                                                                                                                                                                                                                                                                                                        | stateOnly 与 user input 分层                          |
| S11 | 多个 background 完成（idle）                                           | **每个通知一轮**：与 S3 对称，1:1 对应，串行 model-only 轮（当前行为，冻结）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | wake 调度                                             |
| S12 | goal verifying 期间的动作裁决（2026-07-08/11 细化，2026-07-13 更新）   | **goalVerifier 不再是独立操作锁**：消息类（sendText//goal）与 typed `/compact` 均入队；fork **允许**（目标是稳定历史即可，对齐 catalog H06）；sendQueuedNow **允许** = 先 stop verifier（计 failed(cancelled)、goal 转 paused）再 drain（对齐 catalog 238 行）；latest real-user input edit（text 或 goal）**允许** = 先 stop verifier，再按统一 `editUserQuery` target rewind/fork 并按原 intent kind 重发；barrier 失败保留旧 work/input/branch、不启动新 goal。非 latest real-user input edit 仍拒；stop 可中断 verifier。只有 active/queued compact 命中 `compactOperationLock`。 | guard/availability                                    |
| S13 | model-only 续跑轮前的模型切换                                          | **照常显示分隔**：只要某轮实际使用了与上一轮不同的模型就落分隔，不论触发者是用户还是 goal 续跑/BG 唤醒                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | modelChange placement                                 |
| S14 | background 唤醒轮的可见触发形态（2026-07-08，落定 15 号设计待裁决 #1） | **无触发行**：唤醒轮只显示 assistant 内容 + 自己的「已工作」；后台任务信息由 background 抽屉/状态区承载；协议文档 rows 示例中的 `turn:t2/input:background-result` 行需订正                                                                                                                                                                                                                                                                                                                                                                                                            | rows contract                                         |
| S15 | steer 已提交未确认 drain 时用户 stop（2026-07-08）                     | **按是否已注入区分**：runtime 已确认 drained → steer 气泡保留在轮内原位（轮标 interrupted，stop 后可 edit/retry，对齐 G12 先例）；仍在 submitting → 回退 queue（held，autoDrain=false），账本退回 admitted                                                                                                                                                                                                                                                                                                                                                                            | stop 收口、账本状态迁移                               |
