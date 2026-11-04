# 可配置数据存储目录

## 产品规则与范围

统一数据根是本机 ZCode 持久化数据的唯一活动位置。设置页选择的是 base directory，实际根为 `<base>/.zcode`。普通迁移严格为「当前完整根 → 已存在的空文件夹」；隐藏文件也算非空，不合并、不覆盖任意目标内容。首次升级从当前实际生效的历史 App、CLI 和 Electron 来源归拢，不能只复制设置中那一处，也不能按 mtime 选择版本。

状态：统一迁移已实现，macOS 隔离数据的完整 Desktop 冷迁移与原会话续聊已通过；Windows 实机跨盘及手机联合冷恢复仍待验收，详见 CDD catalog / coverage matrix。旧的 `dataBaseDir` 仅复制 `v2` 行为已停用；迁移未提交前仍使用旧路径。

受管内容包括 App 配置/凭据/索引/日志、Agent session DB、插件注册表及内容、工具产物、轨迹与缓存、用户 skills/commands/agents、非项目 conversation workspace，以及 Electron profile / 下载缓存。项目目录与其 `.zcode`、第三方共享 `.agents`、系统 HOME/USERPROFILE、远端 SSH/WSL/Docker/server 的业务根不改变。Electron Stable/Preview/Dev profile 在统一根下仍分别隔离。

```text
<base>/.zcode/
  v2/                      App settings、credentials、tasks-index、logs
  cli/                     session DB、plugins、artifacts、cache、rollout
  workspace/               非项目对话用户文件
  skills/ commands/ agents/ security/ ...
  desktop/<profile>/       Electron userData/sessionData 与下载缓存
<home>/.zcode-data-directory/
  active.json              小型定位文件，不随数据搬迁
  maintenance / leases     跨进程门禁
  transaction.json         可恢复迁移记录，不存消息正文或凭据
```

## 单一所有者、解析与接口

- shared Node-only `@zcode/shared/data-directory` 负责定位文件校验、活动根解析和跨进程使用租约。初始化使用异步 IO；同步消费者只读取已初始化的内存解析结果。没有定位文件时保留原路径语义；已有定位文件但目标缺失、无权限、标记不匹配或损坏时必须阻止启动，不静默回 HOME 创建新库。
- 真实用户 HOME/USERPROFILE 不修改，凭据密钥身份不变化。CLI 默认 storage.dir 与 sessionDbPath 一起派生；显式 CLI 覆盖必须被预检识别，冲突不能静默丢弃。
- `services/data-directory` 是迁移事务与 journal 的唯一 owner；通过明确的来源/生命周期 ports 工作，不导入 Desktop Runtime。Main 只提供 native 目录选择、全窗口/Host/scheduler 调度和冷重启，不接管 task/session/queue 状态。
- 设置页使用平台迁移能力提交本机全局维护请求，草稿与进度只是投影；旧 `settingService.updateDataBaseDir` 不得继续直接复制并切换指针绕过门禁。Web/手机不提供本机搬迁入口。
- 默认 CLI、SDK/Agent、Host、scheduler 与 Desktop 使用同一个根和维护门禁。普通进程持使用租约；全部应用 owner reserve 成功后才封闭新进程租约，避免忙碌检查前干扰已接受任务启动子进程。待现存使用者安全关闭后才复制。尚活跃的独立 CLI、另一应用身份或无法证明安全关闭的进程阻止迁移。旧版本不支持维护协议时不能假定它已停写。
- 本机 ZCode Server 系统服务注册包含旧绝对路径时阻止迁移，需先卸载该服务再搬迁；不能只搬文件后让系统服务继续指向旧根。远端主机的数据根不参与本机迁移。

## 来源盘点与目标校验

1. 读取当前实际 App root、CLI storage.dir、sessionDbPath、Electron profile；明确每个 namespace 的来源。已有统一根时只迁这个根。
2. 历史默认 HOME/v2 可能只是旧副本：App 当前数据优先于旧副本；bootstrap setting.json 的真实来源单独处理。CLI 数据按 CLI 当前配置读取。无法确定归属的同名不同内容冲突中止，双方保持原样。
3. 目标必须是已有空目录，包含隐藏条目也拒绝；执行前重新校验。仅相同 migrationId 的受管 staging 可用于恢复。禁止源/目标相同、互相嵌套、大小写/链接别名重合和 Windows 安装目录；目标空间必须容纳完整副本与校验开销。
4. 迁移清单包括来源、目标、文件类型、大小、内容摘要与所需的 schema 转换。未知文件保留；不能静默跳过 symlink/junction 或不支持的文件类型。链接要保留可达语义或失败退出。

