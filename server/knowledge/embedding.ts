import { createHash } from "node:crypto";
import { KnowledgeError } from "../../src/enterprise/knowledge";

export interface EmbeddingBatch { vectors: number[][]; usage: { inputTokens: number | null; modelDurationMs: number | null; forwardPasses?: number } }

export interface EmbeddingPort {
	readonly signature: string;
	readonly dimensions: number;
	readonly kind: "lexical_baseline" | "local_model" | "fake";
	embed(texts: string[], signal?: AbortSignal, purpose?: "query" | "passage"): Promise<EmbeddingBatch>;
}

export function terms(text: string): string[] {
	const normalized = text.normalize("NFKC").toLowerCase();
	const words: string[] = normalized.match(/[a-z0-9]+(?:[._/-][a-z0-9]+)*/g) ?? [];
	for (const run of normalized.match(/[\u3400-\u9fff]+/g) ?? []) {
		if (run.length === 1) words.push(run);
		for (let index = 0; index < run.length - 1; index++) words.push(run.slice(index, index + 2));
	}
	return [...new Set(words.flatMap((word) => word.includes("/") ? [word, ...word.split("/")] : [word]))];
}

/** Reproducible sparse-feature cosine baseline; NOT a learned semantic embedding. */
export class LexicalEmbedding implements EmbeddingPort {
	readonly dimensions = 256;
	readonly kind = "lexical_baseline" as const;
	readonly signature: string;
	constructor(private readonly aliases: ReadonlyArray<readonly string[]> = []) {
		this.signature = `lexical-hash-v1:256:${createHash("sha256").update(JSON.stringify(aliases)).digest("hex")}`;
	}
	async embed(texts: string[], signal?: AbortSignal) {
		const vectors = texts.map((text) => {
			signal?.throwIfAborted();
			const values = new Array<number>(this.dimensions).fill(0);
			let normalized = text.normalize("NFKC").toLowerCase();
			for (const group of this.aliases) {
				if (group.some((term) => /[^\x00-\x7f]/.test(term) ? normalized.includes(term) : terms(normalized).includes(term))) normalized += ` ${group[0]}`;
			}
			for (const term of terms(normalized)) { const hash = createHash("sha256").update(term).digest(); values[hash.readUInt16BE(0) % this.dimensions] += hash[2] % 2 ? 1 : -1; }
			const norm = Math.hypot(...values) || 1;
			return values.map((v) => v / norm);
		});
		return { vectors, usage: { inputTokens: 0, modelDurationMs: 0 } };
	}
}

export class FakeEmbedding implements EmbeddingPort {
	readonly dimensions = 4;
	readonly kind = "fake" as const;
	readonly signature = "fake-embedding-contract-only-v1:4";
	async embed(texts: string[]) { return { vectors: texts.map(() => [1, 0, 0, 0]), usage: { inputTokens: 0, modelDurationMs: 0 } }; }
}

/** Operator-configured local Ollama only. Never downloads a model or contacts a paid endpoint. */
export class LocalEmbedding implements EmbeddingPort {
	readonly kind = "local_model" as const;
	readonly signature: string;
	constructor(private readonly config: { url: string; model: string; digest: string; dimensions: number; license: string }) {
		const url = new URL(config.url);
		if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
			!/^sha256:[a-f0-9]{64}$/.test(config.digest) || !config.model || !config.license || !Number.isInteger(config.dimensions) || config.dimensions < 1 || config.dimensions > 2048) throw new KnowledgeError("invalid_local_embedding_config");
		this.signature = `ollama:${config.model}:${config.digest}:${config.dimensions}:truncate-false:v1`;
	}
	get dimensions() { return this.config.dimensions; }
	async embed(texts: string[], signal?: AbortSignal) {
		const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
		const read = async (path: string, init?: RequestInit) => {
			const response = await fetch(new URL(path, this.config.url), { ...init, redirect: "error", signal: bounded });
			if (!response.ok) throw new KnowledgeError("local_embedding_unavailable", 503);
			let bytes = 0; const chunks: Uint8Array[] = [];
			for await (const chunk of response.body!) { bytes += chunk.length; if (bytes > 4_000_000) throw new KnowledgeError("embedding_response_too_large"); chunks.push(chunk); }
			return JSON.parse(Buffer.concat(chunks).toString("utf8"));
		};
		const catalog = await read("/api/tags");
		if (!catalog.models?.some((model: { name: string; digest: string }) => model.name === this.config.model && `sha256:${model.digest.replace(/^sha256:/, "")}` === this.config.digest)) throw new KnowledgeError("embedding_model_digest_mismatch", 409);
		const result = await read("/api/embed", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: this.config.model, input: texts, truncate: false, options: { num_ctx: 8192 } }) });
		if (result.model !== this.config.model || !Array.isArray(result.embeddings) || result.embeddings.length !== texts.length) throw new KnowledgeError("embedding_response_invalid");
		const after = await read("/api/tags");
		if (!after.models?.some((model: { name: string; digest: string }) => model.name === this.config.model && `sha256:${model.digest.replace(/^sha256:/, "")}` === this.config.digest)) throw new KnowledgeError("embedding_model_changed_during_call", 409);
		return { vectors: result.embeddings.map((vector: number[]) => validateVector(vector, this.dimensions)), usage: { inputTokens: Number.isSafeInteger(result.prompt_eval_count) ? result.prompt_eval_count as number : null, modelDurationMs: Number.isFinite(result.total_duration) ? Number(result.total_duration) / 1_000_000 : null } };
	}
}

export function validateVector(vector: number[], dimensions: number): number[] {
	if (!Array.isArray(vector) || vector.length !== dimensions || !vector.every(Number.isFinite)) throw new KnowledgeError("embedding_space_mismatch");
	const norm = Math.hypot(...vector);
	if (!norm || !Number.isFinite(norm)) throw new KnowledgeError("embedding_zero_vector");
	return vector.map((v) => v / norm);
}
