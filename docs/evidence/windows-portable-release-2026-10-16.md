# Windows 便携链路：2026-10-16

## 基线与范围

PR51 已经必要 CI run [38973619563](https://github.com/B1ackB/Packx/actions/runs/38973619563) 全部成功后普通合并为 `683f3cea3b0833b0d9270271cc3f44176d4df645`；main run [38973979953](https://github.com/B1ackB/Packx/actions/runs/38973979953) 亦成功。它明确展示 Windows UTF-8/128 KiB 范围和组件缺失，上传先拒绝 PDF/OCR/Office，并修复上传附件预览错误地构造本地路径的问题。真实 Windows 新用例证明按 attachmentId 预览中文附件；首轮无效 UTF-8 夹具在 Store 入口已经被拒绝，修正为入口断言，未放宽 UTF-8 校验。

PR52 在 Host/发行适配层扩展便携验证，不修改 Agent Core Loop 或域权限。源码主实现 `f59ee5913a3c738cbea895d503167be96abd18ae`；类型契约/本证据同步在后续同 PR 提交。该源码的 macOS 实际便携验收已通过，Windows 必须以 PR 最终必要 CI 结果为准，不把本机通过当作 Windows 通过。

## 发行与运行

- 打包只读取 Git 跟踪且允许的文件，以及明确的 dist 构建文件和两个原生程序；不遍历未提交 docs/evidence。构建要求跟踪内容与提交一致，禁止链接/硬链接输入。只生成匹配平台、架构的未签名内部验证包。
- 首启在解压后的新目录真正执行锁定 npm ci，关闭 lifecycle scripts。不复制开发 node_modules、Node、编译器、SDK、用户配置或业务数据；安装完成后才原子写入 lock/Node/平台绑定的安装凭据。
- 重复启动验证安装和数据目录身份，复用现有实例；其他安装/数据目录占用端口则明确拒绝。停止沿用 LocalAccess 会话保护、Origin 检查及精确实例 ID，无按名称或 PID 杀进程。请求按实例键幂等，写 tenant/workspace/actor、来源和时间的审计记录，不含会话令牌。
- 停止取消任务，等待连接及存储关闭；未完成租约与未知外部副作用保留恢复证据。异常退出只通过既有 recover-lock 在原 PID 明确消失后显式恢复；保留 PID 复用/不确定状态，不推断安全重试。
- 升级及回滚使用停机备份和恢复到新数据目录，保留旧安装和旧数据；当前只验 schemaVersion=1 同格式，不宣称未来迁移、跨版本降级或断电磁盘语义已经验证。

## 回归证据

本机 macOS 完整 `eval/portableReleaseSmoke.ts` 实际解压至中文空格目录，独立安装两份依赖，通过重复启停、外来安装/数据目录/Origin/令牌/过期实例拒绝、私密静态路径拒绝、停机备份、独立目录升级和回滚、直接拥有的 Host 强制退出/锁恢复、摘要篡改拒绝。审计记录不含令牌，模型设置不进入备份；没有真实模型请求。

同一脚本在真实 Windows CI 追加无 Node 命令错误、UTF-8 上传与固定原生预览、PDF/Office/图片及超限拒绝；不得跳过或使用 Fake native executor。业务模型保持 Fake，以隔离外部费用和网络变量。Windows Job 仍使用原有限额和隔离合同；工作流预算增至 15 分钟是增加实际干净安装/便携回归的总预算，没有扩大原生编译或任务预算，也没有自动重试。

Windows 首个执行候选 run [38974684391](https://github.com/B1ackB/Packx/actions/runs/38974684391) 已成功编译、通过固定原生测试并生成 ZIP，但系统 tar.exe 解压到中文目标目录返回 1；当时断言没有保留 stderr，不能确定更细的原因。后续 Windows PowerShell 5 的 Expand-Archive 又触发 30 秒超时（run 38975053541），仍未进入启动验收。解压改为既有构建 Harness 已用的 PowerShell 7 中直接调用 .NET ZipFile 路径接口，关闭 stdin、固定命令且以环境变量传路径，不加载 Archive 模块或改变执行策略；仍维持 30 秒预算，先验证 ZIP 魔数，保留 stderr/超时/退出码，再逐文件核对摘要；不是把测试跳过或换成开发依赖。最终是否通过仍以最终 CI 为准。

## 精确阻塞：Windows ZIP 保留

首次 run [38974328660](https://github.com/B1ackB/Packx/actions/runs/38974328660) 在启动前被 GitHub action allowlist 拒绝，未运行任何任务：只允许固定 checkout/setup-node，新官方 upload-artifact 提交未被允许。远端只读 API 同时确认 allowed_actions=selected、github_owned_allowed=false、sha_pinning_required=true。

已移除上传步骤及新 action 引用，继续完整构建/验收。没有改允许清单或权限，也没有改用其他协议绕过。结果：Windows ZIP 会在临时 Runner 中验证后销毁，本轮没有可下载 Windows ZIP；它不是失败上传后的“不确定产物”，而是明确未保留。若后续批准单独的固定官方 action，可只保留已通过验证的 ZIP/摘要、短期保留、无业务资料。可复查的固定版本、许可、边界见 [notice](../windows-release-notices.md)。这不是 sandbox auto-review 拒绝。

## 尚未证明

真实 Windows 11 员工桌面、Defender/SmartScreen/组织策略、真实员工脱敏样本与任务价值、商业再分发及签名安装器、在线模型质量/费用预算、生产多用户安全边界和断电/故障磁盘仍需后续验收。没有关闭隔离或系统保护，没有提权、部署、对外发送或新增付费。
