import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkspaceTutorial, tutorialPlacement, tutorialSteps } from "./WorkspaceTutorial";

describe("workspace tutorial placement", () => {
	it.each([
		["desktop source", { left: 1094, top: 450, width: 320, height: 120 }, { left: 0, top: 0, width: 1440, height: 900 }],
		["narrow source", { left: 26, top: 400, width: 335, height: 130 }, { left: 0, top: 0, width: 390, height: 844 }],
		["bottom composer", { left: 12, top: 650, width: 366, height: 164 }, { left: 0, top: 0, width: 390, height: 844 }],
		["top control", { left: 12, top: 80, width: 290, height: 42 }, { left: 0, top: 0, width: 320, height: 568 }],
		["zoomed viewport", { left: 72, top: 110, width: 250, height: 42 }, { left: 60, top: 70, width: 320, height: 500 }],
	] as const)("keeps the card visible without covering %s", (_name, target, viewport) => {
		const card = tutorialPlacement(target, { width: 352, height: 290 }, viewport);
		expect(card.left).toBeGreaterThanOrEqual(viewport.left);
		expect(card.top).toBeGreaterThanOrEqual(viewport.top);
		expect(card.left + card.width).toBeLessThanOrEqual(viewport.left + viewport.width);
		expect(card.top + card.height).toBeLessThanOrEqual(viewport.top + viewport.height);
		expect(card.left + card.width <= target.left || card.left >= target.left + target.width || card.top + card.height <= target.top || card.top >= target.top + target.height).toBe(true);
	});

	it("centers a missing target without depending on a task or a business action", () => {
		const card = tutorialPlacement(undefined, { width: 352, height: 420 }, { left: 0, top: 0, width: 320, height: 400 });
		expect(card).toEqual({ left: 12, top: 12, width: 296, height: 376 });
	});
});

it("renders all seven steps and explicit exits in both languages without running callbacks", () => {
	expect(tutorialSteps).toHaveLength(7);
	const unexpectedAction = () => { throw new Error("Rendering a tutorial must not perform an action"); };
	for (const language of ["zh", "en"] as const) {
		for (const [step, item] of tutorialSteps.entries()) {
			const markup = renderToStaticMarkup(<WorkspaceTutorial language={language} step={step} onStep={unexpectedAction} onClose={unexpectedAction} />);
			expect(markup.replaceAll("&#x27;", "'")).toContain(item.title[language === "en" ? 1 : 0]);
			expect(markup).toContain(language === "en" ? "Exit tutorial" : "退出教程");
			expect(markup).toContain('aria-labelledby="tutorial-title"');
			expect(markup).toContain(step === 6 ? language === "en" ? "Finish" : "完成" : language === "en" ? "Next" : "下一步");
			if (language === "en") expect(markup).not.toMatch(/\p{Script=Han}/u);
		}
	}
});
