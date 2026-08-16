import { Text } from '@nix/ui';
import type { ReactElement } from 'react';

import { paneScroller } from '../layout/regions';
import { AccessTokensSection } from '../settings/access-tokens-section';
import { MembersSection } from '../settings/members-section';

/**
 * The settings destination: the workspace's members, and the caller's personal access tokens.
 *
 * One screen on purpose. A token is issued per principal but it acts inside this workspace's
 * permission model, so issuing, auditing and revoking credentials happens on the same screen that
 * shows who holds a role - the person deciding whether a token is safe to mint is looking at who
 * else can reach what it can touch.
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

      <MembersSection />
      <AccessTokensSection />
    </div>
  );
}
