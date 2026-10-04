import { useSearchParams } from 'react-router';
import { z } from 'zod';

/**
 * The URL-state parameter for the settings screen's active tab, following the convention in
 * `apps/web/src/routing/url-state.ts`: one Zod schema per parameter, a reader that always returns
 * a valid value, and a writer that replaces rather than pushes so switching tabs does not fill the
 * back button with history entries.
 */
export const SettingsTabSchema = z.enum([
  'workspace',
  'editor',
  'notifications',
  'pets',
  'integrations',
  'access-tokens',
]);

export type SettingsTab = z.infer<typeof SettingsTabSchema>;

export const SETTINGS_TAB_PARAM = 'tab';

export const DEFAULT_SETTINGS_TAB: SettingsTab = 'workspace';

/** Parses one raw search-parameter value, falling back to the default rather than throwing. */
export function parseSettingsTab(raw: string | null): SettingsTab {
  if (raw === null) {
    return DEFAULT_SETTINGS_TAB;
  }
  const result = SettingsTabSchema.safeParse(raw);
  if (result.success) {
    return result.data;
  }
  console.warn(`Ignoring unrecognised "${SETTINGS_TAB_PARAM}" search parameter:`, raw);
  return DEFAULT_SETTINGS_TAB;
}

interface SettingsTabControl {
  readonly tab: SettingsTab;
  readonly setTab: (next: SettingsTab) => void;
}

export function useSettingsTab(): SettingsTabControl {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = parseSettingsTab(searchParams.get(SETTINGS_TAB_PARAM));

  const setTab = (next: SettingsTab): void => {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set(SETTINGS_TAB_PARAM, next);
    setSearchParams(nextParams, { replace: true });
  };

  return { tab, setTab };
}
