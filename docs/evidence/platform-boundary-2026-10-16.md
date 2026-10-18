# 平台路径边界修复：2026-10-16

## 范围与完成证据

基线为 `b35a3e53684186465dc100fe0745bccaa61b40ed`，本机 macOS 26.6.2 arm64，使用已安装的 Node 24.14.0。未触及工作区已有的 `review-v27` 未跟踪材料，未调用真实模型、迁移业务数据或部署。

本次属于 Host 的文件边界修复，不新增 Agent Core 能力。共享 `within()` 被静态前端文件读取、备份恢复目录检查、数据路径诊断和私密配置位置检查使用。原实现只拒绝 `../` 前缀；Windows 的 `path.relative()` 返回反斜杠，导致父目录下的文件和同前缀相邻目录被误判为目录内路径。修复复用标准库 `path.sep`，不改变现有调用方的权限、审批、真实路径和链接检查。

此函数没有副作用、重试或持久状态，不需要新增事件或幂等机制。越界仍由现有调用方拒绝，不产生新的自动恢复或降级行为。

## 离线验证

以下命令均通过 Node 24.14.0 执行，未加载 `.env`：

```sh
node node_modules/vitest/vitest.mjs run server/localDataBoundary.test.ts server/localBackup.test.ts server/localDataMigration.test.ts server/runtime/runtime.contract.test.ts server/runtime/executionRecovery.test.ts server/runtime/sandboxedToolExecutor.contract.test.ts
npm run build
git diff --check
```

- 修改前的有限基线：5 个文件、62 项测试通过。
- 新回归先在原实现运行：19 项中 4 项 Windows 目录穿越检查失败，证明能捕获缺陷。
- 修改后：6 个文件、81 项测试全部通过。新增测试在同一主机分别使用 Node 的 `path.posix` 和 `path.win32` 实现，覆盖目录内路径、父目录、同前缀相邻目录、路径归一化、跨盘符和 UNC 路径。
- TypeScript 项目构建和 Vite 构建通过。本机最初缺少锁文件已有的 `yaml` 2.9.1；从 npm 本地缓存提取并核对 SHA-512 与 `package-lock.json` 一致后补齐，没有改依赖或锁文件、执行安装脚本或联网下载。
- 本轮没有运行完整测试集、真实原生沙箱测试、浏览器测试或 Windows 主机测试；远端 CI 是独立合并门槛。

## 对标与下一阶段

参考 [Claude Code 官方沙箱文档](https://code.claude.com/docs/en/sandboxing) 对 OS 文件／网络隔离及能力边界的说明。本次只借鉴验证目标，未引入或复制外部实现：权限判断通过不等于操作系统隔离有效，平台支持需要实际运行证据。

当前 Packx 通过 `SandboxedToolExecutorPort` 接入 macOS Seatbelt，没有 Windows Executor。Swift 文档读取器、原生监督程序、发行脚本和启动器仍依赖 macOS；备份目标路径仍有按 `/` 拆分的实现需要后续处理。当前 CI 为 Ubuntu Core／Browser 与 macOS Native，安全策略校验固定了这些作业及合并门槛；增加 Windows 作业必须同步策略和失败阻断测试，不能只改 runner 矩阵。

下一阶段先补齐跨平台文件路径及备份目标处理的实际测试，再按公开 Port 增加隔离 Adapter 的方案与威胁模型。Windows 隔离、取消、资源限制、进程树清理及中断恢复须实测通过后才能声明支持；不可关闭隔离作为兼容方案。
