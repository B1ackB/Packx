export interface TaskCheckpointDraft {
	objective: string;
	constraints: string[];
	openQuestions: string[];
	progressNotes: string;
}

export interface TaskCheckpointVersion extends TaskCheckpointDraft {
	version: number;
	status: "proposed" | "active" | "superseded" | "rejected";
	throughMessageId: string;
	userMessageCount: number;
	sourceDigest: string;
	createdAt: string;
	actorId: string;
	confirmation?: { actorId: string; at: string };
}

export interface TaskCheckpointState {
	revision: number;
	versions: TaskCheckpointVersion[];
}

export interface TaskCheckpointView extends TaskCheckpointState {
	userMessageCount: number;
	uncoveredUserMessages: number;
	uncoveredChars: number;
	sourceDigest: string;
	needsReview: boolean;
}

export class TaskCheckpointError extends Error {
	constructor(readonly code: string, readonly status = 409) { super(code); }
}

export function checkpointDraft(value: unknown): TaskCheckpointDraft {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new TaskCheckpointError("invalid_task_checkpoint", 400);
	const p = value as Record<string, unknown>;
	const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max && !/[\x00-\x08\x0b-\x1f\x7f]/.test(v);
	const list = (v: unknown, max: number): v is string[] => Array.isArray(v) && v.length <= max && v.every((item) => text(item, 400) && item.trim());
	if (Object.keys(p).some((key) => !["objective", "constraints", "openQuestions", "progressNotes"].includes(key)) || !text(p.objective, 1000) || !p.objective.trim() || !list(p.constraints, 20) || !list(p.openQuestions, 10) || !text(p.progressNotes, 1500) || JSON.stringify(p).length > 12_000) throw new TaskCheckpointError("invalid_task_checkpoint", 400);
	return { objective: p.objective.trim(), constraints: p.constraints.map((item) => item.trim()), openQuestions: p.openQuestions.map((item) => item.trim()), progressNotes: p.progressNotes.trim() };
}
