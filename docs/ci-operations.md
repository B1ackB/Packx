# CI 运行与验收

当前实现见 [工作流](../.github/workflows/pr-checks.yml)，建设目标见 [安全计划](ci-security-plan.md)，持续验收见 [生产化工作单](production-readiness-plan.md)。本地配置与验证不等于 GitHub Actions 已运行，平台保护以远端读回为准。

## 检查内容与权限

`core-offline` 检查工作流策略、受跟踪文件的数据边界、敏感信息、依赖漏洞、单元/集成测试、类型、构建与八组离线 Eval。`browser` 使用合成 API 跑三个语言/视口项目。`native-product` 在 macOS 编译原生工具，执行三个真实沙箱/文档套件与本地 HTTP 产品回归。`windows-local-data` 在 Windows 2025、固定 Node 上验证路径、备份／SQLite WAL 恢复、迁移和写锁崩溃恢复；脚本在非 Windows 明确失败，每个指定套件必须实际执行且无跳过。这条切片不验证 Windows Agent 沙箱或完整产品支持。`ci-required` 无检出、无依赖安装、无 Token 权限，只有四个执行 Job 都成功时才成功。

执行 Job 仅有 `contents: read`；checkout 不持久化凭据。全部 Action 固定完整提交；工具下载固定发布版本并验证 SHA-256。不开缓存、不上传自定义产物，不配置真实模型、生产数据或部署权限。运行时先以环境变量白名单启动测试子进程，清除 Provider Key、业务路径、在线 Eval 地址、Token 与 `NODE_OPTIONS` 等继承配置。产品 smoke 自行提供的占位 Key 只用于回环 Fake Provider。

托管运行器仍能访问公网，候选代码也能修改它自己的测试和脚本。这里的策略检查防止误配置，不能替代可信维护者对工作流/依赖变更的审阅；当前实施也没有证明企业生产多租户安全或全部依赖的法律合规。

## 本地复现

使用独立、只含候选文件的检出目录，先确保 Node 与 `.nvmrc` 完全一致。敏感信息扫描只取 Git 索引列出的文件与可用 Git 历史；未跟踪文件不会自动进入该检查，所以必须先核对候选文件清单。不要为了复现把整个有无关改动的工作区一次性暂存。

```sh
nvm use
npm ci --ignore-scripts --no-audit --no-fund
node --import tsx scripts/ci.ts metadata
node --import tsx scripts/ci.ts tools
node --import tsx scripts/ci.ts policy
node --import tsx scripts/ci.ts secrets
node --import tsx scripts/ci.ts audit
node --import tsx scripts/ci.ts core
node --import tsx scripts/ci.ts browser-install
node --import tsx scripts/ci.ts browser
node --import tsx scripts/ci.ts native
# 仅在真实 Windows 主机：
node --import tsx scripts/ci.ts windows-local-data
```

没有 nvm 时直接使用 `.nvmrc` 中的 Node 版本。前两类准备与漏洞审计需要联网；测试与 Eval 不调用真实模型。浏览器只调用已安装且锁定的 Playwright；Linux 的官方系统依赖准备可能需要管理员权限。`native` 在非 macOS 明确失败，不自动跳过。Node 脚本与测试使用 Tab 缩进；工作流 YAML 使用语法要求的空格缩进。

工具、测试 JSON 和浏览器失败轨迹仅写入被忽略的 `temp/`，原生构建写入被忽略的 `.blackx-tools/`。它们不进入 Git 或 CI 自定义上传。下载的工具保留各自 LICENSE。第一版不提供漏洞豁免机制，任何 high/critical finding 直接阻断；registry 故障或审计响应不完整也失败。

## 失败排查

| 失败位置 | 处理方式 |
| --- | --- |
| 锁文件安装 | 核对清单与锁文件，不在 CI 自动修锁；用同版 Node/npm 在本地重现 |
| 工具下载或 checksum | 不执行下载物；查官方发布与已审阅清单，不取消校验 |
| 工作流策略 | 检查是否扩大权限、增加 Secret/缓存/上传、跳过 Job 或改写固定命令；正常升级同时更新策略和负向回归 |
| 敏感信息扫描 | 输出仅含规则、路径和行号；先核对命中含义，不输出值，不批量忽略目录或历史提交 |
| 依赖审计 | 修复并重跑；本版不接受 blanket ignore 或自动 `audit fix` |
| 核心测试或类型 | 修代码；报告还要求关键 Runtime、恢复、事件存储、记忆套件实际执行 |
| 原生检查 | 检查 macOS、编译器、系统沙箱和报告；要求每个指定套件有成功断言且无跳过 |
| Windows 本地数据 | 检查真实 Windows runner、固定 Node、八个指定文件的实际断言和 junction／崩溃／队列／定时存储回归；不换成路径模拟或跳过失败用例 |
| 浏览器 | 检查 `temp/browser-tests/`；报告必须涵盖三个项目且无失败、跳过或 flaky |
| 汇总门禁 | 查看四个前置 Job；失败、跳过、取消均不放行，不删除依赖让结果变绿 |

[Gitleaks 配置](../.github/gitleaks.toml) 仅对 generic detector 限定两类已核实的误报：指定证据/历史文件中的源码路径 SHA-256 映射，以及三个具名离线 fixture 中的精确幂等 ID。不豁免整个文件；Provider 专用检测继续有效。每次真实扫描先运行合成反例，验证同一证据目录中的 Provider 格式密钥、64 位十六进制 generic 密钥均被拦截并脱敏，行内 `gitleaks:allow` 无法关闭检查。扫描覆盖当前快照及历史文本 diff，当前归档解包和解码深度限制为 2；不是对任意格式、无限嵌套或不可用历史的无泄露保证。

## 远端提交与待确认的平台步骤

初始本地验证证据见 [2026-10-16 记录](evidence/ci-local-2026-10-16.json)。每次提交前获取最新主分支、证明候选包含它、同步变更后重跑必要检查，再仅提交该增量明确的文件并创建 draft PR。不能混入原有未提交的评测代码、历史证据或另一个工作树的其他功能。

实际 Actions 运行通过后，再给用户确认具体设置差异：将 `ci-required` 设为必需检查、核对新提交/取消/跳过的阻断效果、限定允许的 Action/固定 SHA 策略、设置 7 天日志留存，以及核实费用边界。保留现有 PR、禁止强推/删除、管理员受约束与外部贡献者审批规则；不新增单人无法满足的独立审批要求。平台支持与实际值以当时读回为准，不用 YAML 声明代替设置验证。

2026-10-16 只读核对：仓库为公开的 `B1ackB/Packx`，默认分支 `main`；已有管理员受约束的分支保护，审批数为 0，尚无必需状态检查。Actions 默认只读、不能审批 PR，外部贡献者运行需批准；当前允许全部 Action，未强制 SHA 固定。平台 Secret Scanning 与 Push Protection 已开启，Dependabot security updates 尚未开启。没有修改这些设置。日志留存与账户预算尚待核实。

2026-10-16 16:59 UTC 再次只读核对：main 已要求 GitHub Actions 的 `ci-required` 成功且分支同步，要求解决评审对话，管理员受约束；独立批准数为 0。PR #41 的四个当时检查全部成功，经普通受保护合并产生 `6b77141bb45bddec4e1f9e83bf9aaba28f6e4a9c`。本轮未修改这些平台保护设置；上段是更早的历史读回，不代表当前状态。新增 Windows 检查通过现有 `ci-required` 依赖接入，不减少原有检查。
