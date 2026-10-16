// Fixed synthetic test program only. Never used to execute production tools or parse customer documents.
#define NOMINMAX
#include <winsock2.h>
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <userenv.h>
#include <objbase.h>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>
#include <utility>

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
struct Profile {
	std::wstring name;
	PSID sid = nullptr;
	bool owned = false;
	explicit Profile(std::wstring n) : name(std::move(n)) {
		const HRESULT hr = CreateAppContainerProfile(name.c_str(), L"Packx isolation probe", L"Temporary synthetic CI probe", nullptr, 0, &sid);
		if (FAILED(hr)) throw std::runtime_error("create_private_app_profile:" + std::to_string(static_cast<unsigned long>(hr)));
		owned = true;
	}
	~Profile() {
		if (owned) {
			HRESULT hr = E_FAIL;
			for (unsigned i = 0; i < 100 && FAILED(hr); ++i) { hr = DeleteAppContainerProfile(name.c_str()); if (FAILED(hr)) Sleep(50); }
			if (FAILED(hr)) std::cerr << "probe_profile_cleanup_failed:" << static_cast<unsigned long>(hr) << '\n';
		}
		if (sid) FreeSid(sid);
	}
	void remove() {
		const HRESULT hr = DeleteAppContainerProfile(name.c_str());
		if (FAILED(hr)) throw std::runtime_error("delete_private_app_profile:" + std::to_string(static_cast<unsigned long>(hr)));
		owned = false;
	}
};

// Only called on this probe's newly-created staging directory, never on user files or system paths.
static void grant(const fs::path& path, PSID sid, DWORD rights) {
	PACL oldAcl = nullptr, newAcl = nullptr;
	PSECURITY_DESCRIPTOR descriptor = nullptr;
	const DWORD read = GetNamedSecurityInfoW(const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, &oldAcl, nullptr, &descriptor);
	if (read != ERROR_SUCCESS) throw std::runtime_error("read_stage_acl:" + std::to_string(read));
	EXPLICIT_ACCESSW entry{};
	entry.grfAccessPermissions = rights;
	entry.grfAccessMode = GRANT_ACCESS;
	entry.grfInheritance = fs::is_directory(path) ? SUB_CONTAINERS_AND_OBJECTS_INHERIT : NO_INHERITANCE;
	entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
	entry.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
	entry.Trustee.ptstrName = static_cast<LPWSTR>(sid);
	const DWORD built = SetEntriesInAclW(1, &entry, oldAcl, &newAcl);
	const DWORD changed = built == ERROR_SUCCESS ? SetNamedSecurityInfoW(const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, newAcl, nullptr) : built;
	if (newAcl) LocalFree(newAcl);
	if (descriptor) LocalFree(descriptor);
	if (changed != ERROR_SUCCESS) throw std::runtime_error("grant_private_stage_acl:" + std::to_string(changed));
}
static void lowLabel(const fs::path& path) {
	PSECURITY_DESCRIPTOR descriptor = nullptr;
	check(ConvertStringSecurityDescriptorToSecurityDescriptorW(L"S:(ML;OICI;NW;;;LW)", SDDL_REVISION_1, &descriptor, nullptr) != FALSE, "build_private_low_label");
	PACL label = nullptr; BOOL present = FALSE, defaulted = FALSE;
	const BOOL decoded = GetSecurityDescriptorSacl(descriptor, &present, &label, &defaulted);
	const DWORD changed = decoded && present ? SetNamedSecurityInfoW(const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT, LABEL_SECURITY_INFORMATION, nullptr, nullptr, nullptr, label) : ERROR_INVALID_DATA;
	LocalFree(descriptor);
	if (changed != ERROR_SUCCESS) throw std::runtime_error("label_private_output:" + std::to_string(changed));
}
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
static PROCESS_INFORMATION launch(const fs::path& executable, std::wstring command, const fs::path& directory, std::wstring& environment, PSID sid, HANDLE job, bool lpac) {
	const DWORD count = lpac ? 2 : 1;
	SIZE_T size = 0; InitializeProcThreadAttributeList(nullptr, count, 0, &size);
	std::vector<BYTE> attributes(size);
	auto list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.data());
	check(InitializeProcThreadAttributeList(list, count, 0, &size) != FALSE, "create_attributes");
	SECURITY_CAPABILITIES security{}; security.AppContainerSid = sid;
	DWORD policy = PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT;
	check(UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &security, sizeof(security), nullptr, nullptr) != FALSE, "set_appcontainer");
	if (lpac) check(UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY, &policy, sizeof(policy), nullptr, nullptr) != FALSE, "set_lpac");
	STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup); startup.lpAttributeList = list;
	PROCESS_INFORMATION created{};
	const BOOL launched = CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, FALSE, CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW, environment.data(), directory.c_str(), &startup.StartupInfo, &created);
	const DWORD error = GetLastError(); DeleteProcThreadAttributeList(list);
	if (!launched) throw std::runtime_error("create_appcontainer_suspended:" + std::to_string(error));
	if (!AssignProcessToJobObject(job, created.hProcess) || ResumeThread(created.hThread) == static_cast<DWORD>(-1)) {
		const DWORD failure = GetLastError(); TerminateProcess(created.hProcess, 1); WaitForSingleObject(created.hProcess, 5000); CloseHandle(created.hThread); CloseHandle(created.hProcess);
		throw std::runtime_error("assign_job_and_resume:" + std::to_string(failure));
	}
	return created;
}

