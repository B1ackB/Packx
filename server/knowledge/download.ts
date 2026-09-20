import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { KnowledgeError } from "../../src/enterprise/knowledge";

export interface DownloadGrant { url: string; permissionReference: string; robotsCheckedAt: string; robotsAllowed: boolean; expiresAt: string }
const lastRequest = new Map<string, number>();
export function publicIPv4(address: string) {
	if (isIP(address) !== 4) return false; // IPv6 is conservatively disabled in this initial downloader.
	const [a, b] = address.split(".").map(Number);
	return ![0, 10, 127].includes(a) && a < 224 && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && (b === 168 || b === 0 || b === 2)) && !(a === 198 && [18, 19, 51].includes(b)) && !(a === 203 && b === 0) && !(a === 100 && b >= 64 && b <= 127);
}

/** No crawler: an exact URL needs a reviewed grant AND robots check. Redirects are rejected. */
export async function downloadSnapshot(urlValue: string, grants: readonly DownloadGrant[], signal?: AbortSignal): Promise<Buffer> {
	const url = new URL(urlValue), grant = grants.find((g) => g.url === url.href);
	if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443" || url.search || url.hash || isIP(url.hostname) ||
		!grant?.permissionReference || !grant.robotsAllowed || !Number.isFinite(Date.parse(grant.robotsCheckedAt)) || Date.parse(grant.expiresAt) <= Date.now() || !Number.isFinite(Date.parse(grant.expiresAt))) throw new KnowledgeError("download_not_authorized", 403);
	if (Date.now() - (lastRequest.get(url.hostname) ?? 0) < 1000) throw new KnowledgeError("download_rate_limited", 429);
	lastRequest.set(url.hostname, Date.now());
	const timeout = signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
	const addresses = await Promise.race([lookup(url.hostname, { all: true }), new Promise<never>((_, reject) => timeout.addEventListener("abort", () => reject(new KnowledgeError("download_timeout", 503)), { once: true }))]);
	timeout.throwIfAborted();
	if (!addresses.length || addresses.some((a) => !publicIPv4(a.address))) throw new KnowledgeError("download_address_denied", 403);
	return new Promise((resolve, reject) => {
		const req = request(url, { signal: timeout, headers: { "user-agent": "Packx-ManualImport/1.0", "accept-encoding": "identity" }, lookup: (_host, _options, callback) => callback(null, addresses[0].address, 4) }, (response) => {
			if (response.statusCode !== 200 || Number(response.headers["content-length"] ?? 0) > 10 * 1024 * 1024 || response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") { response.destroy(); reject(new KnowledgeError("download_response_rejected")); return; }
			let bytes = 0; const chunks: Buffer[] = [];
			response.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 10 * 1024 * 1024) { response.destroy(new KnowledgeError("download_too_large")); return; } chunks.push(chunk); });
			response.on("error", () => reject(new KnowledgeError("download_failed", 503)));
			response.on("end", () => resolve(Buffer.concat(chunks)));
		});
		req.on("error", () => reject(new KnowledgeError("download_failed", 503))); req.end();
	});
}
