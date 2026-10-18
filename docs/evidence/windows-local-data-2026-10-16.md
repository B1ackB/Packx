# Windows 本地数据切片：2026-10-16

候选：[PR #42](https://github.com/B1ackB/Packx/pull/42)。继承已合并的 #41，实际最新结论须核对 PR 对应 head 的检查结果；本文保留首次失败和本地修复依据，不以旧运行代表当前状态。

## 首次真实 Windows 运行

[Actions 38937297249](https://github.com/B1ackB/Packx/actions/runs/38937297249)，候选 `ec0775a064db929fe8ce6b546ff4484f54ea78d4`：Windows Server 2025 10.0.26100、x64，runner image `win25-vs2026`／`20261007.264.1`，Node 24.14.0、npm 11.9.0。

四个文件共 33 项测试：32 通过、1 失败。路径、备份／WAL、junction 嵌套拒绝、迁移、Artifact／Session 崩溃和进程间写锁检查通过；File Event Store 在事件崩溃注入之前因只读句柄的 `fsync` 抛出 `EPERM`。必需汇总门禁随之失败；未跳过用例、删除依赖或合并失败候选。

## 修复

- 备份目标采用标准库 `basename`，保留父目录真实路径规范化；链接／junction 指回源目录时在创建文件前拒绝。
- 三个 File Store 的临时文件刷新句柄改为 `r+`。Windows 的 [FlushFileBuffers 要求写权限](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers)，不能使用只读句柄。
- Node 在 Windows 上没有这里使用的目录 fsync 路径。四个现有调用方共用 `syncDirectory`，明确限定 Windows 的进程崩溃恢复语义；POSIX 保留目录刷新，真实失败仍传播。文件内容刷新和原子重命名没有删除，不承诺 Windows 断电持久性。
- 保留崩溃测试，并要求到达注入点的标记；不能把导入或前置写入失败当作成功注入。使用 file URL 导入子进程模块，避免 Windows 盘符被当成 URL scheme。
- Windows 专用 CI 要求真实 `win32`、固定 Node、八个指定文件实际执行且无跳过。新增状态是现有 `ci-required` 的依赖；256 种前置状态组合只有全部成功才放行。

本地 macOS arm64／Node 24.14.0：扩大至 13 个相关文件，106 项测试全部通过；覆盖所有改动的 Store 和目录刷新调用方。TypeScript、Vite 构建和 diff 检查通过。非 Windows 运行专用 CI 命令明确拒绝，不冒充真实平台。

## 限制

Windows 结果仅覆盖列出的本地数据回归，不包括原生工具隔离、完整 Agent 工作流、Provider Secret 的 Windows ACL、任意标识到文件名的映射、长路径、网络盘或断电故障。当前不声明完整 Windows 产品支持或生产就绪。后续验收见 [生产化工作单](../production-readiness-plan.md)。未运行真实模型、迁移用户业务数据或部署；原有 `review-v27` 材料保持不动。
