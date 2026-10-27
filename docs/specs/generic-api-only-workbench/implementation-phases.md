# 分阶段实施与文件清单

关联：[产品 spec](README.md)、[迁移与验收场景](migration-and-acceptance.md)。S0 决策已确认；S1/S2 已实现可审查增量；S3 文件与远端边界已实现；S4 已落实 D01；其余退役与发行仍未完成。每项验收以实际记录为准。

文件清单列出当前已核实的主修改点。目录形式表示该目录的业务文件需逐一复核，不授权按目录名批量删除；共享代码只裁剪退役分支。拟新增文件在清单中明确标识，具体文件名可在实施时按架构上下文调整。

## 阶段顺序与发布策略

| 阶段 | 内容                         | 前置                    | 发布门禁                                      |
| ---- | ---------------------------- | ----------------------- | --------------------------------------------- |
| S0   | 固定合同、迁移清单和测试计划 | 当前 spec               | 定稿基础接口、secret 边界、数据退出方案       |
| S1   | 三协议通用配置和直达执行     | S0                      | 三协议/API-Key/custom-headers/none 的传输证据 |
| S2   | 首次免注册设置与默认模型写入 | S1                      | 干净安装、skip、保存/失败/多窗口验收          |
| S3   | 新旧配置迁移及远端版本边界   | S1；UI 验收依赖 S2      | 迁移可重入、失败保真、新旧远端先拒绝后写入    |
| S4   | 退出账号关联云业务           | S3 的本地数据退出能力   | 停 producer、只读历史、普通业务回归           |
| S5   | 删除官方身份/权益/凭据解析链 | S2/S3/S4                | 云调用全停止后，精确清理官方账号数据          |
| S6   | 依赖/入口/文档收尾与发布     | S1–S5、已确认决策的验收 | 桌面/手机/SSH/独立 CLI 回归及最终网络审计     |

这些是可审查的开发增量，不代表每阶段单独对外发布。最终“无官方账号版”只能在 S6 后发布；中间版本仍可能含官方业务，不能标成移除完成。远端 Host/CLI 版本须协同发布；未知版本不尝试降级写入。

## S0：合同与迁移准备

| 文档/文件                                                                                                                            | 工作                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| 本目录三份 spec                                                                                                                      | 记录已确认 D01–D05；明确允许公共网络列表、headers 合并规则和迁移恢复边界 |
| `docs/ui/login-page.md`                                                                                                              | 标注未来入口；实现阶段再替换已交付登录合同                               |
| `docs/model-provider-welcome-initial-selection.md`、`docs/model-provider/architecture.md`、`docs/model-provider-config-overrides.md` | 对齐默认模型与 schema 版本；不能继续建议单独 default 文件                |
| `docs/conversation-session-case-catalog.md`、`docs/testing/conversation-session-e2e-coverage-matrix.md`                              | 引用本计划，实际测试落地后回填对应状态                                   |
| `.agents/skills/feature-boundary-planner/references/zcode-feature-graph.yaml`                                                        | 添加 planned 入口；保留当前实现的节点                                    |
| `packages/shared/src/provider-provisioning.ts`、`packages/provider-node/src/provider-config-file-codec.ts`                           | 本阶段只作为合同证据读取，拟定版本变化与错误码                           |

保留功能：全部现有行为；本阶段无功能修改。数据迁移：只使用脱敏 fixture 设计，不读取/改写真实用户目录。验收：文档路径有效、决策状态准确、文件清单存在或标为拟新增、用例没有冒称已覆盖。

## S1：通用配置、能力与三协议执行

