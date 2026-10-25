import { render } from 'preact';
import { App } from './app.tsx';
import { ConversationStore } from './store.ts';
import { TooltipLayer } from './tooltip.tsx';
import { vscode } from './vscode-api.ts';

const root = document.getElementById('root');
if (root === null) {
	throw new Error('Missing Webview root element.');
}

render(
	<>
		<App store={new ConversationStore()} vscode={vscode} />
		<TooltipLayer />
	</>,
	root,
);
