import { Tabs, Text } from '@nix/ui';
import { useState, type ReactElement } from 'react';

import { paneScroller } from '../layout/regions';
import { AccessTokensSection } from '../settings/access-tokens-section';
import { EditorPreferencesSection } from '../settings/editor-preferences-section';
import { WorkspaceManagementSection } from '../workspaces/workspace-management-section';

type SettingsTab = 'workspace' | 'editor' | 'access-tokens';

const settingsTabs = [
  { id: 'workspace', label: 'Workspace', closable: false },
  { id: 'editor', label: 'Editor', closable: false },
  { id: 'access-tokens', label: 'Access tokens', closable: false },
] as const;

/** Settings grouped by the thing being managed, with workspace management first. */
export function SettingsPage(): ReactElement {
  const [activeTab, setActiveTab] = useState<SettingsTab>('workspace');

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
        {activeTab === 'access-tokens' ? <AccessTokensSection /> : null}
      </main>
    </div>
  );
}
