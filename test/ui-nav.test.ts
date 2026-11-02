import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { normalizeConfig } from "../src/config.ts";
import { showConfigMenu } from "../src/ui.ts";

interface Scripted {
	titles: string[];
	select: Array<(title: string, options: string[]) => string | undefined>;
}

function scriptedContext(script: Scripted): ExtensionContext {
	return {
		mode: "tui",
		hasUI: true,
		cwd: "/tmp",
		signal: undefined,
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			notify: () => {},
			setStatus: () => {},
			select: async (title: string, options: string[]) => {
				script.titles.push(title);
				const next = script.select.shift();
				assert.ok(next, `unexpected select: ${title}`);
				return next(title, options);
			},
			confirm: async () => false,
			input: async () => undefined,
			editor: async () => undefined,
		},
	} as unknown as ExtensionContext;
}

const config = normalizeConfig({
	specialists: [{ name: "Test OCR", type: "ocr", baseUrl: "http://127.0.0.1" }],
});

const deps = {
	getConfig: () => config,
	save: () => true,
	refresh: () => {},
	doctor: () => "",
	configPath: "/tmp/specialists.json",
};

test("Esc in the type list returns to the family list, then to the main menu", async () => {
	const script: Scripted = {
		titles: [],
		select: [
			(_t, options) => options.find((option) => option.startsWith("➕")),
			(_t, options) => options.find((option) => option.startsWith("Vision")),
			() => undefined, // Esc in the type list
			(title) => {
				assert.equal(title, "Specialist family");
				return undefined; // Esc in the family list -> cancel the wizard
			},
			(title) => {
				assert.match(title, /^Specialists —/);
				return undefined; // Esc in the main menu -> close
			},
		],
	};
	await showConfigMenu(scriptedContext(script), deps);
	assert.equal(script.select.length, 0, "all scripted dialogs consumed");
	assert.ok(script.titles.filter((title) => title === "Specialist family").length >= 2);
});

test("Esc in the edit field list returns to the specialist list, then to the main menu", async () => {
	const script: Scripted = {
		titles: [],
		select: [
			(_t, options) => options.find((option) => option.startsWith("✏️")),
			(title, options) => {
				assert.equal(title, "Edit specialist");
				return options[0];
			},
			(title) => {
				assert.match(title, /— edit/);
				return undefined; // Esc in the field list
			},
			(title) => {
				assert.equal(title, "Edit specialist");
				return undefined; // Esc in the specialist list -> main
			},
			(title) => {
				assert.match(title, /^Specialists —/);
				return undefined; // close
			},
		],
	};
	await showConfigMenu(scriptedContext(script), deps);
	assert.equal(script.select.length, 0, "all scripted dialogs consumed");
	assert.ok(script.titles.includes("Edit specialist"));
});
