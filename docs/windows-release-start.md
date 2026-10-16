# Windows 便携验证包

这是 Windows **x64** 内部验收 ZIP，不是签名安装器，也不表示 Windows 11 员工桌面已经通过验收。包内包含已构建网页和固定 UTF-8 原生程序；不包含 Node.js、Visual Studio/SDK、模型、API Key 或业务数据。

1. 安装 Node.js **24.14 或更高的 24.x**，将 ZIP 解压至当前用户拥有、可写的本机目录。目录可以含中文和空格。不要放在共享目录、网盘或系统目录。
2. 双击 `Start-Packx.cmd`。首次按 package-lock.json 安装依赖，需要 npm Registry 网络；生命周期脚本禁用。失败不会留下成功安装凭据，可检查网络后重试。后续启动复用安装。无需编译器、管理员权限或执行策略调整。
3. 浏览器打开本机页面后配置自己的模型服务；保存不会请求模型。任务才会消耗 API 费用。重复启动同一目录会打开已有实例，不创建第二个 Host；另一安装占用同一端口会拒绝操作。
4. 用 `Stop-Packx.cmd` 停止，或在原启动窗口按 Control-C。停止命令只向通过现有本地会话校验、且安装及实例身份匹配的 Host 发请求，不按进程名/PID 杀进程。等待“Packx stopped”再维护数据。关闭网页不等于停止服务。运行中任务会被取消，未完成租约和未知外部副作用仍按恢复规则处理，不宣称自动完成或安全重试。

Windows 文档范围仅 **128 KiB 以内的 UTF-8 .txt/.md/.csv/.json**。每次读取验证 LPAC、唯一 registryRead 能力、无网络能力和内核单进程 Job，并验证清理。PDF、OCR、扫描件、Office、本地任意路径及任意 Shell 没有 Windows 入口；不退回 Host 解析。网页显示组件是否存在，不把存在等同于隔离成功。

如果 Defender、SmartScreen 或组织策略阻止未签名程序，请停止并交由组织核验；不要关闭保护、添加全局排除项或假装隔离成功。CI 的 Windows Server 2025 证明不代替实际员工 Windows 11 桌面、策略和中文用户环境测试。

## 维护、升级与回滚

在本目录终端执行以下命令，路径请用双引号。配置可在 `.env` 设置 BLACKX_DATA_ROOT；改变后须从同一目录重启。私密模型设置 `.packx-settings.json` 不进入业务备份，需要在新版本重新配置；不能把旧目录整个上传或作为干净发行包分发。

```text
npm run doctor
npm run state -- backup "C:\Users\you\Packx backups\before-upgrade"
npm run state -- verify "C:\Users\you\Packx backups\before-upgrade"
npm run state -- restore "C:\Users\you\Packx backups\before-upgrade" "C:\Users\you\Packx data\new-version"
```

升级：停止旧版 → 备份并验证 → 新版解压至新目录 → 恢复到新数据目录 → 新版 `.env` 指向新数据 → 启动检查任务及附件。旧安装和旧数据保留。回滚：停止新版，用旧版及升级前备份恢复出的另一个新数据目录启动。不要让旧版写新版数据。当前只验证 schemaVersion=1 的同格式恢复；未来不支持版本会拒绝启动，没有破坏性迁移或自动降级。备份包含业务资料，须私密保管。

异常退出：确认原进程已经结束，在对应目录执行 `npm run state -- recover-lock`；仅在 OS 明确确认旧 PID 已消失时回收锁并留审计记录。未知、仍活动或 PID 复用不会自动回收。未完成恢复目录不能启动；不要删除 `.packx-incomplete` 绕过校验。

`packx-release.json` 记录源码提交、平台、架构、范围和文件 SHA-256；ZIP 旁 `.sha256` 用于传输核对。摘要不能证明发布者身份，下载来源仍需信任。发布包与首次启动安装均有独立验证；Node/npm 的安装、签名安装器、自动升级和组织部署另行验收。第三方及编译工具边界见 `docs/windows-release-notices.md`。