## 事件顺序与停写

```mermaid
sequenceDiagram
    participant UI as Settings
    participant M as Migration coordinator
    participant Main as Main lifecycle
    participant W as Hosts / Agent / scheduler
    participant B as Cold-start maintenance
    UI->>M: prepare empty target
    M->>M: validate sources + record preparation owner
    M->>Main: reserve all owners
    Main->>W: reserve scheduler, then seal Hosts and check idle
    alt any owner busy
        Main->>W: cancel reservation and resume admission
        Main->>M: cancel migration without restarting
    else all owners reserved
        Main->>M: block new process leases
        Main->>W: strict close
        W-->>Main: clean-close result
        Main->>Main: flush browser state and exit fully
        B->>B: acquire exclusive use; copy + verify
        B->>B: commit active locator last
        B->>Main: initialize new root then start normal runtime
    end
```

先封闭新 admission 再检查 idle，防止手机提交/定时任务的检查后竞态。reserve 只封闭入口并检查，不能关库或停止已 accepted 工作。任何 owner 忙碌时向全部 owner 发送 cancel、恢复入口并取消事务，不自动重启。只有全部 owner reserve 成功才进入不可逆的 strict-close；之后关闭失败才允许取消迁移并冷启旧根。已 accepted 输入不清空、不自动 drain；有 running、queued、等待交互、在途插件安装或其他不安全写入时不迁移。普通退出的 timeout/forced-exit 不等于 clean-close；任何未确认关闭阻止执行。复制 Electron profile 必须在旧 Electron 完整退出后、下次正常业务导入前的维护阶段执行；该维护阶段不初始化旧 profile，也不是新的 Local Host。

先 reserve scheduler，确认已认领任务的派发与结算均结束后再封闭 Hosts；BUSY 取消先恢复 Hosts，再恢复 scheduler，避免已接受的定时任务被入口门禁丢弃。取消撤销本轮 reservation，迟到的异步结果不能重新封闭入口或确认已取消的准备；旧 reserve 未结束前不能启动下一轮。迁移日志写入失败也必须尝试解封，不能把取消日志成功作为恢复入口的前提。

Bot 入站、附件准备、回推及 Host 终态保存也属于停写屏障；启用的 Bot 连接需先停用，已有在途消息必须完成。维护关闭时关库及 Provider 关闭错误向上传递，不沿用普通退出的 best-effort 吞错语义。

显式 Desktop HOME/profile override 的隔离实例只迁移该实例指定的 Electron profile；普通产品配置归拢 Stable/Preview/Dev。不能从隔离测试或自定义实例扫描真实用户的其他 profile。

desktop-continuous 冷恢复保持现行语义；手机 web-remote-replayable 通过原 attachment + snapshot/gap 恢复。迁移门禁不复制或接管 CommandInbox，不重置 owner/lease/stale run 防护。当前远端 registry 释放可能停止远端 runtime，尚无跨主机可撤销 reservation，因此存在连接中的远端 workspace 时拒绝迁移；用户须先主动断开，不能根据 UI 空闲投影直接关闭远端会话。

## 复制、转换与提交

- 源数据保留，目标 staging 完整构建。普通文件内容 hash 校验，文件变化/读失败不能作为成功。SQLite 在停写后生成一致备份并校验 integrity、关键表/ID；WAL 属于已提交状态，不能只复制主文件或直接丢 WAL。
- 插件 installPath、子代理 outputFile、受管 workspace 的执行路径和引用按明确 schema 转换；不全局替换对话正文/任意字符串。普通项目和远端 identity 不改；非项目工作区变更需保持原 session/task 关联，不能仅重算 hash 导致旧任务不可见。
- 目标验证包括配置可解析、凭据可解密、session 可读取、插件入口/历史 artifact 可达。除明确瞬时锁/套接字外，不能因为目录名含 cache 就丢弃内容。
- 目标普通文件必须在全部转换结束后通过可写且不截断内容的句柄完成落盘；Windows 的文件 flush 不接受只读句柄。落盘失败仍中止提交并保留原目录，不能忽略 `EPERM` 或跳过文件 flush。目录项落盘沿用平台能力边界。
- 最后持久化切换唯一 active locator（原子替换与落盘），随后从新根冷启动。迁移过程中持久化 migrationId、阶段、来源与清单，重试幂等，不能把半成品当活动根。
- 普通运行只写当前根；旧副本不自动删除、不参与活动数据扫描。清理旧副本是单独的显式动作，不能在迁移事务内提前删除。

