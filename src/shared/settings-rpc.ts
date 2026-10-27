import type {
	ComposerSkill,
	ComposerSkillSource,
} from './composer-skills.ts';
import { isRuntimeStatus, type RuntimeStatus } from './rpc.ts';
import { isLanguage, type Language } from './i18n/index.ts';
import {
	isMcpImportSourceId,
	isMcpServer,
	isMcpServerShape,
	type McpImportResult,
	type McpImportSource,
	type McpImportSourceId,
	type McpServer,
} from './mcp-servers.ts';
import { isNonEmptyString, isRecord } from './value-validation.ts';

/** Core settings state shared by every standalone SeekDock settings panel. */
export interface SettingsState {
	hasApiKey: boolean;
	busy: boolean;
	systemPrompt: string;
	systemPromptIsDefault: boolean;
	runtimeStatus: RuntimeStatus;
	runtimeError?: string;
	language: Language;
}

/** One skill row shown by the settings panel. */
export interface SettingsSkill extends ComposerSkill {
	enabled: boolean;
}

/** Absolute directories scanned by DSH for each supported skill scope. */
export interface SettingsSkillRoots {
	workspace: string;
	user: string;
}

/** Complete skill catalog, including rows hidden from the slash menu. */
export interface SettingsSkillCatalog {
	roots: SettingsSkillRoots;
	skills: readonly SettingsSkill[];
}

/** Persisted settings operations completed by the host. */
export type SettingsSaveKind =
	| 'apiKey'
	| 'systemPrompt'
	| 'resetSystemPrompt'
	| 'skill'
	| 'openSkill'
	| 'language'
	| 'mcpServer'
	| 'mcpServerToggle'
	| 'mcpServerDelete'
	| 'mcpImport';

/** Messages posted by the standalone settings Webview. */
export type SettingsToHostMessage =
	| { type: 'ready' }
	| { type: 'saveApiKey'; requestId: string; apiKey: string }
	| { type: 'saveSystemPrompt'; requestId: string; prompt: string }
	| { type: 'resetSystemPrompt'; requestId: string }
	| { type: 'requestSkills'; requestId: string }
	| { type: 'setSkillEnabled'; requestId: string; name: string; enabled: boolean }
	| { type: 'openSkill'; requestId: string; name: string }
	| { type: 'setLanguage'; requestId: string; language: Language }
	| { type: 'requestMcpServers'; requestId: string }
	| {
		type: 'saveMcpServer';
		requestId: string;
		server: McpServer;
		previousServerName?: string;
		secrets: Readonly<Record<string, string>>;
	}
	| { type: 'deleteMcpServer'; requestId: string; serverName: string }
	| {
		type: 'setMcpServerEnabled';
		requestId: string;
		serverName: string;
		enabled: boolean;
	}
	| { type: 'requestMcpImportSources'; requestId: string }
	| {
		type: 'importMcpServers';
		requestId: string;
		sourceId: McpImportSourceId;
		originalNames: readonly string[];
		secrets: Readonly<Record<string, string>>;
	};

/** Messages posted by the extension host to the settings Webview. */
export type HostToSettingsMessage =
	| { type: 'state'; state: SettingsState }
	| { type: 'saved'; requestId: string; kind: SettingsSaveKind }
	| {
		type: 'skillCatalog';
		requestId: string;
		roots: SettingsSkillRoots;
		skills: readonly SettingsSkill[];
	}
	| {
		type: 'mcpServers';
		requestId: string;
		path: string;
		servers: readonly McpServer[];
	}
	| {
		type: 'mcpImportSources';
		requestId: string;
		sources: readonly McpImportSource[];
	}
	| { type: 'mcpImported'; requestId: string; result: McpImportResult }
	| { type: 'error'; requestId: string; message: string };

/** @returns whether a settings Webview message matches the host contract. */
export function isSettingsToHostMessage(value: unknown): value is SettingsToHostMessage {
	if (!isRecord(value) || typeof value.type !== 'string') {
		return false;
	}
	switch (value.type) {
		case 'ready':
			return true;
		case 'saveApiKey':
			return isNonEmptyString(value.requestId) && typeof value.apiKey === 'string';
		case 'saveSystemPrompt':
			return isNonEmptyString(value.requestId) && typeof value.prompt === 'string';
		case 'resetSystemPrompt':
		case 'requestSkills':
		case 'requestMcpServers':
		case 'requestMcpImportSources':
			return isNonEmptyString(value.requestId);
		case 'setSkillEnabled':
			return isNonEmptyString(value.requestId)
				&& isNonEmptyString(value.name)
				&& typeof value.enabled === 'boolean';
		case 'openSkill':
			return isNonEmptyString(value.requestId) && isNonEmptyString(value.name);
		case 'setLanguage':
			return isNonEmptyString(value.requestId) && isLanguage(value.language);
		case 'saveMcpServer':
			return isNonEmptyString(value.requestId)
				&& isMcpServerShape(value.server)
				&& (value.previousServerName === undefined
					|| isNonEmptyString(value.previousServerName))
				&& isStringRecord(value.secrets);
		case 'deleteMcpServer':
			return isNonEmptyString(value.requestId)
				&& isNonEmptyString(value.serverName);
		case 'setMcpServerEnabled':
			return isNonEmptyString(value.requestId)
				&& isNonEmptyString(value.serverName)
				&& typeof value.enabled === 'boolean';
		case 'importMcpServers':
			return isNonEmptyString(value.requestId)
				&& isMcpImportSourceId(value.sourceId)
				&& Array.isArray(value.originalNames)
				&& value.originalNames.every(isNonEmptyString)
				&& isStringRecord(value.secrets);
		default:
			return false;
	}
}

