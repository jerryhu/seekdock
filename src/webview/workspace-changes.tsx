import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import {
	ChevronDown,
	ChevronRight,
	FileCode2,
	FileDiff,
	LoaderCircle,
} from 'lucide-preact';
import type {
	WorkspaceChangeSet,
	WorkspaceChangedFile,
	WorkspaceFileDiff,
} from '../shared/workspace-changes.ts';
import { useI18n } from './i18n-context.tsx';
import { workspaceDiffPreview } from './workspace-diff-preview.ts';

const COLLAPSED_FILE_ROWS = 4;
const HOVER_DELAY_MS = 500;
const PREVIEW_LINE_LIMIT = 80;

interface WorkspaceChangesViewProps {
	changes: WorkspaceChangeSet;
	onRequestDiff: (changes: WorkspaceChangeSet, index: number) => Promise<WorkspaceFileDiff | null>;
	onOpenDiff: (changes: WorkspaceChangeSet, index: number) => void;
}

/** End-of-answer summary of the files one Agent turn changed. */
export function WorkspaceChangesView({
	changes,
	onRequestDiff,
	onOpenDiff,
}: WorkspaceChangesViewProps): JSX.Element {
	const { t } = useI18n();
	const [expanded, setExpanded] = useState(false);
	const foldable = changes.files.length > COLLAPSED_FILE_ROWS;
	const files = foldable && !expanded
		? changes.files.slice(0, COLLAPSED_FILE_ROWS)
		: changes.files;

	return (
		<section className="workspace-changes" aria-label={t('workspaceFileCount', {
			count: changes.total,
		})}>
			<div className="workspace-changes-heading">
				<span className="workspace-changes-mark" aria-hidden="true">
					<FileDiff size={15} />
				</span>
				<span className="workspace-changes-title">
					{t('workspaceFileCount', { count: changes.total })}
				</span>
				<span className="workspace-changes-totals" aria-label={`${changes.added} + / ${changes.deleted} -`}>
					<span className="workspace-added">+{changes.added}</span>
					<span className="workspace-deleted">-{changes.deleted}</span>
				</span>
			</div>
			<ul className="workspace-changes-list">
				{files.map((file, index) => (
					<WorkspaceFileRow
						key={`${file.path}:${index}`}
						file={file}
						index={index}
						changes={changes}
						onRequestDiff={onRequestDiff}
						onOpenDiff={onOpenDiff}
					/>
				))}
			</ul>
			{foldable
				? (
					<button
						type="button"
						className="workspace-changes-toggle"
						aria-expanded={expanded}
						onClick={() => setExpanded(value => !value)}
					>
						{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
						<span>
							{expanded
								? t('workspaceShowFewerFiles')
								: t('workspaceShowAllFiles', { count: changes.files.length })}
						</span>
					</button>
				)
				: null}
		</section>
	);
}

interface PreviewPosition {
	left: number;
	top: number;
	above: boolean;
	width: number;
	maxHeight: number;
}

function WorkspaceFileRow({
	file,
	index,
	changes,
	onRequestDiff,
	onOpenDiff,
}: {
	file: WorkspaceChangedFile;
	index: number;
	changes: WorkspaceChangeSet;
	onRequestDiff: WorkspaceChangesViewProps['onRequestDiff'];
	onOpenDiff: WorkspaceChangesViewProps['onOpenDiff'];
}): JSX.Element {
	const { t } = useI18n();
	const anchor = useRef<HTMLButtonElement>(null);
	const timer = useRef<number>();
	const request = useRef(0);
	const [diff, setDiff] = useState<WorkspaceFileDiff | null>();
	const [loading, setLoading] = useState(false);
	const [open, setOpen] = useState(false);
	const [position, setPosition] = useState<PreviewPosition>();
	const unavailable = file.binary === true || file.oversized === true;

	const clearTimer = (): void => {
		if (timer.current !== undefined) {
			window.clearTimeout(timer.current);
			timer.current = undefined;
		}
	};
	const hide = (): void => {
		clearTimer();
		setOpen(false);
	};
	const show = (): void => {
		const element = anchor.current;
		if (element === null || unavailable) {
			return;
		}
		const rect = element.getBoundingClientRect();
		const width = Math.min(560, window.innerWidth - 16);
		const belowSpace = window.innerHeight - rect.bottom - 14;
		const aboveSpace = rect.top - 14;
		const above = belowSpace < 260 && aboveSpace >= belowSpace;
		setPosition({
			left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
			top: above ? Math.max(8, rect.top - 6) : rect.bottom + 6,
			above,
			width,
			maxHeight: Math.max(120, Math.min(340, above ? aboveSpace : belowSpace)),
		});
		setOpen(true);
	};
	const requestDiff = (): void => {
		if ((diff !== undefined && diff !== null) || loading || unavailable) {
			return;
		}
		const requestId = request.current + 1;
		request.current = requestId;
		setLoading(true);
		void onRequestDiff(changes, index).then((value) => {
			if (request.current === requestId) {
				setDiff(value);
			}
		}).catch(() => {
			if (request.current === requestId) {
				setDiff(null);
			}
		}).finally(() => {
			if (request.current === requestId) {
				setLoading(false);
			}
		});
	};
	const reveal = (): void => {
		clearTimer();
		timer.current = window.setTimeout(() => {
			timer.current = undefined;
			show();
			requestDiff();
		}, HOVER_DELAY_MS);
	};

	useEffect(() => {
		if (!open) {
			return;
		}
		document.addEventListener('scroll', hide, true);
		window.addEventListener('blur', hide);
		return () => {
			document.removeEventListener('scroll', hide, true);
			window.removeEventListener('blur', hide);
		};
	}, [open]);

	useEffect(() => () => {
		clearTimer();
		request.current += 1;
	}, []);

	const preview = diff?.kind === 'text'
		? workspaceDiffPreview(diff, PREVIEW_LINE_LIMIT)
		: undefined;
	const status = unavailable
		? file.binary === true ? t('workspaceDiffBinary') : t('workspaceDiffOversized')
		: undefined;

	return (
		<li className="workspace-change-item">
			<button
				ref={anchor}
				type="button"
				className={`workspace-change-row${unavailable ? ' unavailable' : ''}`}
				aria-label={status ?? t('workspaceDiffOpen', { path: file.display })}
				aria-disabled={unavailable}
				onPointerEnter={reveal}
				onPointerLeave={hide}
				onFocus={reveal}
				onBlur={hide}
				onClick={() => {
					hide();
					if (!unavailable) {
						onOpenDiff(changes, index);
					}
				}}
			>
				<FileCode2 size={14} className="workspace-change-icon" aria-hidden="true" />
				<span className="workspace-change-path">{file.display}</span>
				{status !== undefined
					? <span className="workspace-change-status">{status}</span>
					: (
						<span className="workspace-change-counts">
							<span className="workspace-added">+{file.added}</span>
							<span className="workspace-deleted">-{file.deleted}</span>
						</span>
					)}
			</button>
			{open && position !== undefined
				? (
					<div
						className={`workspace-diff-preview${position.above ? ' above' : ''}`}
						role="tooltip"
						style={{
							left: `${position.left}px`,
							top: `${position.top}px`,
							width: `${position.width}px`,
							maxHeight: `${position.maxHeight}px`,
						}}
					>
						<div className="workspace-diff-preview-title">{file.display}</div>
						{unavailable
							? <div className="workspace-diff-preview-empty">{status}</div>
							: loading
								? (
									<div className="workspace-diff-preview-empty" role="status">
										<LoaderCircle size={13} className="spin" />
										<span>{t('workspaceDiffLoading')}</span>
									</div>
								)
								: diff === null || diff === undefined
									? (
										<div className="workspace-diff-preview-empty">
											{t('workspaceDiffUnavailable')}
										</div>
									)
									: diff.kind !== 'text'
										? (
											<div className="workspace-diff-preview-empty">
												{diff.kind === 'binary'
													? t('workspaceDiffBinary')
													: t('workspaceDiffOversized')}
											</div>
										)
										: preview === undefined || preview.total === 0
											? (
												<div className="workspace-diff-preview-empty">
													{t('workspaceDiffNoLines')}
												</div>
											)
											: (
												<>
													<div className="workspace-diff-preview-code">
														{preview.lines.map((line, lineIndex) => (
															<div
																key={lineIndex}
																className={`workspace-diff-line ${line.kind}`}
															>
																{line.text}
															</div>
														))}
													</div>
													{preview.total > preview.lines.length
														? (
															<div className="workspace-diff-preview-more">
																{t('workspaceDiffTruncated', {
																	count: preview.total - preview.lines.length,
																})}
															</div>
														)
														: null}
												</>
											)}
					</div>
				)
				: null}
		</li>
	);
}
