import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { env, pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { KnowledgeError } from "../../src/enterprise/knowledge";
import { validateVector, type EmbeddingPort } from "./embedding";

export const e5Model = "Xenova/multilingual-e5-small";
export const e5Revision = "761b726dd34fb83930e26aab4e9ac3899aa1fa78";
/** Host-only configuration. No downloads, credentials, endpoint selection or model switching at query time. */
export class OnnxEmbedding implements EmbeddingPort {
	readonly dimensions = 384;
	readonly kind = "local_model" as const;
	readonly signature = `onnx:${e5Model}@${e5Revision}:q8:384:mean:l2:512:prefix-e5:windows-480-v1:transformers-4.3.0`;
	private constructor(private readonly extractor: FeatureExtractionPipeline) {}
	static async create(cacheDir = resolve(".blackx-data/knowledge-model")) {
		const expected = JSON.parse(readFileSync(resolve("docs/evidence/knowledge-model-lock.json"), "utf8")) as { revision: string; files: { path: string; sha256: string }[] };
		if (expected.revision !== e5Revision) throw new KnowledgeError("embedding_model_lock_mismatch");
		for (const file of expected.files) {
			const path = resolve(cacheDir, file.path);
			if (!path.startsWith(resolve(cacheDir) + sep) || createHash("sha256").update(readFileSync(path)).digest("hex") !== file.sha256) throw new KnowledgeError("embedding_model_digest_mismatch");
		}
		env.allowRemoteModels = false; env.cacheDir = cacheDir;
		const extractor = await pipeline("feature-extraction", resolve(cacheDir, e5Model, e5Revision), { dtype: "q8", device: "cpu", local_files_only: true, session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 } });
		return new OnnxEmbedding(extractor);
	}
	async embed(texts: string[], signal?: AbortSignal, purpose: "query" | "passage" = "passage") {
		const started = performance.now(); let inputTokens = 0, forwardPasses = 0;
		const vectors: number[][] = [];
		for (const text of texts) {
			signal?.throwIfAborted();
			if (text.length > 20_000) throw new KnowledgeError("embedding_input_too_large");
			// Recurse at whitespace boundaries for long tables; never silently truncate source content.
			const pending = [text], windows: number[][] = [];
			while (pending.length) {
				signal?.throwIfAborted();
				const part = pending.shift()!;
				const input = `${purpose}: ${part}`;
				const tokens = this.extractor.tokenizer(input, { truncation: false, padding: false }).input_ids.size;
				if (tokens > 480) {
					let mid = Math.floor(part.length / 2);
					const space = part.lastIndexOf(" ", mid); if (space > mid / 2) mid = space;
					if (mid < 1) throw new KnowledgeError("embedding_input_unsplittable");
					pending.unshift(part.slice(0, mid), part.slice(mid)); continue;
				}
				const output = await this.extractor(input, { pooling: "mean", normalize: true });
				signal?.throwIfAborted();
				windows.push(validateVector(Array.from(output.data, Number), this.dimensions)); inputTokens += tokens; forwardPasses++;
			}
			vectors.push(validateVector(Array.from({ length: this.dimensions }, (_, i) => windows.reduce((sum, v) => sum + v[i], 0) / windows.length), this.dimensions));
		}
		return { vectors, usage: { inputTokens, modelDurationMs: performance.now() - started, forwardPasses } };
	}
	async close() { await this.extractor.dispose(); }
}
