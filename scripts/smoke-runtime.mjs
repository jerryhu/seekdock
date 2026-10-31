import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect, createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';
import {
	hostRuntimeTarget,
	resolveRuntimeTarget,
} from './runtime-targets.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const manifest = JSON.parse(
	await readFile(resolve(root, 'resources', 'runtime', 'manifest.json'), 'utf8'),
);
const target = resolveRuntimeTarget(process.argv[2]);
const runtime = manifest.targets[target];
if (runtime === undefined) {
	throw new Error(`No packaged SeekDock runtime exists for ${target}.`);
}
if (target !== hostRuntimeTarget()) {
	console.log(
		`Verified DeepSeek Harness ${target} runtime files; `
		+ `the execution smoke test requires ${target}.`,
	);
	process.exit(0);
}

const requests = [];
const openResponses = new Set();
let approvalToolIssued = false;
let smokeReadIssued = false;
let smokeEditIssued = false;
const server = createServer((request, response) => {
	let body = '';
	request.on('data', chunk => {
		body += chunk.toString('utf8');
	});
	request.on('end', () => {
		const payload = JSON.parse(body);
		requests.push(payload);
		response.writeHead(200, { 'content-type': 'text/event-stream' });
		const serialized = JSON.stringify(payload);
		if (JSON.stringify(payload.messages).includes('Generate the session title from this JSON array')
			&& payload.tools === undefined) {
			for (const event of [
				{ type: 'message_start', message: { usage: { input_tokens: 3 } } },
				{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
				{
					type: 'content_block_delta',
					index: 0,
					delta: { type: 'text_delta', text: 'Generated session title' },
				},
				{ type: 'content_block_stop', index: 0 },
				{ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
				{ type: 'message_stop' },
			]) {
				response.write(`data: ${JSON.stringify(event)}\n\n`);
			}
			response.end();
			return;
		}
		if (serialized.includes('REVIEW_POLICY')) {
			for (const event of [
				{ type: 'message_start', message: { usage: { input_tokens: 3 } } },
				{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
				{
					type: 'content_block_delta',
					index: 0,
					delta: { type: 'text_delta', text: '{"risk":"high","decision":"deny","reason":"smoke denies this call"}' },
				},
				{ type: 'content_block_stop', index: 0 },
				{ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
				{ type: 'message_stop' },
			]) {
				response.write(`data: ${JSON.stringify(event)}\n\n`);
			}
			response.end();
			return;
		}
		if (!approvalToolIssued && serialized.includes('call the approval tool')) {
			approvalToolIssued = true;
			for (const event of [
				{ type: 'message_start', message: { usage: { input_tokens: 3 } } },
				{
					type: 'content_block_start',
					index: 0,
					content_block: { type: 'tool_use', id: 'toolu_approval_1', name: 'bash', input: {} },
				},
				{
					type: 'content_block_delta',
					index: 0,
					delta: {
						type: 'input_json_delta',
						partial_json: '{"command":"echo approval-ok","description":"smoke approval"}',
					},
				},
				{ type: 'content_block_stop', index: 0 },
				{ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } },
				{ type: 'message_stop' },
			]) {
				response.write(`data: ${JSON.stringify(event)}\n\n`);
			}
			response.end();
			return;
		}
		if (serialized.includes('edit the smoke file') && !smokeReadIssued) {
			smokeReadIssued = true;
			for (const event of [
				{ type: 'message_start', message: { usage: { input_tokens: 3 } } },
				{
					type: 'content_block_start',
					index: 0,
					content_block: { type: 'tool_use', id: 'toolu_read_smoke', name: 'read', input: {} },
				},
				{
					type: 'content_block_delta',
					index: 0,
					delta: { type: 'input_json_delta', partial_json: '{"file_path":"smoke.txt"}' },
				},
				{ type: 'content_block_stop', index: 0 },
				{ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } },
				{ type: 'message_stop' },
			]) {
				response.write(`data: ${JSON.stringify(event)}\n\n`);
			}
			response.end();
			return;
		}
		if (serialized.includes('edit the smoke file') && !smokeEditIssued) {
			smokeEditIssued = true;
			for (const event of [
				{ type: 'message_start', message: { usage: { input_tokens: 3 } } },
				{
					type: 'content_block_start',
					index: 0,
					content_block: { type: 'tool_use', id: 'toolu_edit_smoke', name: 'edit', input: {} },
				},
				{
					type: 'content_block_delta',
					index: 0,
					delta: {
						type: 'input_json_delta',
						partial_json: JSON.stringify({
							file_path: 'smoke.txt',
							old_string: 'before',
							new_string: 'after',
						}),
					},
				},
				{ type: 'content_block_stop', index: 0 },
				{ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } },
				{ type: 'message_stop' },
			]) {
				response.write(`data: ${JSON.stringify(event)}\n\n`);
			}
			response.end();
			return;
		}
		const latestUserMessage = payload.messages.findLast(message => message.role === 'user');
		if (JSON.stringify(latestUserMessage?.content).includes('Stop this response')) {
			openResponses.add(response);
			response.once('close', () => openResponses.delete(response));
			for (const event of [
				{ type: 'message_start', message: { usage: { input_tokens: 3 } } },
				{
					type: 'content_block_start',
					index: 0,
					content_block: { type: 'thinking', thinking: '' },
				},
				{
					type: 'content_block_delta',
					index: 0,
					delta: { type: 'thinking_delta', thinking: 'working until stopped' },
				},
				{ type: 'content_block_stop', index: 0 },
				{
					type: 'content_block_start',
					index: 1,
					content_block: { type: 'text', text: '' },
				},
				{
					type: 'content_block_delta',
					index: 1,
					delta: { type: 'text_delta', text: '[partial-answer]' },
				},
			]) {
				response.write(`data: ${JSON.stringify(event)}\n\n`);
			}
			return;
		}
		for (const event of [
			{ type: 'message_start', message: { usage: { input_tokens: 3 } } },
			{
				type: 'content_block_start',
				index: 0,
				content_block: { type: 'thinking', thinking: '' },
			},
			{
				type: 'content_block_delta',
				index: 0,
				delta: { type: 'thinking_delta', thinking: 'checking request' },
			},
			{ type: 'content_block_stop', index: 0 },
			{
				type: 'content_block_start',
				index: 1,
				content_block: { type: 'text', text: '' },
			},
			{
				type: 'content_block_delta',
				index: 1,
				delta: { type: 'text_delta', text: '[mock-answer]' },
			},
			{ type: 'content_block_stop', index: 1 },
			{
				type: 'message_delta',
				delta: { stop_reason: 'end_turn' },
				usage: { output_tokens: 2 },
			},
			{ type: 'message_stop' },
		]) {
			response.write(`data: ${JSON.stringify(event)}\n\n`);
		}
		response.end();
	});
});

await new Promise((resolveListen, rejectListen) => {
	server.once('error', rejectListen);
	server.listen(0, '127.0.0.1', resolveListen);
});
const address = server.address();
if (address === null || typeof address === 'string') {
	throw new Error('SeekDock runtime smoke server did not bind a TCP port.');
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'seekdock-runtime-smoke-'));
const workspaceRoot = join(temporaryRoot, 'workspace');
const cancelSocketPath = join(temporaryRoot, 'cancel.sock');
const permissionSocketPath = join(temporaryRoot, 'permission.sock');
const planSocketPath = join(temporaryRoot, 'plan.sock');
const skillSocketPath = join(temporaryRoot, 'skill.sock');
const sessionTitleSocketPath = join(temporaryRoot, 'session-title.sock');
const workspaceChangesSocketPath = join(temporaryRoot, 'workspace-changes.sock');
const approvalSocketPath = join(temporaryRoot, 'approval.sock');
const planReviewSocketPath = join(temporaryRoot, 'plan-review.sock');
const userAgentsHome = join(temporaryRoot, 'home', '.agents');
const workspaceSkillRoot = join(workspaceRoot, '.agents', 'skills');
const userSkillRoot = join(userAgentsHome, 'skills');
const promptMarker = 'SeekDock runtime smoke system prompt {{literal_braces}}';
const systemPromptPath = join(temporaryRoot, 'active-system-prompt.md');
await writeFile(systemPromptPath, promptMarker, 'utf8');
await mkdir(workspaceRoot, { recursive: true });
await writeFile(join(workspaceRoot, 'smoke.txt'), 'before\n', 'utf8');
await mkdir(join(workspaceSkillRoot, 'smoke-skill'), { recursive: true });
await writeFile(
	join(workspaceSkillRoot, 'smoke-skill', 'SKILL.md'),
	'---\nname: smoke-skill\ndescription: Runtime smoke skill.\n---\n\n# Smoke skill\n\nUse the smoke instructions.\n',
	'utf8',
);
await mkdir(join(workspaceSkillRoot, 'second-smoke-skill'), { recursive: true });
await writeFile(
	join(workspaceSkillRoot, 'second-smoke-skill', 'SKILL.md'),
	'---\nname: second-smoke-skill\ndescription: Second runtime smoke skill.\n---\n\n# Second smoke skill\n\nUse the second smoke instructions.\n',
	'utf8',
);
await mkdir(join(userSkillRoot, 'user-smoke-skill'), { recursive: true });
await writeFile(
	join(userSkillRoot, 'user-smoke-skill', 'SKILL.md'),
	'---\nname: user-smoke-skill\ndescription: User runtime smoke skill.\n---\n\n# User smoke skill\n',
	'utf8',
);
await mkdir(join(workspaceRoot, '.dsh', 'skills', 'ignored-smoke-skill'), { recursive: true });
await writeFile(
	join(workspaceRoot, '.dsh', 'skills', 'ignored-smoke-skill', 'SKILL.md'),
	'---\nname: ignored-smoke-skill\ndescription: Must not be discovered.\n---\n\n# Ignored smoke skill\n',
	'utf8',
);

	const approvalQuestions = [];
	const approvalServer = createNetServer(socket => {
		let input = '';
		socket.setEncoding('utf8');
		socket.on('error', () => {});
		socket.on('data', chunk => {
			input += chunk;
			if (!input.includes('\n')) return;
			try {
				approvalQuestions.push(JSON.parse(input.slice(0, input.indexOf('\n'))));
			} catch {
				// A malformed frame still gets the fail-closed answer below.
			}
			socket.end(`${JSON.stringify({ outcome: 'allowed-once' })}\n`);
		});
	});
	await new Promise((resolveListen, rejectListen) => {
		approvalServer.once('error', rejectListen);
		approvalServer.listen(approvalSocketPath, resolveListen);
	});
