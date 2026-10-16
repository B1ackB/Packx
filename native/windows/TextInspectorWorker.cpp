// Fixed UTF-8 operation only. No scripts, dynamic commands, OCR, or document plugins.
#define NOMINMAX
#include <winsock2.h>
#include <windows.h>
#include <sddl.h>
#include <string>
#include <vector>
#include <stdexcept>

static void require(bool ok, const char* code) { if (!ok) throw std::runtime_error(code); }
static std::string inspect(const wchar_t* path) {
	HANDLE token = nullptr; require(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token) != FALSE, "token_unavailable");
	DWORD container = 0, size = 0;
	const BOOL containerRead = GetTokenInformation(token, TokenIsAppContainer, &container, sizeof(container), &size);
	GetTokenInformation(token, TokenCapabilities, nullptr, 0, &size); std::vector<BYTE> bytes(size);
	const BOOL capsRead = size && GetTokenInformation(token, TokenCapabilities, bytes.data(), size, &size);
	CloseHandle(token); require(containerRead && container == 1 && capsRead, "token_boundary_missing");
	auto caps = reinterpret_cast<TOKEN_GROUPS*>(bytes.data());
	PSID* groups = nullptr; PSID* capabilities = nullptr; DWORD groupCount = 0, count = 0;
	const BOOL derived = DeriveCapabilitySidsFromName(L"registryRead", &groups, &groupCount, &capabilities, &count);
	const bool exact = derived && count == 1 && caps->GroupCount == 1 && EqualSid(caps->Groups[0].Sid, capabilities[0]) && (caps->Groups[0].Attributes & SE_GROUP_ENABLED);
	if (groups) { for (DWORD i = 0; i < groupCount; ++i) LocalFree(groups[i]); LocalFree(groups); }
	if (capabilities) { for (DWORD i = 0; i < count; ++i) LocalFree(capabilities[i]); LocalFree(capabilities); }
	require(exact, "capability_boundary_missing");
	WSADATA sockets{}; require(WSAStartup(MAKEWORD(2, 2), &sockets) == 0, "network_initialization_failed");
	SOCKET connection = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP); const int denied = connection == INVALID_SOCKET ? WSAGetLastError() : 0;
	if (connection != INVALID_SOCKET) closesocket(connection); WSACleanup();
	require(denied == WSAEACCES, "network_boundary_not_verified");
	HANDLE file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
	require(file != INVALID_HANDLE_VALUE, "input_unavailable");
	BY_HANDLE_FILE_INFORMATION info{}; const BOOL identified = GetFileInformationByHandle(file, &info);
	if (!identified || (info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) || info.nNumberOfLinks != 1 || info.nFileSizeHigh || !info.nFileSizeLow || info.nFileSizeLow > 131072) { CloseHandle(file); throw std::runtime_error("input_limit_or_identity"); }
	std::string text(info.nFileSizeLow, '\0'); DWORD read = 0;
	const BOOL loaded = ReadFile(file, text.data(), info.nFileSizeLow, &read, nullptr); CloseHandle(file);
	require(loaded && read == info.nFileSizeLow, "input_read_failed");
	require(text.find('\0') == std::string::npos, "binary_content");
	require(text.rfind("%PDF-", 0) != 0 && text.rfind("PK", 0) != 0, "unsupported_format");
	require(MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), nullptr, 0) > 0, "invalid_encoding");
	if (text.rfind("\xef\xbb\xbf", 0) == 0) text.erase(0, 3);
	require(!text.empty(), "empty_input");
	std::string escaped; escaped.reserve(text.size()); const char* hex = "0123456789abcdef";
	for (unsigned char c : text) {
		if (c == '"' || c == '\\') { escaped += '\\'; escaped += static_cast<char>(c); }
		else if (c < 32) { escaped += "\\u00"; escaped += hex[c >> 4]; escaped += hex[c & 15]; }
		else escaped += static_cast<char>(c);
	}
	return "{\"schemaVersion\":\"asset-inspection.v1\",\"bytes\":" + std::to_string(info.nFileSizeLow) + ",\"kind\":\"text\",\"status\":\"parsed\",\"pages\":[{\"page\":1,\"text\":\"" + escaped + "\",\"method\":\"text\"}],\"pageCount\":1,\"truncated\":false}";
}
int wmain(int argc, wchar_t** argv) {
	SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
	std::string output; int code = 0;
	try { require(argc == 2, "fixed_arguments_required"); output = inspect(argv[1]); }
	catch (const std::exception& error) { output = std::string("{\"error\":\"") + error.what() + "\"}"; code = 2; }
	DWORD written = 0; if (!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), output.data(), static_cast<DWORD>(output.size()), &written, nullptr) || written != output.size()) return 3;
	return code;
}
