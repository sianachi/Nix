import { Text } from '@nix/ui';
import { type ReactElement } from 'react';

import { PreferenceToggle } from '../shared/preference-toggle';
import { useGeneralPreferences } from './general-preferences';

export function PreferencesSection(): ReactElement {
  const footerVisible = useGeneralPreferences((state) => state.footerVisible);
  const setFooterVisible = useGeneralPreferences((state) => state.setFooterVisible);

  return (
    <section aria-labelledby="preferences-heading" className="flex flex-col gap-3">
      <Text id="preferences-heading" variant="h3" as="h2">
        Preferences
      </Text>
      <Text variant="note" tone="muted">
        General interface preferences for this browser.
      </Text>
      <PreferenceToggle
        label="Show status footer"
        checked={footerVisible}
        onChange={setFooterVisible}
        description="Show or hide the offline and status footer at the bottom of the window."
        deviceOnly
        unsaved={null}
      />
    </section>
  );
}
