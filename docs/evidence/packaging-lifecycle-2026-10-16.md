# 包装工作单六类闭环验收

范围固定为同一组合成包装资料、同一确定性Provider、同一预算，覆盖控制器可观察的工作单、版本审批、交付JSON和真实临时目录导出。没有真实客户数据、在线模型或付费请求。此验收不评价真实模型语义质量，也不替代员工试用或完整浏览器/HTTP验收；后者继续由必要CI的产品smoke覆盖。

基线为main `34824c398dcd73feaf92490873177a3a8d4f5527` 的Host行为：先加入相同Fixture实测，再修改生产实现；没有关闭恢复开关模拟基线。[基线结果](packaging-lifecycle-baseline-2026-10-16.json)、[修复后结果](packaging-lifecycle-candidate-2026-10-16.json)记录全部断言、错误分类和计数，执行平台为macOS。

## 固定输入与预算

10000个咖啡豆自立拉链袋，160 × 230 + 80 mm，香港市场，2026-11-30香港交货，品牌稿件待提供。来源为合成用户消息和UTF-8附件。7个权威字段均经过显式人工确认模拟步骤；模型生成不会自动成为verified。审批绑定具体需求单版本，导出再经过独立文件审批。

每例最多24次模型调用、12次模型发起的Tool调用；每次Fake调用上报32输入+8输出的合成计量，最多960合成token/例。这不是实际tokenizer或费用测量。磁盘写入在 `LocalFileAccess.apply` 边界独立计数。取消在需求单审批前触发，其他例交付后验证相应边界；delivered表示曾完成交付，不表示撤权后仍可使用。

| 用例 | 可观察验收结果 | 基线 | 修复后 |
| --- | --- | --- | --- |
| 正常交付 | 输入→来源读取→未确认阻断→7字段确认→版本审批→有引用的批准交付→文件审批→磁盘字节一致 | 通过 | 通过 |
| 重启 | 审批持久化、Gate仍在队列时重建文件存储、控制器及Worker，继续交付 | 通过 | 通过 |
| 重复投递 | 同一审批命令和文件幂等键重复提交；无新模型调用、版本或物理写入 | 通过 | 通过 |
| 取消 | 审批前取消，重启后仍cancelled，不能导出为approved，无写入 | 通过 | 通过 |
| 权限收紧 | 交付后重启Host并保护导出路径，拒绝历史备份及旧模型上下文 | **失败** | 通过 |
| 未知副作用 | 注入磁盘提交后Ledger仍unknown的故障窗口；有回执则核验，无证据则保持未决、人工核对、禁止重放 | 通过 | 通过 |

这是服务重建与持久化故障窗口注入，不声称覆盖断电、故障磁盘或进程任意指令点被杀。

| 指标 | 基线 | 修复后 |
| --- | --- | --- |
| 六类安全验收通过率 | 5/6 | 6/6 |
| 曾完成批准交付 | 5/6（取消例0） | 5/6（取消例0） |
| Fake模型调用/合成token | 41 / 1640 | 40 / 1600 |
| 显式确认/审批步骤 | 52 | 52 |
| 异常人工核对入口 | 2 | 2 |
| 实际磁盘写入/重复写入 | 5 / 0 | 5 / 0 |

调用减少1次来自权限拒绝发生在Provider之前，不代表真实模型成本或质量提升。异常人工核对分别为撤权后的重新取材、无可靠回执的未知操作。后者保留started未决记录，不假装成功。错误分类保留cancelled、permission_denied、unknown_side_effect_requires_review；基线另有permission_history_bypass和permission_context_replay。

## 真实缺陷及最小修复

`ConversationFileService.readLocal` 检查当前路径策略，但指定历史版本的read/content只校验内部备份hash，收紧权限后仍可读取旧字节。file_read没有来源校验钩子，成功结果恢复后也继续进入模型。

修复仅在Enterprise Host/Adapter：历史内容继承当前源路径权限；file_read使用既有validateContextResult比对当前授权与来源；file_list校验包含字节的待审批预览，路径或父目录权限变化时取消待审批记录。Runtime恢复旧协议组时通过原Tool名称/输入调用当前Adapter校验器。没有来源信息的旧单条Tool档案返回不可重试的context_failure，要求重新构建任务上下文，不猜测权限。旧审批/已完成操作审计继续保留，不覆写历史版本。

长期回归还覆盖实时内容变化、允许读取的不可变旧版本、旧协议记录、压缩档案、缺少来源的旧外置档案和撤权待审批预览；在下一次Provider调用前拒绝危险恢复。Agent Core、Loop、Provider协议、公开Schema未修改，无新增依赖。

## Windows独立复查

从生产工厂createRuntime入口重新审查。`eval/windowsProductionBoundary.test.ts`使用普通Anthropic工厂、固定离线Provider、沙箱Tool且不注入Executor，验证Windows返回tool_sandbox_unavailable，连Invocation都不编译。macOS/Linux单测中显式注入platform；同例加入真实Windows必需CI，无跳过。它不证明Windows已有可用沙箱。

引用检查：textDocumentInspection仍仅由其测试导入；Windows探针仍只由CI脚本导入，未注册到server/src生产入口。发行脚本仍拒绝非macOS，未复制native/testing二进制。报告评估保持productionAdapterEnabled=false；CI分别运行诊断/严格模式，网络不可用时严格退出1，否则门禁失败。

**Windows网络门禁仍blocked：LPAC Winsock初始化10107，未执行连接，13/14。** 不能把全绿诊断CI当作14/14或生产可用。原生Executor、PDF/Office/未信任文档Adapter、完整安装升级、Host崩溃清理等仍未实现或验收。UTF-8文本合同仍未注册Tool，没有无隔离fallback。

## 复现与完成边界

`npm run eval:packaging-lifecycle`，可附加一个JSON输出路径。闭环测试和文件权限回归加入core必需套件，独立Eval加入core离线序列；Windows入口回归加入windows-local-data必需套件。必要CI和合并证据在本PR完成后记录。

本轮完成条件就是六类验收、真实权限缺陷回归、Windows禁用边界复查和必要CI/合并。后续可在既有授权内顺序推进macOS员工试用准备、同预算模型质量评测设计及明确的用户恢复入口；在线付费调用、权限扩张、发布部署继续排除。完整Windows支持和生产就绪声明均未达成。
