# 原生隔离探针与清理回归：2026-10-16

PR：[44](https://github.com/B1ackB/Packx/pull/44)，保持 draft。此文件记录失败与边界，不作为 Windows 产品支持声明。临时交接 `/tmp/packx-production-handoff-2026-10-16.md` 的关键事实归档于此；原有 review-v27 未提交材料未纳入。

## 已合并基线

PR41（平台路径边界）合并为 `6b77141bb45bddec4e1f9e83bf9aaba28f6e4a9c`；PR42（Windows 本地数据与必需 CI）合并为 `aa69c7099cb5e3aebf36e6796d8bd4b32cef70da`；PR43（严格工具路径合同）合并为 `1753956baf4164e89eb736a4ada99b5349f1c523`。各自必要 CI 通过后才合并，没有绕过保护。路径合同、本地数据回归不代表 Windows OS 隔离已经通过。

## 实际 Windows 失败

固定合成探针仅使用预装且锁定的工具链，不执行客户文档或模型指定命令，不注册生产 Executor。profile／ACL 变更仅针对本次创建的应用资源和合成临时文件，不修改现有账户、全局 ACL、防火墙或执行策略。

- [`f814e3a` 的运行](https://github.com/B1ackB/Packx/actions/runs/38944808329)：九个文件 83 项 Windows 测试通过，探针失败于 `spawn_contained_child:5`，最后已计数检查为 `job_memory_limit`。没有证明全部网络、后代与正常清理成功。
- [`c527956` 的诊断运行](https://github.com/B1ackB/Packx/actions/runs/38946139523)：`startup=10107; connect=0; noChildProcessCreation=0; regular_startup=0`。普通 AppContainer 可以初始化 Winsock；同 profile 的零 capability LPAC 不能。`connect=0` 是未执行连接时的诊断初值，不能解读为连接成功或访问拒绝。未增加 capability 绕过。
- 子进程创建错误 5 是实际 OS 拒绝，但其 `NoChildProcessCreation` 为 0，不能冒充显式配置的禁止派生策略，亦不能证明所有派生路径被禁止。须进一步明确能力合同与独立 Job 清理证据。
- 微软的 [LPAC 说明](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer) 指出其注册表、COM 等能力比普通 AppContainer 更受限；目前尚未证明具体哪次系统访问造成上述两项失败，不能仅凭 10107 将其称为网络策略拒绝。

## Windows 后续合同与控制

后续探针将子进程能力收窄为显式禁止派生，读取 OS mitigation 并尝试派生验证；另以未隔离的固定合成宿主验证 Job 父子生命周期。两者分别报告，不将宿主成功算成 LPAC 后代通过。增加 staged executable 读／执行访问检查，以进一步区分启动合同错误。网络门禁仍要求 LPAC Winsock 初始化成功并实际收到访问拒绝，10107 不放行。

[`bf78f75` 的运行](https://github.com/B1ackB/Packx/actions/runs/38947188759) 中，合法宿主的后代继承、禁止 breakaway、关闭 Job 后根与后代终止已实际通过；LPAC 在进入主程序前退出为 `0xC0000142`，没有输出计数或完整网络证据。该次同时新增了注册表诊断导入与派生限制，不能直接归因；先移除新增导入单独核验，不添加 capability。该失败继续阻断。

[`dfdc214` 的运行](https://github.com/B1ackB/Packx/actions/runs/38947602625) 中九文件 83 项仍通过，但约 30 秒后 scratch 清理的 `EPERM` 掩盖了原始错误，因此不能将此轮归因到 LPAC 或编译器。后续增加编译完成标记、仅对子进程继承的进程级错误弹窗抑制，以及暂存删除的有界重试；清理失败单独报告，保留原始编译／探针失败，不修改全局错误策略或将失败转成功。

## macOS 清理回归

上述 f814e3a 运行同时在 `macOsSeatbeltSandboxedToolExecutor.test.ts` 的超时清理断言失败：`kill(pid, 0)` 未抛错。该调用无法区分活进程、僵尸或 PID 重用，历史日志未保存足够状态，不能断言当时属于其中哪一种。

本机固定合成超时案例共 184 次采样，观察时原 PID 均已消失，未复现历史失败。更新测试读取 OS 的 PID／PPID／进程组／状态／启动时间／命令；若返回后仍存在原身份活进程立即失败，僵尸允许 OS 回收但须在两秒内消失。握手保证成功、超时、取消与执行失败四条路径都先观察到真实运行的工具及后代，再验证相同启动身份已终止、暂存目录移除。另验证 supervisor 在 preflight 后 spawn 失败时不返回输出并清理暂存。没有修改超时预算、隔离策略或删除旧用例。

本机完整原生回归：47/47 通过（沙箱 30、资产检查 9、文档读取 8）。远端新提交结果须单独核对，不能使用此前成功运行替代。

独立 [PR45](https://github.com/B1ackB/Packx/pull/45) 的 `d43974b` 已通过[全部必要 CI](https://github.com/B1ackB/Packx/actions/runs/38946925616)，真实 macOS 原生 47/47、pending0，固定离线 eval／浏览器／Windows 本地数据及汇总门禁全部成功。作者自审明确不冒充独立审批；保持严格分支保护，于 2026-10-16 18:26:15 UTC 合并为 `a71c30b7c95ec8c1cd69dda34d8bee0dfc811ac6`。没有合并 PR44。

## 额度与下一步

官方只读工具在 2026-10-16 18:14:29 UTC 返回周窗口剩余 70%，secondary=null；不可见窗口不推算，未购买或重置额度。每阶段及长操作前继续读取，遵循工作单的 20%／10% 守卫。

先取得完整 Windows 网络及合法测试宿主的 Job 清理证据，再决定生产 Windows Adapter。探针缺失证据继续阻断，不修改门禁以通过；macOS 的清理回归可独立交付。没有部署、真实模型调用、业务数据迁移或新增依赖。
