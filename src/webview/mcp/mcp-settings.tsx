import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
	Check,
	LoaderCircle,
	Plus,
	Server,
	Settings2,
	Upload,
} from 'lucide-preact';
import {
	isHostToSettingsMessage,
	type HostToSettingsMessage,
	type SettingsSaveKind,
} from '../../shared/settings-rpc.ts';
import type {
	McpImportResult,
	McpImportSource,
	McpImportSourceId,
	McpServer,
} from '../../shared/mcp-servers.ts';
import type { Translator } from '../../shared/i18n/index.ts';
import { McpImportDialog } from './mcp-import-dialog.tsx';
import {
	cloneServer,
	emptyStdioServer,
	McpServerForm,
} from './mcp-server-form.tsx';
import type { SettingsVsCodeApi } from '../settings-vscode-api.ts';

interface McpSettingsProps {
	vscode: SettingsVsCodeApi;
	t: Translator;
	busy: boolean;
}

type Screen =
	| { kind: 'list' }
	| { kind: 'form'; previousServerName?: string };

type PendingKind = 'servers' | 'sources' | 'save' | 'delete' | 'toggle' | 'import';

/** MCP server settings container coordinating host RPC and the list screen. */
export function McpSettings({ vscode, t, busy }: McpSettingsProps): JSX.Element {
	const [screen, setScreen] = useState<Screen>({ kind: 'list' });
	const [servers, setServers] = useState<readonly McpServer[]>([]);
	const [loading, setLoading] = useState(true);
	const [listError, setListError] = useState<string>();
	const [notice, setNotice] = useState<string>();
	const [draft, setDraft] = useState<McpServer>(emptyStdioServer);
	const [formError, setFormError] = useState<string>();
	const [showImport, setShowImport] = useState(false);
	const [sources, setSources] = useState<readonly McpImportSource[]>([]);
	const [sourcesLoading, setSourcesLoading] = useState(false);
	const [importError, setImportError] = useState<string>();
	const [pendingCount, setPendingCount] = useState(0);
	const pending = useRef(new Map<string, PendingKind>());
	const importResult = useRef<McpImportResult>();
	const translator = useRef(t);
	translator.current = t;

	useEffect(() => {
		const listener = (event: MessageEvent<unknown>): void => {
			if (isHostToSettingsMessage(event.data)) {
				handleHostMessage(event.data);
			}
		};
		window.addEventListener('message', listener);
		requestServers();
		return () => window.removeEventListener('message', listener);
	}, [vscode]);

	const track = (requestId: string, kind: PendingKind): void => {
		pending.current.set(requestId, kind);
		setPendingCount(pending.current.size);
	};

	const clear = (requestId: string): PendingKind | undefined => {
		const kind = pending.current.get(requestId);
		pending.current.delete(requestId);
		setPendingCount(pending.current.size);
		return kind;
	};

	const requestServers = (): void => {
		setLoading(true);
		setListError(undefined);
		const requestId = crypto.randomUUID();
		track(requestId, 'servers');
		vscode.postMessage({ type: 'requestMcpServers', requestId });
	};

	const requestSources = (): void => {
		setSourcesLoading(true);
		setImportError(undefined);
		const requestId = crypto.randomUUID();
		track(requestId, 'sources');
		vscode.postMessage({ type: 'requestMcpImportSources', requestId });
	};

	const handleHostMessage = (message: HostToSettingsMessage): void => {
		switch (message.type) {
			case 'mcpServers':
				if (clear(message.requestId) === 'servers') {
					setServers(message.servers);
					setLoading(false);
					setListError(undefined);
				}
				break;
			case 'mcpImportSources':
				if (clear(message.requestId) === 'sources') {
					setSources(message.sources);
					setSourcesLoading(false);
					setImportError(undefined);
				}
				break;
			case 'mcpImported':
				importResult.current = message.result;
				break;
			case 'saved':
				completeSaved(message.requestId, message.kind);
				break;
			case 'error':
				completeError(message.requestId, message.message);
				break;
			case 'state':
			case 'skillCatalog':
				break;
		}
	};

	const completeSaved = (requestId: string, kind: SettingsSaveKind): void => {
		const operation = clear(requestId);
		if (operation === 'save') {
			setScreen({ kind: 'list' });
			setFormError(undefined);
			setNotice(translator.current('mcpServerSaved'));
			requestServers();
			return;
		}
		if (operation === 'delete') {
			setScreen({ kind: 'list' });
			setNotice(translator.current('mcpServerDeleted'));
			requestServers();
			return;
		}
		if (operation === 'toggle') {
			setNotice(translator.current(
				kind === 'mcpServerToggle' ? 'mcpServerUpdated' : 'mcpServerSaved',
			));
			requestServers();
			return;
		}
		if (operation === 'import') {
			const result = importResult.current;
			setShowImport(false);
			setNotice(result === undefined
				? translator.current('mcpImportCompleted')
				: translator.current('mcpImportedCount', {
					imported: result.imported,
					skipped: result.skipped,
				}));
			requestServers();
		}
	};

	const completeError = (requestId: string, message: string): void => {
		const operation = clear(requestId);
		switch (operation) {
			case 'servers':
				setLoading(false);
				setListError(message);
				break;
			case 'sources':
				setSourcesLoading(false);
				setImportError(message);
				break;
			case 'save':
				setFormError(message);
				break;
			case 'delete':
			case 'toggle':
				setListError(message);
				break;
			case 'import':
				setImportError(message);
				break;
			default:
				break;
		}
	};

	const openAdd = (): void => {
		setDraft(emptyStdioServer());
		setNotice(undefined);
		setFormError(undefined);
		setScreen({ kind: 'form' });
	};

	const openEdit = (server: McpServer): void => {
		setDraft(cloneServer(server));
		setNotice(undefined);
		setFormError(undefined);
		setScreen({ kind: 'form', previousServerName: server.serverName });
	};

	const save = (server: McpServer, secrets: Readonly<Record<string, string>>): void => {
		const requestId = crypto.randomUUID();
		track(requestId, 'save');
		setFormError(undefined);
		vscode.postMessage({
			type: 'saveMcpServer',
			requestId,
			server,
			...(screen.kind === 'form' && screen.previousServerName !== undefined
				? { previousServerName: screen.previousServerName }
				: {}),
			secrets,
		});
	};

	const remove = (): void => {
		if (screen.kind !== 'form' || screen.previousServerName === undefined) {
			return;
		}
		const requestId = crypto.randomUUID();
		track(requestId, 'delete');
		vscode.postMessage({
			type: 'deleteMcpServer',
			requestId,
			serverName: screen.previousServerName,
		});
	};

	const toggle = (server: McpServer): void => {
		const requestId = crypto.randomUUID();
		track(requestId, 'toggle');
		vscode.postMessage({
			type: 'setMcpServerEnabled',
			requestId,
			serverName: server.serverName,
			enabled: !server.enabled,
		});
	};

	const openImport = (): void => {
		importResult.current = undefined;
		setImportError(undefined);
		setShowImport(true);
		requestSources();
	};

	const importServers = (
		sourceId: McpImportSourceId,
		originalNames: readonly string[],
		secrets: Readonly<Record<string, string>>,
	): void => {
		const requestId = crypto.randomUUID();
		track(requestId, 'import');
		importResult.current = undefined;
		setImportError(undefined);
		vscode.postMessage({
			type: 'importMcpServers',
			requestId,
			sourceId,
			originalNames,
			secrets,
		});
	};

	const isBusy = pendingCount > 0;

	return (
		<div className="mcp-settings">
			{screen.kind === 'list'
				? (
					renderList()
				)
				: (
					<McpServerForm
						key={screen.previousServerName ?? 'new'}
						t={t}
						server={draft}
						isEditing={screen.previousServerName !== undefined}
						disabled={busy || isBusy}
						error={formError}
						onChange={setDraft}
						onSave={save}
						onBack={() => {
							setScreen({ kind: 'list' });
							setFormError(undefined);
						}}
						onDelete={remove}
					/>
				)}
			{showImport
				? (
					<McpImportDialog
						t={t}
						sources={sources}
						loading={sourcesLoading}
						error={importError}
						busy={isBusy}
						onClose={() => {
							setShowImport(false);
							setImportError(undefined);
						}}
						onImport={importServers}
					/>
				)
				: null}
		</div>
	);

	function renderList(): JSX.Element {
		return (
			<>
				<div className="mcp-toolbar">
					<button
						type="button"
						className="secondary-button"
						onClick={openImport}
						disabled={busy || isBusy}
					>
						<Upload size={14} />
						<span>{t('mcpImport')}</span>
					</button>
					<button
						type="button"
						className="primary-button"
						onClick={openAdd}
						disabled={busy || isBusy}
					>
						<Plus size={14} />
						<span>{t('mcpAddServer')}</span>
					</button>
				</div>

				{notice !== undefined
					? <p className="settings-notice" role="status">{notice}</p>
					: null}
				{listError !== undefined
					? <p className="key-error" role="alert">{listError}</p>
					: null}

				{loading
					? (
						<div className="settings-panel-empty" role="status">
							<LoaderCircle size={20} className="spin" />
							<p>{t('loading')}</p>
						</div>
					)
					: servers.length === 0
						? (
							<div className="settings-panel-empty">
								<Server size={22} />
								<p>{t('mcpNoServers')}</p>
							</div>
						)
						: (
							<ul className="mcp-server-list">
								{servers.map(server => (
									<li key={server.serverName}>
										<div className="mcp-server-copy">
											<strong>{server.serverName}</strong>
											<span>
												{server.transport === 'stdio' ? t('mcpStdio') : t('mcpHttp')}
											</span>
											{server.originalName !== undefined
												&& server.originalName !== server.serverName
												? <small>{server.originalName}</small>
												: null}
										</div>
										<button
											type="button"
											className="icon-button"
											aria-label={t('mcpEditServer', { name: server.serverName })}
											data-tooltip={t('mcpEditServer', { name: server.serverName })}
											onClick={() => openEdit(server)}
											disabled={busy || isBusy}
										>
											<Settings2 size={16} />
										</button>
										<button
											type="button"
											role="switch"
											className="settings-panel-switch"
											aria-checked={server.enabled}
											aria-label={t(server.enabled ? 'mcpDisableServer' : 'mcpEnableServer', {
												name: server.serverName,
											})}
											disabled={busy || isBusy}
											onClick={() => toggle(server)}
										>
											<span>{server.enabled ? <Check size={11} /> : null}</span>
										</button>
									</li>
								))}
							</ul>
						)}
			</>
		);
	}
}
