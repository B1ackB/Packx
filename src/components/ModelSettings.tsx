import { useEffect, useState } from "react";
import { ConversationClient } from "../runtime/conversationClient";
import type { ModelSettingsView } from "../runtime/modelSettings";
import type { Language } from "../i18n";

const client = new ConversationClient();
export function ModelSettings({ language }: { language: Language }) {
	const en = language === "en";
	const [value, setValue] = useState<ModelSettingsView>();
	const [key, setKey] = useState("");
	const [clearKey, setClearKey] = useState(false);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");
	useEffect(() => { void client.modelSettings().then(setValue).catch(() => setMessage("load_failed")); }, []);
	const messages: Record<string, string> = {
		saved: en ? "Saved. Stop and reopen Packx to apply. No model request was sent." : "已保存。停止并重新打开 Packx 后生效；本次未发送模型请求。",
		settings_revision_conflict: en ? "Settings changed in another window. Reopen this panel before saving." : "配置已在其他窗口更改，请重新打开面板后保存。",
		provider_key_required: en ? "Enter the access key supplied by your service provider." : "请填写服务商提供的连接密钥。",
		invalid_provider_url: en ? "Check the service address supplied by your administrator." : "请核对管理员提供的服务地址，勿附带账号或额外内容。",
		model_id_required: en ? "Enter the model name supplied by your service provider." : "请填写服务商提供的模型名称。",
	};
	return <section className="model-settings">
		<h3>{en ? "Model connection" : "模型连接"}</h3>
		<p>{en ? "Use the connection details supplied by your administrator. Ask them to confirm service compatibility." : "填写管理员提供的连接信息，服务是否适用请由管理员确认。"}</p>
		{value && <form onSubmit={(event) => {
			event.preventDefault(); setBusy(true); setMessage("");
			void client.saveModelSettings({ revision: value.revision, mode: value.mode, baseUrl: value.baseUrl, model: value.model, apiKey: key || undefined, clearKey })
				.then((next) => { setValue(next); setKey(""); setClearKey(false); setMessage("saved"); })
				.catch((error: { code?: string }) => { setKey(""); setMessage(error.code ?? "save_failed"); })
				.finally(() => setBusy(false));
		}}>
			<label>{en ? "Connection mode" : "连接模式"}<select value={value.mode} onChange={(e) => setValue({ ...value, mode: e.target.value as ModelSettingsView["mode"] })}><option value="fake">{en ? "Browse only · offline" : "仅浏览 · 不连接模型"}</option><option value="anthropic">{en ? "Connect model service" : "连接模型服务"}</option></select></label>
			<label>{en ? "Service URL" : "服务地址"}<input type="url" required value={value.baseUrl} onChange={(e) => setValue({ ...value, baseUrl: e.target.value })} placeholder="https://api.anthropic.com" /></label>
			<label>{en ? "Model name" : "模型名称"}<input maxLength={200} value={value.model} onChange={(e) => setValue({ ...value, model: e.target.value })} /></label>
			<label>{en ? "Access key" : "连接密钥"}<input type="password" autoComplete="new-password" value={key} maxLength={8192} onChange={(e) => { setKey(e.target.value); setClearKey(false); }} placeholder={value.keyConfigured ? en ? "Configured · leave blank to retain" : "已配置 · 留空保留" : en ? "Enter the key from your service provider" : "填写服务商提供的密钥"} /></label>
			<small>{en ? "Your access key stays on this device and is excluded from task backups." : "连接密钥仅保存在本机，不包含在业务备份中。"}</small>
			{value.keyConfigured && <label className="settings-checkbox"><input type="checkbox" checked={clearKey} onChange={(e) => { setClearKey(e.target.checked); setKey(""); }} />{en ? "Remove the current key and disable previously configured keys" : "清除当前密钥，并停用此前配置的密钥"}</label>}
			<button className="primary-action" disabled={busy}>{busy ? en ? "Saving…" : "保存中…" : en ? "Save connection" : "保存配置"}</button>
			{value.restartRequired && <p>{en ? "Restart required. Running tasks keep their current model." : "等待重启生效。正在执行的任务继续使用当前模型。"}</p>}
		</form>}
		{message && <p role="status">{messages[message] ?? (en ? "Unable to save or load settings. Check the fields and reopen the panel to retry." : "无法保存或读取配置，请检查填写内容并重新打开面板重试。")}</p>}
	</section>;
}
