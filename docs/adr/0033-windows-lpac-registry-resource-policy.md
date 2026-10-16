# ADR-0033：Windows LPAC最小注册表资源策略

状态：受控候选已取得 16/16 直接证据；固定 UTF-8 Port 与产品闭环实现待 CI 验证。
日期：2026-10-16

## 背景

ADR0032的零capability LPAC在固定Windows中13/14，WSAStartup=10107、目录读取5，默认严格退出1。微软[启动LPAC说明](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)明确指出LPAC访问注册表需要registryRead。此机制说明初始化失败的候选原因，尚不证明某个内部调用是唯一原因，也不允许把初始化失败当作网络拒绝。

用户授权判断并实现安全的Windows最小闭环，排除新增付费、凭据权限扩张和未经许可的系统配置。给本次子进程分配公开系统库所需资源，与提升用户/服务账户权限不同；本对照不读取真实凭据、不改系统键ACL或已有用户键。按P1.9先验证现有OS Adapter资源策略，不扩展Core、Loop或模型路由。

## 决定与范围

1. 保留原零capability诊断及严格模式，原计数/blocked/严格退出1不被覆盖。
2. 仅向另一新建LPAC加入`registryRead`，Token实际capability必须唯一且SID等于公开DeriveCapabilitySidsFromName结果。不加入internetClient、privateNetworkClientServer、COM、全用户文件能力或特权句柄。
3. 同一工作程序/文件权限/环境/单进程Job/64MiB资源预算执行对照；同一网络函数先在合法宿主创建socket并连接成功，再要求LPAC初始化0且socket或connect操作明确以10013拒绝。两阶段分别记录错误码；socket被拒时connect未尝试，不能写成连接拒绝。初始化失败和其他socket错误继续阻断。
4. 在当前用户注册表创建唯一合成叶子，DACL仅允许当前用户和SYSTEM，禁止继承。合法宿主正向读写可用；LPAC分别以KEY_QUERY_VALUE和KEY_SET_VALUE验证拒绝。完成后删除并验证键不存在。只清理本次确实新建的键和profile。
5. 候选必须16/16且所有原有清理/隔离门禁通过；缺证据就让CI失败，不用诊断绿灯隐藏候选失败。策略和报告显式区分，不改写13/14为通过。
6. 本轮先回答可行性。如果不能通过，停止候选生产接入并给出具体阻塞；如果通过，才继续单个有界只读UTF-8任务的实际Runtime闭环。不能以候选报告代替生产Port、权限、取消/Host崩溃、输出上限、Artifact与恢复的证据。此时仍不声明完整Windows或PDF/Office支持。

## 替代方案与退出

* 保持零capability：继续安全拒绝，但不能宣称已验证可用的网络边界。
* 直接降为普通AppContainer：扩大系统资源可见面，不作为隐式fallback。
* 修改HKLM Winsock目录ACL、网络例外或启用WSL2/Windows Sandbox：涉及系统配置，不在本轮授权内。
* 一次添加多个LPAC能力：无法归因且扩大读取面，不采用。

SID推导使用既有固定Windows SDK的OneCoreUAP.lib，运行时为系统KernelBase.dll；没有新SDK安装或再分发。未改持久业务Schema或迁移数据。候选失败时保留原策略并关闭未合并实验；生产候选发现退化则恢复Typed sandbox_unavailable，不使用无隔离执行。

## 首次直接证据与报告修正

PR50运行38963809207中，原零能力诊断/严格边界保持；候选初始化0、目录访问0，私有注册表读写及清理通过，但socket()直接10013，未调用connect。原报告将两种错误混在networkConnectionError并标为socket_failed，严格候选因此失败15/16，未合并。

根据[Winsock错误定义](https://learn.microsoft.com/en-us/windows/win32/winsock/windows-sockets-error-codes-2)，WSAEACCES=10013是权限拒绝；这是实际网络资源操作失败，不是WSA初始化不可用。报告升级到experimental.v2，独立networkSocketError/networkConnectionError，精确观测socket_access_denied或access_denied并保留denialStage。缺正向控制、初始化失败、其他socket错误或阶段混淆仍失败。不能把历史v1的socket_failed报告重新标为成功；修正后的同程序新执行才构成证据。


## 最小任务接入（验证中）

使用同一自有 LPAC 启动原语建立两个原生程序：可信 Host broker 与固定 UTF-8 worker。不接受 Shell、任意程序、网络白名单或写入目录；仅 txt/md/csv/json 附件、128 KiB、严格 UTF-8、单页原文。PDF、ZIP、NUL、无效编码与超限输入失败，不执行 Host 解析 fallback。每次 worker 验证 Token、唯一 registryRead 和实际 socket 权限拒绝。

broker 创建挂起进程，先加入单进程 Job 再恢复；Job 限 64 MiB、30 秒 CPU、墙钟最多 60 秒，关闭即终止。显式 HANDLE_LIST 只传 stdout 写端与 NUL stdin，不传 Job、输入文件或其他 Host 句柄；由 Windows LPAC 文件 ACL 控制暂存副本读取。输出走有界管道，临时目录不授予 worker 写入。OS 自有 AppContainer profile 仍有其固有私有资源，不把 Job 宣称为磁盘配额或任意不可信程序沙箱。

Node 与 broker 的控制管道 EOF 表示取消或 Host 进程退出。broker 终止所持 Job，等待所持 worker handle，查询活跃数 0，删除自己新建的 profile，再报告清理证据。主进程硬终止或清理异常返回 sandbox_unavailable/cleanup_unconfirmed，不能重放为已完成；可能需要人工清理孤立 profile，此限制不隐藏。强制结束 broker 时，KILL_ON_JOB_CLOSE 仍限制子进程生命周期。不得按 PID/名称杀死其他程序。

通过现有 SandboxedToolExecutorPort 接入 AssetInspectionService，parserVersion=windows-utf8.v1，缓存键与 macOS 1.3.0 分开；复用版本化 Artifact、来源摘要、显式确认和 Approval，Core 不变。启动只使用预装且固定的 CI 工具链，缺原生二进制/能力/隔离证据失败关闭。Windows 2025 CI 不能证明 Windows 11 用户桌面、安装包、PDF/Office 或生产就绪。

必要回归：真实 UTF-8/BOM/转义字符、编码与格式失败、权限拒绝、3 轮超时/取消/输出超限、3 轮真实 Node Host 终止后的 Job/profile 清理、上传→原生 Tool→Artifact→人工事实确认→版本审批→需求单下载；离线模型仅作为确定性驱动，不当作真实模型效果。


产品接入的首个启动失败保留：CI38966529838/38967037675 中严格探针仍通过，新 broker 的 CreateProcess 返回203（环境字段缺失），worker 尚未开始，相关任务和清理测试按失败处理。修复复用已验证探针的显式 OS 字段：SystemDrive/SystemRoot/windir，以及指向本次私有 profile 的 APPDATA/LOCALAPPDATA/USERPROFILE/TEMP/TMP；不借用真实用户目录、不继承 Provider 变量。ole32 只在可信 broker 释放系统分配的路径内存使用，没有给 LPAC 增加 COM 能力。控制管道采用 destroy 完整关闭连接，避免把 writable end 等同于跨平台句柄关闭，实际 AbortSignal 另有三轮回归。
