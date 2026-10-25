import { context } from "esbuild";

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

async function main() {
	const extensionContext = await context({
		entryPoints: [
			'src/extension.ts'
		],
		bundle: true,
		format: 'esm',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outfile: 'dist/extension.js',
		external: ['vscode'],
		logLevel: 'silent',
		plugins: [
			/* add to the end of plugins array */
			esbuildProblemMatcherPlugin,
		],
	});
	const webviewContext = await context({
		entryPoints: [
			'src/webview/main.tsx'
		],
		bundle: true,
		format: 'iife',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'browser',
		outfile: 'dist/webview.js',
		logLevel: 'silent',
		plugins: [
			esbuildProblemMatcherPlugin,
		],
	});
	const settingsWebviewContext = await context({
		entryPoints: [
			'src/webview/settings-main.tsx'
		],
		bundle: true,
		format: 'iife',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'browser',
		outfile: 'dist/settings-webview.js',
		logLevel: 'silent',
		plugins: [
			esbuildProblemMatcherPlugin,
		],
	});
	const runtimeWrapperContext = await context({
		entryPoints: [
			'src/host/dsh-runtime-wrapper.ts'
		],
		bundle: true,
		format: 'esm',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outfile: 'dist/dsh-runtime-wrapper.js',
		logLevel: 'silent',
		plugins: [
			esbuildProblemMatcherPlugin,
		],
	});
	if (watch) {
		await Promise.all([
			extensionContext.watch(),
			webviewContext.watch(),
			settingsWebviewContext.watch(),
			runtimeWrapperContext.watch(),
		]);
	} else {
		await extensionContext.rebuild();
		await webviewContext.rebuild();
		await settingsWebviewContext.rebuild();
		await runtimeWrapperContext.rebuild();
		await extensionContext.dispose();
		await webviewContext.dispose();
		await settingsWebviewContext.dispose();
		await runtimeWrapperContext.dispose();
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