| 当前文件/目录                                                                                                                                                                      | 计划改动                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `packages/provider/src/config/provider-data-schema.ts`                                                                                                                             | 通用鉴权合同；区分 api-key/custom-headers/none 的完整性；兼容旧字段的读取迁移          |
| `packages/provider/src/config/manual-model-config.ts`、`packages/shared/src/model-config.ts`                                                                                       | 校验手动模型的可执行能力；补充编辑器缺少的工具能力表达；reasoning 决策 D03             |
| `packages/provider/src/config-service.ts`、`packages/provider/src/facades.ts`                                                                                                      | 通用字段、稳定 providerId、公开 mutation/刷新与错误分类；同一 provider 串行写入        |
| `packages/provider/src/resolver.ts`                                                                                                                                                | 通用配置完整性/启停/可选性，与尚未移除的 legacy account 分支清晰分开                   |
| `packages/shared/src/model-provider-types.ts`、`packages/shared/src/model-execution.ts`                                                                                            | 暴露严格类型，传至执行面，不把鉴权变成 UI 布尔开关                                     |
| `packages/services/src/model-provider/providerFacadeServices.ts`、`providerSettingsConnectivity.ts`                                                                                | 公开服务参数/视图、连通性测试的正常 API 错误；复用真实 cwd                             |
| `packages/ui/src/hooks/useModelProviders.ts`                                                                                                                                       | 表单/测试走服务；配置 revision 和服务切换失效                                          |
| `packages/ui/src/settings/model-provider-section/ProviderApiFormatSelect.tsx`、`ProviderTemplatePicker.tsx`、`ProviderDraftSave.ts`、`ProviderFormControls.tsx`、`ApiKeyInput.tsx` | 任意地址/三协议/鉴权/headers 表单；无厂商注册前置；错误定位到字段                      |
| `packages/ui/src/settings/model-provider-section/ProviderModelMetadataDialog.tsx`、`ModelEditorAdvanced.tsx`、`ProviderModelMetadata.ts`、`ProviderModelReasoningLevelEditor.tsx`  | 手动 modelId 和能力；不自动探测不存在的 `/models`                                      |
| `apps/zcode-cli/packages/adapters/src/model/model-execution.ts`                                                                                                                    | 三协议统一取通用配置；none/custom 模式不触发 SDK 默认 Key；错误、工具、usage、流式兼容 |
| `apps/zcode-cli/packages/adapters/src/model/official-coding-plan-gateway.ts`、`endpoint-routing-edition/index.ts`、`provider-endpoint-routing-fetch.ts`                            | 通用路径移除默认官方重写；最终 S5 删除退休路由；保留代理/TLS/取消等公共传输            |
| `apps/zcode-cli/packages/bootstrap/src/provider-endpoint-routing.ts`、`provider-endpoint-routing-source-headers.ts`                                                                | 源 headers 不再依赖官方账号归因；不能把普通厂商 API Key 送到官方网关                   |
| `config/provider/zcode-builtin.json`                                                                                                                                               | 保留普通厂商模板及模型能力；为 S5 分类 account provider，不在此阶段误删普通 API 模板   |
| `packages/provider-node/src/zcode-builtin-download.ts`、`zcode-builtin-release.ts`、`zcode-builtin-remote-synchronizer.ts`                                                         | 目录版本/过滤合同，防止未来刷新重新注入退役 provider                                   |

已新增：`packages/ui/src/settings/model-provider-section/ProviderAuthModeFields.tsx`（通用鉴权/headers 组件）、`apps/zcode-cli/packages/adapters/src/model/model-auth-fetch.ts`（SDK 鉴权头边界）；继续复用现有配置仓库。

保留功能：模板、源/模型启停与排序、代理/CA、一般厂商报错、完整 ModelSelection、工具/权限、local usage。数据迁移：S3 才启用正式文件版本切换；S1 先定义解码和转换 fixture，旧文件仍须可读。验收：API-ONLY-04–11、36；包括每协议的最终 URL/headers/body/stream/tool/usage，不能只证明表单出现选项。

## S2：免注册入口、默认选择与空模型门禁

当前向导为 `ModelSetupPage.tsx` + `modelSetup.ts` + `hooks/useModelSetup.ts`，复用 S1 字段。`saveGenericSetup` 一次 Personal 事务写 source/model/default，稳定 UUID 支持提交后失败重放；`saveConfiguredDefault` 在事务内验证 Host/Personal revision，Selection service 只读。`modelSetupSkipped` 由现有 settings owner 持久化；Root 启动不再等待或迁移账号域。

