import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import {
	FileJson,
	LoaderCircle,
	Upload,
	X,
} from 'lucide-preact';
import type { Translator } from '../../shared/i18n/index.ts';
import type {
	McpImportServerPreview,
	McpImportSource,
	McpImportSourceId,
} from '../../shared/mcp-servers.ts';

interface McpImportDialogProps {
	t: Translator;
	sources: readonly McpImportSource[];
	loading: boolean;
	error?: string;
	busy: boolean;
	onClose: () => void;
	onImport: (
		sourceId: McpImportSourceId,
		originalNames: readonly string[],
		secrets: Readonly<Record<string, string>>,
	) => void;
}

/** Select and import declarations from supported read-only MCP configuration sources. */
export function McpImportDialog({
	t,
	sources,
	loading,
	error,
	busy,
	onClose,
	onImport,
}: McpImportDialogProps): JSX.Element {
	const [selected, setSelected] = useState<Record<string, readonly string[]>>({});
	const [secrets, setSecrets] = useState<Record<string, string>>({});

	useEffect(() => {
		setSelected(Object.fromEntries(sources.map(source => [
			source.id,
			source.servers
				.filter(server => server.error === undefined)
				.map(server => server.originalName),
		])));
	}, [sources]);

	const toggle = (sourceId: McpImportSourceId, originalName: string): void => {
		setSelected((current) => {
			const names = current[sourceId] ?? [];
			return {
				...current,
				[sourceId]: names.includes(originalName)
					? names.filter(name => name !== originalName)
					: [...names, originalName],
			};
		});
	};

	return (
		<div className="mcp-dialog-backdrop" role="presentation">
			<section
				className="mcp-dialog"
				role="dialog"
				aria-modal="true"
				aria-labelledby="mcp-import-title"
			>
				<header className="mcp-dialog-header">
					<div>
						<h2 id="mcp-import-title">{t('mcpImportTitle')}</h2>
						<p>{t('mcpImportDescription')}</p>
					</div>
					<button
						type="button"
						className="icon-button"
						aria-label={t('close')}
						data-tooltip={t('close')}
						onClick={onClose}
						disabled={busy}
					>
						<X size={16} />
					</button>
				</header>
				{loading
					? (
						<div className="settings-panel-empty" role="status">
							<LoaderCircle size={20} className="spin" />
							<p>{t('mcpLoadingImportSources')}</p>
						</div>
					)
					: (
						<div className="mcp-import-sources">
							{sources.map(source => {
								const names = selected[source.id] ?? [];
								const secretNames = [...new Set(source.servers
									.filter(server => (
										server.error === undefined
										&& names.includes(server.originalName)
									))
									.flatMap(server => server.secretNames))];
								const canImport = source.available
									&& source.error === undefined
									&& names.length > 0
									&& !busy;
								return (
									<section className="mcp-import-source" key={source.id}>
										<header>
											<div className="mcp-import-source-title">
												<FileJson size={15} />
												<strong>{t(importSourceLabel(source.id))}</strong>
											</div>
											<code>{source.path}</code>
										</header>
										{!source.available
											? <p className="mcp-muted">{t('mcpImportSourceMissing')}</p>
											: source.error !== undefined
												? <p className="key-error">{t('mcpImportSourceInvalid')}</p>
												: source.servers.length === 0
													? <p className="mcp-muted">{t('mcpImportNoServers')}</p>
													: (
														<>
															<ul className="mcp-import-list">
																{source.servers.map(server => (
																	<li key={server.originalName}>
																		<ImportRow
																			t={t}
																			server={server}
																			checked={names.includes(server.originalName)}
																			onChange={() => toggle(source.id, server.originalName)}
																		/>
																	</li>
																))}
															</ul>
															{secretNames.map(name => (
																<label className="mcp-field" key={name}>
																	<span>{t('mcpSecretValueFor', { name })}</span>
																	<input
																		type="password"
																		value={secrets[name] ?? ''}
																		autocomplete="new-password"
																		spellcheck={false}
																		disabled={busy}
																		onInput={(event) => {
																			const value = event.currentTarget.value;
																			setSecrets(current => ({ ...current, [name]: value }));
																		}}
																	/>
																</label>
															))}
															<div className="mcp-import-actions">
																<button
																	type="button"
																	className="secondary-button"
																	disabled={!canImport}
																	onClick={() => onImport(source.id, names, secrets)}
																>
																	<Upload size={14} />
																	<span>{t('mcpImportSelectedServers', {
																		count: names.length,
																	})}</span>
																</button>
															</div>
														</>
													)}
									</section>
								);
							})}
						</div>
					)}
				{error !== undefined
					? <p className="key-error" role="alert">{error}</p>
					: null}
			</section>
		</div>
	);
}

function ImportRow({
	t,
	server,
	checked,
	onChange,
}: {
	t: Translator;
	server: McpImportServerPreview;
	checked: boolean;
	onChange: () => void;
}): JSX.Element {
	const disabled = server.error !== undefined;
	return (
		<label className={disabled ? 'mcp-import-row invalid' : 'mcp-import-row'}>
			<input
				type="checkbox"
				checked={checked && !disabled}
				disabled={disabled}
				onChange={onChange}
			/>
			<span className="mcp-import-row-copy">
				<strong>{server.originalName}</strong>
				{server.serverName !== server.originalName && server.serverName.length > 0
					? (
						<small>
							{t('mcpNameMapping', { name: server.serverName })}
						</small>
					)
					: null}
				{server.transport !== undefined
					? (
						<small>
							{server.transport === 'stdio' ? t('mcpStdio') : t('mcpHttp')}
						</small>
					)
					: null}
				{server.error !== undefined
					? <em>{localizeImportError(t, server.error)}</em>
					: null}
			</span>
		</label>
	);
}

function localizeImportError(
	t: Translator,
	error: NonNullable<McpImportServerPreview['error']>,
): string {
	switch (error.code) {
		case 'invalidConfiguration':
			return t('mcpImportInvalidConfiguration');
		case 'invalidName':
			return t('mcpImportInvalidName');
		case 'duplicateName':
			return t('mcpImportDuplicateName', { name: error.detail ?? '' });
		case 'unsupportedTransport':
			return t('mcpImportUnsupportedTransport', { transport: error.detail ?? '' });
		case 'unsupportedVariable':
			return t('mcpImportUnsupportedVariable', { variable: error.detail ?? '' });
	}
}

function importSourceLabel(
	id: McpImportSourceId,
):
	| 'mcpImportSourceVscode'
	| 'mcpImportSourceCodex'
	| 'mcpImportSourceClaude'
	| 'mcpImportSourceCursor' {
	switch (id) {
		case 'vscode':
			return 'mcpImportSourceVscode';
		case 'codex':
			return 'mcpImportSourceCodex';
		case 'claude':
			return 'mcpImportSourceClaude';
		case 'cursor':
			return 'mcpImportSourceCursor';
	}
}
