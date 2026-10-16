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

// A separate trusted, fixed host program verifies Job lifecycle; it is not an LPAC escape or a production Tool.
static void verifyHostJobControl(const fs::path& executable, const fs::path& stage, std::wstring& environment, bool single) {
	Handle job(CreateJobObjectW(nullptr, nullptr)); check(job.value != nullptr, "host_control_job");
	JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
	limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
	limits.BasicLimitInformation.ActiveProcessLimit = single ? 1 : 2;
	check(SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) != FALSE, "host_control_limits");
	std::wstring command = quote(executable.wstring()) + (single ? L" --job-single " : L" --job-tree ") + quote(stage.wstring());
	STARTUPINFOW startup{}; startup.cb = sizeof(startup); PROCESS_INFORMATION created{};
	check(CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, FALSE, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW, environment.data(), stage.c_str(), &startup, &created) != FALSE, "host_control_create_suspended");
	Handle root(created.hProcess), thread(created.hThread);
	if (!AssignProcessToJobObject(job.value, root.value) || ResumeThread(thread.value) == static_cast<DWORD>(-1)) {
		const DWORD failure = GetLastError(); TerminateProcess(root.value, 1); WaitForSingleObject(root.value, 5000);
		throw std::runtime_error("host_control_assign_resume:" + std::to_string(failure));
	}
	const auto reportPath = stage / L"output" / (single ? L"job-single.txt" : L"job-tree.txt");
	DWORD descendantPid = 0;
	for (unsigned i = 0; i < 100 && !descendantPid; ++i) {
		{ std::ifstream report(reportPath); report >> descendantPid; }
		if (WaitForSingleObject(root.value, 20) == WAIT_OBJECT_0) break;
	}
	check(descendantPid > 0, "host_control_reached_descendant");
	if (single) {
		check(descendantPid == 1, "host_single_creation_denied");
		job.close(); check(WaitForSingleObject(root.value, 5000) == WAIT_OBJECT_0, "host_single_root_cleanup");
		std::cerr << "host_single_process_control:creation_and_breakaway_denied; root_terminated\n";
		return;
	}
	Handle descendant(OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, descendantPid));
	BOOL inJob = FALSE;
	check(descendant.value && IsProcessInJob(descendant.value, job.value, &inJob) && inJob, "host_control_descendant_same_job");
	job.close();
	check(WaitForSingleObject(root.value, 5000) == WAIT_OBJECT_0 && WaitForSingleObject(descendant.value, 5000) == WAIT_OBJECT_0, "host_control_job_tree_cleanup");
	std::cerr << "host_job_control:descendant_inherits_job; breakaway_denied; root_and_descendant_terminated\n";
}

