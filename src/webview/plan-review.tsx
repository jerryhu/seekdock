import { useMemo, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { ChevronDown, ChevronRight, ClipboardCheck, FileText } from 'lucide-preact';
import type { PlanReview, PlanReviewAnswer, PlanReviewDecision } from '../shared/rpc.ts';
import { planDocument, type PlanDocument } from '../shared/plan-document.ts';
import type { Translator } from '../shared/i18n/index.ts';
import { useI18n } from './i18n-context.tsx';
import { Markdown } from './markdown.tsx';

/**
 * Plan review card for DSH's `exit_plan_mode` question.
 *
 * Approving leaves plan mode for the next step; asking for changes ends the
 * reviewed turn, and the user sends any revision as their own next message.
 * A settled or replayed card folds to its title and opening paragraph, and
 * either state can open the plan as Markdown beside the chat.
 */
export function PlanReviewView({
	review,
	onOpenLink,
	onAnswer,
	onPreview,
}: {
	review: PlanReview;
	onOpenLink: (url: string) => void;
	onAnswer?: (decision: PlanReviewAnswer) => void;
	onPreview: (plan: PlanDocument) => void;
}): JSX.Element {
	const { t } = useI18n();
	const [sent, setSent] = useState(false);
	// `undefined` follows the default: open while the review is live, folded on replay.
	const [expanded, setExpanded] = useState<boolean | undefined>(undefined);
	const decision = review.decision;
	const document = useMemo(() => planDocument(review.plan), [review.plan]);
	const answering = decision === undefined && !sent;
	// Open while the review still needs an answer, and stay open right after it
	// is sent; a replayed card starts folded so a long plan stays out of the way.
	const bodyVisible = expanded ?? (decision === undefined);

	const answer = (value: PlanReviewAnswer): void => {
		if (!answering) {
			return;
		}
		setSent(true);
		onAnswer?.(value);
	};

	return (
		<section className={`plan-review${decision === undefined ? '' : ` resolved ${decision}`}`}>
			<header className="plan-review-header">
				<ClipboardCheck size={15} aria-hidden="true" />
				<span className="plan-review-title">{t('planReviewTitle')}</span>
				{decision === undefined && sent
					? (
						<span className="plan-review-state" role="status" aria-live="polite">
							{t('submittingEllipsis')}
						</span>
					)
					: null}
			</header>
			{bodyVisible
				? (
					<div className="plan-review-plan">
						<Markdown text={document.markdown} onOpenLink={onOpenLink} />
					</div>
				)
				: (
					<div className="plan-review-summary">
						<span className="plan-review-heading">{document.title}</span>
						{document.summary.length === 0
							? null
							: <p className="plan-review-excerpt">{document.summary}</p>}
					</div>
				)}
			<div className="plan-review-actions">
				<button
					type="button"
					className="secondary-button"
					onClick={() => onPreview(document)}
				>
					<FileText size={13} aria-hidden="true" />
					{t('planReviewPreview')}
				</button>
				<button
					type="button"
					className="secondary-button"
					aria-expanded={bodyVisible}
					onClick={() => setExpanded(!bodyVisible)}
				>
					{bodyVisible
						? <ChevronDown size={13} aria-hidden="true" />
						: <ChevronRight size={13} aria-hidden="true" />}
					<span>{bodyVisible ? t('collapseDetails') : t('expandDetails')}</span>
				</button>
				{answering
					? (
						<>
							<button
								type="button"
								className="secondary-button"
								disabled={sent}
								onClick={() => answer('request-changes')}
							>
								{t('planReviewRequestChanges')}
							</button>
							<button
								type="button"
								className="primary-button"
								disabled={sent}
								onClick={() => answer('approve')}
							>
								{t('planReviewApprove')}
							</button>
						</>
					)
					: decision === undefined
						? null
						: <div className="plan-review-outcome">{decisionLabel(decision, t)}</div>}
			</div>
		</section>
	);
}

function decisionLabel(decision: PlanReviewDecision, t: Translator): string {
	switch (decision) {
		case 'approved':
			return t('planReviewApproved');
		case 'changes-requested':
			return t('planReviewChangesRequested');
		case 'cancelled':
			return t('cancelled');
		case 'unavailable':
			return t('planReviewExpired');
	}
}
