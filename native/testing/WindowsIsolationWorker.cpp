// Fixed synthetic worker. Keep broker-only profile/ACL/COM imports outside the LPAC process.
#define NOMINMAX
#include <winsock2.h>
#include <windows.h>
#include <bit>
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
struct NetworkEvidence {
	int initialization = -1;
	int error = -1;
	bool denied = false;
	DWORD moduleLoadError = 0;
};
template <typename T> static T systemApi(HMODULE module, const char* name) {
	const auto address = GetProcAddress(module, name);
	check(address != nullptr, name);
	return std::bit_cast<T>(address);
}
static NetworkEvidence inspectNetwork(unsigned short port) {
	NetworkEvidence result;
	// Load after entry, so an unavailable network DLL cannot hide independent file/Job checks.
	const HMODULE module = LoadLibraryExW(L"ws2_32.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
	if (!module) { result.moduleLoadError = GetLastError(); return result; }
	const auto wsStartup = systemApi<decltype(&::WSAStartup)>(module, "WSAStartup");
	const auto wsCleanup = systemApi<decltype(&::WSACleanup)>(module, "WSACleanup");
	const auto wsSocket = systemApi<decltype(&::socket)>(module, "socket");
	const auto wsClose = systemApi<decltype(&::closesocket)>(module, "closesocket");
	const auto wsNonblock = systemApi<decltype(&::ioctlsocket)>(module, "ioctlsocket");
	const auto wsConnect = systemApi<decltype(&::connect)>(module, "connect");
	const auto wsError = systemApi<decltype(&::WSAGetLastError)>(module, "WSAGetLastError");
	const auto wsSelect = systemApi<decltype(&::select)>(module, "select");
	const auto wsStatus = systemApi<decltype(&::getsockopt)>(module, "getsockopt");
	const auto wsHtons = systemApi<decltype(&::htons)>(module, "htons");
	const auto wsHtonl = systemApi<decltype(&::htonl)>(module, "htonl");
	WSADATA sockets{};
	result.initialization = wsStartup(MAKEWORD(2, 2), &sockets);
	if (result.initialization == 0 && port != 0) {
		SOCKET connection = wsSocket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
		check(connection != INVALID_SOCKET, "child_socket");
		u_long nonblocking = 1; check(wsNonblock(connection, FIONBIO, &nonblocking) == 0, "nonblocking_network_probe");
		sockaddr_in address{}; address.sin_family = AF_INET; address.sin_port = wsHtons(port); address.sin_addr.s_addr = wsHtonl(INADDR_LOOPBACK);
		const int connected = wsConnect(connection, reinterpret_cast<sockaddr*>(&address), sizeof(address));
		result.error = wsError();
		if (connected == SOCKET_ERROR && result.error == WSAEWOULDBLOCK) {
			fd_set writable; FD_ZERO(&writable); FD_SET(connection, &writable);
			fd_set failed; FD_ZERO(&failed); FD_SET(connection, &failed); timeval timeout{1, 0};
			const int ready = wsSelect(0, nullptr, &writable, &failed, &timeout);
			int length = sizeof(result.error);
			if (ready > 0) check(wsStatus(connection, SOL_SOCKET, SO_ERROR, reinterpret_cast<char*>(&result.error), &length) == 0, "network_probe_status");
			else result.error = WSAETIMEDOUT;
		}
		wsClose(connection);
		result.denied = connected == SOCKET_ERROR && result.error == WSAEACCES;
	}
	if (result.initialization == 0) wsCleanup();
	FreeLibrary(module);
	return result;
}

static int child(const fs::path& stage, const fs::path& denied, unsigned short port) {
	unsigned passed = 0;
	auto expect = [&](bool ok, const char* name) { check(ok, name); ++passed; std::ofstream progress(stage / L"output" / L"progress.txt"); progress << passed << " " << name; };
	const HMODULE security = LoadLibraryExW(L"advapi32.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
	check(security != nullptr, "load_security_api");
	const auto openToken = systemApi<decltype(&::OpenProcessToken)>(security, "OpenProcessToken");
	const auto getTokenInfo = systemApi<decltype(&::GetTokenInformation)>(security, "GetTokenInformation");
	HANDLE rawToken = nullptr;
	check(openToken(GetCurrentProcess(), TOKEN_QUERY, &rawToken) != FALSE, "query_probe_token");
	Handle token(rawToken); DWORD actual = 0, size = 0;
	check(getTokenInfo(token.value, TokenIsAppContainer, &actual, sizeof(actual), &size) != FALSE, "query_appcontainer");
	expect(actual == 1, "token_is_appcontainer");
	// Prove the documented LPAC boundary by access, rather than relying on an unsupported token query class.
	expect(!canOpen(denied.parent_path() / L"all-packages.txt", GENERIC_READ), "all_application_packages_opt_out");
	getTokenInfo(token.value, TokenCapabilities, nullptr, 0, &size);
	std::vector<BYTE> capabilities(size);
	check(size > 0 && getTokenInfo(token.value, TokenCapabilities, capabilities.data(), size, &size) != FALSE, "query_capabilities");
	expect(reinterpret_cast<TOKEN_GROUPS*>(capabilities.data())->GroupCount == 0, "no_capabilities");
	FreeLibrary(security);
	expect(canOpen(stage / L"input.txt", GENERIC_READ), "declared_input_read");
	expect(!canOpen(stage / L"input.txt", GENERIC_WRITE), "declared_input_write_denied");
	expect(!canOpen(denied, GENERIC_READ), "other_workspace_read_denied");
	expect(!canOpen(denied, GENERIC_WRITE), "other_workspace_write_denied");
	{ std::ofstream output(stage / L"output" / L"allowed.txt"); output << "synthetic"; expect(output.good(), "declared_output_write"); }
	wchar_t secret[64]{};
	expect(GetEnvironmentVariableW(L"PACKX_PROBE_SECRET", secret, 64) == 0, "parent_environment_not_inherited");
	const auto network = inspectNetwork(port);
	const int networkInitialization = network.initialization, networkError = network.error;
	const bool networkDenied = network.denied;
	// Do not count initialization failure as a network-denial pass. Collect the other independent boundaries first.
	if (networkDenied) expect(true, "loopback_network_denied");
	PROCESS_MITIGATION_CHILD_PROCESS_POLICY childPolicy{};
	check(GetProcessMitigationPolicy(GetCurrentProcess(), ProcessChildProcessPolicy, &childPolicy, sizeof(childPolicy)) != FALSE, "query_child_process_policy");
	{ std::ofstream diagnostic(stage / L"output" / L"network-diagnostic.txt"); diagnostic << "startup=" << networkInitialization << "; connect=" << networkError << "; noChildProcessCreation=" << childPolicy.NoChildProcessCreation << "; moduleLoad=" << network.moduleLoadError << "; workerReadableExecutable=" << canOpen(stage / L"worker.exe", GENERIC_READ | GENERIC_EXECUTE); }
	expect(childPolicy.NoChildProcessCreation != 0, "explicit_child_creation_restricted");
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
	writeReport(stage, std::to_string(passed) + " 0 " + std::to_string(networkInitialization) + " " + std::to_string(networkDenied));
	Sleep(INFINITE);
	return 1;
}

int wmain(int argc, wchar_t** argv) {
	SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
	try {
		if (argc == 2 && std::wstring(argv[1]) == L"--sleep") { Sleep(INFINITE); return 1; }
		if (argc == 3 && std::wstring(argv[1]) == L"--job-tree") {
			std::wstring command = quote(argv[0]) + L" --sleep";
			STARTUPINFOW startup{}; startup.cb = sizeof(startup); PROCESS_INFORMATION created{};
			check(CreateProcessW(argv[0], command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, argv[2], &startup, &created) != FALSE, "host_tree_descendant");
			Handle process(created.hProcess), thread(created.hThread);
			PROCESS_INFORMATION escaped{};
			const BOOL brokeAway = CreateProcessW(argv[0], command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB, nullptr, argv[2], &startup, &escaped);
			if (brokeAway) { TerminateProcess(escaped.hProcess, 1); WaitForSingleObject(escaped.hProcess, 5000); CloseHandle(escaped.hThread); CloseHandle(escaped.hProcess); }
			check(!brokeAway, "host_tree_breakaway_denied");
			{ std::ofstream report(fs::path(argv[2]) / L"output" / L"job-tree.txt"); report << created.dwProcessId; check(report.good(), "host_tree_report"); }
			Sleep(INFINITE); return 1;
		}
		if (argc == 3 && std::wstring(argv[1]) == L"--regular-control") {
			const HMODULE security = LoadLibraryExW(L"advapi32.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
			check(security != nullptr, "control_load_security_api");
			const auto openToken = systemApi<decltype(&::OpenProcessToken)>(security, "OpenProcessToken");
			const auto getTokenInfo = systemApi<decltype(&::GetTokenInformation)>(security, "GetTokenInformation");
			HANDLE raw = nullptr; check(openToken(GetCurrentProcess(), TOKEN_QUERY, &raw) != FALSE, "control_token"); Handle token(raw);
			DWORD actual = 0, size = 0; check(getTokenInfo(token.value, TokenIsAppContainer, &actual, sizeof(actual), &size) != FALSE && actual == 1, "control_is_appcontainer");
			FreeLibrary(security);
			check(canOpen(argv[2], GENERIC_READ), "control_reads_all_packages_file");
			const int started = inspectNetwork(0).initialization;
			{ std::ofstream status(fs::path(argv[2]).parent_path() / L"stage" / L"output" / L"network-control.txt"); status << started; check(status.good(), "write_regular_network_status"); }
			return 0;
		}
		if (argc == 6 && std::wstring(argv[1]) == L"--handle-control") {
			{ std::ofstream marker(fs::path(argv[5]) / L"output" / L"handle-control.txt"); marker << "entered"; check(marker.good(), "handle_query_marker"); }
			BY_HANDLE_FILE_INFORMATION leaked{};
			const bool visible = GetFileInformationByHandle(reinterpret_cast<HANDLE>(std::stoull(argv[2])), &leaked) && leaked.dwVolumeSerialNumber == std::stoul(argv[3]) && fileId(leaked) == std::stoull(argv[4]);
			return visible ? 1 : 0;
		}
		if (argc == 5 && std::wstring(argv[1]) == L"--child") {
			{ std::ofstream entry(fs::path(argv[2]) / L"output" / L"worker-entry.txt"); entry << "entered"; check(entry.good(), "worker_entry_marker"); }
			try { return child(argv[2], argv[3], static_cast<unsigned short>(std::stoul(argv[4]))); }
			catch (const std::exception& error) { writeReport(argv[2], std::string("error ") + error.what()); return 1; }
		}
		check(false, "fixed_worker_arguments");
		return 1;
	} catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
