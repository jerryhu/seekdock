import * as assert from 'node:assert';
import {
	buildPromptWithFiles,
	formatComposerFileMention,
} from '../shared/composer-files.ts';
import type { ComposerFile } from '../shared/rpc.ts';

suite('Composer files', () => {
	test('formats plain and quoted DSH path references', () => {
		assert.strictEqual(formatComposerFileMention('src/app.ts'), '@src/app.ts');
		assert.strictEqual(
			formatComposerFileMention('notes/my file.md'),
			'@"notes/my file.md"',
		);
		assert.strictEqual(formatComposerFileMention('bad"path'), undefined);
		assert.strictEqual(formatComposerFileMention(''), undefined);
	});

	test('appends unique file references after the draft', () => {
		const files: ComposerFile[] = [
			{ id: 'a', name: 'a.ts', path: 'src/a.ts', mention: '@src/a.ts' },
			{ id: 'b', name: 'a.ts', path: 'src/a.ts', mention: '@src/a.ts' },
			{ id: 'c', name: 'b.ts', path: 'src/b.ts', mention: '@src/b.ts' },
		];
		assert.strictEqual(
			buildPromptWithFiles('Review these files.', files),
			'Review these files.\n\n@src/a.ts\n\n@src/b.ts',
		);
		assert.strictEqual(buildPromptWithFiles('', files), '@src/a.ts\n\n@src/b.ts');
	});
});
