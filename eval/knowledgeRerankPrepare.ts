import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// Operator-only, fixed public model/revision; never called by startup or an Agent Tool.
const model = "cross-encoder/mmarco-mMiniLMv2-L12-H384-v1", revision = "1427fd652930e4ba29e8149678df786c240d8825";
const root = resolve(".blackx-data/knowledge-reranker", model, revision);
const files = [];
for (const file of ["README.md", "config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "onnx/model_qint8_arm64.onnx"]) {
	const path = resolve(root, file); mkdirSync(dirname(path), { recursive: true });
	if (!existsSync(path)) {
		execFileSync("curl", ["--fail", "--silent", "--show-error", "--location", "--proto", "=https", "--proto-redir", "=https", "--max-redirs", "3", "--max-time", "300", "--max-filesize", "160000000", `https://huggingface.co/${model}/resolve/${revision}/${file}`, "-o", path + ".partial"], { timeout: 310_000 });
		renameSync(path + ".partial", path);
	}
	const bytes = readFileSync(path); files.push({ path: file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
	console.log(JSON.stringify({ file, bytes: bytes.length }));
}
if (!readFileSync(resolve(root, "README.md"), "utf8").includes("apache-2.0")) throw new Error("reranker_license_not_confirmed");
const lock = { model, revision, license: "Apache-2.0", source: `https://huggingface.co/${model}/tree/${revision}`, preparedAt: new Date().toISOString(), quantization: "qint8_arm64", runtime: "@huggingface/transformers@4.3.0", files };
const path = resolve("docs/evidence/knowledge-reranker-lock.json");
if (existsSync(path)) {
	const previous = JSON.parse(readFileSync(path, "utf8"));
	if (JSON.stringify(previous.files) !== JSON.stringify(files)) throw new Error("reranker_snapshot_changed");
} else writeFileSync(path, JSON.stringify(lock, null, "\t") + "\n");
