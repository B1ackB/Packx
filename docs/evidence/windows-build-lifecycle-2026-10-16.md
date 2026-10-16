# Windows探针构建生命周期

源故障：main `9e842df9` 的[运行38958873340](https://github.com/B1ackB/Packx/actions/runs/38958873340)第一次Windows115项通过；编译cmd在30秒后ETIMEDOUT，随后scratch删除EPERM，探针未启动。第二次重跑成功，但测试报告20:05:08到compile_completed 20:05:39也接近原时限。成功重跑没有修复根因。

vcvars、两次MSVC编译和探针各次执行共用30秒参数；Node超时终止直接子进程，缺少编译后代退出证据。原故障没有采样具体持锁进程，不能声称已定位到某个PID。

## 修复边界

仅管理可信CI构建，未注册到Agent Runtime，不是文件/网络安全沙箱。使用既有预装x64 PowerShell Core及Win32 Job API，不安装工具或修改ExecutionPolicy、系统ACL、网络例外。

* 编译单独90秒，Job最多16进程、总提交内存2GiB；清理最多5秒，监督进程外层最多120秒。诊断/严格探针各30秒不变，无自动重试或构建缓存。
* 挂起创建cmd，记录进程句柄取得的PID及创建时间；加入匿名私有Job后才Resume。Job句柄不可继承、不允许breakaway；关闭监督进程最后Job句柄会终止其所属后代。
* 正常退出、非零退出、超时均终止剩余Job成员并查询activeProcesses=0。根退出码在终止前读取，错误、stdout/stderr及清理状态分别保留；缺报告、原生调用或清理不确定均失败。
* 不按PID/进程名枚举或批量终止。监督进程被中止时由kernel kill-on-close收尾，独立进程不得被误杀。Node父进程直接崩溃的所有情形不由本切片宣称覆盖。

依据[Microsoft Job对象机制](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)和[创建时加入Job的时序](https://devblogs.microsoft.com/oldnewthing/20230209-00/?p=107812)：先关联再执行，后代继承关联；生命周期限制不等于安全限制。Node以[固定24.14.0文档](https://nodejs.org/download/release/v24.14.0/docs/api/child_process.html)为参照。PowerShell只承担CI中的Win32调用。

## 固定回归

真实Windows必需套件新增`eval/windowsBuildJob.test.ts`：成功/退出37/超时/监督进程Abort四类各3轮，加缺失程序1例。每轮先确认后代占用目录、删除失败，再核验Job归零和目录可删；根PID/创建时间及Job计数由原生句柄产生，独立心跳进程持续运行。保留退出码及stderr，不重试掩盖错误。macOS/Linux仅跳过此真实平台行为，Windows切片不允许指定套件跳过。

真实WindowsCI通过后才能判定修复有效；本地类型和平台无关回归仅为前置。Windows生产网络门禁仍blocked、13/14，生产Adapter未接入，本修复不改变严格退出1要求。

首轮PR49运行38961136728：117/117及上述12轮行为通过；实际编译环境初始化失败，Job报告根创建时间、退出1、累计31进程、活动0且cleanupVerified=true，无清理EPERM。调用者环境现以明确UTF-16环境块传入，避免继承PowerShell启动环境；仅允许公开OS前提变量及既有CI白名单，不传递Provider凭据。新增Unicode/精确PATH传递及凭据不继承回归，实际编译结果仍须由新提交CI核验。
