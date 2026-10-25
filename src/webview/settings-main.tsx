import { render } from 'preact';
import { SettingsApp } from './settings.tsx';
import { settingsVsCodeApi } from './settings-vscode-api.ts';
import { TooltipLayer } from './tooltip.tsx';

const root = document.getElementById('root');
if (root === null) {
	throw new Error('Missing settings Webview root element.');
}

render(
	<>
		<SettingsApp vscode={settingsVsCodeApi} />
		<TooltipLayer />
	</>,
	root,
);
