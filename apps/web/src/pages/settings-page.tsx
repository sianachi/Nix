import { Text } from '@nix/ui';
import type { ReactElement } from 'react';

import { paneScroller } from '../layout/regions';
import { AccessTokensSection } from '../settings/access-tokens-section';
import { EditorPreferencesSection } from '../settings/editor-preferences-section';
import { MembersSection } from '../settings/members-section';

/**
 * The settings destination: personal editor preferences, workspace members, and access tokens.
 *
 * One screen on purpose. Personal note-body behavior leads; workspace administration follows. A
 * token is issued per principal but acts inside this workspace's permission model, so issuing,
 * auditing and revoking credentials stays beside the list of people who hold roles.
 *
 * Each section owns its own load and its own honest states, because the two reads fail
 * independently: a members endpoint that refuses says nothing about whether the token list is
 * fine, and one shared spinner would hold the healthy half hostage to the broken one.
 *
 * Not `tokens-page.tsx`, which despite its name is the design-token specimen sheet at `/tokens` -
 * an unlucky collision of vocabularies, resolved by this file never using the bare word.
 */
export function SettingsPage(): ReactElement {
  return (
    <div className={`${paneScroller} flex flex-col gap-4 p-4`}>
      <Text variant="h2" as="h1">
        Settings
      </Text>

      <EditorPreferencesSection />
      <MembersSection />
      <AccessTokensSection />
    </div>
  );
}
