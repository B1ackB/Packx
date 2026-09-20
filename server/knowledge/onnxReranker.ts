import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { AutoModelForSequenceClassification, AutoTokenizer, env } from "@huggingface/transformers";
import { KnowledgeError } from "../../src/enterprise/knowledge";
import type { RerankPort } from "./reranking";

export const rerankerModel = "cross-encoder/mmarco-mMiniLMv2-L12-H384-v1";
export const rerankerRevision = "1427fd652930e4ba29e8149678df786c240d8825";
export class OnnxReranker implements RerankPort {
	readonly signature = `${rerankerModel}@${rerankerRevision}:qint8_arm64:pair-480:max-window:transformers-4.3.0`;
	private constructor(private readonly tokenizer: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>, private readonly model: Awaited<ReturnType<typeof AutoModelForSequenceClassification.from_pretrained>>) {}
	static async create() {
		const root = resolve(".blackx-data/knowledge-reranker", rerankerModel, rerankerRevision);
		const lock = JSON.parse(readFileSync("docs/evidence/knowledge-reranker-lock.json", "utf8")) as { model: string; revision: string; files: Array<{ path: string; sha256: string }> };
		if (lock.model !== rerankerModel || lock.revision !== rerankerRevision) throw new KnowledgeError("reranker_lock_mismatch", 503);
		for (const file of lock.files) {
			const path = resolve(root, file.path);
			if (!path.startsWith(root + sep) || createHash("sha256").update(readFileSync(path)).digest("hex") !== file.sha256) throw new KnowledgeError("reranker_digest_mismatch", 503);
		}
		env.allowRemoteModels = false;
		const tokenizer = await AutoTokenizer.from_pretrained(root, { local_files_only: true });
		const model = await AutoModelForSequenceClassification.from_pretrained(root, { local_files_only: true, model_file_name: "model_qint8_arm64", dtype: "fp32", device: "cpu", session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 } });
		return new OnnxReranker(tokenizer, model);
	}
	async score(query: string, passages: string[], signal?: AbortSignal) {
		if (query.length > 300 || passages.length > 20 || passages.some((p) => p.length > 20_000)) throw new KnowledgeError("reranker_input_limit");
		const started = performance.now(), scores: number[] = []; let inputTokens = 0, forwardPasses = 0;
		for (const passage of passages) {
			const pending = [passage], windows: number[] = [];
			while (pending.length) {
				signal?.throwIfAborted();
				const part = pending.shift()!;
				const input = this.tokenizer(query, { text_pair: part, truncation: false, padding: false });
				if (input.input_ids.size > 480) {
					let mid = Math.floor(part.length / 2); const space = part.lastIndexOf(" ", mid); if (space > mid / 2) mid = space;
					if (mid < 1) throw new KnowledgeError("reranker_unsplittable");
					pending.unshift(part.slice(0, mid), part.slice(mid)); continue;
				}
				const output = await this.model(input); signal?.throwIfAborted();
				if (output.logits.data.length !== 1) throw new KnowledgeError("reranker_output_shape", 503);
				windows.push(Number(output.logits.data[0])); inputTokens += input.input_ids.size; forwardPasses++;
			}
			scores.push(Math.max(...windows));
		}
		return { scores, inputTokens, forwardPasses, durationMs: performance.now() - started };
	}
	async close() { await this.model.dispose(); }
}
