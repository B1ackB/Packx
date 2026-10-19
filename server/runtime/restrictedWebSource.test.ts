import { expect, it } from "vitest";
import { RestrictedWebSource, webSourceUrl } from "./restrictedWebSource";
import { blockedAddress } from "./egressProxy";
const domains = ["docs.example.test"];
it.each(["http://docs.example.test/", "https://docs.example.test:444/", "https://user:pass@docs.example.test/", "https://docs.example.test/?token=x", "https://127.0.0.1/", "https://[::1]/", "https://other.test/", "file:///etc/passwd", "https://docs.example.test.evil.test/"])("denies URL before DNS: %s", (url) => {
	expect(() => webSourceUrl(url, domains)).toThrow("web_url_denied");
});
it.each(["127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.0.1", "192.0.2.1", "::1", "::2", "::ffff:127.0.0.1", "2001:db8::1", "2002:7f00:1::", "fc00::1", "garbage"])("blocks special/private addresses %s", (address) => expect(blockedAddress(address)).toBe(true));
it("pins a validated public address and reads bounded text without executing HTML", async () => {
	const requests: string[] = [];
	const reader = new RestrictedWebSource({ allowedDomains: domains, resolve: async () => ["93.184.216.34"], transport: async (url, address) => {
		requests.push(`${url.href}|${address}`);
		return { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: Buffer.from("<script>secret()</script><style>hide</style><p>A &amp; B</p>") };
	} });
	const source = await reader.read("https://docs.example.test/page#part", new AbortController().signal);
	expect(requests).toEqual(["https://docs.example.test/page|93.184.216.34"]); expect(source.text).toBe("A & B"); expect(source.sha256).toMatch(/^[a-f0-9]{64}$/);
});
it("rejects a mixed DNS answer and redirect to a non-permitted destination", async () => {
	let calls = 0;
	const mixed = new RestrictedWebSource({ allowedDomains: domains, resolve: async () => ["93.184.216.34", "127.0.0.1"], transport: async () => { calls++; throw new Error(); } });
	await expect(mixed.read("https://docs.example.test/", new AbortController().signal)).rejects.toThrow("web_private_address"); expect(calls).toBe(0);
	const redirect = new RestrictedWebSource({ allowedDomains: domains, resolve: async () => ["93.184.216.34"], transport: async () => { calls++; return { status: 302, headers: { location: "https://169.254.169.254/" }, body: Buffer.alloc(0) }; } });
	await expect(redirect.read("https://docs.example.test/", new AbortController().signal)).rejects.toThrow("web_url_denied"); expect(calls).toBe(1);
});
it.each([
	{ headers: { "content-type": "application/pdf" }, body: Buffer.from("PDF"), code: "web_content_unsupported" },
	{ headers: { "content-type": "text/plain; charset=latin1" }, body: Buffer.from("plain"), code: "web_content_unsupported" },
	{ headers: { "content-type": "text/plain", "content-encoding": "gzip" }, body: Buffer.from("plain"), code: "web_content_unsupported" },
	{ headers: { "content-type": "text/plain" }, body: Buffer.alloc(128 * 1024 + 1), code: "source_too_large" },
	{ headers: { "content-type": "text/plain" }, body: Buffer.from([0xff]), code: "web_content_unsupported" },
])("fails closed on unsupported or excessive responses: $code", async ({ headers, body, code }) => {
	const reader = new RestrictedWebSource({ allowedDomains: domains, resolve: async () => ["93.184.216.34"], transport: async () => ({ status: 200, headers, body }) });
	await expect(reader.read("https://docs.example.test/", new AbortController().signal)).rejects.toThrow(code);
});
it("cancels a stalled resolution without connecting", async () => {
	const controller = new AbortController(); let called = false;
	const reader = new RestrictedWebSource({ allowedDomains: domains, resolve: () => new Promise(() => {}), transport: async () => { called = true; throw new Error(); } });
	const pending = reader.read("https://docs.example.test/", controller.signal); controller.abort(new Error("cancelled"));
	await expect(pending).rejects.toThrow("cancelled"); expect(called).toBe(false);
});
it("limits redirect chains", async () => {
	let calls = 0;
	const reader = new RestrictedWebSource({ allowedDomains: domains, resolve: async () => ["93.184.216.34"], transport: async () => { calls++; return { status: 302, headers: { location: "/again" }, body: Buffer.alloc(0) }; } });
	await expect(reader.read("https://docs.example.test/", new AbortController().signal)).rejects.toThrow("web_redirect_limit"); expect(calls).toBe(4);
});
