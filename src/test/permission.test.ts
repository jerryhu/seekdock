import * as assert from 'node:assert';
import {
	displayPermissionDescription,
	displayPermissionLabel,
	displayPresetName,
	permissionBadge,
	permissionRisk,
	permissionRiskCopy,
} from '../shared/permission.ts';

suite('Permission presentation', () => {
	test('localizes built-in presets and preserves host labels', () => {
		assert.strictEqual(
			displayPermissionLabel('read-only', 'read-only', 'zh-cn'),
			'仅可查看',
		);
		assert.strictEqual(
			displayPermissionLabel('workspace-write', 'Workspace Write', 'zh-cn'),
			'工作区内修改',
		);
		assert.strictEqual(
			displayPermissionLabel('danger-full-access', 'Full access', 'zh-cn'),
			'完全权限',
		);
		assert.strictEqual(displayPermissionLabel('auto', 'auto', 'ja'), '自動レビュー');
		assert.strictEqual(displayPermissionLabel('team-review', 'Team review'), 'Team review');
		assert.strictEqual(displayPermissionLabel('team-review', 'team-review'), 'Team Review');
		assert.strictEqual(displayPresetName('custom-mode'), 'Custom Mode');
	});

	test('describes Auto review and gates it with experimental risk copy', () => {
		const auto = { value: 'auto', name: 'auto' };
		assert.strictEqual(permissionBadge('auto'), 'EXP');
		assert.strictEqual(permissionBadge('read-only'), undefined);
		assert.ok(displayPermissionDescription(auto)?.includes('PTC'));
		assert.strictEqual(permissionRisk('auto'), 'auto-review');
		assert.strictEqual(permissionRisk('danger-full-access'), 'full-access');
		assert.strictEqual(permissionRisk('workspace-write'), undefined);
		assert.ok(permissionRiskCopy('auto', 'zh-cn')?.description.includes('不使用沙箱'));
		assert.ok(permissionRiskCopy('danger-full-access', 'zh-cn')?.title.includes('完全权限'));
		assert.strictEqual(permissionRiskCopy('read-only'), undefined);
	});
});
