export function safeRuntimeDiagnostic(error: unknown, environment: NodeJS.ProcessEnv = process.env): string {
	const messages: string[] = [];
	let current: unknown = error;
	for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
		messages.push(`${current.name}: ${current.message}`);
		current = current.cause;
	}
	const secrets = [
		environment.OPENAI_API_KEY,
		environment.ANTHROPIC_API_KEY,
		environment.BLACKX_COMMAND_API_TOKEN,
		environment.BLACKX_WORKER_API_TOKEN,
		environment.BLACKX_OPERATOR_API_TOKEN,
	]
		.filter((value): value is string => Boolean(value))
		.sort((left, right) => right.length - left.length);
	let diagnostic = messages.join(" <- ");
	for (const secret of secrets) diagnostic = diagnostic.replaceAll(secret, "[REDACTED]");
	return diagnostic
		.replace(/(?:sk-ant-|sk-)[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
		.replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
		.slice(0, 2_000);
}
