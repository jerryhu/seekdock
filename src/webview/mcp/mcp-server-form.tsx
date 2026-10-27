import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import {
	ChevronLeft,
	Globe2,
	KeyRound,
	Plus,
	Server,
	Terminal,
	Trash2,
} from 'lucide-preact';
import {
	collectMcpSecretNames,
	validateMcpServer,
	type McpEntry,
	type McpServer,
	type McpValidationIssue,
} from '../../shared/mcp-servers.ts';
import type { Translator } from '../../shared/i18n/index.ts';

interface McpServerFormProps {
	t: Translator;
	server: McpServer;
	isEditing: boolean;
	disabled: boolean;
	error?: string;
	onChange: (server: McpServer) => void;
	onSave: (server: McpServer, secrets: Readonly<Record<string, string>>) => void;
	onBack: () => void;
	onDelete: () => void;
}

/** Add/edit form for one stdio or Streamable HTTP MCP server. */
export function McpServerForm({
	t,
	server,
	isEditing,
	disabled,
	error,
	onChange,
	onSave,
	onBack,
	onDelete,
}: McpServerFormProps): JSX.Element {
	const [localSecrets, setLocalSecrets] = useState<Record<string, string>>({});
	const [validationError, setValidationError] = useState<string>();
	const [confirmDelete, setConfirmDelete] = useState(false);
	const secretNames = collectMcpSecretNames(server);

	const submit = (): void => {
		const issues = validateMcpServer(server);
		if (issues.length > 0) {
			setValidationError(localizeIssue(t, issues[0]));
			return;
		}
		setValidationError(undefined);
		onSave(server, Object.fromEntries(secretNames.map(name => [
			name,
			localSecrets[name] ?? '',
		])));
	};

	return (
		<>
			<button type="button" className="mcp-back" onClick={onBack}>
				<ChevronLeft size={15} />
				<span>{t('back')}</span>
			</button>
			<div className="mcp-form-heading">
				<div>
					<h2>{isEditing ? t('mcpEditServerTitle') : t('mcpAddServerTitle')}</h2>
					<p>{t('mcpServersDetail')}</p>
				</div>
				{isEditing
					? (
						<button
							type="button"
							className={confirmDelete ? 'primary-button danger-button' : 'secondary-button'}
							onClick={() => {
								if (confirmDelete) {
									onDelete();
								} else {
									setConfirmDelete(true);
								}
							}}
							disabled={disabled}
						>
							<Trash2 size={14} />
							<span>{confirmDelete ? t('mcpDeleteServerConfirm') : t('mcpDeleteServer')}</span>
						</button>
					)
					: null}
			</div>

			<div className="mcp-form">
				<label className="mcp-field">
					<span>{t('mcpServerName')}</span>
					<input
						value={server.serverName}
						placeholder="MCP server name"
						spellcheck={false}
						disabled={disabled}
						onInput={(event) => {
							const serverName = event.currentTarget.value;
							const { originalName: _originalName, importedFrom: _importedFrom, ...rest } = server;
							onChange({ ...rest, serverName });
						}}
					/>
					<small>{t('mcpServerNameHint')}</small>
				</label>

				<div className="mcp-field">
					<span>{t('mcpTransport')}</span>
					<div className="mcp-segmented" role="group" aria-label={t('mcpTransport')}>
						<button
							type="button"
							className={server.transport === 'stdio' ? 'active' : undefined}
							aria-pressed={server.transport === 'stdio'}
							disabled={disabled}
							onClick={() => onChange(changeTransport(server, 'stdio'))}
						>
							<Terminal size={14} />
							<span>{t('mcpStdio')}</span>
						</button>
						<button
							type="button"
							className={server.transport === 'http' ? 'active' : undefined}
							aria-pressed={server.transport === 'http'}
							disabled={disabled}
							onClick={() => onChange(changeTransport(server, 'http'))}
						>
							<Globe2 size={14} />
							<span>{t('mcpHttp')}</span>
						</button>
					</div>
				</div>

				{server.transport === 'stdio'
					? (
						<>
							<label className="mcp-field">
								<span>{t('mcpCommand')}</span>
								<input
									value={server.command}
									placeholder="npx"
									spellcheck={false}
									disabled={disabled}
									onInput={event => onChange({
										...server,
										command: event.currentTarget.value,
									})}
								/>
							</label>
							<div className="mcp-field">
								<span>{t('mcpArguments')}</span>
								{server.args.map((argument, index) => (
									<div className="mcp-entry-row" key={`arg-${index}`}>
										<input
											value={argument}
											placeholder={t('mcpArgumentPlaceholder')}
											spellcheck={false}
											disabled={disabled}
											onInput={(event) => {
												const args = [...server.args];
												args[index] = event.currentTarget.value;
												onChange({ ...server, args });
											}}
										/>
										<button
											type="button"
											className="icon-button"
											aria-label={t('mcpRemove')}
											data-tooltip={t('mcpRemove')}
											disabled={disabled}
											onClick={() => onChange({
												...server,
												args: server.args.filter((_, current) => current !== index),
											})}
										>
											<Trash2 size={15} />
										</button>
									</div>
								))}
								<button
									type="button"
									className="mcp-add-row"
									disabled={disabled}
									onClick={() => onChange({ ...server, args: [...server.args, ''] })}
								>
									<Plus size={14} />
									<span>{t('mcpAddArgument')}</span>
								</button>
							</div>
							<McpEntriesEditor
								t={t}
								title={t('mcpEnvironmentVariables')}
								entries={server.env}
								kind="environment"
								disabled={disabled}
								onChange={env => onChange({ ...server, env })}
							/>
							<label className="mcp-field">
								<span>{t('mcpWorkingDirectory')}</span>
								<input
									value={server.cwd ?? ''}
									placeholder="${workspaceFolder}"
									spellcheck={false}
									disabled={disabled}
									onInput={(event) => {
										const cwd = event.currentTarget.value;
										const { cwd: _cwd, ...withoutCwd } = server;
										onChange(cwd.length === 0 ? withoutCwd : { ...withoutCwd, cwd });
									}}
								/>
								<small>{t('mcpWorkingDirectoryHint')}</small>
							</label>
						</>
					)
					: (
						<>
							<label className="mcp-field">
								<span>{t('mcpUrl')}</span>
								<input
									type="url"
									value={server.url}
									placeholder="https://example.com/mcp"
									spellcheck={false}
									disabled={disabled}
									onInput={event => onChange({
										...server,
										url: event.currentTarget.value,
									})}
								/>
							</label>
							<McpEntriesEditor
								t={t}
								title={t('mcpHeaders')}
								entries={server.headers}
								kind="headers"
								disabled={disabled}
								onChange={headers => onChange({ ...server, headers })}
							/>
						</>
					)}

				<div className="mcp-variable-note">
					<KeyRound size={15} />
					<p>{t('mcpVariablesHelp')}</p>
				</div>

				{secretNames.length > 0
					? (
						<section className="mcp-secret-section">
							<h3>{t('mcpSecretValues')}</h3>
							<p>{t('mcpSecretConfiguredHint')}</p>
							{secretNames.map(name => (
								<label className="mcp-field" key={name}>
									<span>{t('mcpSecretValueFor', { name })}</span>
									<input
										type="password"
										value={localSecrets[name] ?? ''}
										autocomplete="new-password"
										spellcheck={false}
										disabled={disabled}
										onInput={(event) => {
											const value = event.currentTarget.value;
											setLocalSecrets(current => ({ ...current, [name]: value }));
										}}
									/>
								</label>
							))}
						</section>
					)
					: null}

				{validationError ?? error
					? <p className="key-error" role="alert">{validationError ?? error}</p>
					: null}
				<div className="mcp-form-actions">
					<button
						type="button"
						className="primary-button"
						onClick={submit}
						disabled={disabled}
					>
						<Server size={14} />
						<span>{t('save')}</span>
					</button>
				</div>
			</div>
		</>
	);
}

