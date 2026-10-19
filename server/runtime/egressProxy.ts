import { lookup } from "node:dns/promises";
import { BlockList, connect as connectSocket, createServer, isIP, type Server, type Socket } from "node:net";

export interface EgressDecision {
	domain: string;
	port: number;
	allowed: boolean;
	reason: "allowed" | "method_not_allowed" | "ip_literal" | "port_not_allowed" | "domain_not_allowed" | "dns_failed" | "private_address" | "upstream_failed" | "malformed_request";
}

export interface EgressProxyOptions {
	allowedDomains: readonly string[];
	resolve?: (host: string) => Promise<readonly string[]>;
	connect?: (address: string, port: number) => Socket;
	onDecision?: (decision: EgressDecision) => void;
	listenPort?: number;
}

const maxRequestHeaderBytes = 8192;

const blockedIPv4 = new BlockList();
for (const [network, prefix] of [
	["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
	["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
	["192.0.2.0", 24], ["198.51.100.0", 24], ["203.0.113.0", 24],
] as const) blockedIPv4.addSubnet(network, prefix, "ipv4");

const blockedIPv6 = new BlockList();
const globalIPv6 = new BlockList();
globalIPv6.addSubnet("2000::", 3, "ipv6");
for (const [network, prefix] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["::ffff:0:0", 96], ["2001:db8::", 32], ["2002::", 16], ["2001::", 32]] as const) {
	blockedIPv6.addSubnet(network, prefix, "ipv6");
}

export function blockedAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 4) return blockedIPv4.check(address, "ipv4");
	if (family === 6) return !globalIPv6.check(address, "ipv6") || blockedIPv6.check(address, "ipv6");
	return true;
}

async function defaultResolve(host: string): Promise<readonly string[]> {
	return (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);
}

function reply(socket: Socket, status: string): void {
	socket.end(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
}

/**
 * Host-side HTTPS CONNECT proxy for sandboxed Tools. It forwards only allowlisted
 * domains on port 443, rejects private or loopback destinations after DNS resolution,
 * and connects to the resolved IP so a later DNS answer cannot change the target.
 * It parses only the CONNECT request line and never forwards plain HTTP.
 */
export class EgressProxy {
	private readonly server: Server;
	private readonly sockets = new Set<Socket>();
	private readonly allowedDomains: ReadonlySet<string>;
	private readonly resolve: (host: string) => Promise<readonly string[]>;
	private readonly connect: (address: string, port: number) => Socket;

	constructor(private readonly options: EgressProxyOptions) {
		this.allowedDomains = new Set(options.allowedDomains.map((domain) => domain.toLowerCase()));
		this.resolve = options.resolve ?? defaultResolve;
		this.connect = options.connect ?? ((address, port) => connectSocket({ host: address, port }));
		this.server = createServer((client) => this.accept(client));
	}

	async start(): Promise<number> {
		await new Promise<void>((resolveListen, rejectListen) => {
			this.server.once("error", rejectListen);
			this.server.listen(this.options.listenPort ?? 0, "127.0.0.1", () => resolveListen());
		});
		const address = this.server.address();
		if (!address || typeof address === "string") throw new Error("Egress proxy did not expose a TCP port");
		return address.port;
	}

	async stop(): Promise<void> {
		for (const socket of this.sockets) socket.destroy();
		await new Promise<void>((resolveClose) => this.server.close(() => resolveClose()));
	}

	private decide(domain: string, port: number, allowed: boolean, reason: EgressDecision["reason"]): void {
		this.options.onDecision?.({ domain, port, allowed, reason });
	}

	private accept(client: Socket): void {
		this.sockets.add(client);
		client.once("close", () => this.sockets.delete(client));
		client.on("error", () => client.destroy());
		client.pause();
		let header = Buffer.alloc(0);
		const onData = (chunk: Buffer) => {
			header = Buffer.concat([header, chunk]);
			const end = header.indexOf("\r\n\r\n");
			if (end < 0) {
				if (header.length > maxRequestHeaderBytes) {
					client.removeListener("data", onData);
					this.decide("", 0, false, "malformed_request");
					reply(client, "400 Bad Request");
				}
				return;
			}
			client.removeListener("data", onData);
			client.pause();
			const rest = header.subarray(end + 4);
			void this.handle(header.subarray(0, end).toString("latin1"), client, rest);
		};
		client.on("data", onData);
		client.resume();
	}

	private async handle(head: string, client: Socket, rest: Buffer): Promise<void> {
		const [requestLine = ""] = head.split("\r\n");
		const [method = "", target = ""] = requestLine.split(" ");
		if (method !== "CONNECT") {
			this.decide("", 0, false, "method_not_allowed");
			return reply(client, "405 Method Not Allowed");
		}
		const separator = target.lastIndexOf(":");
		const host = (separator > 0 ? target.slice(0, separator) : target).toLowerCase().replace(/\.$/, "");
		const port = separator > 0 ? Number(target.slice(separator + 1)) : 0;
		if (isIP(host) !== 0 || host.startsWith("[")) {
			this.decide(host, port, false, "ip_literal");
			return reply(client, "403 Forbidden");
		}
		if (port !== 443) {
			this.decide(host, port, false, "port_not_allowed");
			return reply(client, "403 Forbidden");
		}
		if (!this.allowedDomains.has(host)) {
			this.decide(host, port, false, "domain_not_allowed");
			return reply(client, "403 Forbidden");
		}
		let addresses: readonly string[];
		try {
			addresses = await this.resolve(host);
		} catch {
			this.decide(host, port, false, "dns_failed");
			return reply(client, "502 Bad Gateway");
		}
		if (addresses.length === 0 || addresses.some(blockedAddress)) {
			this.decide(host, port, false, "private_address");
			return reply(client, "403 Forbidden");
		}
		this.tunnel(host, port, addresses[0]!, client, rest);
	}

	private tunnel(host: string, port: number, address: string, client: Socket, rest: Buffer): void {
		const upstream = this.connect(address, port);
		this.sockets.add(upstream);
		upstream.once("close", () => this.sockets.delete(upstream));
		let established = false;
		upstream.on("error", () => {
			if (established) return client.destroy();
			this.decide(host, port, false, "upstream_failed");
			reply(client, "502 Bad Gateway");
		});
		upstream.once("connect", () => {
			established = true;
			this.decide(host, port, true, "allowed");
			client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (rest.length > 0) upstream.write(rest);
			upstream.pipe(client);
			client.pipe(upstream);
			client.resume();
		});
	}
}
