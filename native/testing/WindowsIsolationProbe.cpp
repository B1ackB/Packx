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
#include <memory>

#include "../windows/IsolationSupport.h"
// An owned, synthetic HKCU leaf only. Never edits system/catalog ACLs or existing keys.
struct PrivateRegistry {
	std::wstring key, userPath; bool owned = false;
	explicit PrivateRegistry(const std::wstring& nonce) {
		Handle token; check(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token.value) != FALSE, "registry_owner_token");
		DWORD size = 0; GetTokenInformation(token.value, TokenUser, nullptr, 0, &size); std::vector<BYTE> data(size);
		check(GetTokenInformation(token.value, TokenUser, data.data(), size, &size) != FALSE, "registry_owner_sid");
		LPWSTR sid = nullptr; check(ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(data.data())->User.Sid, &sid) != FALSE, "registry_owner_text");
		const std::wstring owner(sid); LocalFree(sid);
		key = L"Software\\PackxProbe." + nonce; userPath = owner + L"\\" + key;
		const std::wstring sddl = L"D:P(A;;KA;;;SY)(A;;KA;;;" + owner + L")";
		PSECURITY_DESCRIPTOR descriptor = nullptr; check(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr) != FALSE, "private_registry_acl");
		SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), descriptor, FALSE}; HKEY created = nullptr; DWORD disposition = 0;
		const LSTATUS status = RegCreateKeyExW(HKEY_CURRENT_USER, key.c_str(), 0, nullptr, 0, KEY_ALL_ACCESS, &security, &created, &disposition); LocalFree(descriptor);
		if (status != ERROR_SUCCESS) throw std::runtime_error("create_private_registry:" + std::to_string(status));
		RegCloseKey(created);
		check(disposition == REG_CREATED_NEW_KEY, "private_registry_must_be_new"); owned = true;
		HKEY control = nullptr; const LSTATUS readable = RegOpenKeyExW(HKEY_USERS, userPath.c_str(), 0, KEY_QUERY_VALUE | KEY_SET_VALUE, &control);
		if (control) RegCloseKey(control);
		if (readable != ERROR_SUCCESS) { RegDeleteTreeW(HKEY_CURRENT_USER, key.c_str()); owned = false; throw std::runtime_error("private_registry_positive_control:" + std::to_string(readable)); }
	}
	~PrivateRegistry() { if (owned && RegDeleteTreeW(HKEY_CURRENT_USER, key.c_str()) != ERROR_SUCCESS) std::cerr << "private_registry_cleanup_failed\n"; }
	void remove() {
		const LSTATUS status = RegDeleteTreeW(HKEY_CURRENT_USER, key.c_str()); if (status != ERROR_SUCCESS) throw std::runtime_error("private_registry_cleanup:" + std::to_string(status));
		HKEY remaining = nullptr; const LSTATUS missing = RegOpenKeyExW(HKEY_CURRENT_USER, key.c_str(), 0, KEY_QUERY_VALUE, &remaining); if (remaining) RegCloseKey(remaining);
		if (missing != ERROR_FILE_NOT_FOUND) throw std::runtime_error("private_registry_still_present:" + std::to_string(missing));
		owned = false;
	}
};

