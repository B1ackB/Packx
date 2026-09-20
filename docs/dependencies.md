# 本次切片依赖记录

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
