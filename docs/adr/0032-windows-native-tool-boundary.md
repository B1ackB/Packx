# ADR-0032：Windows 原生工具边界分阶段接入

状态：Accepted for path contract；原生隔离与文档 Adapter 尚待实测。
日期：2026-10-16

## 背景

产品负责人授权扩展 Windows，且禁止通过关闭隔离兼容。现有公开 `SandboxedToolExecutorPort` 可复用，但 Manifest 的绝对路径校验仅支持 POSIX；直接接入 Windows Executor 会在执行之前失败。按 AGENTS P1.9，先修复现有通用契约的最小平台边界，不引入新 Loop 或行业分支。

## 决定

1. Core 保留不依赖 Node 的语法校验，新增严格的本地盘符加反斜杠路径；同一 Manifest 的所有权限路径与 executable 必须使用同一语法族。仍由 Host 决定权限、审批、工作区、预算和固定 executable。
2. 首段拒绝盘符相对路径、混合分隔符、UNC／设备／扩展命名空间、ADS、DOS 保留名、尾点／空格及超长路径。不修改系统长路径、开发者模式、网络例外或账户设置。Windows 输出同时拒绝设备／ADS 名和大小写／分隔符重复。
3. 这只是语法合同，不授予文件权限、不提供 OS 隔离。Windows Runtime 在真实 Adapter 及攻击回归通过之前继续拒绝原生工具执行；不接入无隔离解析器。
4. 隔离候选采用微软公开的 AppContainer／LPAC 与 Job Object 机制。AppContainer 提供身份／资源边界，Job Object 提供资源和进程树生命周期；不能把 Job Object 或路径检查单独称为安全沙箱。实现前须证明文件、网络、环境、取消及 Host 崩溃的实际边界。
5. Windows 文档读取按已验证格式逐项开放，校验签名／格式、输入字节／解压／输出／时间预算、失败分类、源 hash、解析器版本和 Artifact 来源。未支持格式明确失败，不伪造空文本成功。
6. 首个 LPAC 候选只允许一个工具进程，启动时显式设置 `PROCESS_CREATION_CHILD_PROCESS_RESTRICTED`，同时检查实际进程 mitigation 和派生拒绝；未配置该策略时观察到的错误 5 不算显式禁派生合同。合法宿主中的固定合成父子程序独立验证 Job 继承、禁止 breakaway 和关闭 Job 后全部终止。这项控制不证明 LPAC 能创建后代，也不取消原定网络、Host 崩溃、取消和资源验收；任何未通过项继续阻断生产 Adapter。

## 替代方案与影响

- 把 Windows 路径改写为 `/C/...`：会让合同和真实 OS 路径不一致，不采用。
- 关闭隔离直接执行：违反 P0／P1，不采用。
- 启用 Windows Sandbox 或 WSL2：涉及可选系统功能或额外运行环境，本阶段不修改系统设置来满足它们。
- 完整通用 Windows 路径解析器：范围过大；严格子集不满足的路径返回校验失败，未来凭实际需求单独扩展。

没有业务数据迁移、权限扩张、新依赖或厂商消息耦合；已有 POSIX 路径语义保持。Windows 真实路径、reparse point、文件 ID、ACL、继承句柄和隔离能力仍须在 Adapter 校验，不能从字符串合法性推断。

## 验证、迁移与退出

路径负向回归在普通离线测试及真实 Windows 必需 CI 中运行；Core 变更继续通过 Runtime Contract、权限、恢复测试和固定 Harness Eval。文档／沙箱阶段各自创建小 PR，不因本 ADR 被接受而声明 Windows 产品支持。

若新路径语法破坏已有合同，停止接入并保留未支持状态；没有持久格式变化，恢复旧校验不涉及业务数据回写。放开 UNC、长路径、外部可执行文件或更广能力时须补充威胁模型及相应回归。

参考：[微软路径规则](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file)、[启动 AppContainer／LPAC](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)、[Job Object](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)。
