import { closeSync, fsyncSync, openSync, constants, existsSync, lstatSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { PrivateFileAccess } from "./privateFileAccess";
import type { ModelSettingsInput, ModelSettingsView } from "../src/runtime/modelSettings";

type Saved = ModelSettingsInput & { schemaVersion: "model-settings.v1"; actor: string; at: string };
export class SettingsError extends Error {
	constructor(readonly code: string, readonly status = 400) { super(code); }
}

function validate(p: ModelSettingsInput) {
	if (!p || !Number.isSafeInteger(p.revision) || p.revision < 0 || !["fake", "anthropic"].includes(p.mode) || typeof p.baseUrl !== "string" || typeof p.model !== "string" || p.model.length > 200 || /[\x00-\x1f]/.test(p.model) || (p.apiKey !== undefined && (typeof p.apiKey !== "string" || p.apiKey.length > 8192 || /[\x00-\x20\x7f]/.test(p.apiKey))) || (p.clearKey !== undefined && typeof p.clearKey !== "boolean")) throw new SettingsError("invalid_model_settings");
	try {
		const url = new URL(p.baseUrl);
		if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || p.baseUrl.length > 2000) throw new Error();
	} catch { throw new SettingsError("invalid_provider_url"); }
	if (p.mode === "anthropic" && !p.model.trim()) throw new SettingsError("model_id_required");
}

/** Credentials live outside business backups; never return them to browser, model or logs. */
export class ModelSettings {
	private readonly initial: string;
	readonly path: string;
	constructor(path: string, private readonly environment: NodeJS.ProcessEnv, private readonly access = new PrivateFileAccess()) {
		this.path = resolve(realpathSync(dirname(path)), basename(path));
		this.initial = JSON.stringify(this.read());
	}
	private read(): Saved | undefined {
		if (!existsSync(this.path)) return undefined;
		const stat = lstatSync(this.path);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16_384) throw new SettingsError("settings_file_unsafe", 503);
		try { this.access.assert(this.path); } catch { throw new SettingsError("settings_file_unsafe", 503); }
		try {
			const value = JSON.parse(readFileSync(this.path, "utf8")) as Saved;
			if (value.schemaVersion !== "model-settings.v1") throw new Error();
			validate(value);
			return value;
		} catch { throw new SettingsError("settings_file_invalid", 503); }
	}
	apply(target: NodeJS.ProcessEnv) {
		const saved = this.read();
		if (!saved) return;
		target.BLACKX_RUNTIME_MODE = saved.mode;
		target.ANTHROPIC_BASE_URL = saved.baseUrl;
		target.ANTHROPIC_MODEL = saved.model;
		if (saved.clearKey) delete target.ANTHROPIC_API_KEY;
		else if (saved.apiKey) target.ANTHROPIC_API_KEY = saved.apiKey;
	}
	view(): ModelSettingsView {
		const saved = this.read();
		const effective = { ...this.environment }; this.apply(effective);
		// Reject credential-bearing legacy URLs before exposing any configuration.
		let baseUrl = effective.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
		try { validate({ revision: 0, mode: "fake", baseUrl, model: "" }); } catch { baseUrl = ""; }
		return { revision: saved?.revision ?? 0, mode: effective.BLACKX_RUNTIME_MODE === "anthropic" ? "anthropic" : "fake", baseUrl, model: effective.ANTHROPIC_MODEL ?? "", keyConfigured: Boolean(effective.ANTHROPIC_API_KEY), restartRequired: this.initial !== JSON.stringify(saved) };
	}
	save(payload: unknown, actor: string): ModelSettingsView {
		const p = payload as ModelSettingsInput;
		validate(p);
		const current = this.read();
		if (p.revision !== (current?.revision ?? 0)) throw new SettingsError("settings_revision_conflict", 409);
		if (p.clearKey && p.apiKey) throw new SettingsError("invalid_model_settings");
		const apiKey = p.clearKey ? undefined : p.apiKey || current?.apiKey;
		const clearKey = p.apiKey ? false : p.clearKey ?? current?.clearKey ?? false;
		if (p.mode === "anthropic" && !(apiKey || (!clearKey && this.environment.ANTHROPIC_API_KEY))) throw new SettingsError("provider_key_required");
		const saved: Saved = { schemaVersion: "model-settings.v1", revision: p.revision + 1, mode: p.mode, baseUrl: p.baseUrl.trim().replace(/\/$/, ""), model: p.model.trim(), apiKey, clearKey, actor, at: new Date().toISOString() };
		const temporary = `${this.path}.${randomUUID()}.tmp`;
		try {
			const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
			try { this.access.prepare(temporary); writeFileSync(fd, JSON.stringify(saved)); fsyncSync(fd); } finally { closeSync(fd); }
			renameSync(temporary, this.path);
		} finally { if (existsSync(temporary)) unlinkSync(temporary); }
		return this.view();
	}
}
