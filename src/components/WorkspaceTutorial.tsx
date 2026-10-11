import { useLayoutEffect, useRef, useState } from "react";
import type { Language } from "../i18n";
import "./workspaceTutorial.css";

// Stable UI anchors only. Steps may reveal UI, but never invoke business commands.
export const tutorialSteps = [
	{
		id: "intake", targets: ["start-request", "intake"], panel: "conversation",
		title: ["提供客户要求与资料", "Add the customer's request"],
		body: ["先新建需求，再描述客户要求、添加附件并发送。未知信息可以先留空。若提示模型未连接，先完成模型设置。已有输入会保留，教程结束后再操作。", "Start a request, describe the customer's needs, add files and send. Unknown details can wait. If no model is connected, open Model settings first. Your input is kept; act after the tutorial."],
	},
	{
		id: "draft", targets: ["generate"], panel: "requirement",
		title: ["生成待核对的草稿", "Create a draft to review"],
		body: ["发送要求后，点击“生成需求单”提取候选信息。草稿尚未批准，AI 提取的值也未确认。已有草稿时先核对下一步的来源，无需重复生成。", "After sending the request, use Create requirement brief to extract candidate information. A draft is unapproved and AI values are unconfirmed. If a draft already exists, review its sources next."],
	},
	{
		id: "sources", targets: ["source"], panel: "requirement",
		title: ["对照原文核对", "Check the original source"],
		fallback: ["生成草稿后会出现候选信息及来源；没有可核对的原文时，请补充客户资料。", "Candidates and sources appear after a draft is generated. Add customer material if the original source is unavailable."],
		body: ["在需求单的信息核对区展开“核对原文”，比较提取值和客户资料。摘录不完整、识别有误或来源冲突时，先查看原附件或向客户澄清，再确认。", "In the brief’s information review area, open Check source and compare the value with the customer's material. For incomplete excerpts, reading errors or conflicts, check the attachment or clarify with the customer first."],
	},
	{
		id: "confirm", targets: ["confirm", "fact-form"], panel: "requirement",
		title: ["补充并确认必要信息", "Complete and confirm information"],
		fallback: ["生成草稿后才有待确认字段。已全部确认时，可以继续查看生成新版本的步骤。", "Confirmation controls follow the first draft. If everything is already confirmed, continue to the new-version step."],
		body: ["“待确认”表示还不能当作已核实要求。核对无误后逐项确认；有误可拒绝，缺失或变更可在修改表补充后再确认。客户的新值不会自动覆盖已确认值。", "Unconfirmed values are not verified requirements. Confirm each checked value, reject errors, and use the edit form for missing or changed information before confirming it. New values never silently replace confirmed ones."],
	},
	{
		id: "regenerate", targets: ["generate"], panel: "requirement",
		title: ["生成包含确认结果的新版本", "Generate the reviewed version"],
		body: ["信息补齐并确认后，生成新版本并查看检查结果。上游资料或事实变化会使旧版本及审批失效。中断或失败时资料保留，按页面提示继续回复、重新审查或重新执行。", "After completing and confirming the information, generate a new version and check the review results. Source or fact changes invalidate earlier versions and approvals. Saved material remains after interruptions; use the offered resume or re-review action."],
	},
	{
		id: "approve", targets: ["approve"], panel: "requirement",
		title: ["批准核对过的当前版本", "Approve the current version"],
		fallback: ["必要信息确认且检查通过后才出现审批入口；已批准的版本可在需求单状态中核对。", "Approval appears once required information is confirmed and checks pass. An already approved version shows its status in the brief."],
		body: ["必要信息已确认且检查通过后，才会出现“批准当前版本”。先核对需求单的版本号与内容，再批准或拒绝。“已批准”只适用于这一个版本。", "Approve current version appears after required information is confirmed and checks pass. Review the version number and contents, then approve or reject. Approved applies only to that specific version."],
	},
	{
		id: "export", targets: ["export"], panel: "requirement",
		title: ["导出交接并留意版本状态", "Export for handoff"],
		fallback: ["生成需求单后会出现导出入口；正式交接前，先核对当前版本已批准。", "Exports appear after a draft is generated. For handoff, first check that the current version is approved."],
		body: ["正式交接前确认当前版本为“已批准”，再导出文本或打印版。草稿和历史版本的导出带有状态标识，不能当作当前批准件。客户改要求后，重新核对、生成并审批。", "For handoff, select the current Approved version, then export text or a print version. Draft and historical exports carry their status and are not the current approved deliverable. Customer changes require a new review, version and approval."],
	},
] as const;

type Rect = { left: number; top: number; width: number; height: number };
const gap = 12;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, Math.max(min, max)));