| 当前文件/目录                                                                                                            | 计划改动                                                                            |
| ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `packages/ui/src/Root.tsx`、`WelcomeScreen.tsx`                                                                          | 启动/手动配置原因分开；收敛模型设置页面；startup 完成后按需确保真实默认 cwd         |
| `packages/ui/src/root/useProviderAvailabilityLoginEntryGuard.ts`、`useRootOAuthEffects.ts`、`useRootWorkspaceActions.ts` | 新 readiness 入口不依赖 user/domain；退役重登/退出后重启行为由 S5 完成              |
| `packages/ui/src/login/`                                                                                                 | 通用表单逻辑迁出，官方 LoginPanel/APIKey 登录流程最终 S5 删除；不要继续伪造域以跳过 |
| `packages/ui/src/hooks/useModelProviders.ts`、`packages/services/src/model-provider/providerFacadeServices.ts`           | 暴露配置默认写命令和部分成功结果；模型选择读取服务不承担第二条写路径                |
| `packages/provider/src/config-service.ts`、`facades.ts`、`model-selection-config.ts`                                     | 验证完整默认选择并返回新 view，保留新草稿 default/preferred 规则                    |
| `packages/provider-node/src/model-selection-config-repository.ts`、`personal-provider-config-repository.ts`              | 复用现有 `saveConfiguredDefault` 和同文件锁/失效通知；默认模型不另存 localStorage   |
| `packages/ui/src/lib/rootStartupGate.ts`、`packages/ui/src/v4/composer/useDraftModelReadinessGate.ts`、`newTaskDraft.ts` | skip/历史只读与发送/预热阻断；手机远控不运行本地向导                                |
| `packages/ui/src/v4/SessionPane.tsx`、`packages/ui/src/lib/composerRecent.ts`                                            | 移除升级引导文案，保持草稿/Recent/Active Model 隔离                                 |
| `packages/ui/src/i18n/`                                                                                                  | 新配置/修复/退役文案，清理实际退役 key；保留多语言                                  |
| `docs/ui/login-page.md`、`docs/model-provider-welcome-initial-selection.md`                                              | 测试完成后改为免注册合同，解释只读 Agent 边界                                       |

拟新增：`packages/ui/src/model-setup/ModelSetupPage.tsx` 与本域状态/helper；复用 S1 表单组件，不能复制一套 supplier 字段/保存逻辑。

保留功能：历史浏览/读取、无模型草稿、原 workspace/项目选择、手机连接、会话运行和队列；设置操作不改 Active Model。数据迁移：已有通用源无需重新注册；旧域忽略由 S3/S5 精确清理，不能用 `markApiKeyLoginSuccess` 代替正式默认保存。验收：API-ONLY-01–03、12–16、34。

## S3：版本化迁移与远端同步

| 当前文件/目录                                                                                                                                                          | 计划改动                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `packages/provider-node/src/provider-config-file-codec.ts`、`personal-provider-config-repository.ts`、`runtime-paths.ts`                                               | Personal v1 → v2（已实现文件边界），legacy 先解码再新 schema，原子迁移与高版本保护         |
| `packages/services/src/model-provider/legacyPersonalProviderConfigImporter.ts`、`legacyZCodeConfigProviderReader.ts`、`legacyModelProviderSerialized.ts`               | 复用现有 legacy 入口；保存能独立运行的普通 API 源，不借新迁移复活账号 provider             |
| `packages/shared/src/validationAppSettings.ts`、`provider-family-connection-selection.ts`、`model-provider-family.ts`                                                  | 定义明确的官方字段迁移 allowlist；主题/语言/普通偏好保留                                   |
| `packages/services/src/credential/credentialService.ts`、`packages/services/src/oauth/repo/oauthCredentialRepo.ts`、`model-provider/accountProviderCredentialStore.ts` | 精确凭据清单与迁移适配；S4 停 producer 后、S5 才实际删除账号凭据                           |
| `packages/services/src/session/offPeakTaskRepo.ts`、`offPeakTaskService.ts`、`packages/shared/src/off-peak-types.ts`                                                   | 安全本地终结、保留历史和 read-only decode；不在新版本做云 cancel/settle                    |
| `packages/services/src/feedback/feedbackLocalTicketStore.ts`、`packages/services/src/paths.ts`                                                                         | 本地摘要/诊断可保留导出；不因云 UI 删除而抹掉存量文件                                      |
| `packages/shared/src/provider-provisioning.ts`、`packages/shared/src/zcode-protocol/index.ts`                                                                          | provisioning v3（提案），移除 accountSettings/OAuth payload；严格运行时校验与能力协商      |
| `packages/services/src/model-provider/providerProvisioningSource.ts`、`providerProvisioningTarget.ts`、`providerProvisioning.ts`                                       | Source 只导出合法通用配置/default；Target 写前验版本、重复 syncId、回滚/刷新               |
| `packages/desktop/src/main/providerProvisioningEnvironmentCoordinator.ts`                                                                                              | 每 Environment 串行及 revision/host 关联；Main 不成为 provider/session owner               |
| `packages/desktop/src/host/remoteProviderProvisioningService.ts`、`remoteWorkspaceServiceCollection.ts`                                                                | 新旧版本 refusal、断连恢复与目标 Host 配置来源                                             |
| `packages/client/src/`                                                                                                                                                 | 逐一检查远端 provider facade 的公开协议映射，增加新命令/版本响应；不扩散 UI 直接 Repo 调用 |

