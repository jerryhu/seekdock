import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import {
	Check,
	Lightbulb,
	LoaderCircle,
	Paperclip,
	Plus,
} from 'lucide-preact';
import { useI18n } from './i18n-context.tsx';

interface ComposerAddMenuProps {
	disabled: boolean;
	pickingFiles: boolean;
	planModeActive: boolean;
	settingPlanMode: boolean;
	onPickFiles: () => void;
	onEnablePlanMode: () => void;
}

/** Composer Add menu for host file references and DSH plan mode. */
export function ComposerAddMenu({
	disabled,
	pickingFiles,
	planModeActive,
	settingPlanMode,
	onPickFiles,
	onEnablePlanMode,
}: ComposerAddMenuProps): JSX.Element {
	const { t } = useI18n();
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const busy = pickingFiles || settingPlanMode;

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

	const chooseFiles = (): void => {
		setOpen(false);
		onPickFiles();
	};

	const choosePlanMode = (): void => {
		setOpen(false);
		if (!planModeActive) {
			onEnablePlanMode();
		}
	};

	return (
		<div className="composer-add" ref={root}>
			<button
				ref={trigger}
				type="button"
				className="composer-add-trigger"
				aria-label={t('addFilesAndMore')}
				data-tooltip={t('addFilesAndMore')}
				data-tooltip-align="start"
				aria-haspopup="menu"
				aria-expanded={open}
				aria-busy={busy}
				disabled={disabled || busy}
				onClick={() => setOpen(value => !value)}
			>
				{busy
					? <LoaderCircle size={15} className="spin" />
					: <Plus size={17} strokeWidth={1.8} />}
			</button>
			{open
				? (
					<div
						className="composer-add-menu"
						role="menu"
						aria-label={t('addFilesAndMore')}
					>
						<div className="composer-add-heading">{t('add')}</div>
						<button
							type="button"
							role="menuitem"
							className="composer-add-option"
							onClick={chooseFiles}
						>
							<span className="composer-add-option-icon" aria-hidden="true">
								<Paperclip size={15} />
							</span>
							<span className="composer-add-option-text">
								<span className="composer-add-option-label">{t('file')}</span>
								<span className="composer-add-option-description">
									{t('addFileDescription')}
								</span>
							</span>
						</button>
						<button
							type="button"
							role="menuitemcheckbox"
							aria-checked={planModeActive}
							className="composer-add-option"
							onClick={choosePlanMode}
						>
							<span className="composer-add-option-icon" aria-hidden="true">
								<Lightbulb size={15} />
							</span>
							<span className="composer-add-option-text">
								<span className="composer-add-option-label">{t('planMode')}</span>
								<span className="composer-add-option-description">
									{planModeActive ? t('planModeEnabled') : t('enablePlanMode')}
								</span>
							</span>
							{planModeActive
								? <Check size={13} className="composer-add-option-check" />
								: null}
						</button>
					</div>
				)
				: null}
		</div>
	);
}
