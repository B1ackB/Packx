import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env, pipeline } from "@huggingface/transformers";

// Explicit operator download, isolated from normal app startup and all offline tests.
const model = "Xenova/multilingual-e5-small", revision = "761b726dd34fb83930e26aab4e9ac3899aa1fa78";
const root = join(process.cwd(), ".blackx-data/knowledge-model");
delete process.env.HF_TOKEN; delete process.env.HUGGING_FACE_HUB_TOKEN;
env.cacheDir = root; env.allowRemoteModels = true;
const extractor = await pipeline("feature-extraction", model, { revision, dtype: "q8", device: "cpu", cache_dir: root, session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 } });
const vector = await extractor("query: 咖啡包装袋的氧气阻隔测试条件", { pooling: "mean", normalize: true });
if (vector.dims[1] !== 384) throw new Error("unexpected_embedding_dimensions");
const files: { path: string; sha256: string; bytes: number }[] = [];
function walk(dir: string) {
	for (const item of readdirSync(join(root, dir), { withFileTypes: true })) {
		const path = join(dir, item.name);
		if (item.isDirectory()) walk(path);
		else if (item.isFile() && item.name !== "model-lock.json") { const bytes = readFileSync(join(root, path)); files.push({ path, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length }); }
	}
}
walk(""); mkdirSync("docs/evidence", { recursive: true });
const lock = { schemaVersion: "knowledge-model.v1", model, revision, dtype: "q8", dimensions: 384, pooling: "mean", normalized: true, maxTokens: 512, prefix: { query: "query: ", passage: "passage: " }, runtime: "@huggingface/transformers@4.3.0", license: "MIT (upstream intfloat/multilingual-e5-small); ONNX conversion by Xenova", preparedAt: new Date().toISOString(), files };
writeFileSync(join(root, "model-lock.json"), JSON.stringify(lock, null, "\t") + "\n");
writeFileSync("docs/evidence/knowledge-model-lock.json", JSON.stringify(lock, null, "\t") + "\n");
await extractor.dispose(); console.log(JSON.stringify({ model, revision, dimensions: 384, totalBytes: files.reduce((n, f) => n + f.bytes, 0), modelCalls: 1, paidCalls: 0 }));
