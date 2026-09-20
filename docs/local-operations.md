# 本地启动、诊断与备份恢复

当前提供源码开发入口和 macOS 本地发行目录，已包含图形化模型配置。发行目录生成与启动见 [发行使用指南](release-start.md)。尚未提供签名公证、自动升级或跨平台安装保证；本机复现不代表企业电脑或干净设备验收。

## 首次使用

1. 安装 README 指定的 Node 24.14.0 和 Apple Command Line Tools，在仓库执行 `npm ci`。
2. 执行 `npm run build:native`，再执行 `npm run doctor`。诊断检查版本、依赖、解析器、数据目录和 Provider 配置形状，不发送模型请求，不显示密钥值。
3. 无真实模型时使用 `npm run dev:fixture`，打开服务显示的本机地址。此模式为临时固定演示，正常退出会清理数据。
4. 执行 `npm start` 后，点击“配置模型”填写连接信息并保存；停止并重新打开后生效。也支持 `.env`。图形设置优先于 `.env` 的 Provider 配置，保存不调用模型。连接真实模型可能计费，诊断通过不等于端点兼容性验证通过。
5. 从 [模拟咖啡袋资料](../examples/coffee-pouch-intake.md) 开始，用 Plan 整理资料。完成后点击“将结果转为需求单草稿”，在右侧逐项确认、审批并导出。

## 数据布局

默认根目录为 `.blackx-data/`。可用 `BLACKX_DATA_ROOT` 改变整组默认位置：agent、events.json、artifacts、attachments、files、cron-schedules.json、stage-jobs.json（SQLite Queue 使用 stage-jobs.sqlite）和 inspection-cache。

已有 `BLACKX_*_PATH` 单项配置优先，不会被新根目录覆盖。历史仅配置 `BLACKX_WORKSPACE_ROOT` 时，解析缓存继续沿用该 Workspace 下的位置，避免静默迁移。自动备份命令只支持标准相对布局；自定义目录须在停机后按现有配置逐项备份并核对，不能忽略拒绝提示。

根目录有 Host/维护操作互斥锁，避免运行时复制出不一致快照。首次升级到含此锁的版本前，必须先退出旧版本 Host；旧版本不知道此锁。

## 备份

先正常停止 Packx。选择已存在的父目录中的**新目录**，不要放在数据目录内部：

```bash
npm run state -- backup /absolute/path/packx-backup-2026-09-13
npm run state -- verify /absolute/path/packx-backup-2026-09-13
```

备份包含标准数据目录中的会话、执行记录、Plan/子任务结果、事件、队列、附件、Artifact、受管理文件备份及 `knowledge/`（资料快照、知识 SQLite、索引、证据选择和审计）。每个文件记录大小与 SHA-256，SQLite 连同 WAL/SHM 保存并在临时副本执行完整性检查。单文件上限 256 MiB；符号链接、硬链接和特殊文件拒绝备份。

备份不包含 `.env`、`.packx-settings.json`、Provider Key、用户在数据目录之外的原始文件、Node 依赖或原生工具。外部原文件和私有配置应使用现有受信备份方式单独保管。备份内容包含业务资料；本命令不提供加密或远端上传。

## 恢复与升级回退

```bash
npm run state -- restore /absolute/path/packx-backup-2026-09-13 /absolute/path/packx-restored
```

恢复先检查清单、路径、文件集合、哈希及 SQLite，再写入新目录；拒绝覆盖现有目录。中断恢复保留 `.packx-incomplete` 标记，Host 拒绝启动该目录。重新恢复到另一个新目录，保留原数据和失败目录供排查，不删除标记来冒充成功。

启用恢复副本之前：

1. 保留原数据；停止其他 Packx Host。
2. 在本地配置中将 `BLACKX_DATA_ROOT` 指向恢复目录。移除或相应调整原来的单项 `BLACKX_*_PATH`；保留备份时的 Queue Driver，避免误读另一队列文件。
3. 核对备份时间之后已经发生的文件操作、审批和定时任务。备份是旧快照，无法回滚外部文件或客户系统；不能把恢复旧快照当作“外部副作用恰好一次”的证明。启动后队列和定时任务可能继续执行。
4. 执行 `npm run doctor`，再启动应用，检查会话、需求单版本、Plan 来源和审批状态。

升级前保存代码版本、私有配置及完整数据备份。回退时使用原代码版本和升级前数据的恢复副本，不让旧代码直接打开已升级的数据。目前备份格式固定为 v1，未知备份版本拒绝；没有承诺任意未来业务 Schema 的自动迁移。

## 异常退出后的锁

正常退出会移除 `.packx-operation.lock`。强制断电、SIGKILL 等可能留下锁：

```bash
npm run state -- recover-lock
```

命令检查原 Host PID，只在进程明确不存在时回收锁，并写入恢复记录；存活、权限不足、PID 被复用或异常锁格式会拒绝。若维护命令自身被强杀并留下 `.packx-lock-recovery` 目录，先核对不存在恢复进程，再移除这个空目录后重试。不要删除 Session 或执行账本的锁来强行重跑未知副作用。

固定原生解析任务由独立监督进程控制 CPU、文件大小、描述符、内存/进程数采样限制；Host 被强制结束后终止解析进程组，重启清理明确失去所有者的输入副本。限制范围和剩余故障边界见 [ADR-0017](adr/0017-local-release-settings-and-native-supervision.md)。

数据根目录的 `.packx-data-version.json` 标记当前布局版本 1。旧布局首次启动只补标记，不改写现有业务数据；未知版本拒绝打开。未来实际 Schema 变化需先实现明确的迁移及回退测试，不提前承诺通用自动迁移。

## 验证范围

本地回归覆盖 File/SQLite/WAL 往返、完整性、目录覆盖拒绝、运行互斥、路径穿越和链接拒绝。没有真实企业数据、故障设备或跨版本生产迁移验证；相关记录保持待补。
