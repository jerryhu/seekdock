import { resolve } from 'node:path';
import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/test/**/*.test.js',
	// The extension keeps its data in the user's home directory, so tests point it
	// at the throwaway user-data folder instead of touching the real session store.
	env: {
		SEEKDOCK_DATA_HOME: resolve('.vscode-test/user-data/seekdock-home'),
	},
});