const makeHarness = () => new DeepSeekHarness({
	cwd: workspaceRoot,
	dshBin: resolve(root, 'dist', 'dsh-runtime-wrapper.js'),
	dshHome: join(temporaryRoot, 'dsh-home'),
	env: {
		...process.env,
		DEEPSEEK_API_KEY: 'seekdock-runtime-smoke',
		DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
		DSH_AGENTS_HOME: userAgentsHome,
		HOME: join(temporaryRoot, 'home'),
			SEEKDOCK_APPROVAL_SOCKET: approvalSocketPath,
			SEEKDOCK_PLAN_REVIEW_SOCKET: planReviewSocketPath,
			SEEKDOCK_CANCEL_SOCKET: cancelSocketPath,
			SEEKDOCK_PERMISSION_SOCKET: permissionSocketPath,
			SEEKDOCK_PLAN_SOCKET: planSocketPath,
			SEEKDOCK_SKILL_SOCKET: skillSocketPath,
			SEEKDOCK_SESSION_TITLE_SOCKET: sessionTitleSocketPath,
			SEEKDOCK_WORKSPACE_CHANGES_SOCKET: workspaceChangesSocketPath,
		SEEKDOCK_DSH_RUNTIME: process.env.SEEKDOCK_RUNTIME_SMOKE_PATH ?? resolve(
			root,
			'resources',
			'runtime',
			target,
			runtime.executable,
		),
			SEEKDOCK_SYSTEM_PROMPT_PATH: systemPromptPath,
		SEEKDOCK_USER_SKILL_DIR: userSkillRoot,
		SEEKDOCK_WORKSPACE_SKILL_DIR: workspaceSkillRoot,
		USERPROFILE: join(temporaryRoot, 'home'),
	},
	initializeTimeoutMs: 30_000,
	patches: [resolve(root, 'resources', 'dsh', 'seekdock-chat.cordis.patch.yml')],
	profile: 'sdk',
	provider: 'deepseek-official',
	model: 'deepseek-v4-flash',
	shutdownTimeoutMs: 3_000,
});
let harness = makeHarness();

