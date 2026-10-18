import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { REPORT_LIMITS, SourceReportError } from "../../src/enterprise/sourceReport";
import { blockedAddress } from "./egressProxy";

type WebResponse = { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer };
export interface RestrictedWebOptions {
	allowedDomains: readonly string[];
	resolve?: (host: string) => Promise<readonly string[]>;
	transport?: (url: URL, address: string, signal: AbortSignal) => Promise<WebResponse>;
}
export function webSourceUrl(value: string, allowedDomains: readonly string[]): URL {
	let url: URL; try { url = new URL(value); } catch { throw new SourceReportError("web_url_denied", 422); }
	if (value.length > 2048 || url.protocol !== "https:" || url.username || url.password || url.port || url.search || isIP(url.hostname) || !allowedDomains.includes(url.hostname) || !/^[a-z0-9.-]+$/.test(url.hostname)) throw new SourceReportError("web_url_denied", 422);
	url.hash = ""; return url;
}
function transport(url: URL, address: string, signal: AbortSignal): Promise<WebResponse> {
	return new Promise((resolve, reject) => {
		const req = request(url, { agent: false, family: isIP(address), signal,
			lookup: (_host, _options, callback) => callback(null, address, isIP(address)),
			headers: { accept: "text/plain, text/html", "accept-encoding": "identity", "user-agent": "PackxSourceReader/1" },
		}, (response) => {
			const chunks: Buffer[] = []; let bytes = 0;
			response.on("error", reject);
			response.on("data", (chunk: Buffer) => {
				bytes += chunk.length;
				if (bytes > REPORT_LIMITS.bytes) { const error = new SourceReportError("source_too_large", 422); response.destroy(error); req.destroy(error); }
				else chunks.push(chunk);
			});
			response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
		});
		req.on("error", reject); req.end();
	});
}
export class RestrictedWebSource {
	readonly allowedDomains: string[];
	constructor(private readonly options: RestrictedWebOptions) {
		this.allowedDomains = [...new Set(options.allowedDomains.map((domain) => domain.trim().toLowerCase()).filter(Boolean))];
		for (const domain of this.allowedDomains) webSourceUrl(`https://${domain}/`, this.allowedDomains);
	}
	validate(value: string) { return webSourceUrl(value, this.allowedDomains).href; }
	async read(value: string, signal: AbortSignal) {
		const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(REPORT_LIMITS.timeoutMs)]);
		let url = webSourceUrl(value, this.allowedDomains);
		try {
			for (let redirect = 0; redirect <= 3; redirect++) {
				boundedSignal.throwIfAborted();
				const resolution = (this.options.resolve ?? (async host => (await lookup(host, { all: true, verbatim: true })).map(a => a.address)))(url.hostname);
				boundedSignal.throwIfAborted();
				const addresses = await new Promise<readonly string[]>((resolve, reject) => {
					const abort = () => reject(boundedSignal.reason);
					boundedSignal.addEventListener("abort", abort, { once: true });
					resolution.then(resolve, reject).finally(() => boundedSignal.removeEventListener("abort", abort));
				});
				boundedSignal.throwIfAborted();
				if (!addresses.length || addresses.some(blockedAddress)) throw new SourceReportError("web_private_address", 422);
				const result = await (this.options.transport ?? transport)(url, addresses[0], boundedSignal);
				boundedSignal.throwIfAborted();
				if ([301, 302, 303, 307, 308].includes(result.status)) {
					if (redirect === 3 || typeof result.headers.location !== "string") throw new SourceReportError("web_redirect_limit", 422);
					url = webSourceUrl(new URL(result.headers.location, url).href, this.allowedDomains); continue;
				}
				if (result.status !== 200) throw new SourceReportError("web_http_error", 422, result.status === 429 || result.status >= 500);
				const type = String(result.headers["content-type"] ?? "").toLowerCase();
				if (!/^(text\/plain|text\/html)(;|$)/.test(type) || /charset\s*=\s*["']?(?!utf-8\b|us-ascii\b)[a-z0-9-]+/.test(type) || result.headers["content-encoding"] && result.headers["content-encoding"] !== "identity") throw new SourceReportError("web_content_unsupported", 422);
				if (!result.body.length || result.body.length > REPORT_LIMITS.bytes) throw new SourceReportError("source_too_large", 422);
				let text: string; try { text = new TextDecoder("utf-8", { fatal: true }).decode(result.body); } catch { throw new SourceReportError("web_content_unsupported", 422); }
				if (type.startsWith("text/html")) text = text.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ").replace(/<[^>]*>/g, " ").replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, name: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " })[name] ?? " ").replace(/\s+/g, " ").trim();
				if (!text.trim()) throw new SourceReportError("source_empty", 422);
				return { url: url.href, text, bytes: result.body.length, sha256: createHash("sha256").update(result.body).digest("hex") };
			}
			throw new SourceReportError("web_redirect_limit", 422);
		} catch (error) {
			if (signal.aborted) throw signal.reason;
			if (error instanceof SourceReportError) throw error;
			throw new SourceReportError(boundedSignal.aborted ? "web_timeout" : "web_unavailable", 503, true);
		}
	}
}