已实现：`provider-config-file-codec.ts` 内 v1→v2 纯转换，`personal-config-migration.ts` 私有备份和 hash journal；provisioning v3 Source/Target 与 Host capability 探测。仍拟新增整体 migration coordinator，待云 producer 停止后协调账号/SQLite/凭据 owner；30 天到期清理不得提前启用。

条件复核：`packages/shared/src/handshake.ts`、`packages/server/src/remote/handshake.ts` 的远端启动能力/版本协商，以及现有部署资产版本。仅当承载 provisioning capability 需要时调整；不能为新信封绕开 SSH/远端握手，或让旧 CLI 在未知能力时接收新配置。

保留功能：源/model 稳定 ID、普通 credentials、历史及 workspace identity、跨 Host 隔离、Remote replayable；所有新增读取/写入异步。数据迁移：见 M01–M10；本阶段先提供可验迁移能力和 producer 停止门禁，账号 secret 清理必须依赖 S4。验收：API-ONLY-17–25、32–33、35、40。

## S4：云业务退出与本地记录保留

| 当前文件/目录                                                                                                                                                                                                                                            | 计划改动                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `packages/services/src/session/offPeakTask*.ts`、`offPeakRuntimeModel.ts`、`offPeakServerClient.ts`、`offPeakMockGateway.ts`                                                                                                                             | 删除在线取号/恢复/核销与调度 producer；必要的历史 decode/迁移从在线服务分离                       |
| `packages/desktop/src/scheduler/offPeakDispatchSettlement.ts`、`scheduler/index.ts`、`packages/desktop/src/host/offPeakDispatchPlan.ts`、`host/index.ts`                                                                                                 | 移除 Off-Peak 派发/终态 outbox，仅保留普通 scheduler/Host 会话处理                                |
| `packages/ui/src/store/offPeakTaskStore.ts`、`packages/ui/src/settings/AutomationsSection.tsx`、`packages/ui/src/v4/OffPeakNewTaskEntry.tsx`                                                                                                             | 删除闲时创建/继续/额度入口；普通 automation 列表及编辑逻辑保留                                    |
| `packages/services/src/highspeed/`、`packages/shared/src/highspeed.ts`、`packages/ui/src/highspeed/`、`packages/ui/src/v4/highspeed/`                                                                                                                    | 移除抽卡、专用 provider、发送 override、营销分享；保留必要的历史消息兼容读法                      |
| `packages/services/src/coding-plan-subscription/`、`packages/services/src/usage-stats/`                                                                                                                                                                  | 删除套餐查询/额度部分；后者只保留仍被使用的本地 usage 读取                                        |
| `packages/ui/src/settings/model-provider-section/` 的 CodingPlan/StartPlan/enterprise 文件                                                                                                                                                               | 移除套餐/组织/注册卡片及 hooks；普通源表单、模型编辑与排序留在原模块                              |
| `packages/ui/src/settings/CodingPlan*.tsx`、`UsageStatsSection.tsx`、`settings/usage-stats/`、`chat-input-toolbar/`、`components/coding-plan-quota-reset/`、`WorkspaceSidebarFooterUsageSummary.tsx`                                                     | 删除购买 Webview、重置、订阅 banner 和配额；保留 AppUsagePanel/通用 context usage                 |
| `packages/desktop/src/preload/codingPlanWebview.ts`、`packages/shared/src/coding-plan-subscription.ts`、`coding-plan-reset.ts`                                                                                                                           | 删除业务 bridge/channel/types，调用方先退出；不删除所有 preload                                   |
| `packages/services/src/official-mcp/`、`packages/shared/src/official-mcp-auth.ts`、`official-mcp-tool-error.ts`                                                                                                                                          | 删除官方发放、JWT 审计/套餐错误；保留 generic MCP client、transport 和 OAuth                      |
| `packages/services/src/conversation-share/`、`packages/shared/src/conversation-share.ts`、`packages/desktop/src/host/conversationShareAttachmentService.ts`                                                                                              | 删除云上传/发布/导入服务；区分本地投影、格式化、既有 provenance 的仍存调用方                      |
| `packages/ui/src/ConversationShare*.tsx`、`packages/ui/src/v4/ConversationShare*.tsx`、`v4/conversationShare*.ts`、`root/shareImportIntent.ts`                                                                                                           | 退役新操作；历史 share-context 解码/本地正文按调用方保留；旧深链提示                              |
| `packages/web/src/share/`、`packages/web-share/`、`scripts/dev-web-share-env.mjs`、根 `package.json`                                                                                                                                                     | 退出独立云分享构建/部署与权限登录；确认保留 `/remote` 构建                                        |
| `packages/services/src/feedback/`、`packages/shared/src/feedback.ts`、`packages/ui/src/feedback/`                                                                                                                                                        | 删除在线工单/后台上传/通知；提取仍使用的本地 log/archive/export 到合适公开域                      |
| `packages/ui/src/rewards/`、`packages/services/src/marketing-touch/`、`packages/ui/src/components/marketing-touch/`、`packages/shared/src/rewardsBridge.ts`、`rewardsEmbedded.ts`、`marketingTouch.ts`、`packages/desktop/src/preload/rewardsWebview.ts` | 删除奖励、营销请求、Webview、后台 poller 与活动入口                                               |
| `packages/services/src/telemetry/telemetryCore.ts`、`zcode-agent/agentTelemetryEnv.ts`、`packages/ui/src/lib/appTelemetry.ts`、`packages/ui/src/v4/telemetry/`、`apps/zcode-cli/packages/telemetry/`                                                     | 退出官方业务事件/trace export 与账号归因；通用本地 metrics/usage/诊断不能一起删；独立 ARMS 依 D01 |
| `packages/services/src/node.ts`、`packages/ui/src/App.tsx`、`Root.tsx`、`packages/desktop/src/host/index.ts`                                                                                                                                             | 停止注册、挂载、轮询和全局通知；匿名云服务也不能继续调用                                          |

