/**
 * Product presentation shared by the permission picker and its risk dialogs.
 *
 * These are the built-in labels and confirmation copy used by DeepSeek
 * Harness Desktop. Host-supplied preset names and descriptions always win, so a
 * deployment can rename or describe its own presets without losing the picker.
 */

import type { PermissionOption } from './rpc.ts';
import { translate, type Language } from './i18n/index.ts';

/** The confirmation gate a preset needs before it becomes current. */
export type PermissionRisk = 'full-access' | 'auto-review';

/** Copy shown by the one-shot experimental risk dialog. */
export interface PermissionRiskCopy {
	title: string;
	description: string;
	acknowledge: string;
	cancel: string;
	confirm: string;
}

const BUILT_IN_LABEL_KEYS = {
	'read-only': 'permissionReadOnly',
	'workspace-write': 'permissionWorkspaceWrite',
	'danger-full-access': 'permissionFullAccess',
	custom: 'permissionCustom',
} as const;

const BUILT_IN_LABEL_VALUES: Readonly<Record<string, string>> = {
	'read-only': 'Read Only',
	'workspace-write': 'Workspace Write',
	'danger-full-access': 'Full access',
	custom: 'Custom',
};

const DEFAULT_ENGLISH_LABELS: Readonly<Record<string, string>> = {
	'read-only': 'Read Only',
	'workspace-write': 'Workspace Write',
	'danger-full-access': 'Full access',
};

/** @returns the localized label for one catalog option. */
export function displayPermissionLabel(
	value: string,
	name: string,
	language: Language = 'en',
): string {
	if (value === 'auto') {
		return translate(language, 'permissionAutoReview');
	}
	const builtInKey = BUILT_IN_LABEL_KEYS[value as keyof typeof BUILT_IN_LABEL_KEYS];
	if (builtInKey !== undefined
		&& (name === value || name === DEFAULT_ENGLISH_LABELS[value])) {
		return translate(language, builtInKey);
	}
	return displayPresetName(name);
}

/** @returns the menu description, preferring product copy for Auto review. */
export function displayPermissionDescription(
	option: PermissionOption,
	language: Language = 'en',
): string | undefined {
	if (option.value === 'auto') {
		return translate(language, 'permissionAutoDescription');
	}
	if (option.value === 'custom') {
		return translate(language, 'permissionCustomDescription');
	}
	return option.description;
}

/** @returns the `EXP` badge shown beside the Auto review option. */
export function permissionBadge(value: string): string | undefined {
	return value === 'auto' ? 'EXP' : undefined;
}

/** @returns the risk confirmation this preset requires, if any. */
export function permissionRisk(value: string): PermissionRisk | undefined {
	if (value === 'danger-full-access') {
		return 'full-access';
	}
	if (value === 'auto') {
		return 'auto-review';
	}
	return undefined;
}

/** @returns localized copy for a risk confirmation. */
export function permissionRiskCopy(
	value: string,
	language: Language = 'en',
): PermissionRiskCopy | undefined {
	if (value === 'danger-full-access') {
		return {
			title: translate(language, 'riskFullAccessTitle'),
			description: translate(language, 'riskFullAccessDescription'),
			acknowledge: translate(language, 'riskFullAccessAcknowledge'),
			cancel: translate(language, 'cancel'),
			confirm: translate(language, 'riskFullAccessConfirm'),
		};
	}
	if (value === 'auto') {
		return {
			title: translate(language, 'riskAutoTitle'),
			description: translate(language, 'riskAutoDescription'),
			acknowledge: translate(language, 'riskAutoAcknowledge'),
			cancel: translate(language, 'cancel'),
			confirm: translate(language, 'riskAutoConfirm'),
		};
	}
	return undefined;
}

/**
 * Convert conventional kebab-case preset keys into title case, matching the
 * Desktop fallback for host-defined presets without a display name.
 *
 * @param name - host-supplied label or key.
 * @returns the title-cased key, or a non-kebab label unchanged.
 */
export function displayPresetName(name: string): string {
	if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
		return name;
	}
	return name
		.split('-')
		.map(word => word.charAt(0).toUpperCase() + word.slice(1))
		.join(' ');
}
