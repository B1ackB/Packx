import { constants, closeSync, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { syncDirectory } from "../syncDirectory";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { LocalDirectoryListing, LocalFileEntry } from "../../src/runtime/conversationFiles";

export class TaskFileError extends Error {
	constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}
export const maxTaskFileBytes = 128 * 1024;
export const fileHash = (value: string) => createHash("sha256").update(value).digest("hex");
const inside = (root: string, path: string) => path === root || (!relative(root, path).startsWith(`..${sep}`) && relative(root, path) !== ".." && !isAbsolute(relative(root, path)));
export function validLocalPath(path: unknown): path is string {
	return typeof path === "string" && isAbsolute(path) && path.length <= 4096 && !/[\x00-\x1f\x7f\\]/.test(path) && !path.split(sep).includes("..");
}
function deny(message: string): never { throw new TaskFileError("file_path_denied", message, 403); }

/** Host-only filesystem access. Reads use Host policy; every mutation requires a matching operation approval. */
export class LocalFileAccess {
	private readonly protectedPaths: string[];
	constructor(protectedPaths: readonly string[], private readonly workspaceRoot = process.cwd()) {
		this.protectedPaths = protectedPaths.map((path) => {
			const suffix: string[] = []; let parent = resolve(path);
			while (!existsSync(parent)) { suffix.unshift(basename(parent)); parent = dirname(parent); }
			return join(realpathSync(parent), ...suffix);
		});
	}
	private protected(path: string): void {
		if (["/", "/System", "/Library", "/dev", "/etc", "/private/etc", "/proc", "/sys"].some((root) => path === root || (root !== "/" && inside(root, path)))) deny("系统目录不能通过文件工具访问");
		if (path.split(sep).some((part) => part.startsWith(".")) || /\.(pem|key|p12|pfx|keychain|keychain-db)$/i.test(path)) deny("隐藏目录、凭据和密钥文件不可通过文件工具访问");
		if (this.protectedPaths.some((root) => inside(resolve(root), path))) deny("Packx 内部数据、审批和已批准交付目录不可通过本地文件工具访问");
	}
	locations() {
		return { homeDirectory: realpathSync(homedir()), workingDirectory: realpathSync(this.workspaceRoot), ...Object.fromEntries(["Documents", "Desktop"].filter((name) => existsSync(join(homedir(), name))).map((name) => [`${name.toLowerCase()}Directory`, realpathSync(join(homedir(), name))])) };
	}
	check(path: string, directory = false): string {
		if (!validLocalPath(path) || path !== resolve(path)) deny("请使用规范的绝对路径，不接受路径跳转");
		this.protected(path);
		const parent = directory ? path : dirname(path);
		let cursor: string = sep;
		try {
			for (const part of parent.split(sep).filter(Boolean)) {
				cursor = join(cursor, part);
				const stat = lstatSync(cursor);
				if (!stat.isDirectory() || stat.isSymbolicLink()) deny("不能通过符号链接访问其他目录");
			}
			if (realpathSync(parent) !== parent) deny("目录实际路径已变化");
			const stat = lstatSync(parent);
			return `${parent}:${stat.dev}:${stat.ino}`;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new TaskFileError("file_not_found", "目标目录不存在，请选择现有目录", 404);
			throw error;
		}
	}
	read(path: string): { absolutePath: string; content: string; sha256: string; size: number; mode: number; identity: string } {
		this.check(path);
		const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const stat = fstatSync(fd);
			if (!stat.isFile() || stat.nlink !== 1) deny("只能操作普通文件，不支持目录、链接或设备");
			if (stat.size > maxTaskFileBytes) throw new TaskFileError("file_too_large", "文本文件最多 128 KiB", 413);
			const bytes = Buffer.alloc(maxTaskFileBytes + 1);
			// Read via the opened descriptor, never follow a newly substituted final symlink.
			let size = 0;
			while (size < bytes.length) { const count = readSync(fd, bytes, size, bytes.length - size, null); if (!count) break; size += count; }
			const data = bytes.subarray(0, size);
			if (data.length >= bytes.length || data.includes(0)) throw new TaskFileError("file_input_invalid", "仅支持不超过 128 KiB 的 UTF-8 文本文件", 400);
			let content: string;
			try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data); } catch { throw new TaskFileError("file_input_invalid", "文件不是 UTF-8 文本，不能直接编辑", 400); }
			return { absolutePath: path, content, sha256: fileHash(content), size: data.length, mode: stat.mode & 0o777, identity: `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}` };
		} finally { closeSync(fd); }
	}
	readDocument(path: string): { absolutePath: string; content: Buffer; sha256: string } {
		this.check(path);
		const limit = 10 * 1024 * 1024;
		const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const stat = fstatSync(fd);
			if (!stat.isFile() || stat.nlink !== 1) deny("只能读取普通文件");
			if (!stat.size || stat.size > limit) throw new TaskFileError("file_too_large", "文档须为 1 字节至 10 MiB", 413);
			const bytes = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
			let size = 0;
			while (size < bytes.length) { const count = readSync(fd, bytes, size, bytes.length - size, null); if (!count) break; size += count; }
			if (size !== stat.size) throw new TaskFileError("file_version_conflict", "读取期间文件已变化", 409);
			const content = bytes.subarray(0, size);
			return { absolutePath: path, content, sha256: createHash("sha256").update(content).digest("hex") };
		} finally { closeSync(fd); }
	}
	inspect(path: string) {
		this.check(path);
		try { return this.read(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
	}
	list(path: string, after?: string): LocalDirectoryListing {
		this.check(path, true);
		if (after !== undefined && (typeof after !== "string" || !after || after.length > 255 || /[/\\\x00-\x1f\x7f]/.test(after))) throw new TaskFileError("file_input_invalid", "文件列表位置无效，请刷新", 400);
		const names = readdirSync(path).sort();
		const entries = names.flatMap((name): LocalFileEntry[] => {
			const absolutePath = join(path, name);
			try {
				this.protected(absolutePath);
				const stat = lstatSync(absolutePath);
				if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) return [];
				return [{ name, absolutePath, kind: stat.isDirectory() ? "directory" : "file", size: stat.size }];
			} catch { return []; }
		});
		const previous = after === undefined ? -1 : entries.findIndex((entry) => entry.name === after);
		if (after !== undefined && previous < 0) throw new TaskFileError("file_version_conflict", "目录内容已变化，请刷新文件列表", 409);
		const page = entries.slice(previous + 1, previous + 201);
		const truncated = previous + 1 + page.length < entries.length;
		return { directory: path, entries: page, total: entries.length, truncated, ...(truncated ? { nextAfter: page.at(-1)!.name } : {}) };
	}
	apply(path: string, content: string | undefined, expectedSha256: string | null, expectedIdentity: string | undefined, parentIdentity: string): void {
		const verify = () => {
			if (this.check(path) !== parentIdentity) throw new TaskFileError("file_version_conflict", "目标目录已变化，请重新审批");
			const current = this.inspect(path);
			if ((current?.sha256 ?? null) !== expectedSha256 || current?.identity !== expectedIdentity) throw new TaskFileError("file_version_conflict", "磁盘文件在审批期间发生变化，请重新读取并审批");
			return current;
		};
		const current = verify();
		if (content === undefined) {
			if (!current) throw new TaskFileError("file_not_found", "要删除的文件不存在", 404);
			verify(); unlinkSync(path);
		} else {
			const temporary = join(dirname(path), `.blackx-${randomUUID()}.tmp`);
			const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, current?.mode ?? 0o600);
			try { writeFileSync(fd, content, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
			try {
				verify();
				if (current) renameSync(temporary, path);
				else { linkSync(temporary, path); unlinkSync(temporary); } // Atomic no-clobber creation.
			} finally { if (existsSync(temporary)) unlinkSync(temporary); }
		}
		syncDirectory(dirname(path));
	}
}
