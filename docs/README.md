# 开发文档入口

本文索引长期维护的规范。当前代码和包脚本用于核实实现事实；标为草案、待实施或欠测的内容不表示交付。文档维护遵循 [AGENTS.md](../AGENTS.md#文档维护)。

| 领域                | 维护入口                                                                                                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 架构与依赖边界      | [架构总览](architecture/zcode-code-architecture-overview.md)、[架构门禁](architecture/architecture-governance.md)                                                                         |
| 会话与协议          | [产品协议](conversation-product-protocol.md)、[状态空间](conversation-product-state-space.md)、[V4 规格导航](v4-refactor/README.md)                                                       |
| 模型配置与执行      | [Provider 架构](model-provider/architecture.md)、[选择状态](model-provider/selection-state.md)、[持久化](model-provider/persistence.md)                                                   |
| 当前 API 工作台改造 | [目标与阶段验收](specs/generic-api-only-workbench/README.md)（实施中）                                                                                                                    |
| CLI Runtime 与工具  | [CLI 规则](../apps/zcode-cli/AGENTS.md)、[架构](../apps/zcode-cli/docs/design/v2/architecture.md)、[工具变更链](../apps/zcode-cli/docs/design/v2/tool/00-tool-change-chain.md)            |
| UI                  | [设计规范](../DESIGN.md)、`ui/` 中的领域 spec                                                                                                                                             |
| 手机远控            | [远控架构](web-remote-control/web-remote-control-architecture.md)、[消息流](architecture/message-flow.md)                                                                                 |
| 浏览器与 CUA        | `browser-use/`、`cua/`、`cua-permission-broker/` 中仍有效的领域 spec                                                                                                                      |
| 遥测与诊断          | [Agent 遥测](trace/cli-agent-telemetry.md)、[性能事件目录](monitoring/performance-telemetry-catalog.md)                                                                                   |
| E2E                 | [案例目录](conversation-session-case-catalog.md)、[覆盖矩阵](testing/conversation-session-e2e-coverage-matrix.md)、[开发工作流](testing/conversation-session-e2e-development-workflow.md) |

## 未完成事项

Provider 尚待实施或裁决的内容在 `model-provider/pending/`；[验证欠测](model-provider/pending/verification-debt-closeout.md)保留未测、失败与人工晋级的区别。保留下来的独立计划继续以其当前状态为准，不因日期较早或旧索引写“完成”而自动关闭。

## 第三方与技能资料

Electron、WebdriverIO、Knip 镜像分别保留来源和许可说明，供有需要的开发查询；它们不替代项目当前依赖版本和实现。仓库开发技能统一从根 `.agents/skills/` 复用；独立插件随包所需的技能资源保持各自分发边界。

## 新增与收尾

优先更新上述已有领域入口。调查、计划、review 和逐次验证默认留在对话或临时目录；确需跨会话保存时说明状态与关闭条件。完成后将唯一有效约束并入 spec，保留未完成事项，删除被取代的过程记录并更新引用。历史细节从 Git 查阅。
