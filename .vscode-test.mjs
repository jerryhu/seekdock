import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import { defineConfig } from '@vscode/test-cli';

// VS Code resolves argv.json and the macOS keychain through HOME. SeekDock's
// DSH runtime runs agent commands with an isolated HOME, so a test host started
// from that shell cannot find the login keychain (the extension reads
// SecretStorage) and blocks on native dialogs. Anchor the test host to the real
// OS user home; in a normal terminal this changes nothing.
const userHome = userInfo().homedir;

export default defineConfig({
	files: 'out/test/**/*.test.js',
	// The extension keeps its data in the user's home directory, so tests point it
	// at the throwaway user-data folder instead of touching the real session store.
	env: {
		SEEKDOCK_DATA_HOME: resolve('.vscode-test/user-data/seekdock-home'),
		HOME: userHome,
		USERPROFILE: userHome,
	},
});
