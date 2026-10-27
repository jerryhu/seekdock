import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import {
	ArrowUp,
	Box,
	Check,
	CircleX,
	Lightbulb,
	LoaderCircle,
	Paperclip,
	Square,
	X,
} from 'lucide-preact';
import {
	buildPromptWithSkills,
	filterComposerSkills,
	groupComposerSkills,
	slashQueryFromDraft,
	type ComposerSkill,
} from '../shared/composer-skills.ts';
import { buildPromptWithFiles } from '../shared/composer-files.ts';
import type { ComposerFile, PermissionCatalog } from '../shared/rpc.ts';
import type { ModelSelection } from '../shared/model-selection.ts';
import { ComposerAddMenu } from './composer-add-menu.tsx';
import { useI18n } from './i18n-context.tsx';
import { ModelPicker } from './model-picker.tsx';
import { PermissionPicker } from './permission-picker.tsx';
import type { VsCodeApi } from './vscode-api.ts';

interface ComposerProps {
	busy: boolean;
	cancelling: boolean;
	configured: boolean;
	runtimeReady: boolean;
	focusToken: number;
	resetToken: number;
	initialDraft: string;
	files: readonly ComposerFile[];
	pickingFiles: boolean;
	fileSelectionError?: string;
	skills: readonly ComposerSkill[];
	skillsLoading: boolean;
	skillError?: string;
	onRequestSkills: () => void;
	onOpenSkill: (name: string) => void;
	planModeActive: boolean;
	planModePending?: boolean;
	planModeError?: string;
	settingPlanMode: boolean;
	onPickFiles: () => void;
	onRemoveFile: (id: string) => void;
	onSetPlanMode: (active: boolean) => void;
	permissionCatalog: PermissionCatalog | null;
	permissionCurrent?: string;
	permissionPending?: string;
	permissionError?: string;
	settingPermission: boolean;
	onSelectPermission: (preset: string) => void;
	modelSelection: ModelSelection;
	modelSelectionError?: string;
	settingModelSelection: boolean;
	onSelectModelSelection: (selection: ModelSelection) => void;
	onSend: (text: string) => void;
	onStop: () => void;
	vscode: VsCodeApi;
}

function fitTextareaToContent(element: HTMLTextAreaElement): void {
	element.style.height = 'auto';
	element.style.height = `${element.scrollHeight}px`;
}

/**
 * Composer input and controls for prompts, files, skills, permissions, plan
 * mode, and the model route. The host remains responsible for sending turns.
 */