static int probe(const fs::path& root, const std::wstring& profileName, const fs::path& worker) {
	check(fs::is_directory(root) && fs::is_empty(root), "fresh_probe_directory");
	const fs::path stage = root / L"stage", output = stage / L"output", denied = root / L"denied.txt";
	fs::create_directories(output);
	{ std::ofstream file(stage / L"input.txt"); file << "synthetic input"; }
	{ std::ofstream file(denied); file << "synthetic other workspace"; }
	{ std::ofstream file(root / L"all-packages.txt"); file << "synthetic all-application-packages control"; }
	fs::copy_file(worker, stage / L"worker.exe");
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
	Handle hostControl(OpenProcess(PROCESS_CREATE_PROCESS | PROCESS_DUP_HANDLE, FALSE, GetCurrentProcessId()));
	check(hostControl.value != nullptr, "unsandboxed_privileged_process_control"); hostControl.close();
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
	limits.BasicLimitInformation.ActiveProcessLimit = 1;
	limits.JobMemoryLimit = 64ULL * 1024 * 1024;
	check(SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) != FALSE, "set_job_limits");
	JOBOBJECT_EXTENDED_LIMIT_INFORMATION actualLimits{};
	check(QueryInformationJobObject(job.value, JobObjectExtendedLimitInformation, &actualLimits, sizeof(actualLimits), nullptr) && actualLimits.BasicLimitInformation.ActiveProcessLimit == 1 && (actualLimits.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_ACTIVE_PROCESS) && !(actualLimits.BasicLimitInformation.LimitFlags & (JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK)), "single_process_job_contract");
	std::wstring command = quote((stage / L"worker.exe").wstring()) + L" --child " + quote(stage.wstring()) + L" " + quote(denied.wstring()) + L" " + std::to_wstring(ntohs(address.sin_port)) + L" " + std::to_wstring(GetCurrentProcessId());
	wchar_t windows[MAX_PATH]{}; check(GetWindowsDirectoryW(windows, MAX_PATH) > 0, "windows_directory");
	LPWSTR sidText = nullptr, folder = nullptr;
	check(ConvertSidToStringSidW(profile.sid, &sidText) != FALSE, "profile_sid_text");
	const HRESULT folderResult = GetAppContainerFolderPath(sidText, &folder); LocalFree(sidText);
	if (FAILED(folderResult)) throw std::runtime_error("private_profile_folder:" + std::to_string(static_cast<unsigned long>(folderResult)));
	const std::wstring appData(folder); CoTaskMemFree(folder);
	std::wstring environment;
	for (const std::wstring& entry : { L"APPDATA=" + appData, L"LOCALAPPDATA=" + appData, L"SystemDrive=" + fs::path(windows).root_name().wstring(), L"SystemRoot=" + std::wstring(windows), L"TEMP=" + output.wstring(), L"TMP=" + output.wstring(), L"USERPROFILE=" + appData, L"windir=" + std::wstring(windows) }) { environment += entry; environment += L'\0'; }
	environment += L'\0';
	verifyHostJobControl(stage / L"worker.exe", stage, environment, false);
	verifyHostJobControl(stage / L"worker.exe", stage, environment, true);
	SetEnvironmentVariableW(L"PACKX_PROBE_SECRET", L"synthetic-never-inherit");
	// A separate fixed AppContainer control must read the AAP-only synthetic file; LPAC must then fail to read it.
	const auto controlProcess = launch(stage / L"worker.exe", quote((stage / L"worker.exe").wstring()) + L" --regular-control " + quote((root / L"all-packages.txt").wstring()), stage, environment, profile.sid, job.value, false);
	Handle controlHandle(controlProcess.hProcess), controlThread(controlProcess.hThread);
	check(WaitForSingleObject(controlHandle.value, 5000) == WAIT_OBJECT_0, "regular_appcontainer_control_timeout");
	DWORD controlExit = 1; check(GetExitCodeProcess(controlHandle.value, &controlExit) != FALSE, "regular_appcontainer_control_status");
	if (controlExit != 0) throw std::runtime_error("regular_appcontainer_control_exit:" + std::to_string(controlExit));
	int regularNetworkInitialization = -1;
	{ std::ifstream status(output / L"network-control.txt"); check(static_cast<bool>(status >> regularNetworkInitialization), "read_regular_network_status"); }
	check(regularNetworkInitialization == 0, "regular_network_initialization_control");
	controlThread.close(); controlHandle.close();
	// Invalid-handle checks can deliberately terminate a strict process. Isolate this negative case from the remaining assertions.
	const auto handleControl = launch(stage / L"worker.exe", quote((stage / L"worker.exe").wstring()) + L" --handle-control " + std::to_wstring(reinterpret_cast<ULONG_PTR>(privateFile.value)) + L" " + std::to_wstring(identity.dwVolumeSerialNumber) + L" " + std::to_wstring(fileId(identity)) + L" " + quote(stage.wstring()), stage, environment, profile.sid, job.value, true);
	Handle handleProcess(handleControl.hProcess), handleThread(handleControl.hThread);
	check(WaitForSingleObject(handleProcess.value, 5000) == WAIT_OBJECT_0, "handle_control_timeout");
	DWORD handleExit = 1; check(GetExitCodeProcess(handleProcess.value, &handleExit) != FALSE, "handle_control_status");
	{ std::ifstream marker(output / L"handle-control.txt"); std::string entered; marker >> entered; check(entered == "entered", "handle_control_reached_query"); }
	check(handleExit == 0 || handleExit == 0xC0000008UL, "private_handle_not_inherited");
	handleThread.close(); handleProcess.close();
	const auto created = launch(stage / L"worker.exe", command, stage, environment, profile.sid, job.value, true);
	Handle process(created.hProcess), thread(created.hThread);
	const auto reportPath = output / L"report.txt";
	for (unsigned i = 0; i < 100 && !fs::exists(reportPath); ++i) {
		if (WaitForSingleObject(process.value, 50) == WAIT_OBJECT_0) break;
	}
	unsigned passed = 0; DWORD descendantPid = 0; int networkInitialization = -1; bool networkDenied = false;
	{ std::ifstream report(reportPath); report >> passed >> descendantPid >> networkInitialization >> networkDenied; }
	if (passed < 13) {
		std::ifstream report(reportPath); std::string error; std::getline(report, error);
		std::ifstream progress(output / L"progress.txt"); std::string step; std::getline(progress, step);
		std::ifstream diagnostic(output / L"network-diagnostic.txt"); std::string boundary; std::getline(diagnostic, boundary);
		DWORD code = STILL_ACTIVE; GetExitCodeProcess(process.value, &code);
		throw std::runtime_error("contained_probe_failed:" + error.substr(0, 512) + "; last_step=" + step.substr(0, 200) + "; child_exit=" + std::to_string(code) + "; worker_entry=" + std::to_string(fs::exists(output / L"worker-entry.txt")) + "; " + boundary + "; regular_startup=" + std::to_string(regularNetworkInitialization));
	}
	job.close();
	check(WaitForSingleObject(process.value, 5000) == WAIT_OBJECT_0, "job_close_kills_child");
	thread.close(); process.close(); privateFile.close();
	closesocket(listener); WSACleanup();
	profile.remove();
	std::ifstream diagnostic(output / L"network-diagnostic.txt"); std::string boundary; std::getline(diagnostic, boundary);
	std::cerr << "lpac_boundary:" << boundary << '\n';
	std::cout << "{\"probe\":\"windows-lpac-fixed-program\",\"childAssertions\":" << passed << ",\"privateHandleNotInherited\":true,\"regularNetworkInitializationError\":" << regularNetworkInitialization << ",\"networkInitializationError\":" << networkInitialization << ",\"networkAccessDenied\":" << (networkDenied ? "true" : "false") << ",\"singleProcessJobRestricted\":true,\"legalHostSingleProcessDenied\":true,\"legalHostJobTreeTerminated\":true,\"lpacProcessTerminated\":true,\"profileDeleted\":true}\n";
	return passed == 14 && networkDenied ? 0 : 1;
}

int wmain(int argc, wchar_t** argv) {
	SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
	try {
		check(argc == 5 && std::wstring(argv[1]) == L"--probe", "fixed_probe_arguments");
		return probe(argv[2], argv[3], argv[4]);
	} catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
