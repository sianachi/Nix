import { Tabs, Text } from '@nix/ui';
import { type ReactElement } from 'react';

import { paneScroller } from '../layout/regions';
import { AccessTokensSection } from '../settings/access-tokens-section';
import { EditorPreferencesSection } from '../settings/editor-preferences-section';
import { NotificationsSection } from '../settings/notifications-section';
import { WorkspaceManagementSection } from '../workspaces/workspace-management-section';
import { PetSettingsSection } from '../pets/pet-settings-section';
import { useSettingsTab, type SettingsTab } from './settings-tab';

const settingsTabs: readonly { id: SettingsTab; label: string; closable: false }[] = [
  { id: 'workspace', label: 'Workspace', closable: false },
  { id: 'editor', label: 'Editor', closable: false },
  { id: 'notifications', label: 'Notifications', closable: false },
  { id: 'pets', label: 'Pets', closable: false },
  { id: 'access-tokens', label: 'Access tokens', closable: false },
];

/** Settings grouped by the thing being managed, with workspace management first. Addressable by
 * `?tab=` so a link to a specific section survives a refresh or gets shared. */
export function SettingsPage(): ReactElement {
  const { tab: activeTab, setTab: setActiveTab } = useSettingsTab();

  return (
    <div className={`${paneScroller} flex flex-col`}>
      <header className="border-b border-divider px-5 pb-5 pt-6 sm:px-8 sm:pt-8">
        <Text variant="kicker">Account</Text>
        <Text variant="h2" as="h1" className="mt-1">
          Settings
        </Text>
        <Text variant="note" tone="muted" className="mt-2 max-w-2xl">
          Manage the place you work, how the editor behaves, and the credentials connected to your
          account.
        </Text>
      </header>

      <div className="px-5 sm:px-8">
        <Tabs
          label="Settings sections"
          items={settingsTabs}
          activeId={activeTab}
          onActivate={(id) => {
            setActiveTab(id as SettingsTab);
          }}
          className="-mx-5 sm:-mx-8"
        />
      </div>

      <main
        id={`settings-panel-${activeTab}`}
        role="tabpanel"
        aria-label={settingsTabs.find((tab) => tab.id === activeTab)?.label}
        className="flex min-w-0 flex-col gap-6 p-5 sm:p-8"
      >
        {activeTab === 'workspace' ? <WorkspaceManagementSection /> : null}
        {activeTab === 'editor' ? <EditorPreferencesSection /> : null}
        {activeTab === 'notifications' ? <NotificationsSection /> : null}
        {activeTab === 'pets' ? <PetSettingsSection /> : null}
        {activeTab === 'access-tokens' ? <AccessTokensSection /> : null}
      </main>
    </div>
  );
}
