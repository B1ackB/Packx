# Harness 错误处理测试与修复闭环

日期：2026-09-21。基准提交：`4df7f4d0b86fdd047cb051d76cc35db84b1e07f8` 加本轮开始前已有的未提交改动。开始时基线为 **73 个测试文件、486 项通过、21 项条件跳过**。已有后台续执行、Runtime 错误转换、Plan 调度等修复被保留并纳入验证，不能算作本轮新增实现。

本轮按“独立测试复现 → 代码团队修复 → 测试团队独立复测 → 整体验收”执行。测试团队 A 负责 Runtime；测试团队 B 负责 Enterprise／Worker；主任务补充 Provider 和知识索引链路、审查修改并执行整体验收。测试者维护断言，代码团队修改生产实现。没有增加依赖、扩大 Agent Core 接口或引入新重试框架。

**结果：新增 4 个测试文件、86 项测试；本轮复现的 7 类生产缺陷全部修复并通过复测。最终全量为 77 个测试文件、572 项通过、21 项条件跳过。** 这是本轮明确列出的离线故障路径闭环，不是任意生产故障均已覆盖的保证。

## 缺陷与修复证据

| 编号 | 注入场景与修复前行为 | 最小修复落点 | 验收行为 |
| --- | --- | --- | --- |
| E01 | Provider 用 JSON 字符串返回 HTTP 401／429／503，客户端对 primitive 使用 `in`，抛出 TypeError 并丢失状态；Runtime 认证／限流分类错误 | [client.ts](../server/anthropic/client.ts) | 先检查外部 JSON 类型，保留真实 HTTP 状态；认证不可重试，限流和服务故障保持对应分类；验证 Client → Provider → Runtime → Trace |
| E02 | Token Count 返回 primitive 时抛裸异常，负数和不安全整数被接受 | [client.ts](../server/anthropic/client.ts) | 无效响应返回结构化 adapter failure；只接受非负安全整数；补测无效成功消息及 text 类型，防止错误 partial callback |
| E03 | 原始认证／取消失败后，activity 或 trace 上报再次失败，覆盖原异常及不可重试属性 | [agentRuntime.ts](../server/runtime/agentRuntime.ts) | 分别尝试两个报告出口，保持原 `code/retryable`；通过 AggregateError 保留主因和次级错误 |
| E04 | Provider 认证失败后，telemetry finally 的 load/save 再失败，原异常变成可重试 model_failure | [modelTelemetry.ts](../server/runtime/modelTelemetry.ts) | 保留上游与存储错误因果链，Runtime 仍返回 authentication／不可重试；模型成功后的持久化错误继续向外失败 |
| E05 | 启动前 executions.list、图片解析、来源校验忽略取消时，执行片 timeout/cancel 不能结束等待 | [agentRuntime.ts](../server/runtime/agentRuntime.ts) | 复用已有 abortable，覆盖初始化和恢复账本等待；三个挂起边界分别验证 timeout/cancel，释放迟到结果后仍无模型调用或回复提交 |
| E06 | slice 耗尽进入死信后，不提供 additionalSlices 仍能 redrive，突破原预算；三种队列均复现 | [stageJobQueue.ts](../src/enterprise/stageJobQueue.ts) | 共用 redrive 检查新增预算后是否仍有余额；无余额返回 job_conflict，原状态不变；显式增加一片只多执行一片 |
| E07 | 知识索引 Embedding 不响应 signal 时，取消任务仍占住 Scheduler，直到 Embedding 返回 | [store.ts](../server/knowledge/store.ts) | 有 signal 时终止 Host 等待，释放 Worker；迟到结果不写 chunks/indexed 事件，后续独立 Job 可执行 |

首轮真实失败证据为：Provider 13 项中 12 失败／1 通过，Runtime 15 项中 11 失败／4 通过，Worker 17 项中 3 失败／14 通过，Knowledge 1 项失败。后续加入控制用例和接口矩阵；修复过程中发现的同步 validator `void | Promise<void>` 类型兼容问题，也补测试并通过 `Promise.resolve` 保留原契约。

测试夹具自身曾出现会话 ID 前缀、Fake Runtime 健康门槛、后续 Job 缺 sessionId 以及 ES2023 不支持 Promise.withResolvers 等问题。均由测试方修正并确认抵达目标故障点，不计作生产缺陷；没有通过降低生产断言使测试通过。

## 固定测试矩阵

| 测试文件 | 数量 | 覆盖内容 |
| --- | ---: | --- |
| [Provider audit](../server/anthropic/errorHandling.audit.test.ts) | 17 | 两个端点 × 三种 HTTP 错误；4 种无效 token count；4 种无效消息；3 种跨 Provider／Runtime／Trace 分类 |
| [Runtime audit](../server/runtime/errorHandling.audit.test.ts) | 18 | 双重故障与因果链 5；初始化 timeout/cancel 6；claim、complete、unknown 副作用和校验抛错 4；同步 validator 1；成功后 telemetry／trace 写入失败 2 |
| [Worker audit](../server/workers/errorHandling.audit.test.ts) | 50 | 三种队列预算正反例 6；Scheduler 错误分类、退避、预算、取消、租约与脱敏 10；Outbox ACK 失败重投 1；全部 16 个 RuntimeFailureCode × retryable 两值 32；SQLite ACK 回滚／重开恢复 1 |
| [Knowledge audit](../server/knowledge/errorHandling.audit.test.ts) | 1 | 真实 KnowledgeService → Scheduler 取消不合作 Embedding，迟到结果不提交，后续任务可继续 |

