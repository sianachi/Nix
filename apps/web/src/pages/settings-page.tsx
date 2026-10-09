import { Tabs, Text } from '@nix/ui';
import { type ReactElement } from 'react';

import { paneScroller } from '../layout/regions';
import { AccessTokensSection } from '../settings/access-tokens-section';
import { CalendarsSection } from '../settings/calendars-section';
import { DailyNotesSection } from '../settings/daily-notes-section';
import { EditorPreferencesSection } from '../settings/editor-preferences-section';
import { NotificationsSection } from '../settings/notifications-section';
import { WorkspaceManagementSection } from '../workspaces/workspace-management-section';
import { PetSettingsSection } from '../pets/pet-settings-section';
import { useSettingsTab, type SettingsTab } from './settings-tab';

const settingsTabs: readonly { id: SettingsTab; label: string; closable: false }[] = [
  { id: 'workspace', label: 'Workspace', closable: false },
  { id: 'editor', label: 'Editor', closable: false },
  { id: 'notifications', label: 'Notifications', closable: false },
  { id: 'daily-notes', label: 'Daily notes', closable: false },
  { id: 'pets', label: 'Pets', closable: false },
  { id: 'integrations', label: 'Calendars', closable: false },
  { id: 'access-tokens', label: 'Access tokens', closable: false },
];

/** Settings grouped by the thing being managed, with workspace management first. Addressable by
 * `?tab=` so a link to a specific section survives a refresh or gets shared. */
export function SettingsPage(): ReactElement {
  const { tab: activeTab, setTab: setActiveTab } = useSettingsTab();

  return (
    <div className={`${paneScroller} flex flex-col`}>
      <header className="border-b border-divider px-3 py-3 sm:px-6 sm:py-4">
        <Text variant="h3" as="h1">
          Settings
        </Text>
        <Text variant="note" tone="muted" className="mt-1 hidden max-w-2xl sm:block">
          Manage the place you work, how the editor behaves, and the credentials connected to your
          account.
        </Text>
      </header>

      <div className="min-w-0">
        <Tabs
          label="Settings sections"
          items={settingsTabs}
          activeId={activeTab}
          onActivate={(id) => {
            const selected = settingsTabs.find((tab) => tab.id === id);
            if (selected !== undefined) setActiveTab(selected.id);
          }}
        />
      </div>

      <main
        id={`settings-panel-${activeTab}`}
        role="tabpanel"
        aria-label={settingsTabs.find((tab) => tab.id === activeTab)?.label}
        className="flex min-w-0 flex-col gap-6 break-words p-3 sm:p-6"
      >
        {activeTab === 'workspace' ? <WorkspaceManagementSection /> : null}
        {activeTab === 'editor' ? <EditorPreferencesSection /> : null}
        {activeTab === 'notifications' ? <NotificationsSection /> : null}
        {activeTab === 'daily-notes' ? <DailyNotesSection /> : null}
        {activeTab === 'pets' ? <PetSettingsSection /> : null}
        {activeTab === 'integrations' ? <CalendarsSection /> : null}
        {activeTab === 'access-tokens' ? <AccessTokensSection /> : null}
      </main>
    </div>
  );
}
