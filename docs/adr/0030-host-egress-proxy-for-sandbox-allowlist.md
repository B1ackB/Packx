# ADR-0030：沙箱域名 allowlist 通过 Host 出口代理实现

- 状态：Accepted；2026-10-14（产品负责人 B1ackB 接受）。
- 实现：`server/runtime/egressProxy.ts`、`macOsSeatbeltSandboxedToolExecutor.ts`。
- 来源：[M3 G2/G4](../milestone-3-production-hardening.md) 要求 `allowlist` 网络模式可用；当前 Seatbelt Adapter 对 `allowlist` 返回 `sandbox_unavailable`（`network_allowlist_proxy_unavailable`），因为没有可信的 Host 代理。
- 关联：[ADR-0008](0008-local-native-tool-sandbox.md)、[ADR-0009](0009-local-document-delivery-slice.md)、[ADR-0017](0017-local-release-settings-and-native-supervision.md)。

## 背景

外部 Tool 有时确实需要访问少量明确的域名，例如读取已授权供应商的公开目录。直接放开 Seatbelt 网络会允许任意目标，因此 M3 默认 `deny-all`。若要支持域名白名单，必须有一个受信的 Host 进程决定哪些域名可以连接。

## 决定

1. Host 为每个需要 `allowlist` 的 Tool Attempt 启动一个只监听 `127.0.0.1` 随机端口的 HTTP CONNECT 代理。代理在 Attempt 结束后关闭。
2. Seatbelt Profile 只允许子进程连接该代理端口。不允许其他 localhost 端口，也不允许任意出网。
3. 子进程环境只注入 `HTTPS_PROXY` / `HTTP_PROXY` 指向该代理，不继承宿主代理配置。
4. 代理只接受 Manifest 中声明的域名（精确匹配，不支持通配符，除非后续 ADR 增加）。
5. 代理在本机解析 DNS 后检查目标 IP。拒绝私网、回环、链路本地和云元数据地址，防止 DNS 重绑定和间接访问 localhost。
6. 每次连接决定（允许或拒绝）写入 Attempt 审计，只记录域名和决定，不记录请求内容、Cookie 或 Authorization 头。
7. 代理不解密 TLS，不改写请求。

## 替代方案

- **维持 `deny-all`**：最安全，但无法支持确有必要的只读外部资料访问。作为默认状态保留。
- **Seatbelt 直接允许特定 IP**：IP 会变化，且无法防止 DNS 重绑定，不采用。
- **只通过 Host Connector 访问外部 API**：对企业系统更合适，应作为长期方向（P0.2）。本 ADR 只处理沙箱内子进程的临时域名访问，不替代 Connector。

## 影响与风险

- 增加一个 Host 进程组件和一个本机端口，需要测试端口占用、代理崩溃和 Attempt 取消时的清理。
- 如果子进程忽略代理环境变量，连接会被 Seatbelt 拒绝，属于 fail-closed，不会直接出网。
- 允许 Seatbelt 访问代理端口，理论上存在经代理访问其他本机服务的途径。代理只转发到已解析的公网 IP，已拒绝回环地址，因此风险可控。
- 需要登记新依赖（如使用成熟代理库）时，必须按 P0.5 记录版本和许可证。本 ADR 倾向只用 Node.js 内置模块实现。

## 验证（实现后必须通过）

- 攻击回归：未声明域名、localhost、私网 IP、云元数据地址、DNS 重绑定到私网，全部被拒绝。
- 子进程忽略代理变量时无法连接。
- Attempt 取消、超时和 Host 强制退出后，代理端口和进程都被清理。
- 允许的域名可以连接，并在审计中留下决定记录。

## 迁移与退出条件

- 默认仍为 `deny-all`，`allowlist` 只对明确声明的 Tool 开放。
- 若在 macOS 实测发现 Seatbelt 无法稳定限制到代理端口，或代理无法通过攻击回归，则停止实现，改为只支持 Host Connector 访问外部 API，并回到本 ADR 修订。

## 实现记录（2026-10-14）

- 代理只解析 CONNECT 请求行，不转发明文 HTTP；非 CONNECT 请求返回 405，端口非 443 或 IP 字面量返回 403。
- 允许域名的每个 DNS 结果都必须是公网地址，任何一个私网、回环或保留地址都会拒绝整次连接；连接直接使用已验证的 IP。
- Seatbelt 只在 `(deny network*)` 之后放行 `localhost:<代理端口>`；子进程环境注入 `HTTPS_PROXY`、`HTTP_PROXY` 及小写变体。
- 验证：`server/runtime/egressProxy.test.ts`（5 项，平台无关）；Seatbelt 测试「reaches only allowlisted domains through the Host proxy」「denies direct connections that bypass the proxy in allowlist mode」。
- 未完成：代理决定目前通过 `onDecision` 回调暴露，尚未写入 Attempt 级审计记录。接入审计端口后再关闭本条。