export function Composer({
	busy,
	cancelling,
	configured,
	runtimeReady,
	focusToken,
	resetToken,
	initialDraft,
	files,
	pickingFiles,
	fileSelectionError,
	skills,
	skillsLoading,
	skillError,
	onRequestSkills,
	onOpenSkill,
	planModeActive,
	planModePending,
	planModeError,
	settingPlanMode,
	onPickFiles,
	onRemoveFile,
	onSetPlanMode,
	permissionCatalog,
	permissionCurrent,
	permissionPending,
	permissionError,
	settingPermission,
	onSelectPermission,
	modelSelection,
	modelSelectionError,
	settingModelSelection,
	onSelectModelSelection,
	onSend,
	onStop,
	vscode,
}: ComposerProps): JSX.Element {
	const { t } = useI18n();
	const [text, setText] = useState(initialDraft);
	const [selectedSkills, setSelectedSkills] = useState<readonly ComposerSkill[]>([]);
	const [skillsOpen, setSkillsOpen] = useState(false);
	const [skillQuery, setSkillQuery] = useState('');
	const [skillHighlight, setSkillHighlight] = useState(0);
	const input = useRef<HTMLTextAreaElement>(null);
	const box = useRef<HTMLDivElement>(null);
	const filteredSkills = useMemo(
		() => filterComposerSkills(skills, skillQuery),
		[skillQuery, skills],
	);
	const skillGroups = useMemo(
		() => groupComposerSkills(filteredSkills),
		[filteredSkills],
	);

	useEffect(() => {
		input.current?.focus();
	}, [focusToken]);

	useLayoutEffect(() => {
		const element = input.current;
		if (element === null) {
			return;
		}
		fitTextareaToContent(element);
		const observer = new ResizeObserver(() => fitTextareaToContent(element));
		observer.observe(document.documentElement);
		return () => observer.disconnect();
	}, []);

	useLayoutEffect(() => {
		const element = input.current;
		if (element === null) {
			return;
		}
		fitTextareaToContent(element);
	}, [text]);

	useEffect(() => {
		if (resetToken > 0) {
			setText('');
			setSelectedSkills([]);
			setSkillsOpen(false);
			setSkillQuery('');
			vscode.setState({ draft: '', files: [] });
		}
	}, [resetToken, vscode]);

	useEffect(() => {
		if (!skillsOpen) {
			return;
		}
		const onPointerDown = (event: PointerEvent): void => {
			const target = event.target;
			if (box.current !== null && target instanceof Node && !box.current.contains(target)) {
				setSkillsOpen(false);
			}
		};
		document.addEventListener('pointerdown', onPointerDown);
		return () => document.removeEventListener('pointerdown', onPointerDown);
	}, [skillsOpen]);

	useEffect(() => {
		if (filteredSkills.length === 0) {
			setSkillHighlight(0);
			return;
		}
		setSkillHighlight(current => Math.min(current, filteredSkills.length - 1));
	}, [filteredSkills.length]);

	const removeLastSkill = (): void => {
		setSelectedSkills(current => current.slice(0, -1));
		input.current?.focus();
	};

	const toggleSkill = (skill: ComposerSkill): void => {
		setSelectedSkills(current => (
			current.some(selected => selected.name === skill.name)
				? current.filter(selected => selected.name !== skill.name)
				: [...current, skill]
		));
		setText('');
		setSkillsOpen(false);
		setSkillQuery('');
		vscode.setState({ draft: '', files });
		queueMicrotask(() => input.current?.focus());
	};

	const submit = (): void => {
		const promptText = buildPromptWithSkills(
			text,
			selectedSkills.map(skill => skill.name),
		);
		const prompt = buildPromptWithFiles(promptText, files);
		if (prompt.length === 0
			|| busy
			|| settingModelSelection
			|| !configured
			|| !runtimeReady) {
			return;
		}
		onSend(prompt);
		setText('');
		setSelectedSkills([]);
		setSkillsOpen(false);
		setSkillQuery('');
		vscode.setState({ draft: '', files: [] });
	};

	const planModeEnabled = planModePending === true ? !planModeActive : planModeActive;
	const addMenuDisabled = busy
		|| settingModelSelection
		|| !configured
		|| !runtimeReady;
	const sendLabel = cancelling
		? t('stopping')
		: !runtimeReady
			? t('initializing')
			: busy ? t('stopGenerating') : t('send');

	return (
		<form
			className="composer"
			onSubmit={(event) => {
				event.preventDefault();
				submit();
			}}
		>
			<div className="composer-box" ref={box}>
				{skillsOpen
					? (
						<div
							className="composer-skill-picker"
							role="listbox"
							aria-label={t('skills')}
						>
							<div className="composer-skill-heading">{t('skills')}</div>
							<div className="composer-skill-list">
								{skillsLoading && skills.length === 0
									? (
										<div className="composer-skill-state" role="status">
											<LoaderCircle size={13} className="spin" />
											<span>{t('loadingSkills')}</span>
										</div>
									)
									: skillGroups.length === 0
										? (
											<div className="composer-skill-state">
												{skillError ?? t('noMatchingSkills')}
											</div>
										)
										: skillGroups.map(group => {
											return (
												<div className="composer-skill-group" key={group.source}>
													<div className="composer-skill-group-heading">
														<span>
															{t(group.source === 'workspace'
																? 'skillSourceWorkspace'
																: 'skillSourceUser')}
														</span>
													</div>
													{group.skills.map(skill => {
														const index = filteredSkills.findIndex(
															item => item.name === skill.name,
														);
														const selected = selectedSkills.some(
															item => item.name === skill.name,
														);
														return (
															<button
																type="button"
																role="option"
																aria-selected={selected}
																className={`composer-skill-option${
																	index === skillHighlight ? ' highlighted' : ''
																}${selected ? ' selected' : ''}`}
																key={skill.name}
																onMouseEnter={() => setSkillHighlight(index)}
																onClick={() => toggleSkill(skill)}
															>
																<Box size={15} aria-hidden="true" />
																<span className="composer-skill-copy">
																	<span className="composer-skill-name">{skill.name}</span>
																	<span className="composer-skill-description">
																		{skill.description}
																	</span>
																</span>
																{selected
																	? (
																		<Check
																			size={13}
																			className="composer-skill-check"
																			aria-hidden="true"
																		/>
																	)
																	: null}
															</button>
														);
													})}
												</div>
											);
										})}
							</div>
							{skillsLoading && skills.length > 0
								? (
									<div className="composer-skill-loading" role="status">
										<LoaderCircle size={11} className="spin" />
									</div>
								)
								: null}
						</div>
					)
					: null}
				{selectedSkills.length === 0
					? null
					: (
						<div className="composer-skill-chips" aria-label={t('selectedSkills')}>
							{selectedSkills.map(skill => (
								<div className="composer-skill-chip" key={skill.name}>
									<button
										type="button"
										className="composer-skill-chip-main"
										aria-label={t('viewSkill', { name: skill.name })}
										data-tooltip={t('viewSkillFile', { name: skill.name })}
										onClick={() => onOpenSkill(skill.name)}
									>
										<Box size={14} aria-hidden="true" />
										<span>{skill.name}</span>
									</button>
									<button
										type="button"
										className="composer-skill-chip-remove"
										aria-label={t('removeSkill', { name: skill.name })}
										data-tooltip={t('removeSkillTooltip')}
										onClick={() => {
											setSelectedSkills(current => (
												current.filter(selected => selected.name !== skill.name)
											));
										}}
									>
										<X size={11} />
									</button>
								</div>
							))}
						</div>
					)}
				<textarea
					ref={input}
					id="prompt"
					rows={3}
					value={text}
					placeholder={selectedSkills.length > 0
						? ''
						: planModeEnabled
							? t('planPromptPlaceholder')
							: t('promptPlaceholder')}
					aria-label={t('promptInputLabel')}
					disabled={!configured || !runtimeReady || settingModelSelection}
					onInput={(event) => {
						const value = event.currentTarget.value;
						const query = slashQueryFromDraft(value);
						if (query !== undefined && !skillsOpen) {
							onRequestSkills();
						}
						setSkillsOpen(query !== undefined);
						setSkillQuery(query ?? '');
						setSkillHighlight(0);
						setText(value);
						vscode.setState({ draft: value, files });
					}}
					onKeyDown={(event) => {
						if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
							if (skillsOpen) {
								event.preventDefault();
								const skill = filteredSkills[skillHighlight];
								if (skill !== undefined) {
									toggleSkill(skill);
								}
								return;
							}
							event.preventDefault();
							submit();
							return;
						}
						if (skillsOpen && event.key === 'ArrowDown') {
							event.preventDefault();
							setSkillHighlight(current => (
								filteredSkills.length === 0
									? 0
									: (current + 1) % filteredSkills.length
							));
							return;
						}
						if (skillsOpen && event.key === 'ArrowUp') {
							event.preventDefault();
							setSkillHighlight(current => (
								filteredSkills.length === 0
									? 0
									: (current - 1 + filteredSkills.length) % filteredSkills.length
							));
							return;
						}
						if (skillsOpen && event.key === 'Escape') {
							event.preventDefault();
							setSkillsOpen(false);
							return;
						}
						if (event.key === 'Backspace'
							&& text.length === 0
							&& selectedSkills.length > 0) {
							event.preventDefault();
							removeLastSkill();
						}
					}}
				/>
				{files.length === 0
					? null
					: (
						<div className="composer-files" aria-label={t('addedFiles')}>
							{files.map(file => (
								<div className="composer-file" key={file.id} title={file.path}>
									<Paperclip size={12} aria-hidden="true" />
									<span className="composer-file-name">{file.name}</span>
									<button
										type="button"
										className="composer-file-remove"
										aria-label={t('removeFile', { name: file.name })}
										data-tooltip={t('removeFileTooltip')}
										onClick={() => onRemoveFile(file.id)}
									>
										<X size={11} />
									</button>
								</div>
							))}
						</div>
					)}
				<div className="composer-actions">
					<div className="composer-tools">
						<ComposerAddMenu
							disabled={addMenuDisabled}
							pickingFiles={pickingFiles}
							planModeActive={planModeEnabled}
							settingPlanMode={settingPlanMode}
							onPickFiles={onPickFiles}
							onEnablePlanMode={() => onSetPlanMode(true)}
						/>
						{permissionCatalog === null
							? null
							: (
								<PermissionPicker
									catalog={permissionCatalog}
									{...(permissionCurrent === undefined ? {} : { current: permissionCurrent })}
									{...(permissionPending === undefined ? {} : { pending: permissionPending })}
									disabled={busy || settingModelSelection}
									setting={settingPermission}
									onSelect={onSelectPermission}
								/>
							)}
						{planModeEnabled
							? (
								<button
									type="button"
									className="plan-mode-chip"
									aria-label={t('planModeActiveClose')}
									data-tooltip={t('closePlanMode')}
									aria-busy={settingPlanMode}
									disabled={busy || settingPlanMode}
									onClick={() => onSetPlanMode(false)}
								>
									<span className="plan-mode-chip-glyph" aria-hidden="true">
										{settingPlanMode
											? <LoaderCircle size={14} className="spin" />
											: (
												<>
													<Lightbulb size={14} className="plan-mode-rest-glyph" />
													<CircleX size={14} className="plan-mode-hover-glyph" />
												</>
											)}
									</span>
									<span>{t('planMode')}</span>
								</button>
							)
							: null}
					</div>
					<div className="composer-trailing">
						<ModelPicker
							selection={modelSelection}
							disabled={busy || settingPermission}
							setting={settingModelSelection}
							onSelect={onSelectModelSelection}
						/>
						<button
							type={busy ? 'button' : 'submit'}
							className={`send-button${busy ? ' stop-button' : ''}`}
							disabled={cancelling
								|| (!busy
									&& ((text.trim().length === 0
											&& files.length === 0
											&& selectedSkills.length === 0)
										|| settingModelSelection
										|| !configured
										|| !runtimeReady))}
							aria-label={sendLabel}
							data-tooltip={sendLabel}
							data-tooltip-align="end"
							aria-busy={busy}
							onClick={busy ? onStop : undefined}
						>
							{busy
								? cancelling
									? <LoaderCircle size={15} className="spin" />
									: <Square size={13} fill="currentColor" strokeWidth={0} />
								: <ArrowUp size={16} strokeWidth={2.2} />}
						</button>
					</div>
				</div>
			</div>
			{permissionError === undefined
				? null
				: <div className="composer-notice" role="alert">{permissionError}</div>}
			{planModeError === undefined
				? null
				: <div className="composer-notice" role="alert">{planModeError}</div>}
			{fileSelectionError === undefined
				? null
				: <div className="composer-notice" role="alert">{fileSelectionError}</div>}
			{skillError === undefined || skillsOpen
				? null
				: <div className="composer-notice" role="alert">{skillError}</div>}
			{modelSelectionError === undefined
				? null
				: <div className="composer-notice" role="alert">{modelSelectionError}</div>}
		</form>
	);
}