/** @returns a new stdio server with enabled defaulting to true. */
export function emptyStdioServer(): McpServer {
	return {
		serverName: '',
		transport: 'stdio',
		enabled: true,
		command: '',
		args: [],
		env: [],
	};
}

/** @returns a mutable copy suitable for form editing. */
export function cloneServer(server: McpServer): McpServer {
	return server.transport === 'stdio'
		? {
			...server,
			args: [...server.args],
			env: server.env.map(entry => ({ ...entry })),
		}
		: {
			...server,
			headers: server.headers.map(entry => ({ ...entry })),
		};
}

function changeTransport(server: McpServer, transport: 'stdio' | 'http'): McpServer {
	if (transport === server.transport) {
		return server;
	}
	const base = {
		serverName: server.serverName,
		enabled: server.enabled,
		...(server.originalName === undefined ? {} : { originalName: server.originalName }),
		...(server.importedFrom === undefined ? {} : { importedFrom: server.importedFrom }),
	};
	return transport === 'stdio'
		? { ...base, transport, command: '', args: [], env: [] }
		: { ...base, transport, url: '', headers: [] };
}

function McpEntriesEditor({
	t,
	title,
	entries,
	kind,
	disabled,
	onChange,
}: {
	t: Translator;
	title: string;
	entries: readonly McpEntry[];
	kind: 'environment' | 'headers';
	disabled: boolean;
	onChange: (entries: readonly McpEntry[]) => void;
}): JSX.Element {
	const addKey = kind === 'environment'
		? 'mcpAddEnvironmentVariable'
		: 'mcpAddHeader';
	const nameKey = kind === 'environment' ? 'mcpKey' : 'mcpHeaderName';
	const valueKey = kind === 'environment' ? 'mcpValue' : 'mcpHeaderValue';
	return (
		<div className="mcp-field">
			<span>{title}</span>
			{entries.map((entry, index) => (
				<div className="mcp-entry-row mcp-entry-row-pair" key={`${kind}-${index}`}>
					<input
						value={entry.name}
						placeholder={t(nameKey)}
						spellcheck={false}
						disabled={disabled}
						onInput={(event) => {
							const next = [...entries];
							next[index] = { ...entry, name: event.currentTarget.value };
							onChange(next);
						}}
					/>
					<input
						value={entry.value}
						placeholder={t(valueKey)}
						spellcheck={false}
						disabled={disabled}
						onInput={(event) => {
							const next = [...entries];
							next[index] = { ...entry, value: event.currentTarget.value };
							onChange(next);
						}}
					/>
					<button
						type="button"
						className="icon-button"
						aria-label={t('mcpRemove')}
						data-tooltip={t('mcpRemove')}
						disabled={disabled}
						onClick={() => onChange(entries.filter((_, current) => current !== index))}
					>
						<Trash2 size={15} />
					</button>
				</div>
			))}
			<button
				type="button"
				className="mcp-add-row"
				disabled={disabled}
				onClick={() => onChange([...entries, { name: '', value: '' }])}
			>
				<Plus size={14} />
				<span>{t(addKey)}</span>
			</button>
		</div>
	);
}

function localizeIssue(t: Translator, issue: McpValidationIssue | undefined): string {
	if (issue === undefined) {
		return t('hostMcpInvalidConfiguration');
	}
	switch (issue.code) {
		case 'nameRequired':
			return t('hostMcpNameRequired');
		case 'nameInvalid':
			return t('hostMcpNameInvalid');
		case 'commandRequired':
			return t('hostMcpCommandRequired');
		case 'urlRequired':
			return t('hostMcpUrlRequired');
		case 'urlInvalid':
			return t('hostMcpUrlInvalid');
		case 'entryNameRequired':
			return t('hostMcpEntryNameRequired');
		case 'entryNameDuplicate':
			return t('hostMcpEntryNameDuplicate', { name: issue.detail ?? '' });
		case 'entryNameInvalid':
			return t('hostMcpEntryNameInvalid', { name: issue.detail ?? '' });
		case 'unsupportedVariable':
			return t('hostMcpInvalidVariable', { variable: issue.detail ?? '' });
	}
}
