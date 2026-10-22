# Windows 验证包的来源与许可边界

Packx source uses the MIT license in the root LICENSE. The two native programs are independently implemented in `native/windows` and built with the preinstalled Windows hosted CI toolchain using Release `/MT`. The exact eligible Visual Studio versions are `18.11.12315.225`, `18.11.12306.390`, and `18.10.12224.181`, with Windows SDK `10.0.26100.0`; the CI log records the selected version. The package excludes Visual Studio, the Windows SDK, separate CRT DLLs, compiler tools, Node/npm installers, and unaudited Harness source. Packx's MIT license does not change Microsoft's compiler or runtime licensing terms.

编译工具使用受其原有许可约束，不要求用户安装或新购编译器。此产物限内部验证，不是客户商业分发批准；签名安装器及商业再分发需在正式发行流程确认工具链许可、静态链接运行库的适用条款、终端条款和组织签名。不得把 CI 提供编译器误写为拥有任意再分发权利。微软官方来源：

- https://visualstudio.microsoft.com/license-terms/vs2026-ga-pro-enterprise/
- https://visualstudio.microsoft.com/license-terms/vs2026-ga-diagnostic-buildtools/
- https://aka.ms/vs/18/redistribution
- https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files

首次依赖安装仅使用 package-lock.json 固定来源及完整性值；各 npm 包保留自身许可。打包不复制 node_modules、用户配置、会话或业务资料，安装禁用 lifecycle scripts；本轮没有引入新的 npm 运行依赖。真实模型数据仅在用户发起任务后发送至其配置的服务，须独立遵守该服务的数据政策和费用预算。

CI 只构建并验证 ZIP。本仓库远端 action 允许清单仅包含固定 checkout/setup-node；新增官方 actions/upload-artifact v7.0.2（MIT，固定提交 cf430e030ddbb5b0abf93d22962f4752f3646cd9，来源 https://github.com/actions/upload-artifact ）被清单拒绝。没有扩大允许清单、绕过上传或发布 Release；当前 Windows ZIP 随临时 CI Runner 销毁，不能从本轮 CI 下载。若后续明确批准该单独动作，仍须只保留已验证的 ZIP/摘要、短期保留、无业务数据，不改变 contents:read。当前可在匹配的已批准 Windows 构建环境执行 npm run release 生成相同结构的本地包。
