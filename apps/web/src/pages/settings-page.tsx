import { Tabs, Text } from '@nix/ui';
import { type ReactElement } from 'react';

import { paneScroller } from '../layout/regions';
import { AccessTokensSection } from '../settings/access-tokens/access-tokens-section';
import { AdministratorsSection } from '../settings/administrators/administrators-section';
import { SiteApprovalsSection } from '../settings/site-approvals/site-approvals-section';
import { BackupsSection } from '../settings/backups/backups-section';
import { McpSection } from '../settings/mcp/mcp-section';
import { CalendarsSection } from '../settings/calendars/calendars-section';
import { DailyNotesSection } from '../settings/daily-notes/daily-notes-section';
import { EditorPreferencesSection } from '../settings/editor/editor-preferences-section';
import { PublishingSection } from '../settings/publishing/publishing-section';
import { PreferencesSection } from '../settings/preferences/PreferencesSection';
import { NotificationsSection } from '../settings/notifications/notifications-section';
import { WorkspaceManagementSection } from '../workspaces/workspace-management-section';
import { PetSettingsSection } from '../pets/pet-settings-section';
import { useCapabilities, type Capabilities } from '../session/capabilities-context';
import { DEFAULT_SETTINGS_TAB, useSettingsTab, type SettingsTab } from './settings-tab';

type Gate = (capabilities: Capabilities) => boolean;

// Personal and place first, then connections, then the operator's own: each tab keeps its id so
// every `?tab=` link still lands where it did.
const settingsTabs: readonly { id: SettingsTab; label: string; closable: false; gate?: Gate }[] = [
  { id: 'workspace', label: 'Workspace', closable: false },
  { id: 'daily-notes', label: 'Daily notes', closable: false },
  { id: 'editor', label: 'Editor', closable: false },
  { id: 'preferences', label: 'Preferences', closable: false },
  { id: 'pets', label: 'Pets', closable: false },
  { id: 'notifications', label: 'Notifications', closable: false },
  { id: 'integrations', label: 'Calendars', closable: false },
  { id: 'publishing', label: 'Publishing', closable: false, gate: (c) => c.sites },
  { id: 'access-tokens', label: 'Access tokens', closable: false },
  { id: 'mcp', label: 'MCP', closable: false },
  { id: 'backups', label: 'Backups', closable: false, gate: (c) => c.operator },
  { id: 'site-approvals', label: 'Site approvals', closable: false, gate: (c) => c.siteApprover },
  {
    id: 'administrators',
    label: 'Administrators',
    closable: false,
    gate: (c) => c.tenantAdministrator || c.siteApprover,
  },
];

/** Settings grouped by the thing being managed, with workspace management first. Addressable by
 * `?tab=` so a link to a specific section survives a refresh or gets shared. */
export function SettingsPage(): ReactElement {
  const { tab: requestedTab, setTab: setActiveTab } = useSettingsTab();
  // Display hints: Core refuses the operator, approver and administrator routes to everyone else.
  const capabilities = useCapabilities();
  const tabs = settingsTabs.filter((tab) => tab.gate?.(capabilities) !== false);
  const activeTab = tabs.some((tab) => tab.id === requestedTab)
    ? requestedTab
    : DEFAULT_SETTINGS_TAB;

  return (
    <div className={`${paneScroller} flex flex-col`}>
      <header className="border-b border-divider px-3 py-3 sm:px-6 sm:py-4">
        <Text variant="h3" as="h1">
          Settings
        </Text>
        <Text variant="note" tone="muted" className="mt-1 hidden max-w-2xl sm:block">
          Manage the place you work, how the editor behaves, what you publish, and the credentials
          connected to your account.
        </Text>
      </header>

      <div className="min-w-0">
        <Tabs
          label="Settings sections"
          items={tabs}
          activeId={activeTab}
          onActivate={(id) => {
            const selected = tabs.find((tab) => tab.id === id);
            if (selected !== undefined) setActiveTab(selected.id);
          }}
        />
      </div>

      <main
        id={`settings-panel-${activeTab}`}
        role="tabpanel"
        aria-label={tabs.find((tab) => tab.id === activeTab)?.label}
        className="flex min-w-0 flex-col gap-6 break-words p-3 sm:p-6"
      >
        {activeTab === 'workspace' ? <WorkspaceManagementSection /> : null}
        {activeTab === 'editor' ? <EditorPreferencesSection /> : null}
        {activeTab === 'preferences' ? <PreferencesSection /> : null}
        {activeTab === 'notifications' ? <NotificationsSection /> : null}
        {activeTab === 'daily-notes' ? <DailyNotesSection /> : null}
        {activeTab === 'pets' ? <PetSettingsSection /> : null}
        {activeTab === 'integrations' ? <CalendarsSection /> : null}
        {activeTab === 'access-tokens' ? <AccessTokensSection /> : null}
        {activeTab === 'mcp' ? <McpSection /> : null}
        {activeTab === 'publishing' ? <PublishingSection /> : null}
        {activeTab === 'backups' ? <BackupsSection /> : null}
        {activeTab === 'site-approvals' ? <SiteApprovalsSection /> : null}
        {activeTab === 'administrators' ? <AdministratorsSection /> : null}
      </main>
    </div>
  );
}
