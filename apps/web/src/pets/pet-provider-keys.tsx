import { isCanceledError, isNixApiError, pets, type PetProviderKey } from '@nix/api-client';
import { Button, Field, Input, Text } from '@nix/ui';
import { useEffect, useRef, useState, type ReactElement } from 'react';

import { useApiClient } from '../api/api-client-provider';

const PROVIDERS = [
  { id: 'anthropic', label: 'Claude (Anthropic)', hint: 'An API key from console.anthropic.com.' },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    hint: 'An API key from openrouter.ai; models without tool support are marked in the chat.',
  },
] as const;

/**
 * The owner's API keys for the key providers a pet may use (requirement 14). A key is stored
 * protected on this server and shown here only by its last characters; it is sent to the provider
 * from the worker on each turn, never to the browser again. Removing it stops every pet on that
 * provider on their next message, with a message saying what to do.
 */
export function PetProviderKeys(): ReactElement {
  const client = useApiClient();
  const [keys, setKeys] = useState<readonly PetProviderKey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const lifetime = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    client
      .query(pets.providers(), { signal: controller.signal })
      .then((response) => {
        if (!controller.signal.aborted) setKeys(response.keys);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || isCanceledError(cause)) return;
        setError('Your provider keys could not be loaded.');
        setKeys([]);
      });
    return () => {
      controller.abort();
    };
  }, [client]);

  async function save(provider: 'anthropic' | 'openrouter'): Promise<void> {
    const key = (drafts[provider] ?? '').trim();
    if (key.length === 0) return;
    setBusy(provider);
    setError(null);
    try {
      const saved = await client.execute(pets.saveProviderKey(provider, key));
      setKeys((current) => [
        ...(current ?? []).filter((entry) => entry.provider !== provider),
        saved,
      ]);
      setDrafts((current) => ({ ...current, [provider]: '' }));
    } catch (cause) {
      setError(
        isNixApiError(cause) && cause.detail !== undefined
          ? cause.detail
          : 'The key could not be saved.',
      );
    } finally {
      setBusy(null);
    }
  }

  async function remove(provider: 'anthropic' | 'openrouter'): Promise<void> {
    setBusy(provider);
    setError(null);
    try {
      await client.execute(pets.removeProviderKey(provider));
      setKeys((current) => (current ?? []).filter((entry) => entry.provider !== provider));
    } catch (cause) {
      setError(
        isNixApiError(cause) && cause.detail !== undefined
          ? cause.detail
          : 'The key could not be removed.',
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <section
      aria-label="Provider keys"
      className="flex min-w-0 flex-col gap-3 border border-divider p-3"
    >
      <Text variant="h3" as="h3">
        Provider keys
      </Text>
      <Text variant="note" tone="muted">
        For pets set to Claude or OpenRouter. A key is kept protected on this server and shown only
        by its last characters; messages from those pets are billed to it. Nothing is sent to a
        provider until a pet set to it is used.
      </Text>
      {error === null ? null : (
        <Text role="alert" variant="note">
          {error}
        </Text>
      )}
      {keys === null ? (
        <Text variant="note" tone="muted" role="status">
          Loading your keys…
        </Text>
      ) : (
        PROVIDERS.map((provider) => {
          const stored = keys.find((entry) => entry.provider === provider.id);
          return (
            <div key={provider.id} className="flex flex-col gap-2">
              <Text variant="bodySmall">
                {provider.label}
                {stored === undefined
                  ? ': no key saved'
                  : `: key ending ${stored.keyHint}, saved ${new Date(stored.savedAt).toLocaleDateString()}`}
              </Text>
              <div className="flex flex-wrap items-end gap-2">
                <Field
                  label={`${provider.label} API key`}
                  hint={provider.hint}
                  className="min-w-0 flex-1"
                >
                  {(control) => (
                    <Input
                      {...control}
                      type="password"
                      autoComplete="off"
                      value={drafts[provider.id] ?? ''}
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        setDrafts((current) => ({ ...current, [provider.id]: value }));
                      }}
                    />
                  )}
                </Field>
                <Button
                  variant="secondary"
                  disabled={busy !== null || (drafts[provider.id] ?? '').trim().length === 0}
                  onClick={() => void save(provider.id)}
                >
                  {stored === undefined ? 'Save key' : 'Replace key'}
                </Button>
                {stored === undefined ? null : (
                  <Button
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => void remove(provider.id)}
                  >
                    Remove key
                  </Button>
                )}
              </div>
            </div>
          );
        })
      )}
    </section>
  );
}
