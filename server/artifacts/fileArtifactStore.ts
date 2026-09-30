import { FileWriteLockError, withFileWriteLock } from "../fileWriteLock";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
	ArtifactContentKey,
	ArtifactContentStore,
} from "../../src/enterprise/artifactStore";
import { ArtifactStoreError } from "../../src/enterprise/artifactStore";

function validatedSegment(value: string, name: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
		throw new ArtifactStoreError("artifact_store_unavailable", `${name} is invalid`);
	}
	return value;
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") {
		const serialized = JSON.stringify(value);
		if (serialized === undefined) {
			throw new ArtifactStoreError("artifact_store_unavailable", "Artifact content is not JSON serializable");
		}
		return serialized;
	}
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")}}`;
}

export class FileArtifactContentStore implements ArtifactContentStore {
	constructor(private readonly rootDirectory: string) {}

	putJson(key: ArtifactContentKey, content: unknown): string {
		const path = this.pathFor(key);
		const serialized = canonicalJson(content);
		this.withLock(path, () => {
			if (existsSync(path)) {
				if (readFileSync(path, "utf8") !== serialized) {
					throw new ArtifactStoreError(
						"artifact_conflict",
						"Artifact version already exists with different content",
					);
				}
				return;
			}
			const directory = dirname(path);
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
			try {
				writeFileSync(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
				renameSync(temporaryPath, path);
				chmodSync(path, 0o600);
			} finally {
				if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
			}
		});
		return `artifact://${key.artifactId}/v${key.artifactVersion}`;
	}

	readJson(key: ArtifactContentKey): unknown {
		const path = this.pathFor(key);
		if (!existsSync(path)) {
			throw new ArtifactStoreError("artifact_not_found", "Artifact content does not exist");
		}
		try {
			return JSON.parse(readFileSync(path, "utf8"));
		} catch (error) {
			throw new ArtifactStoreError(
				"artifact_store_unavailable",
				"Artifact content cannot be read",
				{ cause: error },
			);
		}
	}

	private pathFor(key: ArtifactContentKey): string {
		if (!Number.isInteger(key.artifactVersion) || key.artifactVersion < 1) {
			throw new ArtifactStoreError("artifact_store_unavailable", "artifactVersion is invalid");
		}
		return join(
			this.rootDirectory,
			validatedSegment(key.tenantId, "tenantId"),
			validatedSegment(key.workspaceId, "workspaceId"),
			validatedSegment(key.runId, "runId"),
			validatedSegment(key.artifactId, "artifactId"),
			`v${key.artifactVersion}.json`,
		);
	}

	private withLock<T>(path: string, operation: () => T): T {
		try { return withFileWriteLock(path, operation); }
		catch (error) {
			if (error instanceof FileWriteLockError) throw new ArtifactStoreError("artifact_store_unavailable", "Artifact version is locked or unavailable", { cause: error });
			throw error;
		}
	}
}