跨端退出还需同步以下明确的适配/协议文件，不能只删除 Service 实现：

| 当前文件                                                                                                                                                           | 计划改动                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/client/src/remoteServiceAccess.ts`、`packages/desktop/src/renderer/src/remoteWorkspaceSessionServices.ts`                                                | 删除退休云 service 的代理字段、构造及远端投影；通用 session/model/工具服务保持                                                        |
| `packages/shared/src/channels.ts`、`packages/shared/src/platform.ts`                                                                                               | 清理云业务 ServiceChannels、PlatformChannels、scheduler 消息及 platform 方法；本地日志导出若仍用反馈命名 channel，先迁通用接口再删    |
| `packages/desktop/src/main/index.ts`、`desktopMainIpcPlatform.ts`、`packages/desktop/src/preload/index.ts`、`packages/desktop/src/renderer/src/desktopPlatform.ts` | 云入口、IPC 注册、Off-Peak wake、Feedback/Webview 调用方退出；保留通用 openExternal/原生操作                                          |
| `packages/web/src/main.tsx`                                                                                                                                        | 同步手机未连接时的 home-only service fallback，删除云 share/auth/feedback 和已退休的空 service 投影；保留远控首页和 attachment 初始化 |

目录/通配清单是业务审查范围，不是删除脚本。特别是 share 的本地投影、反馈的日志归档、usage-stats 的本地统计、telemetry 的 runtime usage 须先查实际引用再决定归属。

保留功能：cron、普通 session、工具、MCP OAuth、App Usage、本地历史/导出、插件/Bots。数据迁移：闲时 non-terminal 本地终结；云记录只读保留；停止 producer 并使旧 in-flight/callback generation 失效，才能进入 S5 secret 清理。验收：API-ONLY-26–31、37–39；须以冷启动和升级网络证据证明没有隐藏调用。

## S5：彻底移除官方身份与账号 provider

| 当前文件/目录                                                                                                                                                                                                                                             | 计划改动                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `packages/services/src/oauth/`、`packages/shared/src/oauth.ts`                                                                                                                                                                                            | 移除应用官方 OAuth 服务、适配器、user/profile、refresh/401 重登录及归因；迁移 legacy key 名留在迁移域 |
| `packages/services/src/model-provider/accountProvider*.ts`、`accountRequestAuthService.ts`、`accountProjectTokenClient.ts`、`bigmodelStartPlanZcodeJwt.ts`、`zaiStartPlanBilling.ts`、`codingPlanProviderAvailability.ts`、`offPeakModelSelectionView.ts` | 移除账号 key/组织/权益解析、请求认证和专用模型 view；只读迁移不依赖可执行 account service             |
| `packages/provider/src/account-provider-state.ts`、`effective-model-selection.ts`、`resolver.ts`、`packages/provider-node/src/model-selection-facade.ts`                                                                                                  | 去掉账号连接重映射/套餐分类；保留 generic providerId、reasoning、缺失/停用校验                        |
| `packages/shared/src/account-provider-state.ts`、`model-provider-family.ts`、`provider-family-connection-selection.ts`、`model-provider-types.ts`、`validationAppSettings.ts`                                                                             | 删除正式类型/设置里的账号域和 family modes；old reader 在迁移边界先读取后转换                         |
| `packages/services/src/node.ts`、`model-provider/providerRuntime.ts`、`providerConfigRuntime.ts`                                                                                                                                                          | 删除官方依赖注入、生命周期与自动失效链，保留通用 Runtime                                              |
| `apps/zcode-cli/packages/bootstrap/src/app/standalone-account-provider-runtime.ts`、`process-provider-registry-runtime.ts`、`provider-registry-model-runtime.ts`、`create-app.ts`                                                                         | 独立 CLI 与 Host 同规则；不再初始化官方账号或隐式 token refresh                                       |
| `apps/zcode-cli/packages/adapters/src/auth/bigmodel-oauth.ts`、`cli-oauth.ts`                                                                                                                                                                             | 退出 CLI 官方登录入口；`shared-credentials` 等公共存储与 MCP OAuth 保留                               |
| `apps/zcode-cli/packages/adapters/src/model/official-coding-plan-gateway.ts`、`endpoint-routing-edition/index.ts`、`model-execution.ts`                                                                                                                   | 删除退休 routing/业务错误转换和账号注入；配置 endpoint 直达                                           |
| `packages/ui/src/login/`、`root/useRootOAuthEffects.ts`、`root/oauth*.ts`、`hooks/useOAuth.ts`、`lib/oauthProviderIcon.tsx`                                                                                                                               | 删除官方 UI 登录状态机、avatar/reauth；必要启动配置 helper 已迁至 S2 模块                             |
| `packages/ui/src/root/useRootWorkspaceActions.ts`、`Root.tsx`、`settings/model-provider-section/oauthActions.ts`                                                                                                                                          | 删除登出后清域/重启、官方连接和用户展示；保留 workspace 命令                                          |
| `packages/desktop/src/main/desktopOAuthDeepLink.ts`、`desktopDeepLinkUrl.ts`、`packages/desktop/src/preload/oauthCallbackBridge.ts`                                                                                                                       | 只退役官方回调；保留 workspace、远控等其他 deeplink/IPC                                               |
| `packages/web/src/auth/`、`packages/web/src/main.tsx`                                                                                                                                                                                                     | 删除官方网页 OAuth 门户；保留远控入口与配对状态/独立鉴权                                              |
| `config/provider/zcode-builtin.json`、`packages/provider-node/src/zcode-builtin-remote-synchronizer.ts`                                                                                                                                                   | 移除 account:\* 及其专用模型/隐藏 override；保留普通厂商模板与兼容目录过滤                            |

保留功能：通用 API-Key（含普通 Z.ai/BigModel）、MCP OAuth、SSH/Bot/配对凭据、Public ClientConfig、公共更新/目录以及 relay 的独立授权。数据迁移：M03 官方设置和 M04 精确凭据清理在 producer 全停后执行；移除 account default 不删除普通记录。验收：API-ONLY-01–03、17–19、26–31、35–39，覆盖升级与干净安装。

S4 列出的 `channels.ts`、`platform.ts`、Main/preload/Desktop platform、`remoteServiceAccess.ts` 和 Web home-only fallback 在本阶段再次收口官方 OAuth 字段/通道。保留 `openExternal` 等通用操作，不能因为它过去用于 OAuth 而删除。

## S6：清理、验证和发行

| 当前文件/目录                                                                                                                                                                                                                         | 计划改动                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 根 `package.json`、`pnpm-workspace.yaml`、各受影响包 `package.json`、`pnpm-lock.yaml`                                                                                                                                                 | 删除实际不再使用的 cloud build/scripts/deps；不是先删依赖再修所有调用       |
| `packages/services/src/index.ts`、`node.ts`、`packages/shared/src/index.ts`、`packages/ui/src/index.ts` 及目标包公开入口                                                                                                              | 清理导出/channel/DI/type 与失效引用，遵守公开入口                           |
| `packages/desktop/src/main/webRemoteControlManager.ts`、`webRemoteControlSharedHostAttachments.ts`、`webRemoteControlRelayAuthProvider.ts`、`manifestUpdateProvider.ts`、`packages/services/src/client-config/clientConfigService.ts` | 以保留不变量复核，只有证明必要才改；不删除配对、attachment 和公共更新       |
| `packages/provider/test/`、`packages/provider-node/test/`、`packages/ui/test/`、`packages/services/test/`、`packages/shared/test/`、`packages/client/test/`                                                                           | 新合同/迁移有行为测试；删掉退役业务测试前保留必要的历史兼容断言             |
| `apps/zcode-cli/packages/adapters/tests/`、`apps/zcode-cli/packages/bootstrap/tests/`                                                                                                                                                 | 三协议执行、auth/URL、CLI 启动及无官方网络证据                              |
| `packages/desktop/test/e2e/`                                                                                                                                                                                                          | 新场景先 manual-review/pending；真实 provider wire/文件/协议证据，不只截图  |
| `docs/` 中官方登录、Coding Plan、Off-Peak、Highspeed、云分享/反馈/营销的当前使用指令，`AGENTS.md`、`.agents/skills/` 中相关引用                                                                                                       | 实际退役后同步清理功能/命令引用，历史方案明确归档；更新功能图种子与覆盖矩阵 |

验证要求：根 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`；按实际目标包 `package.json` 执行单测与 CLI 适配器测试；相关 Desktop E2E 使用既有入口。仅在本阶段产生功能改动后执行这些行为验收，不能把本次文档检查算作它们。

