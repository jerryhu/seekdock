import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { tooltipHorizontalShift } from './tooltip-position.ts';

type TooltipPlacement = 'top' | 'bottom';
type TooltipAlignment = 'start' | 'center' | 'end';

interface TooltipState {
	text: string;
	placement: TooltipPlacement;
	alignment: TooltipAlignment;
	left: number;
	top: number;
}

const SHOW_DELAY_MS = 260;
const VIEWPORT_GAP = 7;
const VIEWPORT_MARGIN = 8;

/**
 * Renders one viewport-level tooltip for elements carrying `data-tooltip`.
 * A shared fixed layer keeps tips visible outside scroll and overflow containers.
 */
export function TooltipLayer(): JSX.Element | null {
	const [tooltip, setTooltip] = useState<TooltipState>();
	const timer = useRef<number>();
	const activeTarget = useRef<HTMLElement>();
	const bubble = useRef<HTMLDivElement>(null);

	useLayoutEffect(() => {
		if (tooltip === undefined || bubble.current === null) {
			return;
		}
		const bounds = bubble.current.getBoundingClientRect();
		const shift = tooltipHorizontalShift(bounds, window.innerWidth, VIEWPORT_MARGIN);
		if (shift === 0) {
			return;
		}
		setTooltip(current => current === undefined
			? current
			: { ...current, left: current.left + shift });
	}, [tooltip]);

	useEffect(() => {
		const clearTimer = (): void => {
			if (timer.current !== undefined) {
				window.clearTimeout(timer.current);
				timer.current = undefined;
			}
		};

		const hide = (): void => {
			clearTimer();
			activeTarget.current = undefined;
			setTooltip(undefined);
		};

		const show = (target: HTMLElement): void => {
			const text = target.dataset.tooltip;
			if (text === undefined || text.length === 0 || !target.isConnected) {
				return;
			}
			const rect = target.getBoundingClientRect();
			const requestedPlacement = target.dataset.tooltipPlacement === 'bottom'
				? 'bottom'
				: 'top';
			const placement = requestedPlacement === 'top' && rect.top < 44
				? 'bottom'
				: requestedPlacement;
			const alignment = target.dataset.tooltipAlign === 'start'
				? 'start'
				: target.dataset.tooltipAlign === 'end' ? 'end' : 'center';
			const left = alignment === 'start'
				? rect.left
				: alignment === 'end' ? rect.right : rect.left + rect.width / 2;
			const top = placement === 'bottom'
				? rect.bottom + VIEWPORT_GAP
				: rect.top - VIEWPORT_GAP;
			activeTarget.current = target;
			setTooltip({ text, placement, alignment, left, top });
		};

		const targetFromEvent = (event: Event): HTMLElement | undefined => {
			if (!(event.target instanceof Element)) {
				return undefined;
			}
			const target = event.target.closest('[data-tooltip]');
			return target instanceof HTMLElement ? target : undefined;
		};

		const onPointerOver = (event: PointerEvent): void => {
			const target = targetFromEvent(event);
			if (target === undefined || target === activeTarget.current) {
				return;
			}
			clearTimer();
			activeTarget.current = target;
			timer.current = window.setTimeout(() => {
				timer.current = undefined;
				show(target);
			}, SHOW_DELAY_MS);
		};

		const onPointerOut = (event: PointerEvent): void => {
			const target = targetFromEvent(event);
			const related = event.relatedTarget;
			if (target === undefined
				|| target !== activeTarget.current
				|| (related instanceof Node && target.contains(related))) {
				return;
			}
			hide();
		};

		const onFocusIn = (event: FocusEvent): void => {
			const target = targetFromEvent(event);
			if (target === undefined
				|| target === activeTarget.current
				|| !target.matches(':focus-visible')) {
				return;
			}
			clearTimer();
			show(target);
		};

		const onFocusOut = (event: FocusEvent): void => {
			const target = targetFromEvent(event);
			if (target === undefined || target !== activeTarget.current) {
				return;
			}
			hide();
		};

		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === 'Enter' || event.key === ' ' || event.key === 'Escape') {
				hide();
			}
		};

		document.addEventListener('pointerover', onPointerOver);
		document.addEventListener('pointerout', onPointerOut);
		document.addEventListener('focusin', onFocusIn);
		document.addEventListener('focusout', onFocusOut);
		document.addEventListener('pointerdown', hide, true);
		document.addEventListener('keydown', onKeyDown, true);
		document.addEventListener('scroll', hide, true);
		window.addEventListener('resize', hide);
		return () => {
			clearTimer();
			document.removeEventListener('pointerover', onPointerOver);
			document.removeEventListener('pointerout', onPointerOut);
			document.removeEventListener('focusin', onFocusIn);
			document.removeEventListener('focusout', onFocusOut);
			document.removeEventListener('pointerdown', hide, true);
			document.removeEventListener('keydown', onKeyDown, true);
			document.removeEventListener('scroll', hide, true);
			window.removeEventListener('resize', hide);
		};
	}, []);

	if (tooltip === undefined) {
		return null;
	}
	return (
		<div
			ref={bubble}
			className={`tooltip-bubble tooltip-${tooltip.placement} tooltip-align-${tooltip.alignment}`}
			style={{ left: `${tooltip.left}px`, top: `${tooltip.top}px` }}
			role="tooltip"
			aria-hidden="true"
		>
			{tooltip.text}
		</div>
	);
}
