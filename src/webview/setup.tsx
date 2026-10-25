import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { Eye, EyeOff, KeyRound, LoaderCircle } from 'lucide-preact';
import { useI18n } from './i18n-context.tsx';

interface SetupProps {
	error: string | undefined;
	focusToken: number;
	saving: boolean;
	onSubmit: (apiKey: string) => void;
}

/** First-run credential setup. The host stores the key in SecretStorage. */
export function Setup({ error, focusToken, saving, onSubmit }: SetupProps): JSX.Element {
	const { t } = useI18n();
	const [apiKey, setApiKey] = useState('');
	const [visible, setVisible] = useState(false);
	const input = useRef<HTMLInputElement>(null);

	useEffect(() => {
		input.current?.focus();
	}, [focusToken]);

	return (
		<section className="setup" aria-label={t('setupAria')}>
			<div className="setup-heading">
				<div className="setup-mark"><KeyRound size={19} /></div>
				<h1>{t('connectDeepSeek')}</h1>
			</div>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					const value = apiKey.trim();
					if (value.length > 0 && !saving) {
						onSubmit(value);
					}
				}}
			>
				<label htmlFor="api-key">API Key</label>
				<div className="key-field">
					<input
						ref={input}
						id="api-key"
						type={visible ? 'text' : 'password'}
						value={apiKey}
						placeholder="sk-..."
						autocomplete="off"
						spellcheck={false}
						disabled={saving}
						onInput={event => setApiKey(event.currentTarget.value)}
					/>
					<button
						type="button"
						className="icon-button"
						aria-label={visible ? t('hideApiKey') : t('showApiKey')}
						data-tooltip={visible ? t('hideApiKey') : t('showApiKey')}
						onClick={() => setVisible(value => !value)}
					>
						{visible ? <EyeOff size={14} /> : <Eye size={14} />}
					</button>
				</div>
				<button
					type="submit"
					className="primary-button"
					disabled={saving || apiKey.trim().length === 0}
				>
					{saving ? <LoaderCircle size={14} className="spin" /> : <KeyRound size={14} />}
					<span>{saving ? t('saving') : t('save')}</span>
				</button>
				{error !== undefined
					? <p className="key-error" role="alert">{error}</p>
					: null}
			</form>
		</section>
	);
}
