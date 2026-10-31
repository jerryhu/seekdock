import { useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { ClipboardCheck } from 'lucide-preact';
import type { PlanReview, PlanReviewAnswer, PlanReviewDecision } from '../shared/rpc.ts';
import type { Translator } from '../shared/i18n/index.ts';
import { useI18n } from './i18n-context.tsx';
import { Markdown } from './markdown.tsx';

/**
 * Plan review card for DSH's `exit_plan_mode` question. Approving leaves plan
 * mode for the next step; keeping planning sends the textarea back to the model
 * as revision feedback. Once answered, the card keeps the closed outcome.
 */
export function PlanReviewView({
	review,
	onOpenLink,
	onAnswer,
}: {
	review: PlanReview;
	onOpenLink: (url: string) => void;
	onAnswer?: (decision: PlanReviewAnswer, feedback: string) => void;
}): JSX.Element {
	const { t } = useI18n();
	const [sent, setSent] = useState(false);
	const [feedback, setFeedback] = useState('');
	const decision = review.decision;

	const answer = (value: PlanReviewAnswer): void => {
		if (sent || decision !== undefined) {
			return;
		}
		setSent(true);
		onAnswer?.(value, feedback);
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
			<div className="plan-review-plan">
				<Markdown text={review.plan} onOpenLink={onOpenLink} />
			</div>
			{decision === undefined
				? (
					<>
						<label className="plan-review-feedback">
							<span>{t('planReviewFeedback')}</span>
							<textarea
								value={feedback}
								rows={2}
								disabled={sent}
								placeholder={t('planReviewFeedbackPlaceholder')}
								onInput={event => setFeedback(event.currentTarget.value)}
							/>
						</label>
						<div className="plan-review-actions">
							<button
								type="button"
								className="secondary-button"
								disabled={sent}
								onClick={() => answer('keep-planning')}
							>
								{t('planReviewKeepPlanning')}
							</button>
							<button
								type="button"
								className="primary-button"
								disabled={sent}
								onClick={() => answer('approve')}
							>
								{t('planReviewApprove')}
							</button>
						</div>
					</>
				)
				: <div className="plan-review-outcome">{decisionLabel(decision, t)}</div>}
		</section>
	);
}

function decisionLabel(decision: PlanReviewDecision, t: Translator): string {
	switch (decision) {
		case 'approved':
			return t('planReviewApproved');
		case 'keep-planning':
			return t('planReviewKept');
		case 'cancelled':
			return t('cancelled');
		case 'unavailable':
			return t('planReviewExpired');
	}
}