/** Choose a free side before clamping. A small viewport uses the available space above/below. */
export function tutorialPlacement(target: Rect | undefined, card: { width: number; height: number }, viewport: Rect): Rect {
	const right = viewport.left + viewport.width, bottom = viewport.top + viewport.height;
	const width = Math.min(card.width, Math.max(0, viewport.width - gap * 2));
	let height = Math.min(card.height, Math.max(0, viewport.height - gap * 2));
	if (!target) return { left: viewport.left + (viewport.width - width) / 2, top: viewport.top + (viewport.height - height) / 2, width, height };
	const x = clamp(target.left, viewport.left + gap, right - width - gap);
	const y = clamp(target.top, viewport.top + gap, bottom - height - gap);
	if (target.left - width - gap >= viewport.left + gap) return { left: target.left - width - gap, top: y, width, height };
	if (target.left + target.width + width + gap * 2 <= right) return { left: target.left + target.width + gap, top: y, width, height };
	const above = target.top - viewport.top - gap * 2;
	const below = bottom - target.top - target.height - gap * 2;
	const useBelow = below >= height || below > above;
	height = Math.max(0, Math.min(height, useBelow ? below : above));
	return { left: x, top: useBelow ? target.top + target.height + gap : target.top - height - gap, width, height };
}

export function WorkspaceTutorial({ language, step, onStep, onClose }: {
	language: Language; step: number; onStep: (step: number) => void; onClose: () => void;
}) {
	const dialogRef = useRef<HTMLDialogElement>(null);
	const cardRef = useRef<HTMLDivElement>(null);
	const titleRef = useRef<HTMLHeadingElement>(null);
	const scrollRef = useRef<HTMLElement | null>(null);
	const [layout, setLayout] = useState<{ target?: Rect; card: Rect; fallback: boolean }>();
	const item = tutorialSteps[step];
	const en = language === "en", locale = en ? 1 : 0;

	useLayoutEffect(() => {
		const dialog = dialogRef.current!;
		dialog.showModal();
		return () => dialog.close();
	}, []);

	useLayoutEffect(() => {
		const card = cardRef.current!;
		const opened = new Map<HTMLDetailsElement, boolean>();
		const scrollPositions = new Map<HTMLElement, number>();
		let frame = 0, previousTarget: HTMLElement | undefined;
		const reveal = (target: HTMLElement) => {
			scrollRef.current = null;
			for (let parent: HTMLElement | null = target; parent; parent = parent.parentElement) {
				if (parent instanceof HTMLDetailsElement && !parent.open) { opened.set(parent, false); parent.open = true; }
				if (parent.scrollHeight > parent.clientHeight && /auto|scroll/.test(getComputedStyle(parent).overflowY)) {
					if (!scrollPositions.has(parent)) scrollPositions.set(parent, parent.scrollTop);
					scrollRef.current ??= parent;
				}
			}
			target.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
		};
		const measure = () => {
			frame = 0;
			const visual = window.visualViewport;
			const viewport = { left: visual?.offsetLeft ?? 0, top: visual?.offsetTop ?? 0, width: visual?.width ?? window.innerWidth, height: visual?.height ?? window.innerHeight };
			const visible = (node: HTMLElement | null): node is HTMLElement => !!node && getComputedStyle(node).display !== "none" && !node.closest("[hidden]") && (node.getClientRects().length > 0 || !!node.closest("details:not([open])"));
			const primary = item.targets.map((id) => document.querySelector<HTMLElement>(`[data-tour="${id}"]`)).find(visible);
			const target = primary ?? ["brief-overview", "brief-tab"].map((id) => document.querySelector<HTMLElement>(`[data-tour="${id}"]`)).find(visible);
			if (target && target !== previousTarget) {
				if (previousTarget) observer.unobserve(previousTarget);
				reveal(target); previousTarget = target; observer.observe(target);
			}
			let rect: Rect | undefined;
			if (target) {
				const box = target.getBoundingClientRect();
				let left = Math.max(viewport.left + 6, box.left - 4), top = Math.max(viewport.top + 6, box.top - 4);
				let right = Math.min(viewport.left + viewport.width - 6, box.right + 4), bottom = Math.min(viewport.top + viewport.height - 6, box.bottom + 4);
				// Clip the spotlight to the scroll container so hidden content is never highlighted.
				for (let parent = target.parentElement; parent; parent = parent.parentElement) {
					if (!/auto|scroll|hidden/.test(getComputedStyle(parent).overflowY)) continue;
					const bounds = parent.getBoundingClientRect();
					top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom);
					left = Math.max(left, bounds.left); right = Math.min(right, bounds.right);
				}
				if (right > left && bottom > top) rect = { left, top, width: right - left, height: bottom - top };
			}
			const width = Math.min(352, viewport.width - 24);
			// Measure natural content, not the last constrained height (which would shrink on every observation).
			const previousWidth = card.style.width, previousHeight = card.style.maxHeight;
			const copy = card.querySelector<HTMLElement>(".tutorial-copy")!;
			const copyScrollTop = copy.scrollTop, cardScrollTop = card.scrollTop;
			card.style.width = `${width}px`; card.style.maxHeight = "none";
			const height = card.getBoundingClientRect().height;
			card.style.width = previousWidth; card.style.maxHeight = previousHeight;
			copy.scrollTop = copyScrollTop; card.scrollTop = cardScrollTop;
			let placement = tutorialPlacement(rect, { width, height }, viewport);
			// On a very short viewport, keep the controls usable instead of trapping users in a zero-height card.
			if (placement.height < 160) { rect = undefined; placement = tutorialPlacement(undefined, { width, height }, viewport); }
			setLayout({ target: rect, card: placement, fallback: !primary });
		};
		const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
		const reposition = () => { previousTarget = undefined; schedule(); };
		const observer = new ResizeObserver(schedule);
		observer.observe(document.getElementById("root")!); observer.observe(card);
		const mutations = new MutationObserver(schedule);
		mutations.observe(document.getElementById("root")!, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["open", "hidden", "class"] });
		window.addEventListener("resize", reposition);
		document.addEventListener("scroll", schedule, true);
		window.visualViewport?.addEventListener("resize", reposition);
		window.visualViewport?.addEventListener("scroll", schedule);
		measure(); titleRef.current?.focus({ preventScroll: true });
		return () => {
			cancelAnimationFrame(frame); observer.disconnect(); mutations.disconnect();
			window.removeEventListener("resize", reposition); document.removeEventListener("scroll", schedule, true);
			window.visualViewport?.removeEventListener("resize", reposition); window.visualViewport?.removeEventListener("scroll", schedule);
			opened.forEach((open, element) => { element.open = open; });
			scrollPositions.forEach((top, element) => { element.scrollTop = top; });
		};
	}, [item, language]);

	const target = layout?.target;
	return <dialog ref={dialogRef} className="workspace-tutorial" aria-labelledby="tutorial-title" aria-describedby="tutorial-description" onWheel={(event) => {
		if (!cardRef.current?.contains(event.target as Node)) scrollRef.current?.scrollBy({ top: event.deltaY, left: event.deltaX });
	}} onCancel={(event) => { event.preventDefault(); onClose(); }} onKeyDown={(event) => {
		if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
		if (event.key === "ArrowRight" || event.key === "ArrowLeft") { event.preventDefault(); onStep(clamp(step + (event.key === "ArrowRight" ? 1 : -1), 0, tutorialSteps.length - 1)); }
		if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); cardRef.current?.querySelector(".tutorial-copy")?.scrollBy({ top: event.key === "ArrowDown" ? 60 : -60 }); }
		if (event.key === "Tab") {
			const buttons = [...cardRef.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
			const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
			const next = index < 0 ? event.shiftKey ? buttons.length - 1 : 0 : (index + (event.shiftKey ? buttons.length - 1 : 1)) % buttons.length;
			event.preventDefault(); buttons[next]?.focus();
		}
	}}>
		<svg className="tutorial-shade" aria-hidden="true" width="100%" height="100%">
			<defs><mask id="tutorial-spotlight"><rect width="100%" height="100%" fill="white" />{target && <rect x={target.left} y={target.top} width={target.width} height={target.height} rx="8" fill="black" />}</mask></defs>
			<rect width="100%" height="100%" fill="#1c1b18" fillOpacity=".66" mask="url(#tutorial-spotlight)" />
			{target && <rect x={target.left} y={target.top} width={target.width} height={target.height} rx="8" fill="none" stroke="#ef9479" strokeWidth="2" />}
		</svg>
		<div ref={cardRef} className="tutorial-card" style={layout ? { left: layout.card.left, top: layout.card.top, width: layout.card.width, maxHeight: layout.card.height } : undefined}>
			<div className="tutorial-meta"><span>{en ? "Getting started" : "使用教程"} · {step + 1} / {tutorialSteps.length}</span><button type="button" onClick={onClose}>{en ? "Exit tutorial" : "退出教程"}</button></div>
			<div className="tutorial-copy" aria-live="polite" aria-atomic="true">
				<h2 id="tutorial-title" tabIndex={-1} ref={titleRef}>{item.title[locale]}</h2>
				<p id="tutorial-description">{item.body[locale]}</p>
				{layout?.fallback && <p className="tutorial-fallback">{"fallback" in item ? item.fallback[locale] : en ? "This control is not available in the current view. You can continue or exit the tutorial." : "当前界面尚无此操作入口，可以继续查看或退出教程。"}</p>}
			</div>
			<div className="tutorial-actions"><button type="button" disabled={step === 0} onClick={() => onStep(step - 1)}>{en ? "Previous" : "上一步"}</button><button type="button" className="primary-action" onClick={() => step === tutorialSteps.length - 1 ? onClose() : onStep(step + 1)}>{step === tutorialSteps.length - 1 ? en ? "Finish" : "完成" : en ? "Next" : "下一步"}</button></div>
			<small>{en ? "↑ ↓ read · ← → steps · Esc exits · Preview only" : "↑ ↓ 查看说明 · ← → 切换 · Esc 退出 · 仅演示"}</small>
		</div>
	</dialog>;
}
