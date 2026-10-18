import type { PlanScope } from "./agentPlan";
export type ReportScope = PlanScope & { actorId: string };
export type ReportInput = { kind: "attachment"; attachmentId: string; sha256: string } | { kind: "web"; url: string };
export interface SourceSnapshot {
	schemaVersion: "source-snapshot.v1";
	kind: ReportInput["kind"]; name: string; requestedRef: string; sourceRef: string; sha256: string; textSha256: string;
	capturedAt: string; bytes: number; text: string; truncated: boolean;
}
export interface SourceReportArtifact {
	schemaVersion: "source-report.v1"; version: number; title: string; status: "unverified"; createdAt: string;
	sources: Array<Omit<SourceSnapshot, "text"> & { excerpt: string; snapshotRef: string; excerptTruncated: boolean }>;
	limitations: string[];
}
export interface ReportVersion {
	version: number; title: string; actorId: string; createdAt: string; inputs: ReportInput[];
	status: "queued" | "running" | "completed" | "failed" | "cancelled";
	generation: number; attempts: number; captured: Array<{ index: number; digest: string }>;
	reportDigest?: string; failure?: { code: string; retryable: boolean };
}
export interface SourceReportState { schemaVersion: 1; revision: number; versions: ReportVersion[] }
export interface SourceReportView {
	revision: number; allowedWebDomains: string[];
	versions: Array<ReportVersion & { available: boolean }>;
}
export const REPORT_LIMITS = { versions: 12, sources: 6, urls: 3, attempts: 3, bytes: 128 * 1024, textChars: 32_000, excerptChars: 2000, timeoutMs: 15_000 } as const;
export class SourceReportError extends Error {
	constructor(readonly code: string, readonly status = 409, readonly retryable = false) { super(code); this.name = "SourceReportError"; }
}
