// Host broker for one fixed bounded operation. Job lifetime never substitutes for LPAC isolation.
#include "IsolationSupport.h"
#include <fstream>
#include <algorithm>
#include <objbase.h>
#include <sstream>

static bool ownerClosed() {
	DWORD available = 0;
	if (PeekNamedPipe(GetStdHandle(STD_INPUT_HANDLE), nullptr, 0, nullptr, &available, nullptr)) return false;
	check(GetLastError() == ERROR_BROKEN_PIPE, "owner_control_pipe"); return true;
}
static int run(const fs::path& stage, const std::wstring& name, const fs::path& input, const fs::path& worker, DWORD timeout, DWORD outputLimit) {
	check(name.size() == 43 && name.rfind(L"Packx.Text.", 0) == 0 && name.find_first_not_of(L"0123456789abcdef", 11) == std::wstring::npos, "private_profile_name");
	check(timeout >= 1 && timeout <= 60000 && outputLimit >= 1 && outputLimit <= 1048576, "bounded_limits");
	check(!fs::exists(stage) && fs::create_directory(stage), "exclusive_private_stage");
	std::string profileText; for (wchar_t c : name) profileText += static_cast<char>(c);
	{ std::ofstream owner(stage / L"broker.json"); owner << "{\"pid\":" << GetCurrentProcessId() << ",\"profile\":\"" << profileText << "\",\"creation\":\"intent\"}"; owner.close(); check(owner.good(), "record_broker_owner"); }
	check(fs::copy_file(input, stage / L"input.bin") && fs::copy_file(worker, stage / L"worker.exe"), "copy_fixed_inputs");
	Profile profile(name); RegistryCapability registry;
	grant(stage, profile.sid, FILE_GENERIC_READ | FILE_GENERIC_EXECUTE);
	grant(stage / L"input.bin", profile.sid, FILE_GENERIC_READ);
	grant(stage / L"worker.exe", profile.sid, FILE_GENERIC_READ | FILE_GENERIC_EXECUTE);
	Handle job(CreateJobObjectW(nullptr, nullptr)); check(job.value != nullptr, "create_job");
	JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
	limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_JOB_MEMORY | JOB_OBJECT_LIMIT_JOB_TIME;
	limits.BasicLimitInformation.ActiveProcessLimit = 1; limits.JobMemoryLimit = 64ULL * 1024 * 1024;
	limits.BasicLimitInformation.PerJobUserTimeLimit.QuadPart = 30LL * 10000000;
	check(SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) != FALSE, "set_job_limits");
	SECURITY_ATTRIBUTES inherited{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE}; HANDLE read = nullptr, write = nullptr;
	check(CreatePipe(&read, &write, &inherited, 65536) != FALSE, "output_pipe"); Handle reader(read), writer(write);
	check(SetHandleInformation(reader.value, HANDLE_FLAG_INHERIT, 0) != FALSE, "private_pipe_reader");
	Handle nullInput(CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &inherited, OPEN_EXISTING, 0, nullptr));
	check(nullInput.value != INVALID_HANDLE_VALUE, "empty_worker_stdin");
	wchar_t windows[MAX_PATH]{}; check(GetWindowsDirectoryW(windows, MAX_PATH) > 0, "windows_directory");
	LPWSTR sidText = nullptr, folder = nullptr;
	check(ConvertSidToStringSidW(profile.sid, &sidText) != FALSE, "private_profile_sid");
	const HRESULT folderResult = GetAppContainerFolderPath(sidText, &folder); LocalFree(sidText);
	if (FAILED(folderResult)) throw std::runtime_error("private_profile_folder:" + std::to_string(static_cast<unsigned long>(folderResult)));
	const std::wstring appData(folder); CoTaskMemFree(folder);
	std::wstring environment;
	for (const std::wstring& entry : { L"APPDATA=" + appData, std::wstring(L"LANG=en_US.UTF-8"), L"LOCALAPPDATA=" + appData, L"SystemDrive=" + fs::path(windows).root_name().wstring(), L"SystemRoot=" + std::wstring(windows), L"TEMP=" + appData, L"TMP=" + appData, L"USERPROFILE=" + appData, L"windir=" + std::wstring(windows) }) { environment += entry; environment += L'\0'; }
	environment += L'\0';
	check(!ownerClosed(), "owner_already_closed");
	const auto created = launch(stage / L"worker.exe", quote((stage / L"worker.exe").wstring()) + L" " + quote((stage / L"input.bin").wstring()), stage, environment, profile.sid, job.value, true, registry.sid, writer.value, nullInput.value);
	Handle process(created.hProcess), thread(created.hThread); writer.close(); nullInput.close();
	{ std::ofstream identity(stage / L"worker.json"); identity << "{\"pid\":" << created.dwProcessId << "}"; check(identity.good(), "record_owned_worker"); }
	std::string output, status = "succeeded"; const ULONGLONG start = GetTickCount64(); DWORD exit = STILL_ACTIVE;
	for (;;) {
		DWORD available = 0;
		if (PeekNamedPipe(reader.value, nullptr, 0, nullptr, &available, nullptr)) {
			if (available) {
				if (available > outputLimit - output.size()) { status = "resource_exhausted"; break; }
				char buffer[8192]; DWORD bytes = 0;
				check(ReadFile(reader.value, buffer, (std::min)(available, static_cast<DWORD>(sizeof(buffer))), &bytes, nullptr) != FALSE, "read_worker_output");
				output.append(buffer, bytes); continue;
			}
		} else check(GetLastError() == ERROR_BROKEN_PIPE, "worker_output_pipe");
		if (WaitForSingleObject(process.value, 0) == WAIT_OBJECT_0) { check(GetExitCodeProcess(process.value, &exit) != FALSE, "worker_exit"); if (exit != 0) status = "failed"; break; }
		if (ownerClosed()) { status = "cancelled"; break; }
		if (GetTickCount64() - start >= timeout) { status = "timed_out"; break; }
		Sleep(5);
	}
	check(TerminateJobObject(job.value, 1) != FALSE, "terminate_owned_job");
	check(WaitForSingleObject(process.value, 5000) == WAIT_OBJECT_0, "worker_cleanup");
	JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
	for (unsigned i = 0; i < 100; ++i) { check(QueryInformationJobObject(job.value, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr) != FALSE, "job_cleanup_count"); if (!accounting.ActiveProcesses) break; Sleep(10); }
	check(accounting.ActiveProcesses == 0, "job_still_active");
	process.close(); thread.close(); reader.close(); job.close();
	profile.remove();
	// The model never receives paths, profile names, or host environment through this result.
	std::ostringstream report;
	report << "{\"schemaVersion\":\"windows-text-execution.v1\",\"status\":\"" << status << "\",\"exitCode\":" << (exit == STILL_ACTIVE ? -1 : static_cast<long long>(exit)) << ",\"workerPid\":" << created.dwProcessId << ",\"cleanupVerified\":true,\"profileDeleted\":true,\"diagnostic\":" << (status == "failed" && exit == 2 ? output : "null") << ",\"inspection\":" << (status == "succeeded" ? output : "null") << "}\n";
	// The owner's stdout connection can disappear with the Host. Persist cleanup evidence independently.
	{ std::ofstream pending(stage / L"execution.pending", std::ios::binary); pending << report.str(); pending.close(); check(pending.good(), "persist_execution_evidence"); }
	fs::rename(stage / L"execution.pending", stage / L"execution.json");
	std::cout << report.str();
	return 0;
}
int wmain(int argc, wchar_t** argv) {
	SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
	try {
		check(argc == 7, "fixed_broker_arguments");
		return run(argv[1], argv[2], argv[3], argv[4], std::stoul(argv[5]), std::stoul(argv[6]));
	} catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
