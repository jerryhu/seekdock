import { useMemo, useState } from 'preact/hooks';
import type { ComponentChildren, JSX } from 'preact';
import { Check, Copy } from 'lucide-preact';
import { copyText } from './copy.ts';
import { useI18n } from './i18n-context.tsx';

interface MarkdownProps {
	text: string;
	onOpenLink: (url: string) => void;
}

type MarkdownBlock =
	| { type: 'paragraph'; lines: string[] }
	| { type: 'heading'; level: number; text: string }
	| { type: 'code'; language: string; code: string }
	| { type: 'list'; ordered: boolean; items: string[] }
	| { type: 'quote'; text: string }
	| { type: 'table'; headers: string[]; rows: string[][] }
	| { type: 'rule' };

/** Renders the Markdown subset used by agent responses without injecting HTML. */
export function Markdown({ text, onOpenLink }: MarkdownProps): JSX.Element {
	const blocks = useMemo(() => parseMarkdown(text), [text]);
	return (
		<div className="markdown">
			{blocks.map((block, index) => renderBlock(block, index, onOpenLink))}
		</div>
	);
}

function renderBlock(
	block: MarkdownBlock,
	key: number,
	onOpenLink: (url: string) => void,
): JSX.Element {
	switch (block.type) {
		case 'paragraph':
			return (
				<p key={key}>
					{block.lines.map((line, index) => (
						<span key={index}>
							{renderInline(line, onOpenLink)}
							{index < block.lines.length - 1 ? <br /> : null}
						</span>
					))}
				</p>
			);
		case 'heading': {
			const Tag = `h${Math.min(6, Math.max(1, block.level))}` as keyof JSX.IntrinsicElements;
			return <Tag key={key}>{renderInline(block.text, onOpenLink)}</Tag>;
		}
		case 'code':
			return <CodeBlock key={key} language={block.language} code={block.code} />;
		case 'list':
			return block.ordered
				? (
					<ol key={key}>
						{block.items.map((item, index) => <li key={index}>{renderListItem(item, onOpenLink)}</li>)}
					</ol>
				)
				: (
					<ul key={key}>
						{block.items.map((item, index) => <li key={index}>{renderListItem(item, onOpenLink)}</li>)}
					</ul>
				);
		case 'quote':
			return (
				<blockquote key={key}>
					{parseMarkdown(block.text).map((inner, index) => renderBlock(inner, index, onOpenLink))}
				</blockquote>
			);
		case 'table':
			return (
				<div className="table-wrap" key={key}>
					<table>
						<thead>
							<tr>
								{block.headers.map((header, index) => (
									<th key={index}>{renderInline(header, onOpenLink)}</th>
								))}
							</tr>
						</thead>
						<tbody>
							{block.rows.map((row, rowIndex) => (
								<tr key={rowIndex}>
									{block.headers.map((_, cellIndex) => (
										<td key={cellIndex}>{renderInline(row[cellIndex] ?? '', onOpenLink)}</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			);
		case 'rule':
			return <hr key={key} />;
	}
}

function renderListItem(text: string, onOpenLink: (url: string) => void): ComponentChildren {
	const task = /^\[([ xX])\]\s+(.*)$/.exec(text);
	if (task === null) {
		return renderInline(text, onOpenLink);
	}
	const complete = task[1]?.toLowerCase() === 'x';
	return (
		<span className="task-item">
			<span className={`task-box${complete ? ' checked' : ''}`} aria-hidden="true">
				{complete ? <Check size={10} strokeWidth={3} /> : null}
			</span>
			{renderInline(task[2] ?? '', onOpenLink)}
		</span>
	);
}

function CodeBlock({ language, code }: { language: string; code: string }): JSX.Element {
	const { t } = useI18n();
	const [copied, setCopied] = useState(false);
	const copy = (): void => {
		void copyText(code).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1_500);
		});
	};
	return (
		<div className="code-block">
			<div className="code-toolbar">
				<span>{language.length === 0 ? t('code') : language}</span>
				<button
					type="button"
					className="icon-button"
					aria-label={copied ? t('copied') : t('copyCode')}
					data-tooltip={copied ? t('copied') : t('copyCode')}
					data-tooltip-align="end"
					onClick={copy}
				>
					{copied ? <Check size={13} /> : <Copy size={13} />}
				</button>
			</div>
			<pre><code>{code}</code></pre>
		</div>
	);
}

function renderInline(text: string, onOpenLink: (url: string) => void): ComponentChildren[] {
	// Match one supported Markdown token at a time. Links are restricted to
	// http(s) and mailto so the renderer never emits arbitrary URL schemes.
	const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\*[^*\n]+\*|_[^_\n]+_|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)|<((?:https?:\/\/|mailto:)[^>\s]+)>)/g;
	const nodes: ComponentChildren[] = [];
	let cursor = 0;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(text)) !== null) {
		if (match.index > cursor) {
			nodes.push(text.slice(cursor, match.index));
		}
		const token = match[0];
		if (token.startsWith('`')) {
			nodes.push(<code key={match.index}>{token.slice(1, -1)}</code>);
		} else if (token.startsWith('**') || token.startsWith('__')) {
			nodes.push(<strong key={match.index}>{renderInline(token.slice(2, -2), onOpenLink)}</strong>);
		} else if (token.startsWith('~~')) {
			nodes.push(<del key={match.index}>{renderInline(token.slice(2, -2), onOpenLink)}</del>);
		} else if (token.startsWith('*') || token.startsWith('_')) {
			nodes.push(<em key={match.index}>{renderInline(token.slice(1, -1), onOpenLink)}</em>);
		} else if (token.startsWith('[')) {
			const label = match[2] ?? '';
			const url = match[3] ?? '';
			nodes.push(
				<a
					key={match.index}
					href={url}
					title={url}
					onClick={(event) => {
						event.preventDefault();
						onOpenLink(url);
					}}
				>
					{renderInline(label, onOpenLink)}
				</a>,
			);
		} else if (token.startsWith('<')) {
			const url = token.slice(1, -1);
			nodes.push(
				<a
					key={match.index}
					href={url}
					title={url}
					onClick={(event) => {
						event.preventDefault();
						onOpenLink(url);
					}}
				>
					{url}
				</a>,
			);
		}
		cursor = pattern.lastIndex;
	}
	if (cursor < text.length) {
		nodes.push(text.slice(cursor));
	}
	return nodes;
}

