import { Text } from '@nix/ui';
import { type ReactElement } from 'react';

import { PreferenceToggle } from '../shared/preference-toggle';
import { usePublishingPreference } from './publishing-preference';

export function PublishingSection(): ReactElement {
  const publishing = usePublishingPreference((state) => state.enabled);
  const setPublishing = usePublishingPreference((state) => state.setEnabled);

  return (
    <section aria-labelledby="publishing-heading" className="flex flex-col gap-3">
      <Text id="publishing-heading" variant="h3" as="h2">
        Publishing
      </Text>
      <Text variant="note" tone="muted">
        Choose whether Nix offers site publishing for pages you own. This follows your account
        across devices.
      </Text>
      <PreferenceToggle
        label="Publishing"
        checked={publishing}
        onChange={setPublishing}
        description="Show site publishing for pages you own."
        unsaved={null}
      />
    </section>
  );
}
