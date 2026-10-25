import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import {
	Check,
	ChevronDown,
	Eye,
	FolderPen,
	LoaderCircle,
	LockOpen,
	Shield,
	ShieldAlert,
	Sparkles,
} from 'lucide-preact';
import type { PermissionCatalog, PermissionOption } from '../shared/rpc.ts';
import {
	displayPermissionDescription,
	displayPermissionLabel,
	permissionBadge,
	permissionRisk,
	permissionRiskCopy,
	type PermissionRiskCopy,
} from '../shared/permission.ts';
import { useI18n } from './i18n-context.tsx';

interface PermissionPickerProps {
	catalog: PermissionCatalog;
	current?: string;
	pending?: string;
	/** The agent is answering; a preset must not change mid-turn. */
	disabled: boolean;
	/** A preset switch is waiting for the host. */
	setting: boolean;
	onSelect: (preset: string) => void;
}

/**
 * Composer permission picker, matching DeepSeek Harness Desktop: one compact
 * trigger, a selectable catalog, and a one-shot risk acknowledgement before
 * Full access or the experimental Auto review becomes current.
 */
export function PermissionPicker({
	catalog,
	current,
	pending,
	disabled,
	setting,
	onSelect,
}: PermissionPickerProps): JSX.Element {
	const { language, t } = useI18n();
	const [open, setOpen] = useState(false);
	const [risk, setRisk] = useState<{ value: string } | null>(null);
	const [acknowledged, setAcknowledged] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	const currentValue = pending ?? current ?? catalog.defaultPreset;
	const selected = catalog.options.find(option => option.value === currentValue)
		?? { value: currentValue, name: currentValue };
	const label = displayPermissionLabel(selected.value, selected.name, language);
	const description = displayPermissionDescription(selected, language);
	const busy = setting;
	const riskCopy = risk === null ? undefined : permissionRiskCopy(risk.value, language);

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
		if (risk === null) {
			return;
		}
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === 'Escape') {
				closeRisk();
			}
		};
		document.addEventListener('keydown', onKeyDown);
		return () => document.removeEventListener('keydown', onKeyDown);
	}, [risk]);

	const closeRisk = (): void => {
		setAcknowledged(false);
		setRisk(null);
	};

	const choose = (value: string): void => {
		setOpen(false);
		if (value === currentValue) {
			return;
		}
		if (permissionRisk(value) !== undefined) {
			const copy = permissionRiskCopy(value, language);
			if (copy !== undefined) {
				setAcknowledged(false);
				setRisk({ value });
			}
			return;
		}
		onSelect(value);
	};

	const confirmRisk = (): void => {
		if (risk === null || !acknowledged) {
			return;
		}
		const value = risk.value;
		closeRisk();
		onSelect(value);
	};

	return (
		<div className="permission-picker" ref={root}>
			<button
				type="button"
				className="permission-trigger"
				aria-haspopup="menu"
				aria-expanded={open}
				aria-label={t('accessModeCurrent', { label })}
				data-tooltip={pending === undefined
					? t('changeAccess')
					: t('newSessionAccess', { label })}
				disabled={disabled || busy}
				onClick={() => setOpen(value => !value)}
			>
				<span className="permission-trigger-icon" aria-hidden="true">
					{busy ? <LoaderCircle size={13} className="spin" /> : permissionIcon(currentValue)}
				</span>
				<span className="permission-trigger-label">{label}</span>
				<ChevronDown size={12} className={`permission-chevron${open ? ' open' : ''}`} />
			</button>
			{open
				? (
					<div className="permission-menu" role="menu" aria-label={t('accessMode')}>
						{catalog.options.map(option => (
							<PermissionOptionRow
								key={option.value}
								option={option}
								selected={option.value === currentValue}
								onSelect={choose}
							/>
						))}
					</div>
				)
				: null}
			{risk !== null && riskCopy !== undefined
				? (
					<RiskDialog
						copy={riskCopy}
						acknowledged={acknowledged}
						onAcknowledge={setAcknowledged}
						onCancel={closeRisk}
						onConfirm={confirmRisk}
					/>
				)
				: null}
		</div>
	);
}

function PermissionOptionRow({
	option,
	selected,
	onSelect,
}: {
	option: PermissionOption;
	selected: boolean;
	onSelect: (value: string) => void;
}): JSX.Element {
	const { language } = useI18n();
	const label = displayPermissionLabel(option.value, option.name, language);
	const description = displayPermissionDescription(option, language);
	const badge = permissionBadge(option.value);
	return (
		<button
			type="button"
			role="menuitemradio"
			aria-checked={selected}
			className={`permission-option${selected ? ' selected' : ''}`}
			aria-label={`${label}${description === undefined ? '' : `：${description}`}`}
			data-tooltip={description ?? label}
			data-tooltip-align="start"
			onClick={() => onSelect(option.value)}
		>
			<span className="permission-option-icon" aria-hidden="true">
				{permissionIcon(option.value)}
			</span>
			<span className="permission-option-text">
				<span className="permission-option-label">
					<span className="permission-option-name">{label}</span>
					{badge === undefined
						? null
						: <span className="permission-badge" aria-label={badge}>{badge}</span>}
				</span>
			</span>
			{selected ? <Check size={13} className="permission-option-check" /> : null}
		</button>
	);
}

function RiskDialog({
	copy,
	acknowledged,
	onAcknowledge,
	onCancel,
	onConfirm,
}: {
	copy: PermissionRiskCopy;
	acknowledged: boolean;
	onAcknowledge: (value: boolean) => void;
	onCancel: () => void;
	onConfirm: () => void;
}): JSX.Element {
	return (
		<div className="risk-backdrop" role="presentation" onPointerDown={(event) => {
			if (event.target === event.currentTarget) {
				onCancel();
			}
		}}>
			<div className="risk-dialog" role="dialog" aria-modal="true" aria-labelledby="risk-title">
				<div className="risk-dialog-heading">
					<span className="risk-dialog-icon" aria-hidden="true"><ShieldAlert size={17} /></span>
					<h2 id="risk-title">{copy.title}</h2>
				</div>
				<p className="risk-dialog-description">{copy.description}</p>
				<label className="risk-acknowledge">
					<input
						type="checkbox"
						checked={acknowledged}
						onChange={(event) => onAcknowledge(event.currentTarget.checked)}
					/>
					<span>{copy.acknowledge}</span>
				</label>
				<div className="risk-dialog-actions">
					<button type="button" className="secondary-button" onClick={onCancel}>
						{copy.cancel}
					</button>
					<button
						type="button"
						className="primary-button danger-button"
						disabled={!acknowledged}
						onClick={onConfirm}
					>
						{copy.confirm}
					</button>
				</div>
			</div>
		</div>
	);
}

function permissionIcon(value: string): JSX.Element {
	switch (value) {
		case 'read-only':
			return <Eye size={14} />;
		case 'workspace-write':
			return <FolderPen size={14} />;
		case 'danger-full-access':
			return <LockOpen size={14} />;
		case 'auto':
			return <Sparkles size={14} />;
		case 'custom':
			return <Shield size={14} />;
		default:
			return <Shield size={14} />;
	}
}