function parseMarkdown(source: string): MarkdownBlock[] {
	const lines = source.replace(/\r\n?/g, '\n').split('\n');
	const blocks: MarkdownBlock[] = [];
	let index = 0;

	while (index < lines.length) {
		const line = lines[index] ?? '';
		if (line.trim().length === 0) {
			index += 1;
			continue;
		}

		const fence = /^\s*```([^\s`]*)\s*$/.exec(line);
		if (fence !== null) {
			const code: string[] = [];
			index += 1;
			while (index < lines.length && !/^\s*```\s*$/.test(lines[index] ?? '')) {
				code.push(lines[index] ?? '');
				index += 1;
			}
			if (index < lines.length) {
				index += 1;
			}
			blocks.push({ type: 'code', language: fence[1] ?? '', code: code.join('\n') });
			continue;
		}

		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (heading !== null) {
			blocks.push({
				type: 'heading',
				level: heading[1]?.length ?? 1,
				text: heading[2] ?? '',
			});
			index += 1;
			continue;
		}

		if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
			blocks.push({ type: 'rule' });
			index += 1;
			continue;
		}

		if (/^\s*>/.test(line)) {
			const quote: string[] = [];
			while (index < lines.length && /^\s*>/.test(lines[index] ?? '')) {
				quote.push((lines[index] ?? '').replace(/^\s*>\s?/, ''));
				index += 1;
			}
			blocks.push({ type: 'quote', text: quote.join('\n') });
			continue;
		}

		const firstList = parseListLine(line);
		if (firstList !== undefined) {
			const items: string[] = [];
			while (index < lines.length) {
				const item = parseListLine(lines[index] ?? '');
				if (item === undefined || item.ordered !== firstList.ordered) {
					break;
				}
				items.push(item.text);
				index += 1;
			}
			blocks.push({ type: 'list', ordered: firstList.ordered, items });
			continue;
		}

		const nextLine = lines[index + 1] ?? '';
		if (line.includes('|') && isTableSeparator(nextLine)) {
			const headers = splitTableRow(line);
			const rows: string[][] = [];
			index += 2;
			while (index < lines.length && (lines[index] ?? '').includes('|')) {
				rows.push(splitTableRow(lines[index] ?? ''));
				index += 1;
			}
			blocks.push({ type: 'table', headers, rows });
			continue;
		}

		const paragraph: string[] = [line];
		index += 1;
		while (index < lines.length) {
			const candidate = lines[index] ?? '';
			if (candidate.trim().length === 0 || isBlockStart(candidate)) {
				break;
			}
			paragraph.push(candidate);
			index += 1;
		}
		blocks.push({ type: 'paragraph', lines: paragraph });
	}

	return blocks;
}

function parseListLine(line: string): { ordered: boolean; text: string } | undefined {
	const match = /^\s*(?:([-+*])|(\d+)[.)])\s+(.*)$/.exec(line);
	if (match === null) {
		return undefined;
	}
	return { ordered: match[2] !== undefined, text: match[3] ?? '' };
}

function isBlockStart(line: string): boolean {
	return /^\s*```/.test(line)
		|| /^(#{1,6})\s+/.test(line)
		|| /^\s*>/.test(line)
		|| /^\s*(?:[-+*]|\d+[.)])\s+/.test(line)
		|| /^\s*(---+|\*\*\*+|___+)\s*$/.test(line);
}

function splitTableRow(line: string): string[] {
	return line
		.trim()
		.replace(/^\|/, '')
		.replace(/\|$/, '')
		.split('|')
		.map(cell => cell.trim());
}

function isTableSeparator(line: string): boolean {
	return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}