上述测试使用 Fake Provider、可控 Promise、Fake Timer、临时目录和 SQLite 故障注入。它们进入现有 `npm test` 自动发现范围，不需新依赖或额外运行入口。

单独重放本轮矩阵：

```sh
npx vitest run server/anthropic/errorHandling.audit.test.ts server/runtime/errorHandling.audit.test.ts server/workers/errorHandling.audit.test.ts server/knowledge/errorHandling.audit.test.ts
```

## 整体验收

| 验证 | 实际结果 |
| --- | --- |
| 最终 npm test | 77 文件；572 通过、21 条件跳过；较起始基线增加 86 项 |
| npm run build | 应用／服务端／评测 TypeScript 与 Vite 构建通过 |
| Runtime 团队独立相关复测 | 8 文件、91 项通过；包含本轮 18 项 |
| Worker 团队独立相关复测 | 12 文件、150 项通过；包含本轮 50 项 |
| npm run test:native | 3 文件、30 项通过；与普通测试部分重叠，不直接加总 |
| 固定离线评测 | eval:offline、eval:m1、eval:m2、eval:plan、eval:loop-safety、eval:context、eval:recovery、eval:memory、eval:knowledge 全部通过 |
| npm run eval:product | 本地固定 Provider HTTP 流程通过：个人记忆、知识权限／撤回、Plan 确认、SSE、遥测、文件审批／备份、原生 PDF、需求单审批导出、取消和会话删除 |
| git diff --check | 通过 |

`check:local` 首次执行在原生阶段遇到外层执行沙箱限制：`sandbox_apply: Operation not permitted` 和 localhost `listen EPERM`。普通测试、构建、离线评测和 native 编译此前已经通过。随后获得执行权限，单独重跑 `test:native` 和 `eval:product`，两者均通过。最终补充测试冻结后再跑 npm test，得到上表 572 项结果；不把首次整条命令描述为 exit 0。

### 2026-09-21 再次完整复验

按后续要求，在具备 macOS 原生沙箱和 localhost 监听权限的执行环境重新运行完整 `npm run check:local`，本次整条命令 **exit 0**；随后 `npm run eval:knowledge` 也 **exit 0**。没有改动生产代码或测试断言来完成这次复验。

- 全量单元／集成测试仍为 **77 文件、572 项通过、21 项条件跳过**，包含上面的全部 86 项故障注入／控制用例。
- TypeScript、Vite、8 组固定离线评测、native 编译、**3 文件／30 项原生测试**以及完整本地 HTTP 产品回归均通过。
- 额外知识库固定评测共 66 个案例，验证检索、引用与隔离机制；不将模拟语料指标解释为真实检索质量。
- 没有新增失败。临时复验日志为 `/tmp/packx-error-handling-recheck-local.log`、`/tmp/packx-error-handling-recheck-knowledge.log`。

此次还对照代码同步了 [当前错误处理方法](reliability-recovery.md)：明确 Runtime 与 Tool 两套契约、code／retryable／HTTP 的区别、重试与暂停预算、Runtime 完成证据与 API 去重的区别、取消和未决副作用，以及双重故障的因果链；修正摘要错误分类与对账 5 秒上限等易误读表述。README 和本地操作指南均链接到该说明。

过程日志位于本机 `/tmp/packx-harness-*.log`，会随临时目录清理。长期证据是本报告及仓库内可重新执行的测试，不能依赖临时日志存在。验证没有访问真实模型、产生付费调用、提交／推送代码或改写用户业务数据，也没有重启日常使用的 Host。

## 明确保留的边界

- `abortable` 结束 Host 等待，不能强杀不合作的底层异步操作，也不能抢占同步 CPU 阻塞。取消不撤销已发生的外部副作用。
- 知识索引现在响应传入取消信号；仍未增加统一自动总 deadline。未收到取消时，不返回的 Embedding 仍可能等待；调度 reconcile 的故障隔离也未在本轮重构。
- 成功回复、Trace、遥测和模型计费仍不是一笔事务。成功后的持久化故障继续失败关闭；缺完成证据的回复不会自动重放调用，也没有新增自动补写服务。报告存储坏时，内存因果链不等于持久审计已成功。
- 未知工具副作用仍需权威证据对账；本轮证明零重复写入的固定样例，未新增通用补偿。多 Host 一致性、断电持久性、真实 Provider 质量／计费，以及外部生产系统故障不由 Fake 测试证明。

其它已识别的系统性限制及人工处置继续见 [逐节点故障审计](failure-handling-audit.md) 和 [可靠性恢复](reliability-recovery.md)。本轮没有用更大的预算、放宽权限或清空账本掩盖故障。