保留功能：README §1.2 全部。数据迁移：完成 journal、一次性报告与兼容窗口策略；实际 secrets 不进入报告/fixture。验收：全部 accepted 场景关闭；已确认决策全部落实；真实厂商 smoke、三平台和 mobile/SSH 证据分别记录。未跑的平台/API 不声称通过。

## 实施进度与实际证据（2026-10-12）

| 阶段  | 状态                                        | 已完成/剩余                                                                                                                                                    |
| ----- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S0    | 决策落盘完成                                | D01–D05 confirmed；成功迁移后备份 30 天，失败资料保留；原型合同与场景保持可追踪                                                                                |
| S1    | 通用配置/执行增量已实现，阶段仍 in-progress | authMode、headers 编辑/校验、三协议直达、SDK env/动态 Key 隔离、工具能力和禁用推理参数；目录兼容过滤/账号源退役留 S5，完整发行门禁留 S6                        |
| S2    | 首次/手动通用入口已实现，部分 E2E 通过      | 原子 setup、正式默认、跨启动 skip、无账号域启动；旧 OAuth 专属入口留 S5 删除；只读 Agent 回归按最新记录                                                        |
| S3    | 文件和远端边界已实现，整体迁移 in-progress  | Personal v2、私有备份/hash journal、provisioning v3 握手及 CAS 回滚；账号/SQLite/secret 清理和整体完成/30 天回收仍待 S4/S5                                     |
| S4/S5 | D01 已实现，其余退役 planned                | ARMS 不初始化/注入，保留本地 crash capture，已去未初始化 SDK 的启动配置调用，Main crash capture 明确使用仅本地模式；官方登录、权益、Off-Peak、云业务仍在源码中 |
| S6    | planned                                     | 最终回归/网络 allowlist/多平台/mobile/SSH/真实厂商 smoke                                                                                                       |