static bool canOpen(const fs::path& path, DWORD rights) {
	Handle h(CreateFileW(path.c_str(), rights, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
	return h.value != INVALID_HANDLE_VALUE;
}
static unsigned long long fileId(const BY_HANDLE_FILE_INFORMATION& info) {
	return (static_cast<unsigned long long>(info.nFileIndexHigh) << 32) | info.nFileIndexLow;
}
static PROCESS_INFORMATION launchHostControl(const fs::path& executable, std::wstring command, const fs::path& directory, std::wstring& environment, HANDLE job) {
	STARTUPINFOW startup{}; startup.cb = sizeof(startup); PROCESS_INFORMATION created{};
	check(CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, FALSE, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW, environment.data(), directory.c_str(), &startup, &created) != FALSE, "host_control_create_suspended");
	if (!AssignProcessToJobObject(job, created.hProcess) || ResumeThread(created.hThread) == static_cast<DWORD>(-1)) {
		const DWORD failure = GetLastError(); TerminateProcess(created.hProcess, 1); WaitForSingleObject(created.hProcess, 5000); CloseHandle(created.hThread); CloseHandle(created.hProcess);
		throw std::runtime_error("host_control_assign_resume:" + std::to_string(failure));
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
	const auto created = launchHostControl(executable, command, stage, environment, job.value);
	Handle root(created.hProcess), thread(created.hThread);
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

static int probe(const fs::path& root, const std::wstring& profileName, const fs::path& worker, bool diagnosticOnly, bool registryRead = false) {
	check(fs::is_directory(root) && fs::is_empty(root), "fresh_probe_directory");
	const fs::path stage = root / L"stage", output = stage / L"output", denied = root / L"denied.txt";
	fs::create_directories(output);
	{ std::ofstream file(stage / L"input.txt"); file << "synthetic input"; }
	{ std::ofstream file(denied); file << "synthetic other workspace"; }
	{ std::ofstream file(root / L"all-packages.txt"); file << "synthetic all-application-packages control"; }
	fs::copy_file(worker, stage / L"worker.exe");
	Profile profile(profileName);
	std::unique_ptr<RegistryCapability> registryCapability;
	std::unique_ptr<PrivateRegistry> privateRegistry;
	if (registryRead) { registryCapability = std::make_unique<RegistryCapability>(); privateRegistry = std::make_unique<PrivateRegistry>(profileName); }
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
	if (registryRead) {
		LPWSTR capabilityText = nullptr; check(ConvertSidToStringSidW(registryCapability->sid, &capabilityText) != FALSE, "registry_capability_text");
		command += L" " + quote(capabilityText) + L" " + quote(privateRegistry->userPath); LocalFree(capabilityText);
	}
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
	const auto networkControl = launchHostControl(stage / L"worker.exe", quote((stage / L"worker.exe").wstring()) + L" --network-control " + quote(stage.wstring()) + L" " + std::to_wstring(ntohs(address.sin_port)), stage, environment, job.value);
	Handle networkProcess(networkControl.hProcess), networkThread(networkControl.hThread);
	check(WaitForSingleObject(networkProcess.value, 5000) == WAIT_OBJECT_0, "host_network_control_timeout");
	DWORD networkControlExit = 1; check(GetExitCodeProcess(networkProcess.value, &networkControlExit) != FALSE, "host_network_control_status");
	int hostStartup = -1, hostError = -1, hostSocket = -1; LSTATUS hostCatalog = -1; std::string hostObservation;
	{ std::ifstream report(output / L"host-network.txt"); check(static_cast<bool>(report >> hostStartup >> hostError >> hostCatalog >> hostObservation >> hostSocket), "host_network_control_report"); }
	check(networkControlExit == 0 && hostStartup == 0 && hostSocket == 0 && hostError == 0 && hostCatalog == ERROR_SUCCESS && hostObservation == "connected", "same_probe_unsandboxed_network_control");
	networkThread.close(); networkProcess.close();
	std::cerr << "same_probe_network_control:startup=0; connected=true; catalogAccess=0\n";
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
	HANDLE outputRead = nullptr, outputWrite = nullptr;
	check(CreatePipe(&outputRead, &outputWrite, &inheritedAttributes, 4096) != FALSE, "explicit_output_pipe"); Handle explicitReader(outputRead), explicitWriter(outputWrite);
	check(SetHandleInformation(explicitReader.value, HANDLE_FLAG_INHERIT, 0) != FALSE, "private_output_reader");
	Handle emptyInput(CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &inheritedAttributes, OPEN_EXISTING, 0, nullptr)); check(emptyInput.value != INVALID_HANDLE_VALUE, "explicit_empty_stdin");
	const auto handleControl = launch(stage / L"worker.exe", quote((stage / L"worker.exe").wstring()) + L" --handle-control " + std::to_wstring(reinterpret_cast<ULONG_PTR>(privateFile.value)) + L" " + std::to_wstring(identity.dwVolumeSerialNumber) + L" " + std::to_wstring(fileId(identity)) + L" " + quote(stage.wstring()), stage, environment, profile.sid, job.value, true, registryRead ? registryCapability->sid : nullptr, explicitWriter.value, emptyInput.value);
	Handle handleProcess(handleControl.hProcess), handleThread(handleControl.hThread);
	check(WaitForSingleObject(handleProcess.value, 5000) == WAIT_OBJECT_0, "handle_control_timeout");
	DWORD handleExit = 1; check(GetExitCodeProcess(handleProcess.value, &handleExit) != FALSE, "handle_control_status");
	{ std::ifstream marker(output / L"handle-control.txt"); std::string entered; marker >> entered; check(entered == "entered", "handle_control_reached_query"); }
	check(handleExit == 0 || handleExit == 0xC0000008UL, "private_handle_not_inherited");
	handleThread.close(); handleProcess.close();
	const auto created = launch(stage / L"worker.exe", command, stage, environment, profile.sid, job.value, true, registryRead ? registryCapability->sid : nullptr);
	Handle process(created.hProcess), thread(created.hThread);
	const auto reportPath = output / L"report.txt";
	for (unsigned i = 0; i < 100 && !fs::exists(reportPath); ++i) {
		if (WaitForSingleObject(process.value, 50) == WAIT_OBJECT_0) break;
	}
	unsigned passed = 0; DWORD descendantPid = 0; int networkInitialization = -1, networkError = -1, networkSocket = -1; LSTATUS catalogAccess = -1; bool networkDenied = false; std::string networkObservation;
	{ std::ifstream report(reportPath); report >> passed >> descendantPid >> networkInitialization >> networkDenied >> networkError >> catalogAccess >> networkObservation >> networkSocket; }
	if (passed < (registryRead ? 15u : 13u)) {
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
	if (privateRegistry) privateRegistry->remove();
	std::ifstream diagnostic(output / L"network-diagnostic.txt"); std::string boundary; std::getline(diagnostic, boundary);
	std::cerr << "lpac_boundary:" << boundary << '\n';
	std::cout << "{\"schemaVersion\":\"windows-isolation-experiment.v2\",\"experimentOnly\":true,\"productionAdapterEnabled\":false,\"mode\":\"" << (diagnosticOnly ? "diagnostic" : "strict") << "\",";
	std::cout << "\"capabilityPolicy\":\"" << (registryRead ? "registry-read-only" : "zero-capabilities") << "\",\"capabilities\":" << (registryRead ? "[\"registryRead\"]" : "[]") << ",";
	if (registryRead) std::cout << "\"privateRegistryReadDenied\":true,\"privateRegistryWriteDenied\":true,\"privateRegistryDeleted\":true,";
	std::cout << "\"probe\":\"windows-lpac-fixed-program\",\"childAssertions\":" << passed << ",\"privateHandleNotInherited\":true,\"regularNetworkInitializationError\":" << regularNetworkInitialization << ",\"networkInitializationError\":" << networkInitialization << ",\"networkSocketError\":" << networkSocket << ",\"networkConnectionError\":" << networkError << ",\"catalogAccessError\":" << catalogAccess << ",\"networkObservation\":\"" << networkObservation << "\",\"unsandboxedNetworkControl\":{\"initializationError\":0,\"socketError\":0,\"connectionError\":0,\"catalogAccessError\":0,\"observation\":\"connected\"},\"networkAccessDenied\":" << (networkDenied ? "true" : "false") << ",\"singleProcessJobRestricted\":true,\"legalHostSingleProcessDenied\":true,\"legalHostJobTreeTerminated\":true,\"lpacProcessTerminated\":true,\"profileDeleted\":true}\n";
	const bool socketDenied = networkSocket == WSAEACCES && networkError == -1 && networkObservation == "socket_access_denied";
	const bool connectDenied = networkSocket == 0 && networkError == WSAEACCES && networkObservation == "access_denied";
	const bool networkVerified = passed == (registryRead ? 16u : 14u) && networkDenied && networkInitialization == 0 && (socketDenied || connectDenied);
	const bool characterizedUnavailable = passed == 13 && !networkDenied && networkInitialization == WSASYSCALLFAILURE && networkSocket == -1 && networkError == -1 && catalogAccess == ERROR_ACCESS_DENIED && networkObservation == "initialization_failed";
	return networkVerified || (diagnosticOnly && characterizedUnavailable) ? 0 : 1;
}

int wmain(int argc, wchar_t** argv) {
	SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
	try {
		check(argc == 5 && (std::wstring(argv[1]) == L"--probe" || std::wstring(argv[1]) == L"--diagnose" || std::wstring(argv[1]) == L"--registry-read"), "fixed_probe_arguments");
		return probe(argv[2], argv[3], argv[4], std::wstring(argv[1]) == L"--diagnose", std::wstring(argv[1]) == L"--registry-read");
	} catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
