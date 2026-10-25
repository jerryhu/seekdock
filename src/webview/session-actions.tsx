import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import {
	Ellipsis,
	LoaderCircle,
	Pencil,
	Trash2,
	X,
} from 'lucide-preact';
import { useI18n } from './i18n-context.tsx';

interface SessionTitleMenuProps {
	title: string;
	disabled: boolean;
	deleting: boolean;
	onRename: () => void;
	onDelete: () => void;
}

/** Compact action menu shown beside the active session title. */
export function SessionTitleMenu({
	title,
	disabled,
	deleting,
	onRename,
	onDelete,
}: SessionTitleMenuProps): JSX.Element {
	const { t } = useI18n();
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) {
			return;
		}
		const onPointerDown = (event: PointerEvent): void => {
			if (event.target instanceof Node && !root.current?.contains(event.target)) {
				setOpen(false);
			}
		};
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === 'Escape') {
				setOpen(false);
			}
		};
		document.addEventListener('pointerdown', onPointerDown);
		document.addEventListener('keydown', onKeyDown);
		return () => {
			document.removeEventListener('pointerdown', onPointerDown);
			document.removeEventListener('keydown', onKeyDown);
		};
	}, [open]);

	useEffect(() => {
		if (disabled || deleting) {
			setOpen(false);
		}
	}, [deleting, disabled]);

	return (
		<div className="session-title-menu" ref={root}>
			<button
				type="button"
				className={`icon-button${open ? ' active' : ''}`}
				aria-label={t('sessionActionsFor', { title })}
				data-tooltip={t('sessionActions')}
				data-tooltip-placement="bottom"
				data-tooltip-align="end"
				aria-haspopup="menu"
				aria-expanded={open}
				disabled={disabled}
				onClick={() => setOpen(value => !value)}
			>
				<Ellipsis size={15} />
			</button>
			{open
				? (
					<div className="session-title-popover" role="menu" aria-label={t('sessionActions')}>
						<button
							type="button"
							role="menuitem"
							className="session-title-menu-item"
							onClick={() => {
								setOpen(false);
								onRename();
							}}
						>
							<Pencil size={14} />
							<span>{t('rename')}</span>
						</button>
						<div className="session-title-menu-divider" role="separator" />
						<button
							type="button"
							role="menuitem"
							className="session-title-menu-item danger"
							disabled={deleting}
							onClick={() => {
								setOpen(false);
								onDelete();
							}}
						>
							{deleting
								? <LoaderCircle size={14} className="spin" />
								: <Trash2 size={14} />}
							<span>{t('delete')}</span>
						</button>
					</div>
				)
				: null}
		</div>
	);
}

interface RenameSessionDialogProps {
	title: string;
	submitting: boolean;
	error: string | undefined;
	onCancel: () => void;
	onSubmit: (title: string) => void;
}

/** Focused rename dialog shared by the session title action menu. */
export function RenameSessionDialog({
	title,
	submitting,
	error,
	onCancel,
	onSubmit,
}: RenameSessionDialogProps): JSX.Element {
	const { t } = useI18n();
	const [value, setValue] = useState(title);
	const input = useRef<HTMLInputElement>(null);
	const canSubmit = value.trim().length > 0 && !submitting;

	useEffect(() => {
		input.current?.focus();
		input.current?.select();
	}, []);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === 'Escape' && !submitting) {
				onCancel();
			}
		};
		document.addEventListener('keydown', onKeyDown);
		return () => document.removeEventListener('keydown', onKeyDown);
	}, [onCancel, submitting]);

	return (
		<div
			className="session-dialog-backdrop"
			role="presentation"
			onPointerDown={(event) => {
				if (event.target === event.currentTarget && !submitting) {
					onCancel();
				}
			}}
		>
			<form
				className="session-rename-dialog"
				role="dialog"
				aria-modal="true"
				aria-labelledby="session-rename-title"
				onSubmit={(event) => {
					event.preventDefault();
					if (canSubmit) {
						onSubmit(value);
					}
				}}
			>
				<div className="session-rename-heading">
					<h2 id="session-rename-title">{t('renameSession')}</h2>
					<p>{t('renameSessionHint')}</p>
				</div>
				<button
					type="button"
					className="icon-button session-rename-close"
					aria-label={t('closeRenameDialog')}
					data-tooltip={t('close')}
					disabled={submitting}
					onClick={onCancel}
				>
					<X size={16} />
				</button>
				<input
					ref={input}
					className="session-rename-input"
					type="text"
					aria-label={t('sessionName')}
					value={value}
					maxLength={80}
					disabled={submitting}
					onInput={(event) => setValue(event.currentTarget.value)}
				/>
				{error === undefined
					? null
					: <p className="session-rename-error" role="alert">{error}</p>}
				<div className="session-rename-actions">
					<button
						type="button"
						className="secondary-button"
						disabled={submitting}
						onClick={onCancel}
					>
						{t('cancel')}
					</button>
					<button type="submit" className="primary-button" disabled={!canSubmit}>
						{submitting ? <LoaderCircle size={14} className="spin" /> : null}
						<span>{submitting ? t('savingEllipsis') : t('save')}</span>
					</button>
				</div>
			</form>
		</div>
	);
}
