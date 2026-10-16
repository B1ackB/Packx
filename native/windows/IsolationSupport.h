// Packx-owned LPAC launch primitives. No fallback to an unrestricted child.
#pragma once
#define NOMINMAX
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <userenv.h>
#include <filesystem>
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
		const HRESULT hr = CreateAppContainerProfile(name.c_str(), L"Packx isolated process", L"Temporary Packx process", nullptr, 0, &sid);
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

struct RegistryCapability {
	PSID sid = nullptr;
	RegistryCapability() {
		PSID* groups = nullptr; PSID* capabilities = nullptr; DWORD groupCount = 0, count = 0;
		const BOOL derived = DeriveCapabilitySidsFromName(L"registryRead", &groups, &groupCount, &capabilities, &count);
		const DWORD failure = derived ? ERROR_INVALID_DATA : GetLastError();
		if (groups) for (DWORD i = 0; i < groupCount; ++i) LocalFree(groups[i]);
		if (groups) LocalFree(groups);
		if (derived && capabilities && count == 1) sid = capabilities[0];
		else if (capabilities) for (DWORD i = 0; i < count; ++i) LocalFree(capabilities[i]);
		if (capabilities) LocalFree(capabilities);
		if (!sid) throw std::runtime_error("derive_registry_read_capability:" + std::to_string(failure));
	}
	~RegistryCapability() { if (sid) LocalFree(sid); }
};
// Only grant access to Host-owned staging copies; never mutate source or system ACLs.
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
inline void lowLabel(const fs::path& path) {
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
static PROCESS_INFORMATION launch(const fs::path& executable, std::wstring command, const fs::path& directory, std::wstring& environment, PSID sid, HANDLE job, bool lpac, PSID registryCapability = nullptr, HANDLE output = nullptr, HANDLE input = nullptr) {
	const DWORD count = (lpac ? 2u : 1u) + (output ? 1u : 0u);
	SIZE_T size = 0; InitializeProcThreadAttributeList(nullptr, count, 0, &size);
	std::vector<BYTE> attributes(size);
	auto list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.data());
	check(InitializeProcThreadAttributeList(list, count, 0, &size) != FALSE, "create_attributes");
	SECURITY_CAPABILITIES security{}; security.AppContainerSid = sid;
	SID_AND_ATTRIBUTES capability{registryCapability, SE_GROUP_ENABLED};
	if (registryCapability) { security.Capabilities = &capability; security.CapabilityCount = 1; }
	DWORD policy = PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT;
	check(UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &security, sizeof(security), nullptr, nullptr) != FALSE, "set_appcontainer");
	if (lpac) check(UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY, &policy, sizeof(policy), nullptr, nullptr) != FALSE, "set_lpac");
	HANDLE inherited[] = {output, input};
	if (output) check(UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, sizeof(inherited), nullptr, nullptr) != FALSE, "set_explicit_handles");
	STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup); startup.lpAttributeList = list;
	if (output) { startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES; startup.StartupInfo.hStdOutput = output; startup.StartupInfo.hStdError = output; startup.StartupInfo.hStdInput = input; }
	PROCESS_INFORMATION created{};
	const BOOL launched = CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, output ? TRUE : FALSE, CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW, environment.data(), directory.c_str(), &startup.StartupInfo, &created);
	const DWORD error = GetLastError(); DeleteProcThreadAttributeList(list);
	if (!launched) throw std::runtime_error("create_appcontainer_suspended:" + std::to_string(error));
	if (!AssignProcessToJobObject(job, created.hProcess) || ResumeThread(created.hThread) == static_cast<DWORD>(-1)) {
		const DWORD failure = GetLastError(); TerminateProcess(created.hProcess, 1); WaitForSingleObject(created.hProcess, 5000); CloseHandle(created.hThread); CloseHandle(created.hProcess);
		throw std::runtime_error("assign_job_and_resume:" + std::to_string(failure));
	}
	return created;
}

