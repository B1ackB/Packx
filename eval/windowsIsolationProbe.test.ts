import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assessRegistryReadCandidate, assessWindowsIsolationReport, selectWindowsToolchain } from "../scripts/windowsIsolationProbe";

describe("reviewed Windows toolchain selection", () => {
	const policy = JSON.parse(readFileSync(".github/windows-isolation-toolchain.json", "utf8"));
	const installed = (version: string) => ({ installationVersion: version, installationPath: "C:\\Program Files\\Microsoft Visual Studio\\18\\Enterprise", isComplete: true, isLaunchable: true, isPrerelease: false });
	it.each(["18.10.12224.181", "18.11.12306.390", "18.11.12315.225"])("accepts the exact reviewed build %s during the hosted image rollout", (version) => {
		expect(selectWindowsToolchain([installed(version)], policy.visualStudioVersions)).toEqual({ installation: installed(version).installationPath, version });
	});
	it("uses reviewed preference order, regardless of discovery order or a newer unreviewed build", () => {
		const available = [installed("99.1.10000.1"), installed("18.10.12224.181"), installed("18.11.12306.390")];
		expect(selectWindowsToolchain(available, ["18.11.12306.390", "18.10.12224.181"]).version).toBe("18.11.12306.390");
	});
	it("rejects an unknown build and reports the observed version instead of downloading or falling back", () => {
		expect(() => selectWindowsToolchain([installed("18.11.12306.391")], policy.visualStudioVersions)).toThrow(/installed C\+\+ toolchain versions: 18\.11\.12306\.391; refusing to skip/);
	});
	it.each([{ isComplete: false }, { isLaunchable: false }, { isPrerelease: true }, { installationPath: 'C:\\VS" & echo unexpected' }])("rejects an unusable or unsafe pinned installation: %j", (change) => {
		expect(() => selectWindowsToolchain([{ ...installed("18.10.12224.181"), ...change }], policy.visualStudioVersions)).toThrow();
	});
	it("rejects malformed discovery and non-exact version policies", () => {
		for (const report of [null, {}, [null], [{ installationVersion: "18.10.12224.181" }]]) expect(() => selectWindowsToolchain(report, policy.visualStudioVersions)).toThrow("Invalid Visual Studio installation report");
		for (const versions of [[], ["18.*"], ["[18,19)"]]) expect(() => selectWindowsToolchain([installed("18.10.12224.181")], versions)).toThrow("Expected exact reviewed Visual Studio versions");
	});
});

const unavailable = {
	schemaVersion: "windows-isolation-experiment.v2", experimentOnly: true, productionAdapterEnabled: false, mode: "diagnostic",
	capabilityPolicy: "zero-capabilities", capabilities: [],
	privateHandleNotInherited: true, singleProcessJobRestricted: true, legalHostSingleProcessDenied: true,
	legalHostJobTreeTerminated: true, lpacProcessTerminated: true, profileDeleted: true,
	unsandboxedNetworkControl: { initializationError: 0, socketError: 0, connectionError: 0, catalogAccessError: 0, observation: "connected" },
	regularNetworkInitializationError: 0, networkObservation: "initialization_failed", networkInitializationError: 10107,
	networkSocketError: -1, networkConnectionError: -1, catalogAccessError: 5, networkAccessDenied: false, childAssertions: 13,
};

describe("Windows isolation experimental boundary", () => {
	it("characterizes the observed dependency failure while preserving a blocked network gate", () => {
		expect(assessWindowsIsolationReport(unavailable)).toMatchObject({ experimentValidated: true, productionAdapterEnabled: false, networkGate: "blocked", passedChildAssertions: 13, requiredChildAssertions: 14 });
		expect(assessWindowsIsolationReport({ ...unavailable, mode: "strict" }).networkGate).toBe("blocked");
	});
	it("does not turn genuine network denial into production executor availability", () => {
		expect(assessWindowsIsolationReport({ ...unavailable, networkObservation: "access_denied", networkInitializationError: 0, networkSocketError: 0, networkConnectionError: 10013, networkAccessDenied: true, childAssertions: 14 }))
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

const registryScope = { assertions: 7, systemReadCategories: ["winsock-catalog-metadata"], credentialFixtureReadDenied: true, credentialFixtureWriteDenied: true, modelSettingsFixtureReadDenied: true, modelSettingsFixtureWriteDenied: true, capabilityGrantedUserFixtureReadable: true, capabilityGrantedUserFixtureWriteDenied: true, realUserSecretsAccessed: false };
const registryCandidate = { ...unavailable, schemaVersion: "windows-isolation-experiment.v3", registryScope, mode: "strict", capabilityPolicy: "registry-read-only", capabilities: ["registryRead"], childAssertions: 16, privateRegistryReadDenied: true, privateRegistryWriteDenied: true, privateRegistryDeleted: true, networkObservation: "access_denied", networkInitializationError: 0, networkSocketError: 0, networkConnectionError: 10013, networkAccessDenied: true };
it("keeps the registry-only feasibility policy separate from the zero-capability baseline", () => {
	expect(assessRegistryReadCandidate(registryCandidate)).toMatchObject({ networkGate: "verified", passedChildAssertions: 16, productionAdapterEnabled: false });
	expect(() => assessWindowsIsolationReport(registryCandidate)).toThrow();
});
it("distinguishes direct socket permission denial from connection denial without accepting other socket failures", () => {
	const socketDenied = { ...registryCandidate, networkObservation: "socket_access_denied", networkSocketError: 10013, networkConnectionError: -1 };
	expect(assessRegistryReadCandidate(socketDenied)).toMatchObject({ networkGate: "verified", denialStage: "socket" });
	for (const change of [{ networkSocketError: 10055 }, { networkConnectionError: 10013 }, { networkInitializationError: 10107 }, { networkObservation: "socket_failed" }, { networkSocketError: undefined }]) expect(() => assessRegistryReadCandidate({ ...socketDenied, ...change })).toThrow();
});
it.each([{ capabilities: ["registryRead", "internetClient"] }, { privateRegistryReadDenied: false }, { privateRegistryWriteDenied: false }, { privateRegistryDeleted: false }, { networkInitializationError: 10107 }, { networkObservation: "connected", networkConnectionError: 0 }, { childAssertions: 15 }])("rejects a candidate with unproven permissions or network denial: %j", (change) => {
	expect(() => assessRegistryReadCandidate({ ...registryCandidate, ...change })).toThrow();
});

it.each([{ registryScope: undefined }, { registryScope: { ...registryScope, credentialFixtureReadDenied: false } }, { registryScope: { ...registryScope, modelSettingsFixtureReadDenied: false } }, { registryScope: { ...registryScope, realUserSecretsAccessed: true } }, { registryScope: { ...registryScope, capabilityGrantedUserFixtureReadable: false } }, { registryScope: { ...registryScope, assertions: 6 } }])("rejects missing or misleading registry scope evidence: %j", (change) => { expect(() => assessRegistryReadCandidate({ ...registryCandidate, ...change })).toThrow(); });
