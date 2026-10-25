import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { LocalizedError } from '../shared/i18n/index.ts';

/** Global-state key containing the user's prompt override. */
export const SYSTEM_PROMPT_STATE_KEY = 'seekdock.systemPrompt';

/** Minimal global-state surface used by the prompt store. */
export interface PromptStateStorage {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): PromiseLike<void>;
}

/** Effective system prompt and whether it comes from the packaged default. */
export interface SystemPromptState {
	systemPrompt: string;
	isDefault: boolean;
}

/**
 * Loads the packaged default prompt, persists user overrides, and mirrors the
 * effective text into a file the DSH runtime can read synchronously at startup.
 */
export class SystemPromptStore {
	private defaultPrompt: string | undefined;

	constructor(
		private readonly defaultPromptPath: string,
		private readonly runtimePromptPath: string,
		private readonly state: PromptStateStorage,
	) { }

	/** @returns the effective prompt and its source. */
	async getState(): Promise<SystemPromptState> {
		const custom = this.state.get<unknown>(SYSTEM_PROMPT_STATE_KEY);
		if (typeof custom === 'string' && custom.trim().length > 0) {
			return { systemPrompt: custom.trim(), isDefault: false };
		}
		return { systemPrompt: await this.getDefaultPrompt(), isDefault: true };
	}

	/**
	 * Persist a non-empty custom prompt and synchronize the runtime file.
	 * @param prompt - User-authored prompt text.
	 */
	async save(prompt: string): Promise<void> {
		const normalized = prompt.trim();
		if (normalized.length === 0) {
			throw new LocalizedError('hostPromptEmpty');
		}
		await this.replaceState(normalized, normalized);
	}

	/** Remove the override and restore the packaged default prompt. */
	async reset(): Promise<void> {
		const defaultPrompt = await this.getDefaultPrompt();
		await this.replaceState(undefined, defaultPrompt);
	}

	/**
	 * Write the effective prompt where the DSH plugin expects it.
	 * @returns the effective prompt text that was synchronized.
	 */
	async syncRuntimePrompt(): Promise<string> {
		const effective = await this.getState();
		await this.writeRuntimePrompt(effective.systemPrompt);
		return effective.systemPrompt;
	}

	private async getDefaultPrompt(): Promise<string> {
		if (this.defaultPrompt === undefined) {
			const text = (await readFile(this.defaultPromptPath, 'utf8')).trim();
			if (text.length === 0) {
				throw new LocalizedError('hostDefaultPromptEmpty');
			}
			this.defaultPrompt = text;
		}
		return this.defaultPrompt;
	}

	private async replaceState(storedPrompt: string | undefined, runtimePrompt: string): Promise<void> {
		const previous = this.state.get<unknown>(SYSTEM_PROMPT_STATE_KEY);
		await this.state.update(SYSTEM_PROMPT_STATE_KEY, storedPrompt);
		try {
			await this.writeRuntimePrompt(runtimePrompt);
		} catch (error) {
			try {
				await this.state.update(SYSTEM_PROMPT_STATE_KEY, previous);
			} catch (rollbackError) {
				const aggregate = new AggregateError(
					[error, rollbackError],
					'hostPromptRollbackFailed',
				);
				throw new LocalizedError(
					'hostPromptRollbackFailed',
					undefined,
					{ cause: aggregate },
				);
			}
			throw error;
		}
	}

	private async writeRuntimePrompt(prompt: string): Promise<void> {
		await mkdir(dirname(this.runtimePromptPath), { recursive: true });
		await writeFile(this.runtimePromptPath, prompt, 'utf8');
	}
}
