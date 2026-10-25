import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import {
	Check,
	Eye,
	EyeOff,
	FileText,
	Folder,
	Globe2,
	KeyRound,
	LoaderCircle,
	MessageSquareText,
	Puzzle,
	RotateCcw,
	Save,
	SlidersHorizontal,
	UserRound,
} from 'lucide-preact';
import {
	type ComposerSkillSource,
} from '../shared/composer-skills.ts';
import {
	createTranslator,
	intlLocale,
	isLanguage,
	LANGUAGE_OPTIONS,
	type Language,
	type Translator,
} from '../shared/i18n/index.ts';
import {
	isHostToSettingsMessage,
	type HostToSettingsMessage,
	type SettingsSaveKind,
	type SettingsSkill,
	type SettingsSkillCatalog,
	type SettingsState,
} from '../shared/settings-rpc.ts';
import { detectInitialLanguage } from './i18n-context.tsx';
import type { SettingsVsCodeApi } from './settings-vscode-api.ts';

type SettingsTab = 'general' | 'personalization' | 'skills';
type PromptSaveOperation = 'save' | 'reset';

interface PendingOperation {
	kind: 'apiKey' | 'prompt' | 'skills' | 'skillToggle' | 'openSkill' | 'language';
	skillName?: string;
	previousLanguage?: Language;
}

interface UiState extends Omit<SettingsState, 'language'> {
	ready: boolean;
	savingKey: boolean;
	savingPrompt?: PromptSaveOperation;
	keyError?: string;
	promptError?: string;
	promptNotice?: 'saved' | 'reset';
	skills: readonly SettingsSkill[];
	skillRoots?: SettingsSkillCatalog['roots'];
	skillsLoading: boolean;
	skillError?: string;
	updatingSkill?: string;
}

const INITIAL_STATE: UiState = {
	ready: false,
	hasApiKey: false,
	busy: false,
	systemPrompt: '',
	systemPromptIsDefault: true,
	runtimeStatus: 'idle',
	savingKey: false,
	skills: [],
	skillsLoading: false,
};

const SKILL_SOURCES: readonly ComposerSkillSource[] = ['workspace', 'user'];

