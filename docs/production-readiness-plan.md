# 生产化与跨平台验收工作单

更新时间：2026-10-16。沿用 [AGENTS](../AGENTS.md)、[架构原则](architecture/principles.md)、[M3 Gate](milestone-3-production-hardening.md) 和 [路线图](roadmap.md)，不以本工作单替代既有安全约束或真实用户验收。

目标是包装售前需求单的可验证交付与恢复；Core 保持行业无关，先修 Host／Adapter 与实际业务闭环。每个增量默认 draft PR，经代码审查、必要 CI 和分支保护检查后合并，记录真实合并提交；不部署、不迁移现有业务数据、不新增付费服务或凭据权限。

## 执行与预算

- 每阶段开始、结束和长操作前，通过 Codex 官方只读额度工具读取所有可见窗口。任一窗口剩余 ≤20% 不启动新开发并交接；≤10% 立即暂停；读取失败也暂停新增开发。
- 此守卫属于本次开发流程，不是 Packx 的运行时预算。账号额度共享、结果为快照；不可见窗口不推算，不能承诺精确实时阈值。
- 保留已有未提交的评测与证据；每个提交明确核对文件清单。测试使用 Fake Provider 和合成业务数据，在线收费评测另行处理。

## 顺序与通过条件

| 阶段 | 可验收输出 | 必须通过的证据 | 当前状态 |
| --- | --- | --- | --- |
| 1. 固定基线与路径边界 | 确认真实 repo／Node／提交；修复共享目录判断 | 原实现复现 Windows 路径穿越；修复后相关测试、类型与必要 CI 成功 | [PR #41](https://github.com/B1ackB/Packx/pull/41) 已合并，`6b77141bb45bddec4e1f9e83bf9aaba28f6e4a9c`；[证据](evidence/platform-boundary-2026-10-16.md) |
| 2. Windows 本地数据切片 | 消除备份目标的 POSIX 拆分；增加 Windows 必需 CI | 真实 Windows 上路径、备份／SQLite WAL 恢复、目录 junction 拒绝、迁移与强制终止后的写锁恢复；缺失／跳过／失败均阻断 | [PR #42](https://github.com/B1ackB/Packx/pull/42)／[失败与修复记录](evidence/windows-local-data-2026-10-16.md)；结果以对应提交的 `windows-local-data` 为准 |
| 3. Windows 受控工具隔离 | 在公开 Sandbox Port 下选择 OS Adapter、文档读取方案与威胁模型 | Windows 上验证未授权文件／网络拒绝、Secret 不继承、超时／取消／进程树清理、资源和输出限制；隔离不可用拒绝执行 | 待设计和真实平台证据；不得以关闭隔离兼容 |
| 4. 核心任务闭环 | 输入来源→候选事实→不可变需求单→确认／审批→导出 | 固定任务集中关键事实有来源；未确认值不升级；过期版本不得交付；失败保留草稿与可解释恢复入口 | 复用现有 M2 及任务集，待当前提交逐项复验；真实员工试用仍缺失 |
| 5. 上下文与执行恢复 | 压缩／暂停／崩溃后恢复当前事实和执行证据 | 来源变更拒绝旧快照；重复投递不重复副作用；unknown 不自动重放；租户和审批边界覆盖 | 复用 Runtime Contract、恢复测试和固定 Eval，待当前提交逐项复验 |
| 6. 可靠性与发布判定 | 关联事件、分类失败、预算指标、平台能力矩阵和支持声明 | 同任务／模型／预算的主源对标；失败注入与回归；真实 macOS／Windows 安装和平台测试；未通过项明确阻断支持声明 | 尚未完成；本地／CI 成功不等于生产就绪 |

## 平台与对标边界

当前完整文档工作流和未签名发行仍以 macOS 为基线。Windows 本地数据 CI 只证明该测试切片，不证明 Windows Agent Tool 隔离、文档处理、安装／升级或完整产品支持，也不证明企业多用户隔离。原 M3 的平台范围是历史规划；新增 Windows 支持须补足独立验收。

对标先采用少量官方主源：如 [Claude Code 沙箱说明](https://code.claude.com/docs/en/sandboxing) 中 OS 文件／网络边界与平台限制。逐项比较实际任务完成、隔离、恢复和可观测证据，不按功能数量或宣传判断；不复制外部 Harness 源码。现有任务 Fixture、失败恢复与上下文 Eval 优先复用；新的 Loop、并行或模型路由必须证明固定基线收益后再引入。

## 尚缺证据

阶段 3B 的 [PR #44](https://github.com/B1ackB/Packx/pull/44) 收窄为默认禁用的实验边界：同一函数的非沙箱初始化／连接成功、LPAC 初始化 10107／目录访问 5 已对照；不能以启动失败作为网络策略通过。诊断报告可验收该不可用状态，但 CI 还须实际验证严格模式仍退出 1，所有生产 Adapter 标记保持 false。只有当前提交全部必要 CI 成功才能合并实验代码，不能由此启用 Windows 文档解析。真实错误、macOS 清理回归及此前交接已持久化于[探针证据](evidence/windows-isolation-probe-2026-10-16.md)。

独立 [PR #45](https://github.com/B1ackB/Packx/pull/45) 已在全部必要 CI 成功后合并为 `a71c30b7c95ec8c1cd69dda34d8bee0dfc811ac6`，完成身份感知的 macOS 成功／超时／取消／执行失败清理回归和 spawn 异常清理（真实原生 47/47）。Windows 的创建时 NoChild 属性组合于 main 前退出 `0xC0000142`，改用 ADR0032 的内核单进程 Job 合同后，LPAC 已完成 13 项独立检查及根进程／profile 清理；合法宿主的单进程拒绝和双进程树清理亦通过。网络 Winsock 初始化仍返回 10107，未执行连接，继续阻断；没有增加 capability 或将宿主证据冒充 LPAC 成功。Windows 文档 Adapter 保持未接入。

Windows Sandbox Adapter、原生文档读取与完整安装链路尚不存在或未验收；真实客户素材／员工试用、签名与干净设备发行、生产多用户边界、断电／故障磁盘语义仍待完成。遇到确需新增权限、付费、凭据扩张或破坏性迁移时，先保存已完成成果，再单独说明必要动作及风险，不把当前授权扩大为这些动作。

阶段 3 分解见 [ADR-0032](adr/0032-windows-native-tool-boundary.md)：先补严格 Windows 工具路径合同，再验证 LPAC／Job Object 隔离及清理，最后逐格式接入文档解析。每段保留独立负向回归和真实 Windows CI，合同通过不等于沙箱通过。

阶段 3A：[PR #43](https://github.com/B1ackB/Packx/pull/43) 已通过全部必要 CI，合并为 `1753956baf4164e89eb736a4ada99b5349f1c523`。阶段 3B 的固定原生探针仅创建并删除自己的一次性 AppContainer profile 和临时文件，在真实 Windows 中检查 LPAC token、零 capabilities、文件读写拒绝、默认网络拒绝、环境／句柄不继承、Job 内存与子进程清理。profile 是该测试自己的应用资源，不修改既有账户、全局 ACL、防火墙例外、执行策略或可选系统功能；不向生产 Runtime 注册探针，也不读取客户文档。它仍不证明任意工具、Host 崩溃、全部磁盘预算或文档解析安全，后续须单独验收。
