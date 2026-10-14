# Enterprise Event Store 迁移记录（ADR-0031）

日期：2026-10-14
执行人：B1ackB（产品负责人决定迁移，操作由 Agent 执行）
命令：`npm run migrate:event-store -- .blackx-data/events.json .blackx-data/events.sqlite`

## 1. 操作步骤与结果

| 步骤 | 结果 |
|---|---|
| 1. 检查 Packx 是否运行 | 未运行；根目录锁的持有进程 pid 50746 已不存在（陈旧锁） |
| 2. 按运维文档执行 `npm run state -- recover-lock` | 输出：`Abandoned Host lock recovered. You can restart Packx.`，恢复记录已写入 |
| 3. 完整备份 `npm run state -- backup` | 785 个文件，`npm run state -- verify` 通过 |
| 4. 在副本上试运行迁移 | 46 条事件、6 条 outbox、3 个 Run；源文件 SHA-256 不变 |
| 5. 对真实数据执行迁移 | 同上；生成 `events.sqlite`（86 KB）与带时间戳的备份 |
| 6. 迁移后核对 | 源文件 SHA-256 仍为 `83f3524008bbf180eb4f191d68aee2c253b0b3f21819ca588364d734a6794f1d`；备份与源一致 |
| 7. 权限修正 | `events.sqlite` 初始为 `644`，已改为 `600`，与原 JSON 一致；代码已修复并补测试 |

## 2. 产物

| 文件 | 说明 |
|---|---|
| `.blackx-data/events.json` | 原始文件，未改动 |
| `.blackx-data/events.json.migrated-2026-10-14T03-22-01-412Z.bak` | 迁移前备份，SHA-256 与源一致 |
| `.blackx-data/events.sqlite` | 新的权威存储，当前未被运行时读取 |

## 3. 当前状态

- 运行时仍使用 `file` 驱动，读取的是 `events.json`。
- 切换到 SQLite 需要设置 `BLACKX_EVENT_STORE_DRIVER=sqlite`，并且是单向切换（见 ADR-0031 的切换状态）。
- 切换前，`events.sqlite` 与 `events.json` 的内容一致；切换后两者会逐渐分叉。

## 4. 测试证据

- `enterpriseEventStore.contract.test.ts`：文件与 SQLite 驱动各 5 项，共 10 项，对去重、版本冲突、跨租户拒绝、outbox 生命周期的行为完全一致。
- `eventStoreMigration.test.ts`：4 项，覆盖 v3 与 v2 导入、备份校验与权限、拒绝非空目标、源文件损坏时不创建目标。
