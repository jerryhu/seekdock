import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import {
	ArrowLeft,
	History,
	LoaderCircle,
	MessageSquare,
	RefreshCw,
	Trash2,
} from 'lucide-preact';
import type { SessionSummary } from '../shared/rpc.ts';
import { intlLocale, type Language, type Translator } from '../shared/i18n/index.ts';
import { useI18n } from './i18n-context.tsx';

const RECENT_SESSION_LIMIT = 3;

interface RecentSessionsProps {
	sessions: readonly SessionSummary[];
	total: number;
	loading: boolean;
	error: string | undefined;
	onSelect: (sessionId: string) => void;
	onViewAll: () => void;
}

export function RecentSessions({
	sessions,
	total,
	loading,
	error,
	onSelect,
	onViewAll,
}: RecentSessionsProps): JSX.Element {
	const { language, t } = useI18n();
	const visibleSessions = sessions.slice(0, RECENT_SESSION_LIMIT);
	return (
		<div className="recent-sessions">
			{error !== undefined
				? <p className="session-empty error" role="alert">{error}</p>
				: visibleSessions.length === 0
					? (
						<p className="recent-sessions-empty">
							{loading ? t('loading') : t('noSessions')}
						</p>
					)
					: (
						<ul className="recent-session-list">
							{visibleSessions.map(session => (
								<li key={session.id}>
									<button
										type="button"
										className="recent-session-row"
										title={session.title}
										onClick={() => onSelect(session.id)}
									>
										<span className="recent-session-title">{session.title}</span>
										<time
											className="recent-session-time"
											dateTime={new Date(session.updatedAt).toISOString()}
										>
											{formatSessionTime(session.updatedAt, language, t)}
										</time>
									</button>
								</li>
							))}
						</ul>
					)}
			{error === undefined && total > 0
				? (
					<button type="button" className="recent-sessions-view-all" onClick={onViewAll}>
						{t('viewAllSessions', { count: total })}
					</button>
				)
				: null}
		</div>
	);
}

interface SessionHistoryPageProps {
	sessions: readonly SessionSummary[];
	activeSessionId: string | undefined;
	loading: boolean;
	error: string | undefined;
	onBack: () => void;
	onDelete: (sessionId: string) => void;
	onRefresh: () => void;
	onSelect: (sessionId: string) => void;
	deletingSessionId: string | undefined;
}

/** Full history view grouped by recency with selection and deletion controls. */
export function SessionHistoryPage({
	sessions,
	activeSessionId,
	loading,
	error,
	onBack,
	onDelete,
	onRefresh,
	onSelect,
	deletingSessionId,
}: SessionHistoryPageProps): JSX.Element {
	const { language, t } = useI18n();
	const groups = groupSessions(sessions, t);
	return (
		<div className="history-page">
			<header className="page-header">
				<button
					type="button"
					className="icon-button"
					aria-label={t('back')}
					data-tooltip-placement="bottom"
					data-tooltip-align="start"
					onClick={onBack}
				>
					<ArrowLeft size={16} />
				</button>
				<div className="page-heading">
					<History size={16} />
					<h1>{t('history')}</h1>
					<span className="page-count">{sessions.length}</span>
				</div>
				<button
					type="button"
					className="icon-button page-refresh"
					aria-label={t('history')}
					data-tooltip={t('history')}
					data-tooltip-placement="bottom"
					data-tooltip-align="end"
					disabled={loading}
					onClick={onRefresh}
				>
					<RefreshCw size={14} className={loading ? 'spin' : undefined} />
				</button>
			</header>
			<div className="history-page-content">
				{error !== undefined
					? <p className="session-empty error" role="alert">{error}</p>
					: groups.length === 0
						? (
							<p className="session-empty">
								{loading ? t('loading') : t('noSessions')}
							</p>
						)
						: groups.map(group => (
							<section className="history-group" key={group.label}>
								<h2>{group.label}</h2>
								<div className="history-group-list">
									{group.sessions.map(session => (
										<SessionRow
											key={session.id}
											session={session}
											active={session.id === activeSessionId}
											deletingSessionId={deletingSessionId}
											language={language}
											t={t}
											onDelete={onDelete}
											onSelect={onSelect}
										/>
									))}
								</div>
							</section>
						))}
			</div>
		</div>
	);
}

