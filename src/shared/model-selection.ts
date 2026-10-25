/** Reasoning efforts supported by the SeekDock model picker. */
export const REASONING_LEVELS = [
	{ value: 'off', name: 'Off' },
	{ value: 'low', name: 'Low' },
	{ value: 'high', name: 'High' },
	{ value: 'max', name: 'Max' },
] as const;

/** Provider-owned models exposed by the SeekDock model picker. */
export const MODEL_OPTIONS = [
	{ value: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' },
	{ value: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
] as const;

export type SupportedModelId = (typeof MODEL_OPTIONS)[number]['value'];
export type ReasoningEffortId = (typeof REASONING_LEVELS)[number]['value'];

/** One model route and its adapter-owned reasoning effort. */
export interface ModelSelection {
	model: SupportedModelId;
	reasoningEffort: ReasoningEffortId;
}

/** Default route used until the user chooses another model or effort. */
export const DEFAULT_MODEL_SELECTION: ModelSelection = {
	model: 'deepseek-flash',
	reasoningEffort: 'low',
};

/**
 * @param model - Provider-owned model id.
 * @returns the matching picker option, if the model is supported.
 */
export function modelOption(model: string): (typeof MODEL_OPTIONS)[number] | undefined {
	return MODEL_OPTIONS.find(option => option.value === model);
}

/**
 * @param effort - Adapter-owned reasoning effort id.
 * @returns the matching picker option, if the effort is supported.
 */
export function reasoningLevel(
	effort: string,
): (typeof REASONING_LEVELS)[number] | undefined {
	return REASONING_LEVELS.find(option => option.value === effort);
}

/**
 * @param selection - Model route and reasoning effort.
 * @returns the compact label rendered by the composer trigger.
 */
export function displayModelSelection(
	selection: ModelSelection,
	reasoningName?: string,
): string {
	const model = modelOption(selection.model)?.name ?? selection.model;
	const effort = reasoningName
		?? reasoningLevel(selection.reasoningEffort)?.name
		?? selection.reasoningEffort;
	return `${model} ${effort}`;
}

/** @returns whether both parts of a selection are currently supported. */
export function isModelSelection(value: unknown): value is ModelSelection {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	return typeof candidate.model === 'string'
		&& modelOption(candidate.model) !== undefined
		&& typeof candidate.reasoningEffort === 'string'
		&& reasoningLevel(candidate.reasoningEffort) !== undefined;
}

/** @returns whether two selections address the same route and effort. */
export function sameModelSelection(a: ModelSelection, b: ModelSelection): boolean {
	return a.model === b.model && a.reasoningEffort === b.reasoningEffort;
}