try {
	const sessionId = 'seekdock-runtime-smoke';
	const notifications = [];
	const result = await harness.run('/smoke-skill /second-smoke-skill Reply with OK', {
		sessionId,
		onNotification: notification => notifications.push(notification),
	});
	if (result.finalResponse !== '[mock-answer]') {
			const diagnostics = result.notifications
				.filter(notification => notification.method === 'session.event')
				.slice(-8);
			throw new Error(
				`Unexpected smoke answer: ${JSON.stringify(result.finalResponse)}; `
				+ `recent events: ${JSON.stringify(diagnostics)}`,
			);
	}
	const generatedTitle = await withTimeout(controlRequest(sessionTitleSocketPath, {
		action: 'wait',
		sessionId,
	}), 70_000, 'the generated session title');
	if (generatedTitle?.ok !== true
		|| generatedTitle.source !== 'provider'
		|| generatedTitle.title !== 'Generated session title') {
		throw new Error(`The packaged runtime did not generate a first-prompt session title: ${JSON.stringify(generatedTitle)}`);
	}
	console.log('Session title smoke: first-prompt model title generated.');
	const liveFrames = notifications
		.filter(notification => notification.method === 'seekdock/assistant-stream')
		.map(notification => notification.params.frame);
	if (!liveFrames.some(frame => frame.type === 'chunk'
		&& frame.chunk.type === 'reasoning-delta'
		&& frame.chunk.text.includes('checking'))) {
		throw new Error('The packaged runtime did not forward live reasoning frames.');
	}
	if (!liveFrames.some(frame => frame.type === 'chunk'
		&& frame.chunk.type === 'text-delta'
		&& frame.chunk.text.includes('[mock-'))) {
		throw new Error('The packaged runtime did not forward live text frames.');
	}
	const skillCatalog = await controlRequest(skillSocketPath, {
		action: 'list',
		cwd: workspaceRoot,
	});
	if (skillCatalog?.ok !== true
		|| !skillCatalog.skills.some(skill => skill.name === 'smoke-skill'
			&& skill.source === 'workspace'
			&& skill.path.endsWith(join('.agents', 'skills', 'smoke-skill', 'SKILL.md')))
		|| !skillCatalog.skills.some(skill => skill.name === 'user-smoke-skill'
			&& skill.source === 'user')
		|| skillCatalog.skills.some(skill => skill.name === 'ignored-smoke-skill')) {
		throw new Error(`The packaged runtime did not publish its skill catalog: ${JSON.stringify(skillCatalog)}`);
	}
	const smokeSkill = await controlRequest(skillSocketPath, {
		action: 'get',
		cwd: workspaceRoot,
		name: 'smoke-skill',
	});
	if (smokeSkill?.ok !== true
		|| !smokeSkill.skill.content.includes('Use the smoke instructions.')) {
		throw new Error(`The packaged runtime did not load the selected skill: ${JSON.stringify(smokeSkill)}`);
	}
	const secondSmokeSkill = await controlRequest(skillSocketPath, {
		action: 'get',
		cwd: workspaceRoot,
		name: 'second-smoke-skill',
	});
	if (secondSmokeSkill?.ok !== true
		|| !secondSmokeSkill.skill.content.includes('Use the second smoke instructions.')) {
		throw new Error(`The packaged runtime did not load the second selected skill: ${JSON.stringify(secondSmokeSkill)}`);
	}
	console.log('Skill smoke: catalog discovery and multiple SKILL.md loads verified.');
	const renamed = await controlRequest(sessionTitleSocketPath, {
		sessionId,
		title: '  Smoke renamed session  ',
	});
	if (renamed?.ok !== true || renamed.title !== 'Smoke renamed session') {
		throw new Error(`The packaged runtime did not rename the session: ${JSON.stringify(renamed)}`);
	}
	console.log('Session title smoke: DSH rename and persistence barrier verified.');
	const changesSessionId = 'seekdock-runtime-smoke-changes';
	await harness.session(changesSessionId).getWorkingDirectory();
	const changedRun = await harness.run('edit the smoke file', { sessionId: changesSessionId });
	if (changedRun.finalResponse !== '[mock-answer]') {
		throw new Error(`Unexpected workspace-change answer: ${JSON.stringify(changedRun.finalResponse)}`);
	}
	const changesEvent = changedRun.events.find(event => event.type === 'workspace/changes');
	if (changesEvent?.type !== 'workspace/changes') {
		throw new Error('The packaged runtime did not announce workspace changes.');
	}
	const changesSummary = await controlRequest(workspaceChangesSocketPath, {
		action: 'summary',
		sessionId: changesSessionId,
		seq: changesEvent.seq,
	});
	const changedFile = changesSummary?.summary?.files?.find(file => file.path === 'smoke.txt');
	if (changesSummary?.ok !== true || changedFile === undefined
		|| changedFile.added !== 1 || changedFile.deleted !== 1) {
		throw new Error(`The runtime did not summarize the edited file: ${JSON.stringify(changesSummary)}`);
	}
	const changesDiff = await controlRequest(workspaceChangesSocketPath, {
		action: 'diff',
		sessionId: changesSessionId,
		seq: changesEvent.seq,
		index: changesSummary.summary.files.indexOf(changedFile),
	});
	if (changesDiff?.ok !== true
		|| changesDiff.diff?.kind !== 'text'
		|| !changesDiff.diff.hunks.some(hunk => hunk.lines.includes('-before') && hunk.lines.includes('+after'))) {
		throw new Error(`The runtime did not serve the file comparison: ${JSON.stringify(changesDiff)}`);
	}
	console.log('Workspace changes smoke: summary and contextual diff verified.');
		const firstRequest = requests[0];
		if (firstRequest?.system === undefined
			|| !JSON.stringify(firstRequest.system).includes(promptMarker)) {
			throw new Error('The packaged runtime did not apply the configured system prompt.');
		}
		const firstRequestMessages = JSON.stringify(firstRequest.messages);
		if (!firstRequestMessages.includes('Use the smoke instructions.')
			|| !firstRequestMessages.includes('Use the second smoke instructions.')) {
			throw new Error(
				`The packaged runtime did not inject the selected slash skill: ${firstRequestMessages.slice(0, 2_000)}`,
			);
		}
	const catalog = await controlRequest(permissionSocketPath, { action: 'catalog' });
	if (catalog?.ok !== true
		|| !catalog.catalog.options.some(option => option.value === 'auto')) {
		throw new Error(
			`The packaged runtime did not publish the Auto review preset: ${JSON.stringify(catalog)}`,
		);
	}
	const initialPermission = await controlRequest(permissionSocketPath, {
		action: 'state',
		sessionId,
	});
	if (initialPermission?.current !== 'workspace-write') {
		throw new Error(`Unexpected initial permission: ${JSON.stringify(initialPermission)}`);
	}
	const switchedPermission = await controlRequest(permissionSocketPath, {
		action: 'set',
		sessionId,
		preset: 'auto',
	});
	if (switchedPermission?.current !== 'auto') {
		throw new Error(`The runtime did not switch to Auto review: ${JSON.stringify(switchedPermission)}`);
	}
	await controlRequest(permissionSocketPath, {
		action: 'set',
		sessionId,
		preset: 'workspace-write',
	});
	console.log('Permission smoke: Auto review catalog and preset switch verified.');
	const initialPlan = await controlRequest(planSocketPath, { action: 'state', sessionId });
	if (initialPlan?.ok !== true || initialPlan.active !== false) {
		throw new Error(`Unexpected initial plan mode: ${JSON.stringify(initialPlan)}`);
	}
	const enabledPlan = await controlRequest(planSocketPath, {
		action: 'set',
		sessionId,
		active: true,
	});
	if (enabledPlan?.ok !== true || enabledPlan.active !== true) {
		throw new Error(`The runtime did not enable plan mode: ${JSON.stringify(enabledPlan)}`);
	}
	const disabledPlan = await controlRequest(planSocketPath, {
		action: 'set',
		sessionId,
		active: false,
	});
	if (disabledPlan?.ok !== true || disabledPlan.active !== false) {
		throw new Error(`The runtime did not disable plan mode: ${JSON.stringify(disabledPlan)}`);
	}
	console.log('Plan-mode smoke: DSH plan state switch verified.');
	await harness.close();
	harness = makeHarness();
	await harness.start();
	await harness.resumeSession(sessionId);
	const resumed = await harness.run('Follow up', { sessionId });
	if (resumed.finalResponse !== '[mock-answer]') {
		throw new Error(`Unexpected resumed answer: ${JSON.stringify(resumed.finalResponse)}`);
	}
	const resumedRequest = requests.findLast(request => (
		JSON.stringify(request.messages).includes('Follow up')
	));
	if (resumedRequest === undefined
		|| !JSON.stringify(resumedRequest.messages).includes('Reply with OK')
		|| !JSON.stringify(resumedRequest.messages).includes('Follow up')) {
		throw new Error('The packaged runtime did not resume persisted conversation history.');
	}

	const approvalSessionId = 'seekdock-runtime-smoke-approval';
	await harness.session(approvalSessionId).getWorkingDirectory();
	const approvalPreset = await controlRequest(permissionSocketPath, {
		action: 'set',
		sessionId: approvalSessionId,
		preset: 'auto',
	});
	if (approvalPreset?.current !== 'auto') {
		throw new Error(`The runtime did not switch the approval session to Auto: ${JSON.stringify(approvalPreset)}`);
	}
	const approvalRun = await harness.run('call the approval tool', { sessionId: approvalSessionId });
	if (approvalRun.finalResponse !== '[mock-answer]') {
		throw new Error(`Unexpected approval answer: ${JSON.stringify(approvalRun.finalResponse)}`);
	}
	if (approvalQuestions.length !== 1) {
		throw new Error(`Expected one approval question: ${JSON.stringify(approvalQuestions)}`);
	}
	const approvalQuestion = approvalQuestions[0];
	const approvalDisplay = approvalQuestion?.displayReason;
	const hasApprovalDisplay = typeof approvalDisplay === 'string'
		? approvalDisplay.length > 0
		: typeof approvalDisplay === 'object' && approvalDisplay !== null
			&& typeof approvalDisplay.zh === 'string' && approvalDisplay.zh.length > 0;
	if (approvalQuestion?.toolCallId !== 'toolu_approval_1' || !hasApprovalDisplay) {
		throw new Error(`Unexpected approval question: ${JSON.stringify(approvalQuestion)}`);
	}
	const approvalToolResult = approvalRun.events.find(event => event.type === 'tool/result'
		&& event.data?.message?.toolCallId === 'toolu_approval_1');
	if (approvalToolResult === undefined
		|| !JSON.stringify(approvalToolResult.data.message.content).includes('approval-ok')) {
		throw new Error(`The approved tool did not execute: ${JSON.stringify(approvalToolResult)}`);
	}
	await controlRequest(permissionSocketPath, {
		action: 'set',
		sessionId: approvalSessionId,
		preset: 'workspace-write',
	});
	console.log('Approval smoke: Auto review denial and allow-once verified.');

	const stoppedNotifications = [];
	const sawPartial = Promise.withResolvers();
	const stoppedRun = harness.run('Stop this response', {
		sessionId,
		onNotification: notification => {
			stoppedNotifications.push(notification);
			const params = notification.params;
			const frame = params.frame;
			if (notification.method === 'seekdock/assistant-stream'
				&& frame?.type === 'chunk'
				&& frame.chunk?.type === 'text-delta'
				&& frame.chunk.text.includes('[partial-answer]')) {
				sawPartial.resolve();
			}
		},
	});
	await withTimeout(sawPartial.promise, 10_000, 'the streamed partial answer');
	console.log('Stop smoke: partial answer observed.');
	const cancelResult = await withTimeout(
		cancelViaSocket(cancelSocketPath, sessionId),
		5_000,
		'the cancel bridge response',
	);
	console.log('Stop smoke: cancel admitted.');
	if (cancelResult.accepted !== true || cancelResult.interrupted !== true) {
		throw new Error(`Unexpected stop receipt: ${JSON.stringify(cancelResult)}`);
	}
	const stopped = await withTimeout(stoppedRun, 10_000, 'the stopped turn to settle');
	console.log('Stop smoke: turn settled.');
	const stoppedEnd = stopped.events.find(event => event.type === 'turn/end');
	if (stoppedEnd?.type !== 'turn/end'
		|| stoppedEnd.data.reason.kind !== 'aborted'
		|| stoppedEnd.data.reason.reason.kind !== 'user') {
		throw new Error(`The stopped turn was not persisted as a user abort: ${JSON.stringify(stoppedEnd)}`);
	}
	if (!stopped.events.some(event => event.type === 'assistant/message'
		&& event.data.interrupted === true
		&& event.data.message.content.some(block => block.type === 'text'
			&& block.text.includes('[partial-answer]')))) {
		throw new Error('The stopped turn did not commit its visible partial answer.');
	}
	if (!stoppedNotifications.some(notification => notification.method === 'session.status'
		&& notification.params.status === 'idle')) {
		throw new Error('The stopped turn did not return the agent to idle.');
	}
	console.log('Stop smoke: persisted abort and partial answer verified.');

	const afterStop = await harness.run('Continue after stop', { sessionId });
	if (afterStop.finalResponse !== '[mock-answer]') {
		throw new Error(`The runtime did not answer after a stop: ${JSON.stringify(afterStop.finalResponse)}`);
	}
	console.log('Stop smoke: follow-up answer verified.');
	console.log('DeepSeek Harness answer, stop, persisted resume, and follow-up succeeded.');
} finally {
	for (const response of openResponses) {
		response.destroy();
	}
	await harness.close();
	await new Promise((resolveClose, rejectClose) => {
		server.close(error => {
			if (error === undefined) {
				resolveClose();
			} else {
				rejectClose(error);
			}
		});
	});
	await new Promise(resolveClose => approvalServer.close(() => resolveClose()));
	await rm(temporaryRoot, { recursive: true, force: true });
}