## 失败与恢复

| 状态               | 规则                                                           |
| ------------------ | -------------------------------------------------------------- |
| 预检/复制/校验失败 | 不提交指针；源保持可用；受管 staging 可按同一 migrationId 重试 |
| 中断/断电          | 下次正常启动前读取 journal，恢复维护或明确报错，不启动半成品   |
| 提交后新根启动失败 | 保留新根与旧副本；不静默回旧根；恢复必须显式进行               |
| 新根已有新业务写入 | 绝不能直接拨回旧副本；返回原盘必须完整反向迁移到空目标         |
| D 盘缺失/不可写    | 明确阻止进入业务状态，不在 C 盘创建空库                        |

维护启动执行失败时提供原生恢复入口：重试、取消本次迁移并启动原目录、退出。只有指针尚未提交时才能取消；保留失败目标用于诊断，不自动删除。指针已经提交时禁止恢复旧副本；修复新根后重试。尚未获得停写确认的 prepared 事务，只有发起进程已退出时才能在冷启动中取消；第二个实例不能撤销仍活跃的准备事务。

## UI 与验收

设置入口文案为“迁移并重启”，明确要求空文件夹、需结束正在运行的任务、保留旧副本。提交错误必须区分非空目标、来源冲突、占用、磁盘/权限和校验失败；不先把 UI 当前路径改成失败目标。迁移需要全应用冷重启，不能保存后继续向旧根开展业务。

CDD01–CDD12 的 accepted 状态、setup/action/assertions 见 [case catalog](../conversation-session-case-catalog.md#cdd-configurable-data-directory--可配置数据存储路径)，实际执行结果见 [coverage matrix](../testing/conversation-session-e2e-coverage-matrix.md)。CDD01 已替换“CLI 留在 HOME”的旧断言，验证完整搬迁、原 session 续聊及旧数据库停止写入；旧版通过记录不用于证明新契约。

## Windows 安装目录保护

Windows 上禁止把数据根目录设置到 ZCode 的安装目录或其子目录。原因是安装目录会被安装器和自动更新流程管理，若把 `<dataBaseDir>/.zcode/v2/` 放进去，后续更新可能覆盖或清理用户数据。

拦截规则：

| 来源                       | 示例                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| 当前桌面应用安装目录       | `process.resourcesPath` 的上级目录，例如 `C:\Users\{UserName}\AppData\Local\Programs\ZCode` |
| Program Files 安装目录     | `%ProgramFiles%\ZCode`、`%ProgramFiles(x86)%\ZCode`、`%ProgramW6432%\ZCode`                 |
| 用户 LocalAppData 安装目录 | `%LOCALAPPDATA%\Programs\ZCode`                                                             |

Desktop 迁移协调器传入当前安装目录，`packages/services/src/paths.ts` 按 Windows 路径规则做大小写不敏感的“等于或位于其下”判断。Main 在关闭进程前校验选择路径，迁移引擎对 `realpath` 后的路径再次校验，防止父目录 junction 绕过；实际复制前仍复核目标身份。UI 只展示错误提示，不作为唯一安全边界。

### 安装器阻断保护

Windows 安装包不会禁止用户选择任意安装目录。为覆盖历史版本已把数据放进安装目录的用户，NSIS assisted installer 会在用户选完安装目录、真正写入文件前检查最终安装目录及其子目录是否存在 `.zcode`：

1. 按 electron-builder assisted installer 的目录补齐规则计算最终安装目录
2. 若用户选择的是父目录，electron-builder 会安装到 `$INSTDIR\ZCode`，因此检查 `$INSTDIR\ZCode` 及其子目录
3. 命中后展示阻断页，提示安装目录或其子目录包含 `.zcode` 数据，继续安装或更新会让安装器清理历史会话和配置
4. 阻断页禁用“下一步”，并把“上一步”按钮加宽、文案改为“重选目录”
5. 用户点击“重选目录”后回到目录选择页，必须选择其他安装目录才能继续安装
6. 用户仍可取消安装器退出；不提供“忽略并继续”入口
7. 静默安装命中 `.zcode` 时直接退出失败，避免自动化安装绕过数据保护

该阻断保护只面向安装包流程，不替代设置页的数据迁移校验。