function SessionRow({
	session,
	active,
	deletingSessionId,
	onDelete,
	onSelect,
	language,
	t,
}: {
	session: SessionSummary;
	active: boolean;
	deletingSessionId?: string;
	onDelete?: (sessionId: string) => void;
	onSelect: (sessionId: string) => void;
	language: Language;
	t: Translator;
}): JSX.Element {
	const [confirming, setConfirming] = useState(false);
	const row = useRef<HTMLDivElement>(null);
	const deleting = deletingSessionId === session.id;

	useEffect(() => {
		if (!confirming) {
			return;
		}
		const resetOutsideRow = (event: Event): void => {
			if (event.target instanceof Node && !row.current?.contains(event.target)) {
				setConfirming(false);
			}
		};
		document.addEventListener('pointerdown', resetOutsideRow, true);
		document.addEventListener('focusin', resetOutsideRow, true);
		return () => {
			document.removeEventListener('pointerdown', resetOutsideRow, true);
			document.removeEventListener('focusin', resetOutsideRow, true);
		};
	}, [confirming]);

	return (
		<div className={`session-row${active ? ' active' : ''}`} ref={row}>
			<button
				type="button"
				className="session-row-main"
				title={session.title}
				onClick={() => onSelect(session.id)}
			>
				<span className="session-row-icon"><MessageSquare size={13} /></span>
				<span className="session-row-copy">
					<span className="session-row-title">{session.title}</span>
					<span className="session-row-meta">
						{formatSessionTime(session.updatedAt, language, t)}
						<span aria-hidden="true"> · </span>
						{t('messageCount', { count: session.messageCount })}
					</span>
				</span>
				{active
					? <span className="session-active-dot" aria-label={t('currentSession')} />
					: null}
			</button>
			{onDelete !== undefined && !active
				? (
					<button
						type="button"
						className={`session-delete-button${confirming ? ' confirming' : ''}`}
						aria-label={t('confirmDeleteSession', { title: session.title })}
						data-tooltip={confirming ? t('confirmDeleteAgain') : t('deleteSession')}
						data-tooltip-align="end"
						disabled={deletingSessionId !== undefined}
						onClick={() => {
							if (confirming) {
								onDelete(session.id);
							} else {
								setConfirming(true);
							}
						}}
						onBlur={(event) => {
							const row = event.currentTarget.parentElement;
							if (event.relatedTarget instanceof Node && row?.contains(event.relatedTarget)) {
								return;
							}
							setConfirming(false);
						}}
					>
						{deleting
							? <LoaderCircle size={13} className="spin" />
								: confirming
									? <span>{t('confirmDelete')}</span>
									: <Trash2 size={13} />}
					</button>
				)
				: null}
		</div>
	);
}

function groupSessions(
	sessions: readonly SessionSummary[],
	t: Translator,
): readonly { label: string; sessions: readonly SessionSummary[] }[] {
	const now = new Date();
	const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const startOfYesterday = startOfToday - 24 * 60 * 60 * 1_000;
	const startOfSevenDays = startOfToday - 6 * 24 * 60 * 60 * 1_000;
	const buckets = [
		{ label: t('today'), sessions: [] as SessionSummary[] },
		{ label: t('yesterday'), sessions: [] as SessionSummary[] },
		{ label: t('pastSevenDays'), sessions: [] as SessionSummary[] },
		{ label: t('earlier'), sessions: [] as SessionSummary[] },
	];
	for (const session of sessions) {
		if (session.updatedAt >= startOfToday) {
			buckets[0]!.sessions.push(session);
		} else if (session.updatedAt >= startOfYesterday) {
			buckets[1]!.sessions.push(session);
		} else if (session.updatedAt >= startOfSevenDays) {
			buckets[2]!.sessions.push(session);
		} else {
			buckets[3]!.sessions.push(session);
		}
	}
	return buckets.filter(bucket => bucket.sessions.length > 0);
}

function formatSessionTime(
	timestamp: number,
	language: Language,
	t: Translator,
): string {
	const date = new Date(timestamp);
	const now = new Date();
	const elapsedMinutes = Math.max(0, Math.floor((now.getTime() - timestamp) / 60_000));
	if (elapsedMinutes < 1) {
		return t('justNow');
	}
	if (elapsedMinutes < 60) {
		return t('minutesAgo', { count: elapsedMinutes });
	}
	if (elapsedMinutes < 24 * 60) {
		return t('hoursAgo', { count: Math.floor(elapsedMinutes / 60) });
	}
	const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const startOfYesterday = startOfToday - 24 * 60 * 60 * 1_000;
	if (timestamp >= startOfYesterday) {
		return t('yesterday');
	}
	if (timestamp >= startOfToday - 6 * 24 * 60 * 60 * 1_000) {
		return new Intl.DateTimeFormat(intlLocale(language), { weekday: 'short' }).format(date);
	}
	return new Intl.DateTimeFormat(intlLocale(language), {
		month: 'numeric',
		day: 'numeric',
	}).format(date);
}
