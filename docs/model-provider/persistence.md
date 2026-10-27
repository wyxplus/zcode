# Provider 配置持久化与轮询

> 状态：普通读取去锁已实现；读取故障保护与恢复通知仍待设计，不宣称完全解决故障恢复。

## 目标与原因

多个 Host/Agent 默认约每秒读取同一份 Personal 配置，却都参与排他目录锁，纯读也产生锁目录/owner 文件写入和删除。
应用写入已使用同目录临时文件加 rename 替换；正常读者可以观察上一次或新一次已提交文档，无需等待写者准备新文件。
普通 read 同时承担 Legacy 导入与格式规范化，不能直接删除整个读取入口的锁。

## 本次行为契约

```text
显式 read -> 无锁读取、解码
             ├─ 正式规范文件 -> 返回快照
             ├─ 文件缺失且没有 importer -> 沿用现有空配置行为
             └─ 需要导入/规范化 -> 原有写锁 -> 重读最新文件 -> 按当前内容决定是否写回

poll -> 无锁读取、解码 -> 比较内容版本 -> 沿用现有变化通知

update -> 原有写锁 -> 重读最新文件 -> transform/校验 -> 临时文件 + rename -> updated
```

- `NodePersonalProviderConfigRepository` 继续是唯一文件 IO 与轮询 owner；不增加跨进程读写锁或另一份配置缓存。
- 正常读取、纯轮询不创建锁目录，不写 owner，不因另一个正常 writer 持锁而等待；未规范化文档的显式读取仍可能等待写锁。
- 首次导入、规范化写回及修改必须在原锁内重新读取；无锁阶段的旧文档不能拿来直接覆盖写入。
- 无锁解析使用与现有读取完全相同的 decoder、encoder、内容 revision；不修改 schema、迁移脚本或文件路径。
- 写入协议、排队、锁预算、锁回收、私有临时文件及 rename 重试保持不变；兼容仍使用原锁的旧版本写者。
- 单轮 poll 完成后再安排下一轮。显式 read/update 的 finally 不能在 poll 在飞期间再排入第二轮。
- 本 Repository 有新的成功写入时，丢弃此前启动的 poll 结果，避免旧读取晚返回导致 observedRevision 倒退和重复变更通知。
  只用进程内写入代次，不修改磁盘 revision，不新增配置同步协议。
- 读者仅保证观察完整已提交版本，不增加严格的跨进程线性读取或发送前同步屏障。
- 普通读取失败后的空配置降级、poll-error 与同版本恢复规则保持现状；本次减少触发源，不宣称完整解决故障恢复。
- 不修改 Registry、UI、账号、默认选择语义或远程同步协议。默认选择、Host/Worker/Standalone 复用本 Repository；
  手机仍通过 shared-host，远程仍使用所属 Environment，desktop continuous / mobile replayable 无变化。

## 边界与验证

- 生产实现限定 `packages/provider-node/src/personal-provider-config-repository.ts`，复用 shared 公共文件工具。
- 无 UI 交互或页面结构修改；回归放在 Repository 及真实子进程文件 IO 层，复用现有 Provider 保存/默认选择/同步测试。
- Linux 本机运行验证；Windows/macOS 实机结果不得以 Linux 测试替代。Node/libuv Windows 普通文件打开包含共享删除能力，
  rename 使用替换目标文件的操作；跨平台验证仍要覆盖并发读取及替换失败。外部程序原地写坏文件、权限失败不属于本次保证。

## 尚待联合设计的恢复语义

1. 读取失败保留最后有效 Personal 数据：明确唯一 owner；区分新用户无文件、启动从未读成功、运行中失败、合法空文件、
   文件突然消失；默认选择与规则来自同一快照；保存和远程分发必须校验真实文件，不能把旧缓存当作最新写入依据。
2. 恢复通知与诊断：区分文件读取恢复和 Registry 应用完成；内容版本不变也要收敛错误状态；处理 Facade/UI 的版本去重、
   首次 start 失败未订阅、并发过期结果、Environment 换代；失败/恢复事件低频，锁排队/获取/持有/释放分阶段，
   已提交但释放失败不得伪装成未提交；不自动重放用户保存，不泄露凭据。

这两项先共同确定状态模型与影响面，再更新 spec/测试及实现，不以逐个 catch 兜底推进。
