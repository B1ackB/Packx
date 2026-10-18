import type { AggregateScope } from "./contracts";

export interface ArtifactContentKey extends AggregateScope {
	artifactId: string;
	artifactVersion: number;
}

export interface ArtifactContentStore {
	putJson(key: ArtifactContentKey, content: unknown): string;
	readJson(key: ArtifactContentKey): unknown;
	list(scope: AggregateScope): ArtifactContentKey[];
}

export class ArtifactStoreError extends Error {
	constructor(
		readonly code: "artifact_conflict" | "artifact_not_found" | "artifact_store_unavailable",
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "ArtifactStoreError";
	}
}
