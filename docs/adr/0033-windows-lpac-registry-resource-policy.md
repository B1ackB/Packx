# ADR-0033：Windows LPAC最小注册表资源策略

状态：固定 UTF-8 Port 与业务闭环已取得真实 Windows CI 证据；仅在最新必需 CI 通过后按限定范围启用。
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


后续 CI38967498265 的实际 UTF-8、输入拒绝、三轮 timeout/cancel/output 与三轮 Port AbortSignal 已通过；两项仍失败且未合并。Host 强制终止后原 stdout 连接可丢失，不能用空 stdout 判定资源未清理或假定成功；broker 在 Job 活跃数为0且 profile 删除后，原子保存 Host-owned execution.json，崩溃回归据此验证。此记录不自动推进 Run/Stage，也不等于业务交付。另一项为测试夹具未注册 Worker 允许列表中的 document_read，在执行前被 Unknown allowed tool 正确拒绝；补齐与真实入口一致的注册，并将同一业务流程以 Fake Port 独立离线运行，验证配置、来源 Artifact、事实确认、审批和交付门禁，避免只在远程 Windows 才发现 Host 夹具错误。


CI38968307174 在 Windows 本地数据127/127后，于10秒工具链发现预算内出现 vswhere ETIMEDOUT，尚未编译或执行该提交的原生程序；其他必要平台通过。保留此基础设施失败，不当成产品成功或产品失败分数。后续补充发现阶段/version/path/version 的有界耗时与错误码，维持原预算与零自动重试，避免盲目增加时限。另将暂存调用显式绑定原 tenantId/workspaceId/runId，离线验证伪造任一维度不能调用底层执行器且不能破坏原合法执行。


## registryRead实际资源范围（合成矩阵验证中）

它只作为每个LPAC进程SECURITY_CAPABILITIES中的唯一SID，不修改系统全局能力、现有键ACL、用户账户权限或网络例外。LPAC仍取用户Token与资源允许SID的交集；能力名称不等于“全注册表只读”，AppContainer自己的私有资源仍可能可写，也不能保证所有应用写进共享键的秘密都不可读。

新增独立7项范围证据，与原16项隔离断言分开记录，候选报告v3必须两者完整：公开HKLM Winsock配置键仅查询元数据；当前用户+SYSTEM且禁止继承的credential/model-settings合成键分别拒绝读写；一个仅在本次拥有的合成用户子键上显式给registryRead授予KR，必须能读到合成canary而拒绝写入。后者明确证明“有能力授予的用户键可读”，不得宣称所有HKCU都不可达。所有值均合成，宿主正向读写可用，最后删除本次拥有的根及所有子键并验证不存在。

未打开或读取真实用户敏感键/凭据，故不对实际账户每种秘密存储作未经测试的绝对保证。产品固定worker只做Token/网络边界验证和UTF-8读取，不提供注册表工具、任意程序或Host秘密环境；秘密不得放入授予这些能力或Package SID的共享资源。扫描/Office等格式保持不可用。

## Host崩溃与Node生命周期

CI38969996377中构建131/131、启动期取消三轮、原子创建入Job及正常/超时/取消通过；实际业务与其余原生检查也通过，独立Host崩溃证据未产生。Node24.14实际uv版本1.51.0，其[Windows实现](https://raw.githubusercontent.com/libuv/libuv/v1.51.0/src/win/process.c)将非detached子进程放入Host拥有的关闭即杀Job，所以Host死亡会先杀broker，不能仅推断stdout丢失。可信broker现按[Node detached机制](https://nodejs.org/download/release/v24.14.0/docs/api/child_process.html#optionsdetached)独立于该自动清理关系，不unref，保留控制管道、墙钟和close等待，收到EOF就终止并核验自己持有的worker Job再删profile。detached不设置CREATE_BREAKAWAY_FROM_JOB；worker仍在原子分配的单进程Job与LPAC内，没有放开其隔离或进程树。新的真实Host强制结束三轮必须实际通过。


CI38970539090全部必需检查通过：Windows137/137，受保护任务7/7无跳过（含真实Host终止三轮、Port取消三轮及业务交付），macOS原生48/48；构建50个总进程、active=0、createdInJob/cleanupVerified均true；原零能力严格拒绝，候选16+7资源断言全部通过。该成绩不覆盖之后新增的重启回收保护，最终提交须再次通过门禁。

独立broker在创建profile前写入Host-owned broker.json（PID、profile名称和creation=intent，不把意图当作已创建证明）。Node重启时，活broker或没有profileDeleted/cleanupVerified持久证据的Native目录保留；只在broker已退出且证据完整时回收。离线fake liveness覆盖存活/缺失/否定/完成四种分流，真实Host崩溃三轮继续验证后续回收，不按PID杀进程，PID复用只会保守保留。