S1 单测：`pnpm exec vitest run packages/provider/test packages/ui/test/genericApiProviderDraft.test.ts packages/ui/test/modelProviderDraftSave.test.ts packages/ui/test/useModelProviders.test.ts`，27 文件 / 362 项通过。CLI adapter 的 6 文件 / 54 项通过（generic API 15 项包含九协议鉴权组合、三协议流式 usage 和三协议工具输入）；另外 model-execution/provider-endpoint-routing 旧回归 30 项通过。旧测试需本地监听，受限运行的 EPERM 已通过同命令权限重跑验证。

Desktop 设置 E2E：`generic-api-auth-settings.test.ts` 在显式本地 replay 下 1/1 通过，runId `desktop-e2e-20261012084045607-p42211-45353155b586e3ff`，报告位于 `packages/desktop/.e2e-artifacts/<runId>/summary.md`。状态仍 manual-review/pending，不计为 UI 发模型请求、手机或正式 CI 覆盖。首次 capture 缺端点、两次带假账号的登录过期失败证据保留；最终 fixture 仅此用例不播种官方账号，使用真实通用设置 UI 完成断言，不改生产代码绕过弹窗。

代码检查：根 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过；lint 0 errors / 62 个基线 warnings。`pnpm --filter @zcode/desktop typecheck:e2e`、`pnpm --filter @zcode/adapters typecheck` 通过；CLI 依赖的旧 dist 在首次检查中出现错配，重建现有 contracts/dynamic-workflow 后已复核。根与 CLI 各用自己的 formatter 定向检查通过。架构策略未管理 provider/shared/services/ui/zcode-cli 的具体层，检查通过不等于这些边界自动获得完整证明；本增量遵守公开入口、单一配置 owner，无 UI → Repo/IO 新路径。

