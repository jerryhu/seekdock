import * as assert from 'node:assert';
import {
	DEFAULT_WORKSPACE_ID,
	buildWorkspaceOptions,
	customWorkspaceId,
	isWorkspaceOption,
	isWorkspaceSelectionState,
	type WorkspaceFolderRef,
} from '../shared/workspaces.ts';

const folders: readonly WorkspaceFolderRef[] = [
	{ id: 'file:///repo/one', name: 'one', path: '/repo/one' },
	{ id: 'file:///repo/two', name: 'two', path: '/repo/two' },
];

suite('Working directory picker model', () => {
	test('uses the fallback directory when VS Code has no folder', () => {
		const options = buildWorkspaceOptions([], '/home/jerry', '/home/jerry');

		assert.deepStrictEqual(options, [{
			id: DEFAULT_WORKSPACE_ID,
			name: 'jerry',
			path: '/home/jerry',
			kind: 'default',
		}]);
	});

	test('keeps a current directory outside the folder list as a custom option', () => {
		const options = buildWorkspaceOptions([], '/home/jerry/work', '/home/jerry');

		assert.deepStrictEqual(options, [
			{
				id: DEFAULT_WORKSPACE_ID,
				name: 'jerry',
				path: '/home/jerry',
				kind: 'default',
			},
			{
				id: customWorkspaceId('/home/jerry/work'),
				name: 'work',
				path: '/home/jerry/work',
				kind: 'custom',
			},
		]);
	});

	test('lists workspace folders in VS Code order', () => {
		const options = buildWorkspaceOptions(folders, '/repo/two', '/home/jerry');

		assert.deepStrictEqual(options, [
			{ id: 'file:///repo/one', name: 'one', path: '/repo/one', kind: 'folder' },
			{ id: 'file:///repo/two', name: 'two', path: '/repo/two', kind: 'folder' },
		]);
	});

	test('appends a resumed session directory outside the folder list', () => {
		const options = buildWorkspaceOptions(folders, 'C:\\work\\other', '/home/jerry');

		assert.strictEqual(options.length, 3);
		assert.deepStrictEqual(options[2], {
			id: customWorkspaceId('C:\\work\\other'),
			name: 'other',
			path: 'C:\\work\\other',
			kind: 'custom',
		});
	});

	test('accepts only complete, coherent selector states', () => {
		const state = {
			options: [{ id: 'one', name: 'one', path: '/repo/one', kind: 'folder' }],
			currentId: 'one',
		};

		assert.ok(isWorkspaceSelectionState(state));
		assert.ok(isWorkspaceSelectionState({ ...state, pendingId: 'one' }));
		assert.ok(isWorkspaceSelectionState({ ...state, error: 'nope' }));
		assert.ok(!isWorkspaceSelectionState({ ...state, options: [] }));
		assert.ok(!isWorkspaceSelectionState({ ...state, currentId: 'two' }));
		assert.ok(!isWorkspaceSelectionState({ ...state, currentId: '' }));
		assert.ok(!isWorkspaceSelectionState({ ...state, pendingId: 1 }));
		assert.ok(!isWorkspaceSelectionState({
			...state,
			options: [{ id: 'one', name: 'one', path: '/repo/one', kind: 'session' }],
		}));
	});

	test('validates one picker option', () => {
		assert.ok(isWorkspaceOption({
			id: 'one',
			name: 'one',
			path: '/repo/one',
			kind: 'folder',
		}));
		assert.ok(!isWorkspaceOption({ id: 'one', name: 'one', path: '', kind: 'folder' }));
		assert.ok(!isWorkspaceOption({ id: 'one', name: 'one', path: '/repo/one' }));
	});
});
