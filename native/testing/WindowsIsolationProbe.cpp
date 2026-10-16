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

static int child(const fs::path& stage, const fs::path& denied, unsigned short port, HANDLE inherited, DWORD volume, unsigned long long identity) {
	unsigned passed = 0;
	auto expect = [&](bool ok, const char* name) { check(ok, name); ++passed; };
	HANDLE rawToken = nullptr;
	check(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &rawToken) != FALSE, "query_probe_token");
	Handle token(rawToken); DWORD actual = 0, size = 0;
	check(GetTokenInformation(token.value, TokenIsAppContainer, &actual, sizeof(actual), &size) != FALSE, "query_appcontainer");
	expect(actual == 1, "token_is_appcontainer");
	check(GetTokenInformation(token.value, TokenIsLessPrivilegedAppContainer, &actual, sizeof(actual), &size) != FALSE, "query_lpac");
	expect(actual == 1, "token_is_lpac");
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
	WSADATA sockets{}; check(WSAStartup(MAKEWORD(2, 2), &sockets) == 0, "child_winsock");
	SOCKET connection = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
	check(connection != INVALID_SOCKET, "child_socket");
	sockaddr_in address{}; address.sin_family = AF_INET; address.sin_port = htons(port); address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
	const int connected = connect(connection, reinterpret_cast<sockaddr*>(&address), sizeof(address));
	const int networkError = WSAGetLastError();
	closesocket(connection); WSACleanup();
	expect(connected == SOCKET_ERROR && networkError == WSAEACCES, "loopback_network_denied");
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
	writeReport(stage, std::to_string(passed) + " " + std::to_string(grandchild.dwProcessId));
	Sleep(INFINITE);
	return 1;
}

static int probe(const fs::path& root, const std::wstring& profileName) {
	check(fs::is_directory(root) && fs::is_empty(root), "fresh_probe_directory");
	const fs::path stage = root / L"stage", output = stage / L"output", denied = root / L"denied.txt";
	fs::create_directories(output);
	{ std::ofstream file(stage / L"input.txt"); file << "synthetic input"; }
	{ std::ofstream file(denied); file << "synthetic other workspace"; }
	wchar_t executable[MAX_PATH]{}; check(GetModuleFileNameW(nullptr, executable, MAX_PATH) > 0, "probe_executable");
	fs::copy_file(executable, stage / L"worker.exe");
	Profile profile(profileName);
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
	SIZE_T attributeSize = 0; InitializeProcThreadAttributeList(nullptr, 2, 0, &attributeSize);
	std::vector<BYTE> attributes(attributeSize);
	auto list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.data());
	check(InitializeProcThreadAttributeList(list, 2, 0, &attributeSize) != FALSE, "create_attributes");
	SECURITY_CAPABILITIES security{}; security.AppContainerSid = profile.sid;
	DWORD lpac = PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT;
	check(UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &security, sizeof(security), nullptr, nullptr) != FALSE, "set_appcontainer");
	check(UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY, &lpac, sizeof(lpac), nullptr, nullptr) != FALSE, "set_lpac");
	std::wstring command = quote((stage / L"worker.exe").wstring()) + L" --child " + quote(stage.wstring()) + L" " + quote(denied.wstring()) + L" " + std::to_wstring(ntohs(address.sin_port)) + L" " + std::to_wstring(reinterpret_cast<ULONG_PTR>(privateFile.value)) + L" " + std::to_wstring(identity.dwVolumeSerialNumber) + L" " + std::to_wstring(fileId(identity));
	wchar_t windows[MAX_PATH]{}; check(GetWindowsDirectoryW(windows, MAX_PATH) > 0, "windows_directory");
	LPWSTR sidText = nullptr, folder = nullptr;
	check(ConvertSidToStringSidW(profile.sid, &sidText) != FALSE, "profile_sid_text");
	const HRESULT folderResult = GetAppContainerFolderPath(sidText, &folder); LocalFree(sidText);
	if (FAILED(folderResult)) throw std::runtime_error("private_profile_folder:" + std::to_string(static_cast<unsigned long>(folderResult)));
	const std::wstring appData(folder); CoTaskMemFree(folder);
	std::wstring environment;
	for (const std::wstring& entry : { L"APPDATA=" + appData, L"LOCALAPPDATA=" + appData, L"SystemRoot=" + std::wstring(windows), L"TEMP=" + output.wstring(), L"TMP=" + output.wstring(), L"USERPROFILE=" + appData }) { environment += entry; environment += L'\0'; }
	environment += L'\0';
	SetEnvironmentVariableW(L"PACKX_PROBE_SECRET", L"synthetic-never-inherit");
	STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup); startup.lpAttributeList = list;
	PROCESS_INFORMATION created{};
	const BOOL launched = CreateProcessW((stage / L"worker.exe").c_str(), command.data(), nullptr, nullptr, FALSE, CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW, environment.data(), stage.c_str(), &startup.StartupInfo, &created);
	DeleteProcThreadAttributeList(list);
	check(launched != FALSE, "create_lpac_suspended");
	Handle process(created.hProcess), thread(created.hThread);
	if (!AssignProcessToJobObject(job.value, process.value)) { TerminateProcess(process.value, 1); WaitForSingleObject(process.value, 5000); check(false, "assign_job_before_resume"); }
	check(ResumeThread(thread.value) != static_cast<DWORD>(-1), "resume_contained_process");
	const auto reportPath = output / L"report.txt";
	for (unsigned i = 0; i < 100 && !fs::exists(reportPath); ++i) {
		if (WaitForSingleObject(process.value, 50) == WAIT_OBJECT_0) break;
	}
	unsigned passed = 0; DWORD descendantPid = 0;
	{ std::ifstream report(reportPath); report >> passed >> descendantPid; }
	if (passed != 15 || !descendantPid) {
		std::ifstream report(reportPath); std::string error; std::getline(report, error);
		throw std::runtime_error("contained_probe_failed:" + error.substr(0, 512));
	}
	Handle descendant(OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, descendantPid));
	check(descendant.value != nullptr, "observe_descendant");
	job.close();
	check(WaitForSingleObject(process.value, 5000) == WAIT_OBJECT_0, "job_close_kills_child");
	check(WaitForSingleObject(descendant.value, 5000) == WAIT_OBJECT_0, "job_close_kills_descendant");
	descendant.close(); thread.close(); process.close(); privateFile.close();
	closesocket(listener); WSACleanup();
	profile.remove();
	std::cout << "{\"probe\":\"windows-lpac-fixed-program\",\"childAssertions\":15,\"processTreeTerminated\":true,\"profileDeleted\":true}\n";
	return 0;
}

int wmain(int argc, wchar_t** argv) {
	try {
		if (argc == 2 && std::wstring(argv[1]) == L"--sleep") { Sleep(INFINITE); return 1; }
		if (argc == 8 && std::wstring(argv[1]) == L"--child") {
			try { return child(argv[2], argv[3], static_cast<unsigned short>(std::stoul(argv[4])), reinterpret_cast<HANDLE>(std::stoull(argv[5])), std::stoul(argv[6]), std::stoull(argv[7])); }
			catch (const std::exception& error) { writeReport(argv[2], std::string("error ") + error.what()); return 1; }
		}
		check(argc == 4 && std::wstring(argv[1]) == L"--probe", "fixed_probe_arguments");
		return probe(argv[2], argv[3]);
	} catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
