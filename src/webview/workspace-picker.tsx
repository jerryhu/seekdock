import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import {
	Check,
	ChevronDown,
	Folder,
	LoaderCircle,
} from 'lucide-preact';
import type { WorkspaceOption } from '../shared/workspaces.ts';
import { useI18n } from './i18n-context.tsx';

interface WorkspacePickerProps {
	options: readonly WorkspaceOption[];
	/** Option the runtime currently uses for new sessions. */
	currentId: string;
	/** Option being applied while the runtime restarts. */
	pendingId?: string;
	disabled: boolean;
	onSelect: (id: string) => void;
}

/**
 * Composer control for the directory the agent runs in. Options mirror the
 * open VS Code folders; the menu shows each absolute path on hover so folders
 * sharing a display name stay distinguishable.
 */
export function WorkspacePicker({
	options,
	currentId,
	pendingId,
	disabled,
	onSelect,
}: WorkspacePickerProps): JSX.Element {
	const { t } = useI18n();
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const pendingActive = pendingId !== undefined;
	const pending = pendingId === undefined
		? undefined
		: options.find(option => option.id === pendingId);
	const current = options.find(option => option.id === currentId)
		?? pending
		?? options[0];

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

	const label = (option: WorkspaceOption): string => (
		option.kind === 'default' ? t('workspaceDefaultName') : option.name
	);

	const choose = (option: WorkspaceOption): void => {
		setOpen(false);
		if (option.id === currentId && !pendingActive) {
			return;
		}
		onSelect(option.id);
	};

	if (current === undefined) {
		return <></>;
	}

	return (
		<div className="workspace-picker" ref={root}>
			<button
				ref={trigger}
				type="button"
				className="workspace-trigger"
				aria-haspopup="menu"
				aria-expanded={open}
				aria-label={t('workspaceCurrent', { label: label(current) })}
				data-tooltip={t('changeWorkspace')}
				data-tooltip-align="start"
				aria-busy={pendingActive}
				disabled={disabled || pendingActive}
				onClick={() => setOpen(value => !value)}
			>
				<Folder size={15} className="workspace-trigger-icon" aria-hidden="true" />
				<span className="workspace-trigger-label">{label(current)}</span>
				{pendingActive
					? <LoaderCircle size={12} className="spin workspace-trigger-status" />
					: <ChevronDown size={12} className={`workspace-chevron${open ? ' open' : ''}`} />}
			</button>
			{open
				? (
					<div className="workspace-menu" role="menu" aria-label={t('workspaces')}>
						{options.map(option => {
							const selected = option.id === currentId;
							return (
								<button
									key={option.id}
									type="button"
									role="menuitemradio"
									aria-checked={selected}
									className={`workspace-option${selected ? ' selected' : ''}`}
									data-tooltip={option.path}
									data-tooltip-align="start"
									onClick={() => choose(option)}
								>
									<span className="workspace-option-icon" aria-hidden="true">
										<Folder size={14} />
									</span>
									<span className="workspace-option-label">{label(option)}</span>
									{selected
										? <Check size={13} className="workspace-option-check" />
										: null}
								</button>
							);
						})}
					</div>
				)
				: null}
		</div>
	);
}
