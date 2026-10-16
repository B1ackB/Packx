// Fixed synthetic worker. Keep broker-only profile/ACL/COM imports outside the LPAC process.
#define NOMINMAX
#include <winsock2.h>
#include <windows.h>
#include <sddl.h>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace fs = std::filesystem;
static void check(bool ok, const char* stage) {
	if (!ok) throw std::runtime_error(std::string(stage) + ":" + std::to_string(GetLastError()));
}
struct Handle {
	HANDLE value = nullptr;
	explicit Handle(HANDLE h = nullptr) : value(h) {}
	~Handle() { close(); }
	Handle(const Handle&) = delete;
	Handle& operator=(const Handle&) = delete;
	void close() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); value = nullptr; }
};
static std::wstring quote(const std::wstring& value) {
	std::wstring result = L"\"";
	size_t slashes = 0;
	for (wchar_t c : value) {
		if (c == L'\\') { ++slashes; continue; }
		result.append(c == L'\"' ? slashes * 2 + 1 : slashes, L'\\');
		result += c; slashes = 0;
	}
	result.append(slashes * 2, L'\\');
	return result + L'\"';
}
static bool canOpen(const fs::path& path, DWORD rights) {
	Handle h(CreateFileW(path.c_str(), rights, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
	return h.value != INVALID_HANDLE_VALUE;
}
static unsigned long long fileId(const BY_HANDLE_FILE_INFORMATION& info) {
	return (static_cast<unsigned long long>(info.nFileIndexHigh) << 32) | info.nFileIndexLow;
}
static void writeReport(const fs::path& stage, const std::string& value) {
	const fs::path pending = stage / L"output" / L"report.tmp";
	{ std::ofstream report(pending); report << value; check(report.good(), "write_probe_report"); }
	fs::rename(pending, stage / L"output" / L"report.txt");
}
enum class NetworkOutcome { InitializationFailed, SocketFailed, SocketAccessDenied, Connected, AccessDenied, ConnectionFailed };
struct NetworkProbe {
	int startup = -1;
	int error = -1;
	int socketError = -1;
	LSTATUS catalogAccess = ERROR_INVALID_FUNCTION;
	NetworkOutcome outcome = NetworkOutcome::InitializationFailed;
};
static const char* outcomeName(NetworkOutcome outcome) {
	switch (outcome) {
		case NetworkOutcome::InitializationFailed: return "initialization_failed";
		case NetworkOutcome::SocketFailed: return "socket_failed";
		case NetworkOutcome::SocketAccessDenied: return "socket_access_denied";
		case NetworkOutcome::Connected: return "connected";
		case NetworkOutcome::AccessDenied: return "access_denied";
		case NetworkOutcome::ConnectionFailed: return "connection_failed";
	}
	throw std::runtime_error("unknown_network_outcome");
}
// Exactly the same function runs in the trusted non-sandbox control and the LPAC worker.
static NetworkProbe inspectNetwork(unsigned short port) {
	NetworkProbe result;
	HKEY catalog = nullptr;
	result.catalogAccess = RegOpenKeyExW(HKEY_LOCAL_MACHINE, L"SYSTEM\\CurrentControlSet\\Services\\WinSock2\\Parameters", 0, KEY_READ, &catalog);
	if (result.catalogAccess == ERROR_SUCCESS) RegCloseKey(catalog);
	WSADATA sockets{}; result.startup = WSAStartup(MAKEWORD(2, 2), &sockets);
	if (result.startup != 0) return result;
	SOCKET connection = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
	if (connection == INVALID_SOCKET) { result.socketError = WSAGetLastError(); result.outcome = result.socketError == WSAEACCES ? NetworkOutcome::SocketAccessDenied : NetworkOutcome::SocketFailed; WSACleanup(); return result; }
	result.socketError = 0;
	u_long nonblocking = 1; check(ioctlsocket(connection, FIONBIO, &nonblocking) == 0, "nonblocking_network_probe");
	sockaddr_in address{}; address.sin_family = AF_INET; address.sin_port = htons(port); address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
	const int connected = connect(connection, reinterpret_cast<sockaddr*>(&address), sizeof(address));
	result.error = connected == 0 ? 0 : WSAGetLastError();
	if (connected == SOCKET_ERROR && result.error == WSAEWOULDBLOCK) {
		fd_set writable; FD_ZERO(&writable); FD_SET(connection, &writable);
		fd_set failed; FD_ZERO(&failed); FD_SET(connection, &failed); timeval timeout{1, 0};
		const int ready = select(0, nullptr, &writable, &failed, &timeout);
		int length = sizeof(result.error);
		if (ready > 0) check(getsockopt(connection, SOL_SOCKET, SO_ERROR, reinterpret_cast<char*>(&result.error), &length) == 0, "network_probe_status");
		else result.error = ready == 0 ? WSAETIMEDOUT : WSAGetLastError();
	}
	result.outcome = result.error == 0 ? NetworkOutcome::Connected : result.error == WSAEACCES ? NetworkOutcome::AccessDenied : NetworkOutcome::ConnectionFailed;
	closesocket(connection); WSACleanup();
	return result;
}
static int child(const fs::path& stage, const fs::path& denied, unsigned short port, DWORD hostPid, const wchar_t* registrySid = nullptr, const wchar_t* privateRegistry = nullptr) {
	unsigned passed = 0;
	auto expect = [&](bool ok, const char* name) { check(ok, name); ++passed; std::ofstream progress(stage / L"output" / L"progress.txt"); progress << passed << " " << name; };
	HANDLE rawToken = nullptr;
	check(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &rawToken) != FALSE, "query_probe_token");
	Handle token(rawToken); DWORD actual = 0, size = 0;
	check(GetTokenInformation(token.value, TokenIsAppContainer, &actual, sizeof(actual), &size) != FALSE, "query_appcontainer");
	expect(actual == 1, "token_is_appcontainer");
	// Prove the documented LPAC boundary by access, rather than relying on an unsupported token query class.
	expect(!canOpen(denied.parent_path() / L"all-packages.txt", GENERIC_READ), "all_application_packages_opt_out");
	GetTokenInformation(token.value, TokenCapabilities, nullptr, 0, &size);
	std::vector<BYTE> capabilities(size);
	check(size > 0 && GetTokenInformation(token.value, TokenCapabilities, capabilities.data(), size, &size) != FALSE, "query_capabilities");
	const auto groups = reinterpret_cast<TOKEN_GROUPS*>(capabilities.data());
	if (registrySid) {
		PSID expected = nullptr; check(ConvertStringSidToSidW(registrySid, &expected) != FALSE, "registry_capability_sid");
		const bool exact = groups->GroupCount == 1 && EqualSid(groups->Groups[0].Sid, expected) && (groups->Groups[0].Attributes & SE_GROUP_ENABLED); LocalFree(expected);
		expect(exact, "only_registry_read_capability");
		for (const auto access : { KEY_QUERY_VALUE, KEY_SET_VALUE }) {
			HKEY key = nullptr; const LSTATUS status = RegOpenKeyExW(HKEY_USERS, privateRegistry, 0, access, &key); if (key) RegCloseKey(key);
			expect(status == ERROR_ACCESS_DENIED, access == KEY_QUERY_VALUE ? "private_registry_read_denied" : "private_registry_write_denied");
		}
		unsigned scopeChecks = 0; auto scopeExpect = [&](bool ok, const char* name) { check(ok, name); ++scopeChecks; };
		for (const std::wstring leaf : { L"credential-fixture", L"model-settings-fixture" }) for (const auto access : { KEY_QUERY_VALUE, KEY_SET_VALUE }) {
			HKEY fixture = nullptr; const LSTATUS status = RegOpenKeyExW(HKEY_USERS, (std::wstring(privateRegistry) + L"\\" + leaf).c_str(), 0, access, &fixture); if (fixture) RegCloseKey(fixture);
			scopeExpect(status == ERROR_ACCESS_DENIED, "user_only_registry_resource_denied");
		}
		HKEY shared = nullptr; const auto sharedPath = std::wstring(privateRegistry) + L"\\capability-readable-fixture";
		const LSTATUS sharedRead = RegOpenKeyExW(HKEY_USERS, sharedPath.c_str(), 0, KEY_QUERY_VALUE, &shared);
		wchar_t value[64]{}; DWORD bytes = sizeof(value), type = 0;
		const LSTATUS queried = sharedRead == ERROR_SUCCESS ? RegQueryValueExW(shared, L"fixture", nullptr, &type, reinterpret_cast<BYTE*>(value), &bytes) : sharedRead; if (shared) RegCloseKey(shared);
		scopeExpect(queried == ERROR_SUCCESS && type == REG_SZ && std::wstring(value) == L"synthetic-not-a-secret", "explicitly_capability_granted_user_key_readable");
		shared = nullptr; const LSTATUS sharedWrite = RegOpenKeyExW(HKEY_USERS, sharedPath.c_str(), 0, KEY_SET_VALUE, &shared); if (shared) RegCloseKey(shared);
		scopeExpect(sharedWrite == ERROR_ACCESS_DENIED, "read_grant_does_not_grant_write");
		HKEY catalog = nullptr; const LSTATUS catalogRead = RegOpenKeyExW(HKEY_LOCAL_MACHINE, L"SYSTEM\\CurrentControlSet\\Services\\WinSock2\\Parameters", 0, KEY_QUERY_VALUE, &catalog);
		DWORD values = 0; const LSTATUS metadata = catalogRead == ERROR_SUCCESS ? RegQueryInfoKeyW(catalog, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, &values, nullptr, nullptr, nullptr, nullptr) : catalogRead; if (catalog) RegCloseKey(catalog);
		scopeExpect(metadata == ERROR_SUCCESS, "system_network_catalog_metadata_readable");
		{ std::ofstream scope(stage / L"output" / L"registry-scope.txt"); scope << scopeChecks; check(scope.good(), "write_registry_scope_evidence"); }
	} else expect(groups->GroupCount == 0, "no_capabilities");
	expect(canOpen(stage / L"input.txt", GENERIC_READ), "declared_input_read");
	expect(!canOpen(stage / L"input.txt", GENERIC_WRITE), "declared_input_write_denied");
	expect(!canOpen(denied, GENERIC_READ), "other_workspace_read_denied");
	expect(!canOpen(denied, GENERIC_WRITE), "other_workspace_write_denied");
	{ std::ofstream output(stage / L"output" / L"allowed.txt"); output << "synthetic"; expect(output.good(), "declared_output_write"); }
	wchar_t secret[64]{};
	expect(GetEnvironmentVariableW(L"PACKX_PROBE_SECRET", secret, 64) == 0, "parent_environment_not_inherited");
	Handle host(OpenProcess(PROCESS_CREATE_PROCESS | PROCESS_DUP_HANDLE, FALSE, hostPid));
	expect(host.value == nullptr, "privileged_host_process_handle_denied");
	const auto network = inspectNetwork(port);
	const int networkInitialization = network.startup, networkError = network.error;
	const bool networkDenied = network.outcome == NetworkOutcome::AccessDenied || network.outcome == NetworkOutcome::SocketAccessDenied;
	// Do not count initialization failure as a network-denial pass. Collect the other independent boundaries first.
	if (networkDenied) expect(true, "network_resource_denied");
	PROCESS_MITIGATION_CHILD_PROCESS_POLICY childPolicy{};
	check(GetProcessMitigationPolicy(GetCurrentProcess(), ProcessChildProcessPolicy, &childPolicy, sizeof(childPolicy)) != FALSE, "query_child_process_policy");
	{ std::ofstream diagnostic(stage / L"output" / L"network-diagnostic.txt"); diagnostic << "startup=" << networkInitialization << "; socket=" << network.socketError << "; connect=" << networkError << "; catalogAccess=" << network.catalogAccess << "; observation=" << outcomeName(network.outcome) << "; noChildProcessCreation=" << childPolicy.NoChildProcessCreation << "; workerReadableExecutable=" << canOpen(stage / L"worker.exe", GENERIC_READ | GENERIC_EXECUTE); }
	BOOL inJob = FALSE; check(IsProcessInJob(GetCurrentProcess(), nullptr, &inJob) != FALSE, "query_job");
	expect(inJob != FALSE, "child_is_in_job");
	void* excessive = VirtualAlloc(nullptr, 128ULL * 1024 * 1024, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
	if (excessive) VirtualFree(excessive, 0, MEM_RELEASE);
	expect(excessive == nullptr, "job_memory_limit");
	std::wstring command = quote((stage / L"worker.exe").wstring()) + L" --sleep";
	STARTUPINFOW startup{}; startup.cb = sizeof(startup); PROCESS_INFORMATION grandchild{};
	const BOOL spawned = CreateProcessW((stage / L"worker.exe").c_str(), command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, stage.c_str(), &startup, &grandchild);
	if (spawned) { TerminateProcess(grandchild.hProcess, 1); WaitForSingleObject(grandchild.hProcess, 5000); CloseHandle(grandchild.hThread); CloseHandle(grandchild.hProcess); }
	expect(!spawned, "child_creation_denied");
	writeReport(stage, std::to_string(passed) + " 0 " + std::to_string(networkInitialization) + " " + std::to_string(networkDenied) + " " + std::to_string(network.error) + " " + std::to_string(network.catalogAccess) + " " + outcomeName(network.outcome) + " " + std::to_string(network.socketError));
	Sleep(INFINITE);
	return 1;
}

int wmain(int argc, wchar_t** argv) {
	SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
	try {
		if (argc == 2 && std::wstring(argv[1]) == L"--sleep") { Sleep(INFINITE); return 1; }
		if (argc == 3 && (std::wstring(argv[1]) == L"--job-tree" || std::wstring(argv[1]) == L"--job-single")) {
			const bool single = std::wstring(argv[1]) == L"--job-single";
			std::wstring command = quote(argv[0]) + L" --sleep";
			STARTUPINFOW startup{}; startup.cb = sizeof(startup); PROCESS_INFORMATION created{};
			const BOOL spawned = CreateProcessW(argv[0], command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, argv[2], &startup, &created);
			if (single && spawned) { TerminateProcess(created.hProcess, 1); WaitForSingleObject(created.hProcess, 5000); }
			Handle process(spawned ? created.hProcess : nullptr), thread(spawned ? created.hThread : nullptr);
			check(single ? !spawned : spawned != FALSE, "host_control_child_creation_contract");
			PROCESS_INFORMATION escaped{};
			const BOOL brokeAway = CreateProcessW(argv[0], command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB, nullptr, argv[2], &startup, &escaped);
			if (brokeAway) { TerminateProcess(escaped.hProcess, 1); WaitForSingleObject(escaped.hProcess, 5000); CloseHandle(escaped.hThread); CloseHandle(escaped.hProcess); }
			check(!brokeAway, "host_tree_breakaway_denied");
			{ std::ofstream report(fs::path(argv[2]) / L"output" / (single ? L"job-single.txt" : L"job-tree.txt")); report << (single ? 1 : created.dwProcessId); check(report.good(), "host_tree_report"); }
			Sleep(INFINITE); return 1;
		}
		if (argc == 4 && std::wstring(argv[1]) == L"--network-control") {
			const auto result = inspectNetwork(static_cast<unsigned short>(std::stoul(argv[3])));
			std::ofstream report(fs::path(argv[2]) / L"output" / L"host-network.txt");
			report << result.startup << " " << result.error << " " << result.catalogAccess << " " << outcomeName(result.outcome) << " " << result.socketError;
			check(report.good(), "host_network_report");
			return result.outcome == NetworkOutcome::Connected ? 0 : 1;
		}
		if (argc == 3 && std::wstring(argv[1]) == L"--regular-control") {
			HANDLE raw = nullptr; check(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw) != FALSE, "control_token"); Handle token(raw);
			DWORD actual = 0, size = 0; check(GetTokenInformation(token.value, TokenIsAppContainer, &actual, sizeof(actual), &size) != FALSE && actual == 1, "control_is_appcontainer");
			check(canOpen(argv[2], GENERIC_READ), "control_reads_all_packages_file");
			WSADATA sockets{}; const int started = WSAStartup(MAKEWORD(2, 2), &sockets);
			{ std::ofstream status(fs::path(argv[2]).parent_path() / L"stage" / L"output" / L"network-control.txt"); status << started; check(status.good(), "write_regular_network_status"); }
			if (started == 0) WSACleanup();
			return 0;
		}
		if (argc == 6 && std::wstring(argv[1]) == L"--handle-control") {
			{ std::ofstream marker(fs::path(argv[5]) / L"output" / L"handle-control.txt"); marker << "entered"; check(marker.good(), "handle_query_marker"); }
			BY_HANDLE_FILE_INFORMATION leaked{};
			const bool visible = GetFileInformationByHandle(reinterpret_cast<HANDLE>(std::stoull(argv[2])), &leaked) && leaked.dwVolumeSerialNumber == std::stoul(argv[3]) && fileId(leaked) == std::stoull(argv[4]);
			return visible ? 1 : 0;
		}
		if ((argc == 6 || argc == 8) && std::wstring(argv[1]) == L"--child") {
			{ std::ofstream entry(fs::path(argv[2]) / L"output" / L"worker-entry.txt"); entry << "entered"; check(entry.good(), "worker_entry_marker"); }
			try { return child(argv[2], argv[3], static_cast<unsigned short>(std::stoul(argv[4])), std::stoul(argv[5]), argc == 8 ? argv[6] : nullptr, argc == 8 ? argv[7] : nullptr); }
			catch (const std::exception& error) { writeReport(argv[2], std::string("error ") + error.what()); return 1; }
		}
		check(false, "fixed_worker_arguments");
		return 1;
	} catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