static int child(const fs::path& stage, const fs::path& denied, unsigned short port, HANDLE inherited, DWORD volume, unsigned long long identity) {
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
	expect(reinterpret_cast<TOKEN_GROUPS*>(capabilities.data())->GroupCount == 0, "no_capabilities");
	expect(canOpen(stage / L"input.txt", GENERIC_READ), "declared_input_read");
	expect(!canOpen(stage / L"input.txt", GENERIC_WRITE), "declared_input_write_denied");
	expect(!canOpen(denied, GENERIC_READ), "other_workspace_read_denied");
	expect(!canOpen(denied, GENERIC_WRITE), "other_workspace_write_denied");
	{ std::ofstream output(stage / L"output" / L"allowed.txt"); output << "synthetic"; expect(output.good(), "declared_output_write"); }
	wchar_t secret[64]{};
	expect(GetEnvironmentVariableW(L"PACKX_PROBE_SECRET", secret, 64) == 0, "parent_environment_not_inherited");
	WSADATA sockets{};
	const int networkInitialization = WSAStartup(MAKEWORD(2, 2), &sockets);
	bool networkDenied = false;
	if (networkInitialization == 0) {
		SOCKET connection = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
		check(connection != INVALID_SOCKET, "child_socket");
		u_long nonblocking = 1; check(ioctlsocket(connection, FIONBIO, &nonblocking) == 0, "nonblocking_network_probe");
		sockaddr_in address{}; address.sin_family = AF_INET; address.sin_port = htons(port); address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
		const int connected = connect(connection, reinterpret_cast<sockaddr*>(&address), sizeof(address));
		int networkError = WSAGetLastError();
		if (connected == SOCKET_ERROR && networkError == WSAEWOULDBLOCK) {
			fd_set writable; FD_ZERO(&writable); FD_SET(connection, &writable);
			fd_set failed; FD_ZERO(&failed); FD_SET(connection, &failed); timeval timeout{1, 0};
			const int ready = select(0, nullptr, &writable, &failed, &timeout);
			int length = sizeof(networkError);
			if (ready > 0) check(getsockopt(connection, SOL_SOCKET, SO_ERROR, reinterpret_cast<char*>(&networkError), &length) == 0, "network_probe_status");
			else networkError = WSAETIMEDOUT;
		}
		closesocket(connection); WSACleanup();
		networkDenied = connected == SOCKET_ERROR && networkError == WSAEACCES;
	}
	// Do not count initialization failure as a network-denial pass. Collect the other independent boundaries first.
	if (networkDenied) ++passed;
	BY_HANDLE_FILE_INFORMATION leaked{};
	expect(!GetFileInformationByHandle(inherited, &leaked) || leaked.dwVolumeSerialNumber != volume || fileId(leaked) != identity, "private_handle_not_inherited");
	BOOL inJob = FALSE; check(IsProcessInJob(GetCurrentProcess(), nullptr, &inJob) != FALSE, "query_job");
	expect(inJob != FALSE, "child_is_in_job");
	void* excessive = VirtualAlloc(nullptr, 128ULL * 1024 * 1024, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
	if (excessive) VirtualFree(excessive, 0, MEM_RELEASE);
	expect(excessive == nullptr, "job_memory_limit");
	std::wstring command = quote((stage / L"worker.exe").wstring()) + L" --sleep";
	STARTUPINFOW startup{}; startup.cb = sizeof(startup); PROCESS_INFORMATION grandchild{};
	check(CreateProcessW((stage / L"worker.exe").c_str(), command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, stage.c_str(), &startup, &grandchild) != FALSE, "spawn_contained_child");
	Handle descendant(grandchild.hProcess), descendantThread(grandchild.hThread);
	BOOL sameJob = FALSE; check(IsProcessInJob(descendant.value, nullptr, &sameJob) != FALSE, "query_descendant_job");
	expect(sameJob != FALSE, "descendant_inherits_job");
	PROCESS_INFORMATION escaped{};
	const BOOL brokeAway = CreateProcessW((stage / L"worker.exe").c_str(), command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB, nullptr, stage.c_str(), &startup, &escaped);
	if (brokeAway) { TerminateProcess(escaped.hProcess, 1); WaitForSingleObject(escaped.hProcess, 5000); CloseHandle(escaped.hThread); CloseHandle(escaped.hProcess); }
	expect(!brokeAway, "job_breakaway_denied");
	writeReport(stage, std::to_string(passed) + " " + std::to_string(grandchild.dwProcessId) + " " + std::to_string(networkInitialization) + " " + std::to_string(networkDenied));
	Sleep(INFINITE);
	return 1;
}

static int probe(const fs::path& root, const std::wstring& profileName) {
	check(fs::is_directory(root) && fs::is_empty(root), "fresh_probe_directory");
	const fs::path stage = root / L"stage", output = stage / L"output", denied = root / L"denied.txt";
	fs::create_directories(output);
	{ std::ofstream file(stage / L"input.txt"); file << "synthetic input"; }
	{ std::ofstream file(denied); file << "synthetic other workspace"; }
	{ std::ofstream file(root / L"all-packages.txt"); file << "synthetic all-application-packages control"; }
	wchar_t executable[MAX_PATH]{}; check(GetModuleFileNameW(nullptr, executable, MAX_PATH) > 0, "probe_executable");
	fs::copy_file(executable, stage / L"worker.exe");
	Profile profile(profileName);
	BYTE anyPackage[SECURITY_MAX_SID_SIZE]{}; DWORD sidSize = sizeof(anyPackage);
	check(CreateWellKnownSid(WinBuiltinAnyPackageSid, nullptr, anyPackage, &sidSize) != FALSE, "all_packages_control_sid");
	grant(root / L"all-packages.txt", anyPackage, FILE_GENERIC_READ);
	grant(stage, profile.sid, FILE_GENERIC_READ | FILE_GENERIC_EXECUTE);
	// Files existed before the inherited grant; grant only these synthetic copies explicitly.
	grant(stage / L"worker.exe", profile.sid, FILE_GENERIC_READ | FILE_GENERIC_EXECUTE);
	grant(stage / L"input.txt", profile.sid, FILE_GENERIC_READ);
	grant(output, profile.sid, FILE_GENERIC_READ | FILE_GENERIC_WRITE | DELETE | FILE_DELETE_CHILD);
	lowLabel(output);
	SECURITY_ATTRIBUTES inheritedAttributes{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
	Handle privateFile(CreateFileW(denied.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, &inheritedAttributes, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
	check(privateFile.value != INVALID_HANDLE_VALUE, "private_inheritable_handle");
	check(canOpen(denied, GENERIC_READ | GENERIC_WRITE), "unsandboxed_file_control");
	BY_HANDLE_FILE_INFORMATION identity{}; check(GetFileInformationByHandle(privateFile.value, &identity) != FALSE, "private_file_identity");
	WSADATA sockets{}; check(WSAStartup(MAKEWORD(2, 2), &sockets) == 0, "parent_winsock");
	SOCKET listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP); check(listener != INVALID_SOCKET, "parent_listener");
	sockaddr_in address{}; address.sin_family = AF_INET; address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
	check(bind(listener, reinterpret_cast<sockaddr*>(&address), sizeof(address)) == 0 && listen(listener, 4) == 0, "parent_listen");
	int addressSize = sizeof(address); check(getsockname(listener, reinterpret_cast<sockaddr*>(&address), &addressSize) == 0, "listener_address");
	SOCKET control = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
	check(control != INVALID_SOCKET && connect(control, reinterpret_cast<sockaddr*>(&address), sizeof(address)) == 0, "unsandboxed_network_control");
	closesocket(control);
	void* memoryControl = VirtualAlloc(nullptr, 128ULL * 1024 * 1024, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
	check(memoryControl != nullptr, "unsandboxed_memory_control"); VirtualFree(memoryControl, 0, MEM_RELEASE);
	Handle job(CreateJobObjectW(nullptr, nullptr)); check(job.value != nullptr, "create_job");
	JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
	limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_JOB_MEMORY;
	limits.BasicLimitInformation.ActiveProcessLimit = 2;
	limits.JobMemoryLimit = 64ULL * 1024 * 1024;
	check(SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) != FALSE, "set_job_limits");
	std::wstring command = quote((stage / L"worker.exe").wstring()) + L" --child " + quote(stage.wstring()) + L" " + quote(denied.wstring()) + L" " + std::to_wstring(ntohs(address.sin_port)) + L" " + std::to_wstring(reinterpret_cast<ULONG_PTR>(privateFile.value)) + L" " + std::to_wstring(identity.dwVolumeSerialNumber) + L" " + std::to_wstring(fileId(identity));
	wchar_t windows[MAX_PATH]{}; check(GetWindowsDirectoryW(windows, MAX_PATH) > 0, "windows_directory");
	LPWSTR sidText = nullptr, folder = nullptr;
	check(ConvertSidToStringSidW(profile.sid, &sidText) != FALSE, "profile_sid_text");
	const HRESULT folderResult = GetAppContainerFolderPath(sidText, &folder); LocalFree(sidText);
	if (FAILED(folderResult)) throw std::runtime_error("private_profile_folder:" + std::to_string(static_cast<unsigned long>(folderResult)));
	const std::wstring appData(folder); CoTaskMemFree(folder);
	std::wstring environment;
	for (const std::wstring& entry : { L"APPDATA=" + appData, L"LOCALAPPDATA=" + appData, L"SystemDrive=" + fs::path(windows).root_name().wstring(), L"SystemRoot=" + std::wstring(windows), L"TEMP=" + output.wstring(), L"TMP=" + output.wstring(), L"USERPROFILE=" + appData, L"windir=" + std::wstring(windows) }) { environment += entry; environment += L'\0'; }
	environment += L'\0';
	SetEnvironmentVariableW(L"PACKX_PROBE_SECRET", L"synthetic-never-inherit");
	// A separate fixed AppContainer control must read the AAP-only synthetic file; LPAC must then fail to read it.
	const auto controlProcess = launch(stage / L"worker.exe", quote((stage / L"worker.exe").wstring()) + L" --regular-control " + quote((root / L"all-packages.txt").wstring()), stage, environment, profile.sid, job.value, false);
	Handle controlHandle(controlProcess.hProcess), controlThread(controlProcess.hThread);
	check(WaitForSingleObject(controlHandle.value, 5000) == WAIT_OBJECT_0, "regular_appcontainer_control_timeout");
	DWORD controlExit = 1; check(GetExitCodeProcess(controlHandle.value, &controlExit) != FALSE, "regular_appcontainer_control_status");
	if (controlExit != 0) throw std::runtime_error("regular_appcontainer_control_exit:" + std::to_string(controlExit));
	int regularNetworkInitialization = -1;
	{ std::ifstream status(output / L"network-control.txt"); check(static_cast<bool>(status >> regularNetworkInitialization), "read_regular_network_status"); }
	controlThread.close(); controlHandle.close();
	const auto created = launch(stage / L"worker.exe", command, stage, environment, profile.sid, job.value, true);
	Handle process(created.hProcess), thread(created.hThread);
	const auto reportPath = output / L"report.txt";
	for (unsigned i = 0; i < 100 && !fs::exists(reportPath); ++i) {
		if (WaitForSingleObject(process.value, 50) == WAIT_OBJECT_0) break;
	}
	unsigned passed = 0; DWORD descendantPid = 0; int networkInitialization = -1; bool networkDenied = false;
	{ std::ifstream report(reportPath); report >> passed >> descendantPid >> networkInitialization >> networkDenied; }
	if (passed < 14 || !descendantPid) {
		std::ifstream report(reportPath); std::string error; std::getline(report, error);
		std::ifstream progress(output / L"progress.txt"); std::string step; std::getline(progress, step);
		DWORD code = STILL_ACTIVE; GetExitCodeProcess(process.value, &code);
		throw std::runtime_error("contained_probe_failed:" + error.substr(0, 512) + "; last_step=" + step.substr(0, 200) + "; child_exit=" + std::to_string(code));
	}
	Handle descendant(OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, descendantPid));
	check(descendant.value != nullptr, "observe_descendant");
	job.close();
	check(WaitForSingleObject(process.value, 5000) == WAIT_OBJECT_0, "job_close_kills_child");
	check(WaitForSingleObject(descendant.value, 5000) == WAIT_OBJECT_0, "job_close_kills_descendant");
	descendant.close(); thread.close(); process.close(); privateFile.close();
	closesocket(listener); WSACleanup();
	profile.remove();
	std::cout << "{\"probe\":\"windows-lpac-fixed-program\",\"childAssertions\":" << passed << ",\"regularNetworkInitializationError\":" << regularNetworkInitialization << ",\"networkInitializationError\":" << networkInitialization << ",\"networkAccessDenied\":" << (networkDenied ? "true" : "false") << ",\"processTreeTerminated\":true,\"profileDeleted\":true}\n";
	return passed == 15 && networkDenied ? 0 : 1;
}

int wmain(int argc, wchar_t** argv) {
	try {
		if (argc == 2 && std::wstring(argv[1]) == L"--sleep") { Sleep(INFINITE); return 1; }
		if (argc == 3 && std::wstring(argv[1]) == L"--regular-control") {
			HANDLE raw = nullptr; check(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw) != FALSE, "control_token"); Handle token(raw);
			DWORD actual = 0, size = 0; check(GetTokenInformation(token.value, TokenIsAppContainer, &actual, sizeof(actual), &size) != FALSE && actual == 1, "control_is_appcontainer");
			check(canOpen(argv[2], GENERIC_READ), "control_reads_all_packages_file");
			WSADATA sockets{}; const int started = WSAStartup(MAKEWORD(2, 2), &sockets);
			{ std::ofstream status(fs::path(argv[2]).parent_path() / L"stage" / L"output" / L"network-control.txt"); status << started; check(status.good(), "write_regular_network_status"); }
			if (started == 0) WSACleanup();
			return 0;
		}
		if (argc == 8 && std::wstring(argv[1]) == L"--child") {
			try { return child(argv[2], argv[3], static_cast<unsigned short>(std::stoul(argv[4])), reinterpret_cast<HANDLE>(std::stoull(argv[5])), std::stoul(argv[6]), std::stoull(argv[7])); }
			catch (const std::exception& error) { writeReport(argv[2], std::string("error ") + error.what()); return 1; }
		}
		check(argc == 4 && std::wstring(argv[1]) == L"--probe", "fixed_probe_arguments");
		return probe(argv[2], argv[3]);
	} catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
