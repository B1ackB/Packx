/** Host identity retained in the same transaction as a local business mutation. */
export interface MutationBinding {
	tenantId: string;
	workspaceId: string;
	runId: string;
	stageId: string;
	actorId: string;
	executionId: string;
	toolCallId: string;
	tool: string;
	idempotencyKey: string;
	approvalId: string;
	inputDigest: string;
}
export interface MutationReceipt extends MutationBinding { result: string }
export interface RecordedMutation<Value> {
	binding: MutationBinding;
	result(value: Value): unknown;
}
const fields = ["tenantId", "workspaceId", "runId", "stageId", "actorId", "executionId", "toolCallId", "tool", "idempotencyKey", "approvalId", "inputDigest"] as const;

export function validMutationReceipt(value: unknown): value is MutationReceipt {
	if (!value || typeof value !== "object") return false;
	const receipt = value as MutationReceipt;
	if (!fields.every(key => typeof receipt[key] === "string" && receipt[key].length > 0 && receipt[key].length <= 1024) || !/^sha256:[a-f0-9]{64}$/.test(receipt.inputDigest) || typeof receipt.result !== "string" || receipt.result.length > 16_000) return false;
	try { JSON.parse(receipt.result); return true; } catch { return false; }
}

export function findMutationReceipt(receipts: readonly MutationReceipt[] | undefined, binding: MutationBinding): MutationReceipt | undefined {
	const receipt = receipts?.find(value => value.tool === binding.tool && value.idempotencyKey === binding.idempotencyKey);
	if (receipt && (!validMutationReceipt(receipt) || !fields.every(key => receipt[key] === binding[key]))) throw new Error("mutation_receipt_identity_conflict");
	return receipt;
}

export function validMutationReceipts(owner: { tenantId?: string; workspaceId?: string; runId?: string; mutationReceipts?: MutationReceipt[] }): boolean {
	const receipts = owner.mutationReceipts;
	return receipts === undefined || Array.isArray(receipts) && receipts.length <= 256 && receipts.every(receipt => validMutationReceipt(receipt) && receipt.tenantId === owner.tenantId && receipt.workspaceId === owner.workspaceId && receipt.runId === owner.runId) && new Set(receipts.map(receipt => JSON.stringify([receipt.tool, receipt.idempotencyKey]))).size === receipts.length;
}

export function recordMutation<Value extends { mutationReceipts?: MutationReceipt[] }>(value: Value, mutation?: RecordedMutation<Value>): void {
	if (!mutation || findMutationReceipt(value.mutationReceipts, mutation.binding)) return;
	// Receipt retention is bounded; exceeding it rejects the transaction before any write.
	if ((value.mutationReceipts?.length ?? 0) >= 256) throw new Error("mutation_receipt_limit");
	const receipt = { ...mutation.binding, result: JSON.stringify(mutation.result(structuredClone(value))) };
	if (!validMutationReceipt(receipt) || ["tenantId", "workspaceId", "runId"].some(key => (value as Record<string, unknown>)[key] !== receipt[key as keyof MutationBinding])) throw new Error("invalid_mutation_receipt");
	value.mutationReceipts = [...(value.mutationReceipts ?? []), receipt];
}