## 各阶段测试文件映射

优先扩展以下已存在的测试种子，不要求复用与目标合同冲突的旧断言：

| 阶段  | 现有证据/扩展点                                                                                                                                                                                                                 | 拟新增证据                                                            |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| S1    | `apps/zcode-cli/packages/adapters/tests/model-execution.test.ts`、`provider-endpoint-routing-fetch.test.ts`、`official-coding-plan-gateway.test.ts`；`packages/provider/test/model-selection-config.test.ts`                    | 三协议 auth/URL/wire contract；none/custom 环境污染测试               |
| S2    | `packages/ui/test/providerAvailabilityLoginEntryGuard.test.ts`、`loginApiKeyForm.test.ts`、`rootStartupGate.test.ts`、`v4DraftModelReadinessGate.test.ts`；`packages/desktop/test/e2e/provider-readiness-agent-startup.test.ts` | 通用 setup/default 部分完成、多窗口、重启和免注册 E2E                 |
| S3    | `packages/services/test/providerProvisioningSource.test.ts`、`providerProvisioningTarget.test.ts`、`providerProvisioningFileIntegration.test.ts`；`packages/client/test/remoteProviderFacadeServices.test.ts`                   | Personal v1/v2 故障注入、混合源迁移、remote v2/v3 handshake/rollback  |
| S4/S5 | `packages/services/test/offPeakTaskRepo.test.ts`、`feedbackLocalTicketStore.test.ts`、`packages/ui/test/providerFamilyDomainMigration.test.ts`                                                                                  | retired 历史、精确 credential 清理与零业务网络验收                    |
| S6    | 现有普通 automation/MCP/Bot/跨 Host/手机场景，实施前按脚本与实际文件重核                                                                                                                                                        | `generic-api-only-workbench` 系列 manual-review E2E（拟新增，未编码） |

S2/S3/D01 实际证据：Provider/UI/provisioning/diagnostics 合并回归 44 文件 / 493 项通过；provider-node 全包 29 文件 / 257 项通过（本地 HTTP/watcher/子进程用例在权限重跑后通过，保留最初 sandbox 失败）。追加 receipt rename 前/后故障、已知旧 receipt 转换、旧 peer 未读 secret 即拒绝的测试通过；资源/本地崩溃/关闭 SDK 定向 6 文件 / 107 项通过。

首次通用向导 E2E 1/1 通过，runId `desktop-e2e-20261012105207457-p50914-0900635786ba27f6`：干净账号、skip、两次冷重启、无 Key 自定义模型原子默认写入与稳定 ID。仍 pending，不宣称真实 API、mobile/SSH 或多平台验证。关闭 SDK 后只读 Agent 回归 1/1 通过，runId `desktop-e2e-20261012110659667-p58122-8fe053fe8d583884`：历史正文、阻断发送/保留草稿、主动选择模型后的唯一 Agent 复用；失败证据包含旧账号域 UI 步骤、未初始化 SDK 的启动 setConfig 和已绑定草稿不可被新默认覆写的断言修正。

根 typecheck、lint（0 errors / 62 warnings）和架构检查通过；E2E 类型检查通过。额外执行 Desktop main/preload/renderer/scheduler 的独立 tsconfig 检查失败：错误主要位于未修改的既有文件，包括 shared 文件超出 rootDir、renderer 测试 Node 类型/样式声明、autoUpdater/browserGuestManager/scheduler 类型错误；尚未对这整组错误做隔离基线复核，不能称该额外检查通过；根检查不包含所有 Desktop 子工程。没有改写真实用户目录，没有宣布整体迁移完成，没有启用备份到期删除，没有发布或提交。

最终通用 UI 复跑：`generic-api-first-run.test.ts` 与 `generic-api-auth-settings.test.ts` 在最终 v2/SDK 关闭源码上 2/2 通过，runId `desktop-e2e-20261012111102611-p60693-a80afbc8ab10aec2`，报告 `packages/desktop/.e2e-artifacts/<runId>/summary.md`。首轮花括号 glob 被 WDIO 拆分导致零场景，保留为未执行的失败运行；最终用实际 glob 验证。最后补充 Host 成功/失败回包都丢弃远端自由错误文本，避免 API secrets 进入公开响应。