/** Standalone settings panel backed by the extension-host settings RPC. */
export function SettingsApp({ vscode }: { vscode: SettingsVsCodeApi }): JSX.Element {
	const [tab, setTab] = useState<SettingsTab>('general');
	const [language, setLanguage] = useState<Language>(detectInitialLanguage);
	const [ui, setUi] = useState<UiState>(INITIAL_STATE);
	const [apiKey, setApiKey] = useState('');
	const [keyVisible, setKeyVisible] = useState(false);
	const [promptText, setPromptText] = useState('');
	// Replies can arrive out of order; the request id identifies which optimistic
	// UI state must be committed or rolled back.
	const pending = useRef(new Map<string, PendingOperation>());
	const skillsRequested = useRef(false);
	const previousSavingKey = useRef(false);
	const hasPendingLanguage = (): boolean => (
		[...pending.current.values()].some(operation => operation.kind === 'language')
	);
	const t = createTranslator(language);
	const tabMeta: Record<SettingsTab, { label: string; detail: string }> = {
		general: {
			label: t('general'),
			detail: t('generalDetail'),
		},
		personalization: {
			label: t('personalization'),
			detail: t('personalizationDetail'),
		},
		skills: {
			label: t('skills'),
			detail: t('skillsDetail'),
		},
	};

	useEffect(() => {
		const listener = (event: MessageEvent<unknown>): void => {
			if (isHostToSettingsMessage(event.data)) {
				handleHostMessage(event.data);
			}
		};
		window.addEventListener('message', listener);
		vscode.postMessage({ type: 'ready' });
		return () => window.removeEventListener('message', listener);
	}, [vscode]);

	useEffect(() => {
		setPromptText(ui.systemPrompt);
	}, [ui.systemPrompt]);

	useEffect(() => {
		document.documentElement.lang = intlLocale(language);
	}, [language]);

	useEffect(() => {
		if (previousSavingKey.current && !ui.savingKey && ui.keyError === undefined) {
			setApiKey('');
		}
		previousSavingKey.current = ui.savingKey;
	}, [ui.keyError, ui.savingKey]);

	useEffect(() => {
		if (!ui.ready || ui.runtimeStatus !== 'ready') {
			if (ui.runtimeStatus !== 'ready') {
				skillsRequested.current = false;
			}
			return;
		}
		if (!skillsRequested.current) {
			requestSkills();
		}
	}, [ui.ready, ui.runtimeStatus]);

	const handleHostMessage = (message: HostToSettingsMessage): void => {
		switch (message.type) {
			case 'state': {
				const { language: hostLanguage, ...state } = message.state;
				setUi(current => ({
					...current,
					...state,
					ready: true,
				}));
				if (!hasPendingLanguage()) {
					setLanguage(hostLanguage);
				}
				break;
			}
			case 'saved':
				completeSaved(message.requestId, message.kind);
				break;
			case 'skillCatalog':
				skillsRequested.current = true;
				setUi(current => ({
					...current,
					skills: message.skills,
					skillRoots: message.roots,
					skillsLoading: false,
					skillError: undefined,
					updatingSkill: undefined,
				}));
				pending.current.delete(message.requestId);
				break;
			case 'error':
				completeError(message.requestId, message.message);
				break;
		}
	};

	const completeSaved = (requestId: string, kind: SettingsSaveKind): void => {
		const operation = pending.current.get(requestId);
		pending.current.delete(requestId);
		if (kind === 'apiKey' || operation?.kind === 'apiKey') {
			setUi(current => ({
				...current,
				hasApiKey: true,
				savingKey: false,
				keyError: undefined,
			}));
			return;
		}
		if (operation?.kind === 'skillToggle') {
			setUi(current => ({
				...current,
				updatingSkill: undefined,
			}));
			return;
		}
		if (operation?.kind === 'openSkill') {
			return;
		}
		if (kind === 'language' || operation?.kind === 'language') {
			return;
		}
		setUi(current => ({
			...current,
			savingPrompt: undefined,
			promptError: undefined,
			promptNotice: kind === 'resetSystemPrompt'
				? 'reset'
				: 'saved',
		}));
	};

	const completeError = (requestId: string, message: string): void => {
		const operation = pending.current.get(requestId);
		pending.current.delete(requestId);
		if (operation?.kind === 'apiKey') {
			setUi(current => ({
				...current,
				savingKey: false,
				keyError: message,
			}));
			return;
		}
		if (operation?.kind === 'prompt') {
			setUi(current => ({
				...current,
				savingPrompt: undefined,
				promptNotice: undefined,
				promptError: message,
			}));
			return;
		}
		if (operation?.kind === 'skillToggle') {
			setUi(current => ({
				...current,
				updatingSkill: undefined,
				skillError: message,
				skills: current.skills.map(item => (
					item.name === operation.skillName
						? { ...item, enabled: !item.enabled }
						: item
				)),
			}));
			return;
		}
		if (operation?.kind === 'openSkill') {
			setUi(current => ({ ...current, skillError: message }));
			return;
		}
		if (operation?.kind === 'language') {
			if (operation.previousLanguage !== undefined) {
				setLanguage(operation.previousLanguage);
			}
			return;
		}
		skillsRequested.current = false;
		setUi(current => ({
			...current,
			skillsLoading: false,
			skillError: message,
		}));
	};

	const requestSkills = (): void => {
		if (ui.skillsLoading) {
			return;
		}
		const requestId = crypto.randomUUID();
		pending.current.set(requestId, { kind: 'skills' });
		setUi(current => ({
			...current,
			skillsLoading: true,
			skillError: undefined,
		}));
		vscode.postMessage({ type: 'requestSkills', requestId });
	};

	const saveApiKey = (): void => {
		const value = apiKey.trim();
		if (value.length === 0 || ui.savingKey) {
			return;
		}
		const requestId = crypto.randomUUID();
		pending.current.set(requestId, { kind: 'apiKey' });
		setUi(current => ({
			...current,
			savingKey: true,
			keyError: undefined,
		}));
		vscode.postMessage({ type: 'saveApiKey', requestId, apiKey: value });
	};

	const savePrompt = (): void => {
		const value = promptText.trim();
		if (value.length === 0 || ui.savingPrompt !== undefined) {
			return;
		}
		const requestId = crypto.randomUUID();
		pending.current.set(requestId, { kind: 'prompt' });
		setUi(current => ({
			...current,
			savingPrompt: 'save',
			promptError: undefined,
			promptNotice: undefined,
		}));
		vscode.postMessage({ type: 'saveSystemPrompt', requestId, prompt: value });
	};

	const resetPrompt = (): void => {
		if (ui.savingPrompt !== undefined) {
			return;
		}
		const requestId = crypto.randomUUID();
		pending.current.set(requestId, { kind: 'prompt' });
		setUi(current => ({
			...current,
			savingPrompt: 'reset',
			promptError: undefined,
			promptNotice: undefined,
		}));
		vscode.postMessage({ type: 'resetSystemPrompt', requestId });
	};

	const toggleSkill = (skill: SettingsSkill): void => {
		if (ui.updatingSkill !== undefined) {
			return;
		}
		const enabled = !skill.enabled;
		const requestId = crypto.randomUUID();
		pending.current.set(requestId, {
			kind: 'skillToggle',
			skillName: skill.name,
		});
		setUi(current => ({
			...current,
			skillError: undefined,
			updatingSkill: skill.name,
			skills: current.skills.map(item => (
				item.name === skill.name ? { ...item, enabled } : item
			)),
		}));
		vscode.postMessage({
			type: 'setSkillEnabled',
			requestId,
			name: skill.name,
			enabled,
		});
	};

	const openSkill = (name: string): void => {
		const requestId = crypto.randomUUID();
		pending.current.set(requestId, { kind: 'openSkill', skillName: name });
		vscode.postMessage({ type: 'openSkill', requestId, name });
	};

	const selectLanguage = (value: string): void => {
		if (!isLanguage(value) || value === language) {
			return;
		}
		const requestId = crypto.randomUUID();
		pending.current.set(requestId, {
			kind: 'language',
			previousLanguage: language,
		});
		setLanguage(value);
		vscode.postMessage({ type: 'setLanguage', requestId, language: value });
	};

	const keyDisabled = ui.busy
		|| ui.runtimeStatus === 'initializing'
		|| ui.savingKey;
	const promptDisabled = ui.busy
		|| ui.runtimeStatus === 'initializing'
		|| ui.savingPrompt !== undefined;
	const skillDisabled = ui.busy || ui.runtimeStatus !== 'ready';
	const skillGroups = SKILL_SOURCES
		.map(source => ({
			source,
			skills: ui.skills.filter(skill => skill.source === source),
		}))
		.filter(group => group.skills.length > 0);

	if (!ui.ready) {
		return (
			<div className="settings-panel-boot" aria-label={t('settingsLoading')}>
				<LoaderCircle size={18} className="spin" />
			</div>
		);
	}

	return (
		<div className="settings-panel-shell">
			<aside className="settings-panel-sidebar">
				<div className="settings-panel-brand">
					<div>
						<strong>SeekDock</strong>
						<span
							className={`settings-panel-runtime ${ui.runtimeStatus}`}
							title={t('harnessRuntimeStatus')}
						>
							<span />
							{runtimeLabel(ui.runtimeStatus, t)}
						</span>
					</div>
				</div>
				<nav className="settings-panel-navigation" aria-label={t('settingsCategories')}>
					<button
						type="button"
						className={tab === 'general' ? 'active' : undefined}
						aria-current={tab === 'general' ? 'page' : undefined}
						onClick={() => setTab('general')}
					>
						<SlidersHorizontal size={15} />
						<span>{t('general')}</span>
					</button>
					<button
						type="button"
						className={tab === 'personalization' ? 'active' : undefined}
						aria-current={tab === 'personalization' ? 'page' : undefined}
						onClick={() => setTab('personalization')}
					>
						<MessageSquareText size={15} />
						<span>{t('personalization')}</span>
					</button>
					<button
						type="button"
						className={tab === 'skills' ? 'active' : undefined}
						aria-current={tab === 'skills' ? 'page' : undefined}
						onClick={() => setTab('skills')}
					>
						<Puzzle size={15} />
						<span>{t('skills')}</span>
						{ui.skills.length > 0
							? <span className="settings-panel-nav-count">{ui.skills.length}</span>
							: null}
					</button>
				</nav>
			</aside>

			<main className="settings-panel-main">
				<header className="settings-panel-header">
					<div>
						<h1>{tabMeta[tab].label}</h1>
						<p>{tabMeta[tab].detail}</p>
					</div>
				</header>

				<div className="settings-panel-content">
					{tab === 'general'
						? (
							<div className="settings-panel-stack">
								<section
									className="settings-panel-section settings-panel-language"
									aria-labelledby="language-heading"
								>
									<div className="settings-panel-section-copy">
										<h2 id="language-heading">{t('language')}</h2>
										<p id="language-description">{t('languageDescription')}</p>
									</div>
									<select
										id="settings-language"
										value={language}
										aria-labelledby="language-heading"
										aria-describedby="language-description"
										onChange={event => selectLanguage(event.currentTarget.value)}
									>
										{LANGUAGE_OPTIONS.map(option => (
											<option key={option.value} value={option.value}>
												{option.label}
											</option>
										))}
									</select>
								</section>

								<section className="settings-panel-section" aria-labelledby="api-key-heading">
									<div className="settings-panel-section-copy settings-panel-section-copy-inline">
										<div>
											<h2 id="api-key-heading">DeepSeek API Key</h2>
											<p>{t('apiKeyCredentials')}</p>
										</div>
										<span className={`settings-panel-status${ui.hasApiKey ? ' configured' : ''}`}>
											{ui.hasApiKey ? t('configured') : t('notConfigured')}
										</span>
									</div>
									<form
										className="settings-panel-form"
										onSubmit={(event) => {
											event.preventDefault();
											saveApiKey();
										}}
									>
										<label htmlFor="settings-api-key">API Key</label>
										<div className="settings-panel-key-field">
											<KeyRound size={15} />
											<input
												id="settings-api-key"
												type={keyVisible ? 'text' : 'password'}
												value={apiKey}
												placeholder={ui.hasApiKey
													? t('apiKeyReplacePlaceholder')
													: 'sk-...'}
												autocomplete="off"
												spellcheck={false}
												disabled={keyDisabled}
												onInput={event => setApiKey(event.currentTarget.value)}
											/>
											<button
												type="button"
												className="icon-button"
												aria-label={keyVisible ? t('hideApiKey') : t('showApiKey')}
												data-tooltip={keyVisible ? t('hideApiKey') : t('showApiKey')}
												onClick={() => setKeyVisible(value => !value)}
											>
												{keyVisible ? <EyeOff size={15} /> : <Eye size={15} />}
											</button>
										</div>
										<div className="settings-panel-actions">
											<button
												type="submit"
												className="primary-button"
												disabled={keyDisabled || apiKey.trim().length === 0}
											>
												{ui.savingKey
													? <LoaderCircle size={14} className="spin" />
													: <KeyRound size={14} />}
												<span>{ui.savingKey ? t('saving') : t('saveApiKey')}</span>
											</button>
										</div>
										{ui.keyError !== undefined
											? <p className="key-error" role="alert">{ui.keyError}</p>
											: null}
									</form>
								</section>
							</div>
						)
						: null}

					{tab === 'personalization'
						? (
							<section className="settings-panel-section" aria-labelledby="prompt-heading">
								<div className="settings-panel-section-copy settings-panel-section-copy-inline">
									<div>
										<h2 id="prompt-heading">{t('prompt')}</h2>
										<p>{t('promptDescription')}</p>
									</div>
									<span className={`settings-panel-status${ui.systemPromptIsDefault ? '' : ' configured'}`}>
										{ui.systemPromptIsDefault
											? t('defaultPrompt')
											: t('customizedPrompt')}
									</span>
								</div>
								<form
									className="settings-panel-form"
									onSubmit={(event) => {
										event.preventDefault();
										savePrompt();
									}}
								>
									<label htmlFor="settings-system-prompt">{t('systemPrompt')}</label>
									<textarea
										id="settings-system-prompt"
										className="prompt-editor"
										rows={18}
										value={promptText}
										spellcheck={false}
										disabled={promptDisabled}
										onInput={event => setPromptText(event.currentTarget.value)}
									/>
									<div className="settings-panel-actions">
										<button
											type="button"
											className="secondary-button"
											disabled={promptDisabled || ui.systemPromptIsDefault}
											onClick={resetPrompt}
										>
											{ui.savingPrompt === 'reset'
												? <LoaderCircle size={14} className="spin" />
												: <RotateCcw size={14} />}
											<span>{t('restoreDefault')}</span>
										</button>
										<button
											type="submit"
											className="primary-button"
											disabled={promptDisabled || promptText.trim().length === 0}
										>
											{ui.savingPrompt === 'save'
												? <LoaderCircle size={14} className="spin" />
												: <Save size={14} />}
											<span>{t('savePrompt')}</span>
										</button>
									</div>
									{ui.promptError !== undefined
										? <p className="key-error" role="alert">{ui.promptError}</p>
										: null}
									{ui.promptNotice !== undefined
										? (
											<p className="settings-notice" role="status">
												{t(ui.promptNotice === 'reset' ? 'promptReset' : 'promptSaved')}
											</p>
										)
										: null}
								</form>
							</section>
						)
						: null}

					{tab === 'skills'
						? (
							<div className="settings-panel-skills">
								{!ui.hasApiKey
									? (
										<div className="settings-panel-empty">
											<KeyRound size={20} />
											<p>{t('configureApiForSkills')}</p>
										</div>
									)
									: ui.runtimeStatus === 'initializing' || ui.skillsLoading
										? (
											<div className="settings-panel-empty" role="status">
												<LoaderCircle size={20} className="spin" />
												<p>{t('loadingSkillsTitle')}</p>
											</div>
										)
										: ui.runtimeStatus === 'error'
											? (
												<div className="settings-panel-empty error" role="alert">
													<p>{ui.runtimeError ?? t('harnessInitFailed')}</p>
												</div>
											)
											: (
												<>
														{skillGroups.map(({ source, skills }) => {
														return (
															<section className="settings-panel-skill-group" key={source}>
																<header className="settings-panel-skill-group-header">
																	<div className="settings-panel-skill-group-title">
																		{source === 'workspace'
																			? <Folder size={15} />
																			: <UserRound size={15} />}
																		<h2>
																			{t(source === 'workspace'
																				? 'skillSourceWorkspace'
																				: 'skillSourceUser')}
																		</h2>
																		<code>{ui.skillRoots?.[source] ?? '—'}</code>
																	</div>
																	<span>{skills.filter(skill => skill.enabled).length}/{skills.length}</span>
																</header>
																	<ul className="settings-panel-skill-list">
																		{skills.map(skill => (
																			<li className={skill.enabled ? 'enabled' : undefined} key={skill.name}>
																				<div className="settings-panel-skill-copy">
																					<strong>{skill.name}</strong>
																					<p>{skill.description}</p>
																				</div>
																				<button
																					type="button"
																					className="icon-button settings-panel-skill-open"
																					aria-label={t('openSkillFile', {
																						name: skill.name,
																					})}
																					data-tooltip={t('openSkillFile', {
																						name: skill.name,
																					})}
																					onClick={() => openSkill(skill.name)}
																				>
																					<FileText size={15} />
																				</button>
																				<button
																					type="button"
																					role="switch"
																					className="settings-panel-switch"
																					aria-checked={skill.enabled}
																					aria-label={t(skill.enabled
																						? 'disableSkill'
																						: 'enableSkill', {
																						name: skill.name,
																					})}
																					disabled={skillDisabled || ui.updatingSkill !== undefined}
																					onClick={() => toggleSkill(skill)}
																				>
																					<span>
																						{ui.updatingSkill === skill.name
																							? <LoaderCircle size={11} className="spin" />
																							: skill.enabled
																								? <Check size={11} />
																								: null}
																					</span>
																				</button>
																			</li>
																		))}
																	</ul>
															</section>
														);
													})}
														{skillGroups.length === 0
															? (
																<div className="settings-panel-empty">
																	<Puzzle size={20} />
																	<p>{t('noSkills')}</p>
																</div>
															)
															: null}
													{ui.skillError !== undefined
														? <p className="key-error" role="alert">{ui.skillError}</p>
														: null}
												</>
											)}
							</div>
						)
						: null}
				</div>
			</main>
		</div>
	);
}

function runtimeLabel(
	status: SettingsState['runtimeStatus'],
	t: Translator,
): string {
	switch (status) {
		case 'ready':
			return t('harnessConnected');
		case 'initializing':
			return t('harnessStarting');
		case 'error':
			return t('harnessError');
		default:
			return t('harnessStopped');
	}
}
