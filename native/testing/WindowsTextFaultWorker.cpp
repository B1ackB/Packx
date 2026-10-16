// Deliberately non-terminating fixed CI fixture. Never registered as a production tool.
#include <windows.h>
#include <fstream>
#include <string>
int wmain(int argc, wchar_t** argv) {
	if (argc == 2) { std::ifstream input(argv[1]); std::string mode; input >> mode;
		if (mode == "output") { const std::string chunk(8192, 'x'); DWORD written = 0; for (unsigned i = 0; i < 256; ++i) WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), chunk.data(), static_cast<DWORD>(chunk.size()), &written, nullptr); }
	}
	Sleep(INFINITE); return 1;
}
