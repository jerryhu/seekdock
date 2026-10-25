export interface HorizontalBounds {
	left: number;
	right: number;
}

/**
 * @param bounds - The rendered tooltip's horizontal viewport bounds.
 * @param viewportWidth - The current viewport width in CSS pixels.
 * @param margin - The minimum distance to keep from either viewport edge.
 * @returns the horizontal shift needed to keep the tooltip inside the viewport.
 */
export function tooltipHorizontalShift(
	bounds: HorizontalBounds,
	viewportWidth: number,
	margin = 8,
): number {
	if (bounds.left < margin) {
		return margin - bounds.left;
	}
	if (bounds.right > viewportWidth - margin) {
		return viewportWidth - margin - bounds.right;
	}
	return 0;
}
