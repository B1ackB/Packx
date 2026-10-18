# UTF-8 文本读取的独立合同

落点为 Host/worker Adapter 的纯字节函数 `server/runtime/textDocumentInspection.ts`，复用 `AssetInspection`，不扩展 Agent Core 或行业规则。它目前只由离线测试调用，没有注册成 Tool，没有读取文件／网络 API，也不接到 AssetInspectionService；Windows 生产隔离仍不可用，未增加 Host fallback。

首段只支持 `txt/md/csv/json` 的原始 UTF-8 文本：严格解码，保留 Unicode、CRLF、公式／指令／链接字面内容；不执行 JSON 语义、CSV 公式、脚本或外部引用。拒绝 PDF/ZIP 冒充文本、NUL、非 UTF-8、空输入、超过10 MiB输入或100万UTF-16单元输出。输出超过限制直接拒绝，不把截断当完整读取。

调用者提供已冻结的来源 SHA-256；函数复制有界字节，再用同一副本校验 hash 和解码。UTF-8 BOM 的原始字节仍参与 digest。源变化、取消、大小或格式错误具有稳定 code，retryable=false，不返回部分文本，不将原始内容或私有取消原因放入错误。成功返回 parserId、sourceSha256 及既有 inspection schema；parsed 仅表示读到了文本，不建立 verified 业务事实。

后续接入必须在已验证的 Sandbox Port 内执行，并由 Host 验证租户/文件权限、源版本、完成证据和 Artifact 版本/来源。这个内存函数不是沙箱、不读取任意路径、不承诺抢占同步解码；执行器仍须负责超时/取消/资源/崩溃恢复。它的成功不允许绕过 Windows 网络隔离门禁。

离线回归覆盖四种格式、Unicode/换行/BOM、畸形编码、伪装文件、输入与输出边界、来源变化、取消及重复计算。Windows 必需套件明确包含该文件，实际运行结果须以 PR 当前 head 为准；不冒充 Windows 已支持客户文档读取。

[PR46](https://github.com/B1ackB/Packx/pull/46) 的 `47116a7` 已通过[全部必要CI](https://github.com/B1ackB/Packx/actions/runs/38953331357)：真实Windows111/111、其中本合同12/12，macOS原生47/47，固定eval/构建/浏览器均通过且无跳过。作者自审后于2026-10-16 19:16:39 UTC合并为 `9d48164374232d3af1f7a9e56f992ed810b593f0`；没有注册Windows生产读取器。
