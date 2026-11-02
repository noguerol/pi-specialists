/**
 * Budget types and defaults.
 *
 * A specialist's budget is the amount of work its server can take in one
 * request: context window, output reserve, image/audio limits and how many
 * items to batch. Values can be discovered from the server (see budget.ts) or
 * overridden per specialist in `specialists.json`.
 *
 * This module has no imports so config.ts can use normalizeBudget() without a
 * circular dependency on the HTTP probe.
 */

export interface BudgetOverrides {
	/** Context window in tokens (llama.cpp n_ctx, OpenAI context_window…). */
	contextTokens?: number;
	/** Tokens reserved for the answer. */
	maxOutputTokens?: number;
	/** Maximum image width/height before resizing. */
	maxImageSide?: number;
	/** Maximum image pixels (width × height) before resizing. */
	maxImagePixels?: number;
	/** Maximum audio seconds per request; longer audio is split. */
	maxAudioSeconds?: number;
	/** Maximum files/pages/chunks processed in one batch call. */
	maxItems?: number;
	/** Concurrent requests in a batch (1 = sequential, best for single-slot servers). */
	maxParallel?: number;
	/** DPI used to rasterise PDF pages. */
	pdfDpi?: number;
}

export interface Budget {
	contextTokens?: number;
	maxOutputTokens: number;
	maxImageSide: number;
	maxImagePixels: number;
	maxAudioSeconds: number;
	maxItems: number;
	maxParallel: number;
	pdfDpi: number;
	source: "config" | "probe" | "default";
	modalities?: { vision?: boolean; audio?: boolean };
}

export const DEFAULT_BUDGET: Omit<Budget, "source"> = {
	maxOutputTokens: 1_024,
	maxImageSide: 1_600,
	maxImagePixels: 2_000_000,
	maxAudioSeconds: 30,
	maxItems: 200,
	maxParallel: 1,
	pdfDpi: 150,
};

function positive(value: unknown): number | undefined {
	const number = Number(value);
	if (!Number.isFinite(number) || number <= 0) return undefined;
	return Math.round(number);
}

/** Coerce a raw budget object; unknown/invalid fields are dropped. */
export function normalizeBudget(raw: unknown): BudgetOverrides | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const obj = raw as Record<string, unknown>;
	const budget: BudgetOverrides = {};
	const fields: Array<keyof BudgetOverrides> = [
		"contextTokens",
		"maxOutputTokens",
		"maxImageSide",
		"maxImagePixels",
		"maxAudioSeconds",
		"maxItems",
		"maxParallel",
		"pdfDpi",
	];
	for (const field of fields) {
		const value = positive(obj[field]);
		if (value !== undefined) budget[field] = value;
	}
	return Object.keys(budget).length > 0 ? budget : undefined;
}

export function validateBudget(budget: BudgetOverrides | undefined): string[] {
	if (!budget) return [];
	const errors: string[] = [];
	const check = (field: keyof BudgetOverrides, min: number, max: number): void => {
		const value = budget[field];
		if (value === undefined) return;
		if (!Number.isInteger(value) || value < min || value > max) {
			errors.push(`budget.${field} must be an integer between ${min} and ${max}`);
		}
	};
	check("contextTokens", 256, 2_000_000);
	check("maxOutputTokens", 16, 131_072);
	check("maxImageSide", 128, 16_384);
	check("maxImagePixels", 10_000, 100_000_000);
	check("maxAudioSeconds", 1, 3_600);
	check("maxItems", 1, 2_000);
	check("maxParallel", 1, 16);
	check("pdfDpi", 36, 600);
	return errors;
}

export function budgetSummary(budget: Budget): string {
	const ctx = budget.contextTokens ? `ctx=${budget.contextTokens}` : "ctx=?";
	return [
		ctx,
		`out=${budget.maxOutputTokens}`,
		`img=${budget.maxImageSide}px/${(budget.maxImagePixels / 1_000_000).toFixed(1)}MP`,
		`audio=${budget.maxAudioSeconds}s`,
		`items=${budget.maxItems}`,
		`parallel=${budget.maxParallel}`,
		...(budget.modalities
			? [
					`mods=${[budget.modalities.vision ? "vision" : "", budget.modalities.audio ? "audio" : ""]
						.filter(Boolean)
						.join("+") || "none"}`,
				]
			: []),
		`source=${budget.source}`,
	].join(" · ");
}
