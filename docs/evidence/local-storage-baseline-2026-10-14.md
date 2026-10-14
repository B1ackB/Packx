# 本地存储基线与恢复证据（M3 G5 / H4）

日期：2026-10-14
环境：macOS（Darwin），Node v24.14.0，单进程本机 Host。
测量脚本：`eval/localStorageBaseline.ts`（`node --import tsx eval/localStorageBaseline.ts`）。

## 1. 单文件 Event Store 的成本曲线

每次提交都会重写整个 `events.json`（临时文件、fsync、rename、目录 fsync）。下表每档在已有事件基础上追加 20 次 `run.created`，并在文件加载 20 次。

| 事件数 | 文件大小 | 追加中位 | 追加 P95 | 加载中位 |
|---|---|---|---|---|
| 120 | 36.5 KB | 9.68 ms | 11.69 ms | 0.13 ms |
| 520 | 158.9 KB | 11.95 ms | 12.81 ms | 0.56 ms |
| 1 020 | 312.0 KB | 13.29 ms | 14.57 ms | 0.87 ms |
| 2 020 | 620.0 KB | 17.05 ms | 17.87 ms | 1.50 ms |

观察：
- 每条事件约 310 字节，文件大小与事件数线性增长。
- 追加耗时随文件大小线性增长，但在 2 000 条事件以内仍低于 20 ms。
- 这是按线性外推的结果，未在 10 万条事件规模上实测。

## 2. 决策阈值（待产品负责人确认）

本次不迁移到 SQLite。`docs/handoff` 第 6 节第 4 项保持未决。建议在以下任一条件出现时，另立 ADR 评估单机 SQLite（仍属于单机、不引入分布式）：
- 追加 P95 超过 100 ms，或文件超过 50 MB。
- 任一条件在真实用户数据上出现，而不是只在合成基线中出现。

## 3. 本次补充的崩溃与迁移证据

| 场景 | 测试 | 结果 |
|---|---|---|
| 旧版 schema v2 文档被读取并在下一次提交时升级为 v3 | `fileEventStoreRecovery.test.ts`「upgrades a schema v2 document…」 | 通过 |
| 崩溃后遗留的部分写入临时文件不影响读取 | 「ignores an orphaned partial write…」 | 通过 |
| 临时写入路径已被他人占用时，不删除该文件 | 「never deletes a file that already occupies its temporary write path」 | 修复前失败：原实现会删除他人文件并掩盖错误类型；修复后通过 |
| 有序迁移，每步提交后才记录版本 | `localDataMigration.test.ts`「runs ordered steps…」 | 通过 |
| 迁移步骤失败时保留上一个已提交版本，修复后继续 | 「keeps the last committed version…」 | 通过 |
| 拒绝更新版本的数据，拒绝缺失迁移步骤 | 「refuses data written by a newer release…」 | 通过 |
| 损坏的 Event Store 文件失败关闭 | `fileEventStore.test.ts`「fails closed when the persisted event document is corrupt」（既有） | 通过 |
| 备份与恢复往返、WAL 快照、中断恢复 | `localBackup.test.ts`（既有） | 通过 |

## 4. 已知限制

1. 目录 fsync 在 rename 之后执行。如果 rename 已成功而目录 fsync 失败，调用方会收到 `event_store_unavailable`，但数据可能已经提交。命令去重能让重试安全，但调用方不能仅凭错误判断写入未发生。
2. 启动时不清理遗留的 `*.tmp` 临时文件。清理需要和写锁协调，否则可能删除正在写入的文件，本次不做。
3. 队列（`stage-jobs.json`）的迁移与崩溃注入未纳入本次范围。
4. 迁移框架目前只注册了版本 1，没有真实的版本 2 迁移。框架由测试中的注入步骤验证。