function cancelViaSocket(socketPath, sessionId) {
	return new Promise((resolve, reject) => {
		const socket = connect(socketPath);
		let response = '';
		socket.setEncoding('utf8');
		socket.once('connect', () => {
			socket.end(`${JSON.stringify({ sessionId })}\n`);
		});
		socket.on('data', chunk => {
			response += chunk;
		});
		socket.once('error', reject);
		socket.once('end', () => {
			try {
				resolve(JSON.parse(response));
			} catch (error) {
				reject(error);
			}
		});
	});
}

function controlRequest(socketPath, payload) {
	return new Promise((resolve, reject) => {
		const socket = connect(socketPath);
		let response = '';
		socket.setEncoding('utf8');
		socket.once('connect', () => {
			socket.end(`${JSON.stringify(payload)}\n`);
		});
		socket.on('data', chunk => {
			response += chunk;
		});
		socket.once('error', reject);
		socket.once('end', () => {
			try {
				resolve(JSON.parse(response));
			} catch (error) {
				reject(error);
			}
		});
	});
}

function withTimeout(promise, timeoutMs, label) {
	let timer;
	return Promise.race([
		promise,
		new Promise((_, reject) => {
			timer = setTimeout(() => {
				reject(new Error(`Timed out waiting for ${label}.`));
			}, timeoutMs);
		}),
	]).finally(() => clearTimeout(timer));
}
