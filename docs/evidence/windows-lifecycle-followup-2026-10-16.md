# Windows生命周期跟进：回调、退出与清理

状态：已取得真实Windows直接证据，见末节；合并仍以PR最新完整提交的必需CI为准。此前PR49绿灯不能替代本次竞争条件回归。

## 失败与最小证据

CI38968848420在windowsBuildJob.test.ts:48的finally中目录删除EPERM，遮住主失败；126/127，后续原生产品未执行。此前38968307174是vswhere发现10秒ETIMEDOUT，属于另一基础设施阶段，不混作同一根因。

Node24.14本机实测（darwin，仅证明Node事件顺序）：spawn→callback(ABORT_ERR)→exit→close。原promisify(execFile)在取消回调即拒绝，无法保证supervisor及共享stdio已关闭。其[官方close定义](https://nodejs.org/download/release/v24.14.0/docs/api/child_process.html#event-close)也区分exit与stdio关闭。离线事件夹具固定“回调先发生”和相反顺序，要求两者均到达后才能释放资源；没有假称该夹具是Windows隔离实测。

旧测试finally只abort，不等待work，并以sentinel.exitCode代替close，可能在supervisor仍持有cwd时删除目录；又未保留主错误。现在先取消并等待work/close，再删除目录；若仍EPERM，AggregateError保留主错误与清理错误及cause，不吞错。合成双故障回归验证两者均存在。

原独立10秒握手没有包括已有30秒supervisor启动预算。改为沿用该显式预算并在工作已失败时立即抛原错误，不改变真实编译预算或增加自动重试。就绪JSON用原子rename发布，避免exists后读取半个JSON。

## 创建边界

代码检查还发现CreateProcess(SUSPENDED)与AssignProcessToJobObject之间有宿主死亡窗口。这不是已确认的历史EPERM唯一原因；单独消除并验证。采用Windows10/Server2016起的[PROC_THREAD_ATTRIBUTE_JOB_LIST](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)，在创建时分配所持匿名Job，恢复前查询实际成员身份。C#构建supervisor与C++LPAC启动共用同一OS机制，SDK静态断言核对C#属性常量。不以Job代替LPAC权限隔离，不继承Job句柄，不按PID/名称清理。

## 必须验证

* 原成功/失败/超时/Owner中止各3轮，根身份、创建即入Job、active=0、无关进程存活。
* 初始化阶段立即取消3轮：返回后无重试即可删除cwd。
* 主错误+清理EPERM同时存在的离线诊断回归。
* 实际Windows UTF-8任务、Host崩溃、正常结束、超时、取消及独立清理记录。

原失败全部保留，不重跑到绿；新提交仍须全部必需CI通过才允许启用限定任务并合并。线上模型调用暂停，费用预算尚未确认。


## 直接验收结果

源码 `6cae606b12d147659f516a2995148bc538d84c61` 的 [CI38971033418](https://github.com/B1ackB/Packx/actions/runs/38971033418)全部必需检查成功：Windows本地数据/构建生命周期137/137，真实受保护任务与重启回收8/8、均无跳过；macOS原生48/48；核心1160通过，48项默认平台/在线未运行另列，不冒充全执行。浏览器、类型、构建、安全与依赖门禁亦通过。

构建Job报告createdInJob=true、cleanupVerified=true、totalProcesses=50、activeProcesses=0，耗时19329ms。原零能力13/14且严格退出1保持；registryRead-only为16项原隔离+7项资源矩阵全部通过，初始化0、socket10013、connect未尝试。真实Host结束后，独立broker完成Job/profile清理并持久记录，重启回收等待其退出与完整证据；未确认记录保持保留。原始失败没有删除或改为成功。

此证据仅验收固定UTF-8上传任务和所列故障边界，不覆盖PDF/OCR/Office、任意程序、Windows11桌面发行、断电或生产多用户。真实模型调用仍暂停。
