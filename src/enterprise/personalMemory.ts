export interface MemoryScope { tenantId: string; workspaceId: string; actorId: string }
export interface MemoryDraft {
	topic: string;
	content: string;
	expiresAt?: string;
}
export interface MemoryVersion extends MemoryDraft {
	version: number;
	source: { runId: string; messageId?: string; digest: string; kind: "user_entry" | "user_message" };
	createdAt: string;
	confirmedAt?: string;
}
export interface PersonalMemory {
	id: string;
	revision: number;
	status: "proposed" | "active" | "change_pending" | "revoked";
	versions: MemoryVersion[];
	activeVersion?: number;
	pendingVersion?: number;
}
export interface MemoryView {
	items: Array<PersonalMemory & { available: boolean; unavailableReason?: "expired" | "source_unavailable" }>;
	limits: { active: number; items: number; contentChars: number };
}
export class MemoryError extends Error {
	constructor(readonly code: string, readonly status = 409) { super(code); }
}
