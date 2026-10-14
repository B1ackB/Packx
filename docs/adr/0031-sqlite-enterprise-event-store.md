# ADR-0031：本地 Enterprise Event Store 迁移到 SQLite

- 状态：Accepted；2026-10-14（产品负责人 B1ackB 决定迁移）。
- 关联：[ADR-0004](0004-leased-stage-job-scheduler.md)、[ADR-0005](0005-transactional-outbox-and-queue-operations.md)、[本地存储基线](../evidence/local-storage-baseline-2026-10-14.md)、[D8](../project-decisions.md)。

## 背景

Enterprise Event Store 当前是单个 `events.json`，每次提交都重写整个文档。基线显示追加耗时随事件数线性增长（2 020 条时约 17 ms）。单机规模下仍可接受，但文件重写方式没有事务边界，也无法按 Run、租户做索引查询。本地已有多个 SQLite 存储（stage-jobs、task-checkpoints、personal-memory 等），使用 Node.js 内置的 `node:sqlite`，不引入新依赖。

## 决定

1. 新增 `SqliteEnterpriseEventStore`，实现现有 `EnterpriseEventStore` 接口，语义与文件版本逐条一致：按 commandId 去重、期望版本冲突检测、跨租户访问拒绝、outbox 发布与失败延迟。
2. 两种实现必须通过同一套契约测试。
3. 提供一次性迁移：读取并校验 `events.json`（schema v2 或 v3），在单个事务内写入 SQLite，然后逐 Run 对比读取结果；任何差异都回滚。原 JSON 文件保留不动，并生成带时间戳的备份副本。
4. 目标数据库已有事件时拒绝迁移，避免重复导入。
5. 驱动通过 `BLACKX_EVENT_STORE_DRIVER=file|sqlite` 选择。默认值在迁移在真实本地数据上验证通过后再切换，切换本身单独记录。
6. 不做分布式存储、不做共享数据库。SQLite 仍然只服务单个本机 Host，与 D8 的边界一致。

## 替代方案

- 继续使用 `events.json`：实现简单，但没有事务边界和索引，规模增长后需要再次迁移。
- 使用 PostgreSQL：属于托管云选型，路线图规定本地 M3 不提前选择，不采用。

## 影响与风险

- 数据格式变化：切换后 `events.sqlite` 成为权威来源。`events.json` 与备份只保留用于迁移核对，不能作为切换后的回退依据（见下文切换状态）。
- SQLite 写锁与文件锁的语义不同。`BEGIN IMMEDIATE` 事务替代了文件锁，忙时映射为 `concurrency_conflict`。
- 文件版本中 fsync 与 rename 的崩溃语义，在 SQLite 中由数据库的事务日志保证。

## 验证

- 契约测试对两种驱动均通过：去重、版本冲突、跨租户拒绝、outbox 生命周期。
- 迁移测试：空库导入、非空库拒绝、差异回滚、v2 文档导入、备份文件存在。
- 在真实本地数据副本上执行迁移，并记录校验结果。

## 切换状态（2026-10-14）

- 本地真实数据已迁移：46 条事件、6 条 outbox、3 个 Run，源文件迁移前后 SHA-256 不变，备份已生成。证据见 [迁移记录](../evidence/event-store-migration-2026-10-14.md)。
- 默认驱动仍为 `file`。`events.sqlite` 存在时不会被自动读取，切换由 `BLACKX_EVENT_STORE_DRIVER=sqlite` 显式完成。
- **切换是单向的。** 当前没有 SQLite 到 JSON 的反向导出工具。切换后再写入的事件，只能通过恢复 SQLite 数据或备份找回，不能直接回退到 `events.json`。在提供反向导出并验证之前，切换需要产品负责人明确确认。

## 退出条件

若 SQLite 驱动在契约测试或真实数据验证中出现不一致，停止切换，保留 `file` 作为默认驱动，并通过新 ADR 修订。
