export interface TaskFileVersion {
	artifactId: string;
	path: string;
	absolutePath?: string;
	storagePath?: string;
	version: number;
	sha256: string;
	size: number;
	status: "draft" | "deleted";
	createdAt: string;
	actorId: string;
	executionId: string;
	approvalId: string;
	restoredFromVersion?: number;
}

export interface FileApprovalView {
	id: string;
	operation: "write" | "delete";
	path: string;
	expectedVersion?: number | null;
	expectedSha256?: string | null;
	content?: string;
	sourceVersion?: number;
	before?: string;
	status: "pending" | "approved" | "rejected" | "cancelled" | "executing" | "applied";
	createdAt: string;
	expiresAt: string;
}

export interface ConversationFilesView {
	files: TaskFileVersion[];
	approvals: FileApprovalView[];
}

export interface LocalFileEntry {
	name: string;
	absolutePath: string;
	kind: "directory" | "file";
	size: number;
}

export interface LocalDirectoryListing { directory: string; entries: LocalFileEntry[]; truncated: boolean }
export interface LocalFileLocations { locations: Record<string, string>; files: TaskFileVersion[] }
