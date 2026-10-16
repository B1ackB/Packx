# ADR-0033：Windows LPAC最小注册表资源策略

状态：受控可行性对照，生产接入待直接安全证据。
日期：2026-10-16

## 背景

ADR0032的零capability LPAC在固定Windows中13/14，WSAStartup=10107、目录读取5，默认严格退出1。微软[启动LPAC说明](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)明确指出LPAC访问注册表需要registryRead。此机制说明初始化失败的候选原因，尚不证明某个内部调用是唯一原因，也不允许把初始化失败当作网络拒绝。

用户授权判断并实现安全的Windows最小闭环，排除新增付费、凭据权限扩张和未经许可的系统配置。给本次子进程分配公开系统库所需资源，与提升用户/服务账户权限不同；本对照不读取真实凭据、不改系统键ACL或已有用户键。按P1.9先验证现有OS Adapter资源策略，不扩展Core、Loop或模型路由。

## 决定与范围

1. 保留原零capability诊断及严格模式，原计数/blocked/严格退出1不被覆盖。
2. 仅向另一新建LPAC加入`registryRead`，Token实际capability必须唯一且SID等于公开DeriveCapabilitySidsFromName结果。不加入internetClient、privateNetworkClientServer、COM、全用户文件能力或特权句柄。
3. 同一工作程序/文件权限/环境/单进程Job/64MiB资源预算执行对照；同一网络函数先在合法宿主成功，再要求LPAC初始化0且实际connect以10013拒绝。
4. 在当前用户注册表创建唯一合成叶子，DACL仅允许当前用户和SYSTEM，禁止继承。合法宿主正向读写可用；LPAC分别以KEY_QUERY_VALUE和KEY_SET_VALUE验证拒绝。完成后删除并验证键不存在。只清理本次确实新建的键和profile。
5. 候选必须16/16且所有原有清理/隔离门禁通过；缺证据就让CI失败，不用诊断绿灯隐藏候选失败。策略和报告显式区分，不改写13/14为通过。
6. 本轮先回答可行性。如果不能通过，停止候选生产接入并给出具体阻塞；如果通过，才继续单个有界只读UTF-8任务的实际Runtime闭环。不能以候选报告代替生产Port、权限、取消/Host崩溃、输出上限、Artifact与恢复的证据。此时仍不声明完整Windows或PDF/Office支持。

## 替代方案与退出

* 保持零capability：继续安全拒绝，但不能宣称已验证可用的网络边界。
* 直接降为普通AppContainer：扩大系统资源可见面，不作为隐式fallback。
* 修改HKLM Winsock目录ACL、网络例外或启用WSL2/Windows Sandbox：涉及系统配置，不在本轮授权内。
* 一次添加多个LPAC能力：无法归因且扩大读取面，不采用。

SID推导使用既有固定Windows SDK的OneCoreUAP.lib，运行时为系统KernelBase.dll；没有新SDK安装或再分发。未改持久业务Schema或迁移数据。候选失败时保留原策略并关闭未合并实验；生产候选发现退化则恢复Typed sandbox_unavailable，不使用无隔离执行。
