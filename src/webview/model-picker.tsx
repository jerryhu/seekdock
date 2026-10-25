import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { Brain, Check, ChevronDown, LoaderCircle } from 'lucide-preact';
import {
	MODEL_OPTIONS,
	REASONING_LEVELS,
	displayModelSelection,
	type ModelSelection,
} from '../shared/model-selection.ts';
import { useI18n } from './i18n-context.tsx';

interface ModelPickerProps {
	selection: ModelSelection;
	/** The agent is answering; DSH cannot recycle its model route mid-turn. */
	disabled: boolean;
	/** A selection is being persisted and the runtime is restarting. */
	setting: boolean;
	onSelect: (selection: ModelSelection) => void;
}

/**
 * Compact composer control for the DSH model route and reasoning effort.
 * The full route is visible in a roomy composer and collapses to a brain icon
 * when the container narrows, leaving the permission control room beside it.
 */
export function ModelPicker({
	selection,
	disabled,
	setting,
	onSelect,
}: ModelPickerProps): JSX.Element {
	const { t } = useI18n();
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const label = displayModelSelection(selection);

	useEffect(() => {
		if (!open) {
			return;
		}
		const onPointerDown = (event: PointerEvent): void => {
			const target = event.target;
			if (root.current !== null && target instanceof Node && !root.current.contains(target)) {
				setOpen(false);
			}
		};
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === 'Escape') {
				setOpen(false);
				trigger.current?.focus();
			}
		};
		document.addEventListener('pointerdown', onPointerDown);
		document.addEventListener('keydown', onKeyDown);
		return () => {
			document.removeEventListener('pointerdown', onPointerDown);
			document.removeEventListener('keydown', onKeyDown);
		};
	}, [open]);

	const choose = (next: ModelSelection): void => {
		setOpen(false);
		onSelect(next);
	};

	return (
		<div className="model-picker" ref={root}>
			<button
				ref={trigger}
				type="button"
				className="model-trigger"
				aria-haspopup="menu"
				aria-expanded={open}
				aria-label={t('modelAndReasoningCurrent', { label })}
				data-tooltip={t('changeModelOrReasoning')}
				data-tooltip-align="end"
				aria-busy={setting}
				disabled={disabled || setting}
				onClick={() => setOpen(value => !value)}
			>
				<Brain size={16} className="model-trigger-icon" aria-hidden="true" />
				<span className="model-trigger-label">{label}</span>
				{setting
					? <LoaderCircle size={12} className="spin model-trigger-status" />
					: <ChevronDown size={12} className={`model-chevron${open ? ' open' : ''}`} />}
			</button>
			{open
				? (
					<div className="model-menu" role="menu" aria-label={t('modelAndReasoning')}>
						<div className="model-menu-section">
							<div className="model-menu-heading">{t('model')}</div>
							{MODEL_OPTIONS.map(option => {
								const selected = option.value === selection.model;
								return (
									<button
										key={option.value}
										type="button"
										role="menuitemradio"
										aria-checked={selected}
										className={`model-option${selected ? ' selected' : ''}`}
										onClick={() => choose({
											model: option.value,
											reasoningEffort: selection.reasoningEffort,
										})}
									>
										<span className="model-option-label">{option.name}</span>
										{selected ? <Check size={13} className="model-option-check" /> : null}
									</button>
								);
							})}
						</div>
						<div className="model-menu-divider" role="separator" />
						<div className="model-menu-section">
							<div className="model-menu-heading">{t('reasoning')}</div>
							<div className="reasoning-options">
								{REASONING_LEVELS.map(level => {
									const selected = level.value === selection.reasoningEffort;
									return (
										<button
											key={level.value}
											type="button"
											role="menuitemradio"
											aria-checked={selected}
											className={`reasoning-option${selected ? ' selected' : ''}`}
											onClick={() => choose({
												model: selection.model,
												reasoningEffort: level.value,
											})}
										>
											<span>{level.name}</span>
											{selected ? <Check size={10} /> : null}
										</button>
									);
								})}
							</div>
						</div>
					</div>
				)
				: null}
		</div>
	);
}