/** @returns whether a settings host message matches the Webview contract. */
export function isHostToSettingsMessage(value: unknown): value is HostToSettingsMessage {
	if (!isRecord(value) || typeof value.type !== 'string') {
		return false;
	}
	switch (value.type) {
		case 'state':
			return isSettingsState(value.state);
		case 'saved':
			return isNonEmptyString(value.requestId)
				&& (value.kind === 'apiKey'
					|| value.kind === 'systemPrompt'
					|| value.kind === 'resetSystemPrompt'
					|| value.kind === 'skill'
					|| value.kind === 'openSkill'
					|| value.kind === 'language'
					|| value.kind === 'mcpServer'
					|| value.kind === 'mcpServerToggle'
					|| value.kind === 'mcpServerDelete'
					|| value.kind === 'mcpImport');
		case 'skillCatalog':
			return isNonEmptyString(value.requestId)
				&& isSettingsSkillRoots(value.roots)
				&& Array.isArray(value.skills)
				&& value.skills.every(isSettingsSkill);
		case 'mcpServers':
			return isNonEmptyString(value.requestId)
				&& isNonEmptyString(value.path)
				&& Array.isArray(value.servers)
				&& value.servers.every(isMcpServer);
		case 'mcpImportSources':
			return isNonEmptyString(value.requestId)
				&& Array.isArray(value.sources)
				&& value.sources.every(isMcpImportSource);
		case 'mcpImported':
			return isNonEmptyString(value.requestId) && isMcpImportResult(value.result);
		case 'error':
			return isNonEmptyString(value.requestId) && typeof value.message === 'string';
		default:
			return false;
	}
}

function isSettingsState(value: unknown): value is SettingsState {
	return isRecord(value)
		&& typeof value.hasApiKey === 'boolean'
		&& typeof value.busy === 'boolean'
		&& typeof value.systemPrompt === 'string'
		&& typeof value.systemPromptIsDefault === 'boolean'
		&& isRuntimeStatus(value.runtimeStatus)
		&& isLanguage(value.language)
		&& (value.runtimeError === undefined || typeof value.runtimeError === 'string');
}

function isSettingsSkill(value: unknown): value is SettingsSkill {
	return isRecord(value)
		&& isNonEmptyString(value.name)
		&& typeof value.description === 'string'
		&& isComposerSkillSource(value.source)
		&& typeof value.enabled === 'boolean';
}

function isSettingsSkillRoots(value: unknown): value is SettingsSkillRoots {
	return isRecord(value)
		&& isNonEmptyString(value.workspace)
		&& isNonEmptyString(value.user);
}

function isComposerSkillSource(value: unknown): value is ComposerSkillSource {
	return value === 'workspace' || value === 'user';
}

function isMcpImportSource(value: unknown): value is McpImportSource {
	return isRecord(value)
		&& isMcpImportSourceId(value.id)
		&& typeof value.path === 'string'
		&& typeof value.available === 'boolean'
		&& Array.isArray(value.servers)
		&& value.servers.every(isMcpImportServerPreview)
		&& (value.error === undefined || typeof value.error === 'string');
}

function isMcpImportServerPreview(value: unknown): boolean {
	return isRecord(value)
		&& typeof value.originalName === 'string'
		&& typeof value.serverName === 'string'
		&& (value.transport === undefined
			|| value.transport === 'stdio'
			|| value.transport === 'http')
		&& Array.isArray(value.secretNames)
		&& value.secretNames.every(name => typeof name === 'string')
		&& (value.error === undefined || isRecord(value.error));
}

function isMcpImportResult(value: unknown): value is McpImportResult {
	return isRecord(value)
		&& typeof value.imported === 'number'
		&& typeof value.skipped === 'number';
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
	return isRecord(value) && Object.values(value).every(item => typeof item === 'string');
}

