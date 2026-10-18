import { createHash } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ArtifactContentStore } from "../../src/enterprise/artifactStore";
import type { StageJobLease, StageJobQueue } from "../../src/enterprise/stageJobQueue";
import { REPORT_LIMITS, SourceReportError, type ReportInput, type ReportScope, type ReportVersion, type SourceSnapshot, type SourceReportArtifact, type SourceReportState, type SourceReportView } from "../../src/enterprise/sourceReport";
import type { StageJobHandlerResult } from "../workers/stageJobScheduler";
import { reconcileIndependently } from "../workers/stageJobScheduler";
import type { FileConversationAttachmentStore } from "../runtime/conversationAttachments";
import { RestrictedWebSource } from "../runtime/restrictedWebSource";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value, (_key, v) => v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(key => [key, v[key]])) : v)).digest("hex");
const textHash = (value: string) => createHash("sha256").update(value).digest("hex");
const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const active = (v: ReportVersion) => v.status === "queued" || v.status === "running";
const hashValid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function validState(state: SourceReportState, actor: string): boolean {
	return state.schemaVersion === 1 && Number.isSafeInteger(state.revision) && state.revision >= 0 && Array.isArray(state.versions) && state.versions.length <= REPORT_LIMITS.versions && state.versions.filter(active).length <= 1 && state.versions.every((v, index) =>
		v.version === index + 1 && v.actorId === actor && typeof v.title === "string" && !!v.title.trim() && v.title.length <= 120 && Number.isFinite(Date.parse(v.createdAt)) &&
		["queued", "running", "completed", "failed", "cancelled"].includes(v.status) && Number.isSafeInteger(v.attempts) && v.attempts >= 1 && v.attempts <= REPORT_LIMITS.attempts && v.generation === v.attempts &&
		Array.isArray(v.inputs) && v.inputs.length > 0 && v.inputs.length <= REPORT_LIMITS.sources && v.inputs.filter(i => i.kind === "web").length <= REPORT_LIMITS.urls && new Set(v.inputs.map(digest)).size === v.inputs.length &&
		v.inputs.every(i => i.kind === "attachment" ? validId(i.attachmentId) && hashValid(i.sha256) : i.kind === "web" && typeof i.url === "string" && i.url.startsWith("https://") && i.url.length <= 2048) &&
		Array.isArray(v.captured) && v.captured.length <= v.inputs.length && v.captured.every((c, i) => c.index === i && hashValid(c.digest)) &&
		(v.status !== "completed" || v.captured.length === v.inputs.length && hashValid(v.reportDigest)) &&
		(v.status !== "failed" || !!v.failure) && (!v.failure || typeof v.failure.code === "string" && v.failure.code.length <= 128 && typeof v.failure.retryable === "boolean"));
}
interface Options { assertAvailable(scope: ReportScope): void; cancelJob(jobId: string, scope: ReportScope): void; now?: () => string }

