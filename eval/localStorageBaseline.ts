import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileEnterpriseEventStore } from "../server/enterprise/fileEventStore";
import { ProposalRunEngine } from "../src/enterprise/proposalRunEngine";

// Measures the single-file Event Store cost model: every committed write rewrites the whole document.
const sizes = [100, 500, 1000, 2000];
const samples = 20;

function percentile(values: number[], p: number): number {
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

function round(value: number): number {
	return Math.round(value * 100) / 100;
}

const results = [];
for (const size of sizes) {
	const directory = mkdtempSync(join(tmpdir(), "packx-storage-baseline-"));
	try {
		const path = join(directory, "events.json");
		const engine = new ProposalRunEngine(new FileEnterpriseEventStore(path));
		const scopeFor = (runId: string) => ({ tenantId: "baseline-tenant", workspaceId: "baseline-workspace", runId });
		const commandFor = (runId: string) => ({ ...scopeFor(runId), commandId: `create-${runId}`, correlationId: "baseline", actorId: "baseline-user", expectedVersion: 0 });
		for (let index = 0; index < size; index += 1) engine.create(commandFor(`run-${index}`));

		const appendMs: number[] = [];
		for (let index = size; index < size + samples; index += 1) {
			const started = performance.now();
			engine.create(commandFor(`run-${index}`));
			appendMs.push(performance.now() - started);
		}

		const loadMs: number[] = [];
		for (let attempt = 0; attempt < samples; attempt += 1) {
			const started = performance.now();
			new ProposalRunEngine(new FileEnterpriseEventStore(path)).load(scopeFor("run-0"));
			loadMs.push(performance.now() - started);
		}

		results.push({
			events: size + samples,
			fileBytes: statSync(path).size,
			appendMedianMs: round(percentile(appendMs, 50)),
			appendP95Ms: round(percentile(appendMs, 95)),
			loadMedianMs: round(percentile(loadMs, 50)),
		});
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

console.log(JSON.stringify({ measuredAt: new Date().toISOString(), node: process.version, platform: process.platform, samples, results }, null, 2));
