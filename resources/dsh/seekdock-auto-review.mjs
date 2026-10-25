/**
 * Mount DSH's experimental Auto review layer inside the SeekDock SDK runtime.
 *
 * The packaged SDK runtime keeps `@deepseek-ai/dsh-experimental-auto-review`
 * nested under its own `@deepseek-ai/dsh` installation, so a bare package name
 * in the SeekDock patch cannot resolve from resources/dsh. The Cordis loader
 * can import packages relative to the runtime's own profile, which is exactly
 * how the profile rows resolve, so use that path and mount the package's own
 * plugin implementation under this row.
 */

export const name = 'seekdock-auto-review';

/** Services the Auto review plugin requires before it may advertise its preset. */
export const inject = [
	'approval',
	'llm',
	'permissionPresets',
	'sessions',
	'tools',
	'workingDirectory',
];

const AUTO_REVIEW_PACKAGE = '@deepseek-ai/dsh-experimental-auto-review';

export async function apply(ctx) {
	let autoReview;
	try {
		autoReview = await ctx.loader.import(AUTO_REVIEW_PACKAGE, ctx.baseUrl);
	} catch (error) {
		// Auto review is an optional layer: keep every other permission mode usable
		// when a runtime does not ship the experimental package.
		ctx.logger.warn(`SeekDock: Auto review is unavailable in this runtime: ${String(error)}`);
		return;
	}
	if (typeof autoReview?.apply !== 'function') {
		ctx.logger.warn('SeekDock: the Auto review package exported no apply function.');
		return;
	}
	try {
		await autoReview.apply(ctx);
	} catch (error) {
		ctx.logger.warn(`SeekDock: Auto review failed to mount: ${String(error)}`);
	}
}
