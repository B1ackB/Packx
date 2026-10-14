import { request as httpRequest } from "node:http";
import { connect, createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { EgressProxy, type EgressDecision } from "./egressProxy";

const started: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const stop of started.splice(0).reverse()) await stop();
});

async function echoServer(): Promise<{ server: Server; port: number }> {
	const server = createServer();
	server.on("connection", (socket) => socket.pipe(socket));
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
	started.push(() => new Promise<void>((resolveClose) => server.close(() => resolveClose())));
	return { server, port: (server.address() as { port: number }).port };
}

async function proxyFor(options: ConstructorParameters<typeof EgressProxy>[0]): Promise<{ proxy: EgressProxy; port: number }> {
	const proxy = new EgressProxy(options);
	const port = await proxy.start();
	started.push(() => proxy.stop());
	return { proxy, port };
}

function openConnect(port: number, target: string): Promise<{ head: string; socket: Socket }> {
	return new Promise((resolveOpen, rejectOpen) => {
		const socket = connect(port, "127.0.0.1", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
		let data = "";
		socket.on("data", (chunk) => {
			data += chunk.toString("latin1");
			if (data.includes("\r\n\r\n")) resolveOpen({ head: data, socket });
		});
		socket.on("close", () => resolveOpen({ head: data, socket }));
		socket.on("error", rejectOpen);
		started.push(async () => { socket.destroy(); });
	});
}

describe("egress proxy", () => {
	it("refuses domains outside the allowlist without resolving them", async () => {
		const decisions: EgressDecision[] = [];
		let resolved = 0;
		const { port } = await proxyFor({
			allowedDomains: ["api.allowed.test"],
			resolve: async () => { resolved += 1; return ["93.184.216.34"]; },
			connect: () => { throw new Error("must not connect"); },
			onDecision: (decision) => decisions.push(decision),
		});

		const { head } = await openConnect(port, "other.test:443");

		expect(head).toMatch(/^HTTP\/1\.1 403 Forbidden/);
		expect(resolved).toBe(0);
		expect(decisions).toEqual([expect.objectContaining({ domain: "other.test", allowed: false, reason: "domain_not_allowed" })]);
	});

	it("refuses IP literals, ports other than 443 and non-CONNECT methods", async () => {
		const decisions: EgressDecision[] = [];
		const { port } = await proxyFor({
			allowedDomains: ["api.allowed.test"],
			connect: () => { throw new Error("must not connect"); },
			onDecision: (decision) => decisions.push(decision),
		});

		expect((await openConnect(port, "1.1.1.1:443")).head).toMatch(/^HTTP\/1\.1 403/);
		expect((await openConnect(port, "api.allowed.test:80")).head).toMatch(/^HTTP\/1\.1 403/);
		const plain = await new Promise<number | undefined>((resolveStatus, rejectStatus) => {
			const req = httpRequest({ host: "127.0.0.1", port, method: "GET", path: "http://api.allowed.test/" }, (response) => {
				response.resume();
				resolveStatus(response.statusCode);
			});
			req.on("error", rejectStatus);
			req.end();
		});
		expect(plain).toBe(405);
		expect(decisions.map((decision) => decision.reason)).toEqual(expect.arrayContaining(["ip_literal", "port_not_allowed", "method_not_allowed"]));
	});

	it("refuses permitted domains that resolve to any private or loopback address", async () => {
		for (const addresses of [["10.0.0.5"], ["192.168.1.9"], ["169.254.169.254"], ["127.0.0.1"], ["::1"], ["93.184.216.34", "127.0.0.1"]]) {
			const { port } = await proxyFor({
				allowedDomains: ["api.allowed.test"],
				resolve: async () => addresses,
				connect: () => { throw new Error("must not connect"); },
			});

			expect((await openConnect(port, "api.allowed.test:443")).head, addresses.join(",")).toMatch(/^HTTP\/1\.1 403/);
		}
	});

	it("does not start when its listening port is already occupied", async () => {
		const occupant = createServer();
		await new Promise<void>((resolveListen) => occupant.listen(0, "127.0.0.1", resolveListen));
		started.push(() => new Promise<void>((resolveClose) => occupant.close(() => resolveClose())));
		const port = (occupant.address() as { port: number }).port;
		const proxy = new EgressProxy({ allowedDomains: ["api.allowed.test"], listenPort: port });

		await expect(proxy.start()).rejects.toMatchObject({ code: "EADDRINUSE" });
	});

	it("reports DNS failures as bad gateway without connecting", async () => {
		const decisions: EgressDecision[] = [];
		const { port } = await proxyFor({
			allowedDomains: ["api.allowed.test"],
			resolve: async () => { throw new Error("no such host"); },
			connect: () => { throw new Error("must not connect"); },
			onDecision: (decision) => decisions.push(decision),
		});

		expect((await openConnect(port, "api.allowed.test:443")).head).toMatch(/^HTTP\/1\.1 502 Bad Gateway/);
		expect(decisions).toEqual([expect.objectContaining({ reason: "dns_failed" })]);
	});

	it("tunnels a permitted domain only to the resolved address it validated", async () => {
		const echo = await echoServer();
		const dialed: string[] = [];
		const decisions: EgressDecision[] = [];
		const { port } = await proxyFor({
			allowedDomains: ["api.allowed.test"],
			resolve: async () => ["93.184.216.34"],
			connect: (address) => {
				dialed.push(address);
				return connect(echo.port, "127.0.0.1");
			},
			onDecision: (decision) => decisions.push(decision),
		});

		const { head, socket } = await openConnect(port, "api.allowed.test:443");
		expect(head).toMatch(/^HTTP\/1\.1 200 Connection Established/);
		const echoed = await new Promise<string>((resolveEcho) => {
			let data = "";
			socket.on("data", (chunk) => { data += chunk.toString("latin1"); if (data.includes("ping")) resolveEcho(data); });
			socket.write("ping");
		});

		expect(echoed).toContain("ping");
		expect(dialed).toEqual(["93.184.216.34"]);
		expect(decisions).toEqual([expect.objectContaining({ domain: "api.allowed.test", port: 443, allowed: true, reason: "allowed" })]);
	});
});
