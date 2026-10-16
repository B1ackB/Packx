# 本次切片依赖记录

## 2026-10-16：Windows 固定隔离探针的 CI 工具链

独立编写的测试探针只使用微软 Win32 AppContainer／LPAC、ACL、Job Object 和 Winsock API，没有引入外部 Harness 源码、npm 依赖或生产运行时组件。固定已安装 Visual Studio Enterprise 2026 `18.10.12224.181`、Windows SDK `10.0.26100.0` 与 vswhere `3.1.7`，来源为 [GitHub 官方 runner image 20261007.264.1 清单](https://github.com/actions/runner-images/blob/win25-vs2026/20261007.264/images/windows/Windows2025-VS2026-Readme.md)，配置见 `.github/windows-isolation-toolchain.json`。固定版本不存在则失败，不下载替代工具或修改系统设置。

vswhere 为 [MIT](https://github.com/microsoft/vswhere/blob/3.1.7/LICENSE.txt)。Visual Studio／Windows SDK 属微软专有许可，仅使用 GitHub 托管运行器已提供的 CI 工具链；不下载、复制或分发 SDK、编译器及其许可证所约束的运行时组件。静态链接的探针仅在本次临时目录中执行并删除，不加入发行物、不上传二进制；正式产品分发需要另行审核 SDK／CRT 再分发许可，不能以此实验替代。编译和测试不访问真实模型或客户资料，网络探针仅连接同一运行器的合成回环 listener。

日期：2026-09-05。该记录只覆盖本次新增依赖，不代表历史供应链完整审计已经完成。

| 依赖 | 固定版本与来源 | 许可证 / 商用边界 | 数据边界 |
| --- | --- | --- | --- |
| marked | npm `marked@18.0.11`，`package-lock.json` 固定 tarball 与 integrity；[官方源码](https://github.com/markedjs/marked/tree/v18.0.11) | MIT；保留 npm 包中的 LICENSE。无新增运行时传递依赖 | 仅浏览器本地词法分析，不上传正文；React 渲染原始 HTML 为文本；链接仅允许 http/https，外部图片不自动加载 |
| Apple PDFKit / ImageIO | macOS 系统框架，绑定用户 OS；[PDFKit 官方文档](https://developer.apple.com/documentation/pdfkit)、[ImageIO 官方文档](https://developer.apple.com/documentation/imageio) | 不复制/分发 Apple SDK 或框架；独立 Swift 源码由本机 Command Line Tools 编译。本切片未完成签名安装包分发 | 解析器在本机 Seatbelt 中断网运行，仅接触声明的资料副本 |

`marked` integrity：

```text
sha512-HnslJfsZkRPBDJRHvVtAaWlZHEpSu7u8LgQuJCELjRKuWR+hpq4A7sLq3p8HaI9ypVoXDXxV34CsQJEe1+J5Aw==
```

Swift 解析器与 PDF 测试文件均独立编写，没有使用 `temp/claude-code-best/` 源码，也没有新增 Codex/Claude Code 运行时依赖。

## 2026-09-13 本地发行补充

独立编写的 `native/ToolSupervisor.c` 使用 macOS 系统 libc/libproc、setrlimit 和进程组能力，由 Command Line Tools 编译；不分发 Apple SDK、框架或 Node 运行时。发行物首次安装沿用 `package-lock.json` 中的既有依赖与包内许可证（`npm ci --ignore-scripts`）；未增加第三方依赖，不将本记录视为历史依赖的完整供应链审计。

## 2026-09-17 包装证据检索补充

最初合成基线没有新增 npm 依赖；同日真实语料实验已新增下节列出的锁定依赖。使用已有 Node 24.14.0 的 `node:sqlite`、crypto、https、dns、fs；Node 运行时许可和内置第三方声明以安装包 LICENSE 为准，SQLite 为 public domain。复用既有资料解析器、文件存储和持久队列，所有新增逻辑独立编写。

默认 embedding 为仓库内确定性词项特征基线，不含外部模型权重。可选本地模型必须由操作者另行记录固定模型 digest、维度、权重来源/量化版本、许可和 Ollama 运行时版本；仓库不会下载或分发。候选 [BAAI/bge-m3](https://huggingface.co/BAAI/bge-m3) 模型卡标明 MIT / 1024 维，**本次没有完成真实权重与运行环境验收**。Ollama HTTP 协议不需要新增 SDK。

PostgreSQL 17 / [pgvector v0.8.6](https://github.com/pgvector/pgvector/tree/v0.8.6) 仅为待验证迁移参考；两者使用 PostgreSQL License，未安装或打包。实际部署还须固定补丁版本/镜像 digest 并记录镜像的完整依赖清单。公开数据源权限另见 [资料登记](knowledge/sources.md)，模型或数据库软件许可证不授予第三方文档的索引与再分发权。

### 同日后续：真实资料实验依赖

真实资料实验使用 `@huggingface/transformers@4.3.0`（官方 Hugging Face 仓库，Apache-2.0）在本地 CPU 运行固定的 multilingual-e5-small ONNX 权重，及 `fast-xml-parser@5.11.1`（NaturalIntelligence 官方仓库，MIT）解析 PMC 允许下载的 JATS XML。安装限定本仓库并固定版本；不使用全局安装、付费推理或远程代码执行。模型上游 `intfloat/multilingual-e5-small` 为 MIT；ONNX 转换来源 `Xenova/multilingual-e5-small` 的固定提交和逐文件哈希另存实验记录。实验数据不上传给模型服务。

Transformers.js 依赖 ONNX Runtime 1.30.0（MIT）、ONNX Runtime Web 1.31.0 开发构建（MIT）、sharp 0.35.4 或锁定的修复版（Apache-2.0，libvips LGPL-2.1-or-later）、Hugging Face Jinja 和 tokenizers（Apache-2.0）；实际传递版本、integrity 与许可由锁文件及本次供应链记录固定。曾试装 3.8.1，但 npm audit 指出其 sharp/libvips 传递依赖高危公告，因此在运行模型前换成 4.3.0。保留相关 LICENSE；模型文件不混入源码发布物。安装禁用生命周期脚本，若运行时需要额外二进制，再单独检查来源与许可。

传递包版本、来源、integrity 和许可见 [依赖记录](evidence/knowledge-dependencies.json)；权重及分词器哈希见 [模型锁](evidence/knowledge-model-lock.json)。

### 2026-09-18：本地多语言重排

没有新增 npm 包。复用固定 Transformers.js 4.3.0，采用上游 [cross-encoder/mmarco-mMiniLMv2-L12-H384-v1](https://huggingface.co/cross-encoder/mmarco-mMiniLMv2-L12-H384-v1/tree/1427fd652930e4ba29e8149678df786c240d8825)，固定提交 `1427fd652930e4ba29e8149678df786c240d8825`，Apache-2.0。下载上游 `onnx/model_qint8_arm64.onnx`，约 118.6 MB，配置和分词器另计；逐文件 SHA-256 见 [重排模型锁](evidence/knowledge-reranker-lock.json)。仅操作者准备命令联网，启动和查询只读本地权重，关闭远程模型及远程代码。原模型卡随缓存保存；若分发权重须保留 Apache 许可及适用 NOTICE，本仓库不打包权重。没有付费推理、远程文档上传或新 Python 服务。

## 2026-10-12：教程浏览器回归

新增开发依赖 `@playwright/test@1.64.0`，仅引入 `playwright@1.64.0` 和 `playwright-core@1.64.0` 两个传递包。来源为 npm 官方 registry 与 [Microsoft Playwright 官方源码](https://github.com/microsoft/playwright/tree/v1.64.0)，三个包均为 Apache-2.0；保留包内 LICENSE/NOTICE，固定 tarball 与 SHA-512 integrity 见 `package-lock.json`。安装禁用生命周期脚本，不引入产品运行时依赖。

按 [Playwright 官方浏览器准备方式](https://playwright.dev/docs/browsers) 单独下载 Chromium Headless Shell；本次锁定清单为 revision 1248 / 156.0.8078.4，并随安装准备 FFmpeg revision 1013。实际来源由该版 `playwright-core/browsers.json` 与安装器固定，本机 macOS arm64 下载来自 `cdn.playwright.dev`。Chromium 主体采用 BSD 条款，其他组成部分以随附 `LICENSE.headless_shell` 为准；FFmpeg 附带 `COPYING.LGPLv2.1`。它们仅保存在开发环境浏览器缓存中，不加入 Packx 发行物；分发二进制时需另行遵循各自完整许可要求。

测试使用独立浏览器上下文、本机 Vite 与合成 API fixture，拒绝非 GET、未登记 API 和外部 HTTP 请求，不访问用户业务数据、真实模型或付费服务。失败截图与轨迹只写入已忽略的 `temp/browser-tests/`；依赖/浏览器首次准备需要访问上述公开下载源，测试数据不上传。运行方法与验证边界见 [浏览器回归说明](../tests/browser/README.md)。

## 2026-10-16：CI 安全检查与漏洞修复

本次不新增产品运行时直接依赖。新增开发依赖与独立检查工具如下，来源和下载校验值固定在锁文件及 [CI 工具清单](../.github/ci-tools.json)：

| 工具或依赖 | 固定来源 | 许可与用途 |
| --- | --- | --- |
| `yaml@2.9.1` | npm 官方 registry；[上游源码](https://github.com/eemeli/yaml/tree/v2.9.1)，无新增传递依赖 | ISC；仅解析工作流结构，保留包内 LICENSE |
| `actions/checkout@v7.0.1` | [完整提交](https://github.com/actions/checkout/tree/3d3c42e5aac5ba805825da76410c181273ba90b1) | MIT；仅检出代码，不持久化凭据 |
| `actions/setup-node@v7.0.0` | [完整提交](https://github.com/actions/setup-node/tree/820762786026740c76f36085b0efc47a31fe5020) | MIT；固定 Node，不启用包管理器缓存 |
| `actionlint@1.7.12` | [官方 release](https://github.com/rhysd/actionlint/releases/tag/v1.7.12)；Linux x64、macOS arm64/x64 包均固定 SHA-256 | MIT；本地语法检查，下载后保留 LICENSE.txt；禁用可选外部 shellcheck/pyflakes 集成 |
| `gitleaks@8.30.1` | [官方 release](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1)；上述三个平台包固定 SHA-256 | MIT；使用 CLI 二进制，不引入 Gitleaks Action 或商业服务，保留 LICENSE；扫描数据不上传 |

GitHub API 已核对两个 Action tag 指向上述原仓库 commit；工具归档 SHA-256 与官方 release asset digest 一致，本地 macOS arm64 下载后实际比对通过。Linux/macOS x64 下载仍需各自运行器实际验收。下载的是固定归档，不执行在线安装脚本；本仓库不提交或分发这些二进制。

首次审计发现 [sharp 高危公告 GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w) 与 [source-map-js 高危公告 GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q)。仅在现有依赖范围内更新传递锁定：`sharp 0.35.4 → 0.35.5`、对应平台包同版更新、`@img/sharp-libvips-* 1.3.3 → 1.3.4`、`source-map-js 1.2.1 → 1.2.2`。未运行 `npm audit fix`，未放宽版本范围或忽略漏洞；更新后审计为 0 findings。

实际锁文件的 sharp 元数据为 Apache-2.0，libvips 平台包为 LGPL-3.0-or-later，部分 Windows/WASM 包包含组合许可，source-map-js 为 BSD-3-Clause；与更新前各对应条目的 SPDX 相同。以当前锁文件及各包完整 LICENSE/NOTICE 为准，不能沿用上文历史段落中的简化 libvips 许可说明。本轮检查保留已安装包的许可文件，不打包分发原生库；未来发行物包含这些组件时仍须单独核对适用许可、NOTICE 与源代码提供等义务，不把漏洞审计通过视为再分发许可已审核完成。