/** Local bounded reports use the existing queue and immutable Artifact store. No model or new bus. */
export class SourceReportWorkflow {
	private readonly db: DatabaseSync;
	constructor(path: string, private readonly queue: StageJobQueue, private readonly artifacts: ArtifactContentStore, private readonly attachments: FileConversationAttachmentStore, readonly web: RestrictedWebSource, private readonly options: Options) {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.db = new DatabaseSync(path);
		this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
			CREATE TABLE IF NOT EXISTS source_report_events (tenant TEXT, workspace TEXT, run TEXT, actor TEXT, revision INTEGER, command TEXT, digest TEXT, type TEXT, at TEXT, state TEXT,
			PRIMARY KEY(tenant,workspace,run,actor,revision), UNIQUE(tenant,workspace,run,actor,command));`);
		if (path !== ":memory:") chmodSync(path, 0o600);
	}
	close() { this.db.close(); }
	private now() { return this.options.now?.() ?? new Date().toISOString(); }
	private params(scope: ReportScope) { return [scope.tenantId, scope.workspaceId, scope.runId, scope.actorId]; }
	private state(scope: ReportScope): SourceReportState {
		const row = this.db.prepare("SELECT state FROM source_report_events WHERE tenant=? AND workspace=? AND run=? AND actor=? ORDER BY revision DESC LIMIT 1").get(...this.params(scope));
		if (!row) return { schemaVersion: 1, revision: 0, versions: [] };
		try { const state = JSON.parse(String(row.state)) as SourceReportState;
			if (!validState(state, scope.actorId)) throw new Error();
			return state;
		} catch { throw new SourceReportError("report_store_corrupt", 503); }
	}
	private change(scope: ReportScope, command: string, payload: unknown, type: string, expected: number, update: (state: SourceReportState) => void) {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const state = this.state(scope), key = digest(payload);
			const prior = this.db.prepare("SELECT digest FROM source_report_events WHERE tenant=? AND workspace=? AND run=? AND actor=? AND command=?").get(...this.params(scope), command);
			if (prior) { if (prior.digest !== key) throw new SourceReportError("report_command_conflict"); }
			else {
				if (state.revision !== expected) throw new SourceReportError("report_revision_conflict");
				update(state); state.revision++;
				if (!validState(state, scope.actorId)) throw new SourceReportError("report_store_corrupt", 503);
				this.db.prepare("INSERT INTO source_report_events VALUES (?,?,?,?,?,?,?,?,?,?)").run(...this.params(scope), state.revision, command, key, type, this.now(), JSON.stringify(state));
			}
			this.db.exec("COMMIT"); return state;
		} catch (error) { this.db.exec("ROLLBACK"); throw error; }
	}
	private key(scope: ReportScope, version: number, index?: number) {
		return { ...scope, artifactId: index === undefined ? "source-report" : `source-report-${version}-source-${index}`, artifactVersion: index === undefined ? version : 1 };
	}
	private jobId(scope: ReportScope, v: ReportVersion) { return `report-${digest([this.params(scope), v.version, v.generation]).slice(0, 40)}`; }
	private checkSources(scope: ReportScope, inputs: ReportInput[]) {
		this.options.assertAvailable(scope);
		for (const input of inputs) {
			if (input.kind === "web") this.web.validate(input.url);
			else {
				const { attachment } = this.attachments.read({ ...scope, conversationId: scope.runId }, input.attachmentId);
				if (attachment.sha256 !== input.sha256 || attachment.kind !== "text") throw new SourceReportError("report_source_changed", 409);
				if (attachment.size > REPORT_LIMITS.bytes) throw new SourceReportError("source_too_large", 422);
			}
		}
	}
	view(scope: ReportScope): SourceReportView {
		this.options.assertAvailable(scope);
		const state = this.state(scope);
		return { revision: state.revision, allowedWebDomains: [...this.web.allowedDomains], versions: state.versions.map(v => {
			let available = true; try { this.checkSources(scope, v.inputs); if (v.status === "completed") this.report(scope, v.version); } catch { available = false; }
			return { ...v, available };
		}) };
	}
	command(scope: ReportScope, body: unknown): SourceReportView {
		this.options.assertAvailable(scope);
		const p = body as Record<string, unknown> | null;
		if (!p || !validId(p.requestId) || !Number.isSafeInteger(p.revision) || !["start", "cancel", "retry"].includes(String(p.action))) throw new SourceReportError("report_invalid_command", 400);
		const state = this.change(scope, `user:${p.requestId}`, p, `report.${p.action}`, Number(p.revision), state => {
			if (p.action === "start") {
				if (state.versions.some(active)) throw new SourceReportError("report_running");
				if (state.versions.length >= REPORT_LIMITS.versions) throw new SourceReportError("report_version_limit");
				if (typeof p.title !== "string" || !p.title.trim() || p.title.length > 120 || !Array.isArray(p.inputs) || !p.inputs.length || p.inputs.length > REPORT_LIMITS.sources) throw new SourceReportError("report_invalid_command", 422);
				const inputs: ReportInput[] = p.inputs.map((input: unknown) => {
					const i = input as Record<string, unknown> | null;
					if (i?.kind === "attachment" && Object.keys(i).length === 3 && validId(i.attachmentId) && typeof i.sha256 === "string" && /^[a-f0-9]{64}$/.test(i.sha256)) return { kind: "attachment", attachmentId: i.attachmentId, sha256: i.sha256 };
					if (i?.kind === "web" && Object.keys(i).length === 2 && typeof i.url === "string") return { kind: "web", url: this.web.validate(i.url) };
					throw new SourceReportError("report_invalid_command", 422);
				});
				if (inputs.filter(i => i.kind === "web").length > REPORT_LIMITS.urls || new Set(inputs.map(digest)).size !== inputs.length) throw new SourceReportError("report_invalid_command", 422);
				this.checkSources(scope, inputs);
				state.versions.push({ version: state.versions.length + 1, title: p.title.trim(), actorId: scope.actorId, createdAt: this.now(), inputs, status: "queued", generation: 1, attempts: 1, captured: [] });
			} else {
				const v = state.versions.find(v => v.version === p.version);
				if (!v) throw new SourceReportError("report_not_found", 404);
				if (p.action === "cancel") {
					if (!active(v)) throw new SourceReportError("report_terminal");
					v.status = "cancelled";
				} else {
					if (v.status !== "failed" || !v.failure?.retryable || v.attempts >= REPORT_LIMITS.attempts || state.versions.some(active)) throw new SourceReportError("report_not_retryable");
					this.checkSources(scope, v.inputs); v.generation++; v.attempts++; v.status = "queued"; delete v.failure;
				}
			}
		});
		for (const v of state.versions) if (v.status === "cancelled") this.options.cancelJob(this.jobId(scope, v), scope);
		this.dispatch(scope); return this.view(scope);
	}
	private dispatch(scope: ReportScope) {
		for (const v of this.state(scope).versions.filter(active)) {
			try { this.options.assertAvailable(scope); } catch (error) {
				if (!(error instanceof SourceReportError) || error.code !== "report_scope_unavailable") throw error;
				const s = this.state(scope); this.change(scope, `deleted:${v.version}`, v.version, "report.cancelled", s.revision, s => { s.versions[v.version - 1].status = "cancelled"; });
				this.options.cancelJob(this.jobId(scope, v), scope); continue;
			}
			const jobId = this.jobId(scope, v), job = this.queue.get(jobId);
			if (job && ["dead_letter", "cancelled", "completed"].includes(job.status)) {
				const s = this.state(scope); this.change(scope, `job-terminal:${jobId}`, jobId, "report.failed", s.revision, s => { s.versions[v.version - 1].status = "failed"; s.versions[v.version - 1].failure = { code: "report_job_failed", retryable: true }; });
			} else if (!job) this.queue.enqueue({ ...scope, jobId, stageId: "source-report", commandId: jobId, correlationId: jobId, expectedVersion: v.version, sessionId: jobId, maxFailures: 1, maxSlices: REPORT_LIMITS.sources + 2, payload: { actorId: scope.actorId, version: v.version, generation: v.generation } });
		}
	}
	reconcile() {
		const scopes = this.db.prepare("SELECT DISTINCT tenant, workspace, run, actor FROM source_report_events").all().map(row => ({ tenantId: String(row.tenant), workspaceId: String(row.workspace), runId: String(row.run), actorId: String(row.actor) }));
		reconcileIndependently(Object.fromEntries(scopes.map(scope => [digest(this.params(scope)), () => this.dispatch(scope)])));
	}
	private snapshot(scope: ReportScope, v: ReportVersion, index: number): SourceSnapshot | undefined {
		const receipt = v.captured.find(c => c.index === index);
		if (!receipt) return undefined;
		const value = this.artifacts.readJson(this.key(scope, v.version, index)) as SourceSnapshot;
		if (digest(value) !== receipt.digest) throw new SourceReportError("report_artifact_corrupt", 503);
		return value;
	}
	async execute(lease: StageJobLease, signal: AbortSignal, guard: () => void): Promise<StageJobHandlerResult> {
		const scope = { tenantId: lease.tenantId, workspaceId: lease.workspaceId, runId: lease.runId, actorId: String(lease.payload?.actorId ?? "") };
		const version = Number(lease.payload?.version), generation = Number(lease.payload?.generation);
		let v = this.state(scope).versions[version - 1];
		if (!v || v.generation !== generation || !active(v)) return { status: "completed" };
		const check = () => {
			guard(); signal.throwIfAborted();
			v = this.state(scope).versions[version - 1];
			if (!v || !active(v) || v.generation !== generation) throw new SourceReportError("report_superseded");
			this.checkSources(scope, v.inputs);
		};
		try {
			check();
			const index = v.inputs.findIndex((_, index) => !v.captured.some(c => c.index === index));
			if (index >= 0) {
				const input = v.inputs[index]; let snapshot: SourceSnapshot;
				// A snapshot written just before a crash is recovered from its immutable key.
				try { snapshot = this.artifacts.readJson(this.key(scope, version, index)) as SourceSnapshot; }
				catch (error) {
					if (!(error instanceof Error) || !("code" in error) || error.code !== "artifact_not_found") throw error;
					const source = input.kind === "web" ? await this.web.read(input.url, signal) : (() => {
						const { attachment, content } = this.attachments.read({ ...scope, conversationId: scope.runId }, input.attachmentId);
						return { text: new TextDecoder("utf-8", { fatal: true }).decode(content), sha256: attachment.sha256, bytes: content.length, name: attachment.name, url: attachment.sourceRef };
					})();
					const text = source.text.slice(0, REPORT_LIMITS.textChars);
					if (!text.trim()) throw new SourceReportError("source_empty", 422);
					snapshot = { schemaVersion: "source-snapshot.v1", kind: input.kind, name: "name" in source && typeof source.name === "string" ? source.name : new URL(source.url).hostname, requestedRef: input.kind === "web" ? input.url : source.url, sourceRef: source.url, bytes: source.bytes, sha256: source.sha256, textSha256: textHash(text), text, truncated: text.length !== source.text.length, capturedAt: this.now() };
					check(); this.artifacts.putJson(this.key(scope, version, index), snapshot);
				}
				check();
				if (snapshot.schemaVersion !== "source-snapshot.v1" || snapshot.kind !== input.kind || typeof snapshot.text !== "string" || snapshot.text.length > REPORT_LIMITS.textChars || snapshot.textSha256 !== textHash(snapshot.text) || input.kind === "attachment" && snapshot.sha256 !== input.sha256 || input.kind === "web" && (snapshot.requestedRef !== input.url || this.web.validate(snapshot.sourceRef) !== snapshot.sourceRef)) throw new SourceReportError("report_artifact_corrupt", 503);
				const s = this.state(scope); this.change(scope, `capture:${version}:${index}`, digest(snapshot), "report.source_captured", s.revision, s => { const p = s.versions[version - 1]; p.status = "running"; p.captured.push({ index, digest: digest(snapshot) }); });
				return { status: "paused", sessionId: lease.sessionId };
			}
			const report: SourceReportArtifact = { schemaVersion: "source-report.v1", version, title: v.title, status: "unverified", createdAt: v.createdAt,
				sources: v.inputs.map((_, index) => { const { text, ...source } = this.snapshot(scope, v, index)!; return { ...source, excerpt: text.slice(0, REPORT_LIMITS.excerptChars), excerptTruncated: source.truncated || text.length > REPORT_LIMITS.excerptChars, snapshotRef: `artifact://source-report-${version}-source-${index}/v1` }; }),
				limitations: ["Deterministic source excerpts, not model analysis or verified business facts.", "Web snapshots may change after capture; HTML is text-only, without JavaScript, tables or layout guarantees.", "Reports preserve source differences without adjudicating them. Review original sources before decisions."],
			};
			check(); this.artifacts.putJson(this.key(scope, version), report); check();
			const s = this.state(scope); this.change(scope, `complete:${version}`, digest(report), "report.completed", s.revision, s => { const p = s.versions[version - 1]; p.status = "completed"; p.reportDigest = digest(report); });
			return { status: "completed" };
		} catch (error) {
			if (signal.aborted) throw error;
			guard(); const s = this.state(scope), current = s.versions[version - 1];
			if (current && active(current) && current.generation === generation) this.change(scope, `failure:${version}:${generation}`, generation, "report.failed", s.revision, s => {
				const p = s.versions[version - 1]; p.status = "failed";
				const code = error instanceof SourceReportError ? error.code : "report_source_unavailable";
				p.failure = { code, retryable: error instanceof SourceReportError ? error.retryable : error instanceof Error && "code" in error && ["artifact_store_unavailable", "attachment_store_unavailable", "SQLITE_BUSY"].includes(String(error.code)) };
			});
			return { status: "completed" };
		}
	}
	report(scope: ReportScope, version: number): SourceReportArtifact {
		this.options.assertAvailable(scope); const v = this.state(scope).versions[version - 1];
		if (!v || v.status !== "completed") throw new SourceReportError("report_not_found", 404);
		this.checkSources(scope, v.inputs);
		const report = this.artifacts.readJson(this.key(scope, version)) as SourceReportArtifact;
		if (digest(report) !== v.reportDigest) throw new SourceReportError("report_artifact_corrupt", 503);
		for (const source of report.sources) if (source.kind === "web") this.web.validate(source.sourceRef);
		return report;
	}
	source(scope: ReportScope, version: number, index: number): SourceSnapshot {
		this.report(scope, version); // Revalidate ownership, source availability and report digest.
		if (!Number.isInteger(index) || index < 0) throw new SourceReportError("report_not_found", 404);
		const value = this.snapshot(scope, this.state(scope).versions[version - 1], index);
		if (!value) throw new SourceReportError("report_not_found", 404);
		return value;
	}
}
