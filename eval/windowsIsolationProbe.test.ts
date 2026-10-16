import { describe, expect, it } from "vitest";
import { assessWindowsIsolationReport } from "../scripts/windowsIsolationProbe";

const unavailable = {
	schemaVersion: "windows-isolation-experiment.v1", experimentOnly: true, productionAdapterEnabled: false, mode: "diagnostic",
	privateHandleNotInherited: true, singleProcessJobRestricted: true, legalHostSingleProcessDenied: true,
	legalHostJobTreeTerminated: true, lpacProcessTerminated: true, profileDeleted: true,
	unsandboxedNetworkControl: { initializationError: 0, connectionError: 0, catalogAccessError: 0, observation: "connected" },
	regularNetworkInitializationError: 0, networkObservation: "initialization_failed", networkInitializationError: 10107,
	networkConnectionError: -1, catalogAccessError: 5, networkAccessDenied: false, childAssertions: 13,
};

describe("Windows isolation experimental boundary", () => {
	it("characterizes the observed dependency failure while preserving a blocked network gate", () => {
		expect(assessWindowsIsolationReport(unavailable)).toMatchObject({ experimentValidated: true, productionAdapterEnabled: false, networkGate: "blocked", passedChildAssertions: 13, requiredChildAssertions: 14 });
		expect(assessWindowsIsolationReport({ ...unavailable, mode: "strict" }).networkGate).toBe("blocked");
	});
	it("does not turn genuine network denial into production executor availability", () => {
		expect(assessWindowsIsolationReport({ ...unavailable, networkObservation: "access_denied", networkInitializationError: 0, networkConnectionError: 10013, networkAccessDenied: true, childAssertions: 14 }))
			.toMatchObject({ networkGate: "verified", productionAdapterEnabled: false });
	});
	it.each([
		{ productionAdapterEnabled: true }, { experimentOnly: false }, { schemaVersion: "tool-execution-result.v1" },
		{ mode: ["diagnostic"] },
		{ networkAccessDenied: true }, { childAssertions: 14 }, { catalogAccessError: 0 },
		{ networkObservation: "connected", networkInitializationError: 0, networkConnectionError: 0 },
		{ networkObservation: "connection_failed", networkInitializationError: 0, networkConnectionError: 10060 },
		{ unsandboxedNetworkControl: { initializationError: 10107 } }, { profileDeleted: false },
		{ lpacProcessTerminated: false }, { legalHostJobTreeTerminated: false }, { singleProcessJobRestricted: false },
	])("rejects incomplete or misleading evidence: %j", (change) => {
		expect(() => assessWindowsIsolationReport({ ...unavailable, ...change })).toThrow("Invalid Windows isolation experiment");
	});
});
