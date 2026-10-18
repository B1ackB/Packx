import type { RuntimeHealth } from "./contracts";

/** Host product capabilities, separate from Agent Runtime health and model availability. */
export interface DocumentCapabilities {
	scope: "windows-utf8" | "macos-documents" | "unavailable";
	components: "present" | "missing" | "unsupported";
	extensions: string[];
	maxBytes: number;
	isolationVerification: "per-execution";
}
export interface HostRuntimeHealth extends RuntimeHealth {
	documents?: DocumentCapabilities;
	localHost?: { instanceId: string; installationId: string; dataRootId: string };
}

export function documentCapabilityText(capability: DocumentCapabilities | undefined, english: boolean) {
	if (!capability) return english ? "Document reading capability not confirmed" : "文档读取能力尚未确认";
	if (capability.scope === "unavailable") return english ? "Document reading is unavailable on this platform" : "此平台暂不提供文档读取";
	if (capability.components === "missing") return english ? "Document components are missing. Check the installation." : "缺少本机读取组件，请检查安装或使用完整发行包。";
	if (capability.scope === "windows-utf8") return english ? "Windows: UTF-8 text only, up to 128 KiB. PDF, Office and OCR are unavailable. Protection is checked on every read." : "Windows 仅支持 128 KiB 内的 UTF-8 文本；PDF、Office 和扫描识别不可用。每次读取均检查本机保护。";
	return english ? "Local PDF, Word and Excel reading. Review extracted text and scan recognition." : "本机支持 PDF、Word 和 Excel 读取；提取文字及扫描识别结果仍需核对。";
}
