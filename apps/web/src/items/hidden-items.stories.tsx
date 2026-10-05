import { useState, type ReactNode } from 'react';

import { HiddenItemsList, type HiddenEntry } from './hidden-items-list';

export default { title: 'Nix/Items/Hidden items', parameters: { layout: 'padded' } };
const noop = () => undefined;

function Example({
  loading = false,
  failed = false,
  unavailable = false,
  empty = false,
  saveFailed = false,
}) {
  const [entries, setEntries] = useState<readonly HiddenEntry[]>(
    empty
      ? []
      : [
          { id: 'one', title: 'Meeting notes', failed: false },
          { id: 'two', title: unavailable || failed ? null : 'Old project plan', failed },
        ],
  );
  return (
    <div className="max-w-sm">
      <HiddenItemsList
        entries={entries}
        count={loading ? 70 : entries.length}
        loading={loading}
        hasMore={loading}
        saveFailed={saveFailed}
        onOpen={noop}
        onShow={(id) => {
          setEntries(entries.filter((entry) => entry.id !== id));
        }}
        onShowAll={() => {
          setEntries([]);
        }}
        onRetry={noop}
        onMore={noop}
      />
    </div>
  );
}
export const Ready = { render: (): ReactNode => <Example /> };
export const Loading = { render: (): ReactNode => <Example loading /> };
export const RequestFailed = { render: (): ReactNode => <Example failed /> };
export const Unavailable = { render: (): ReactNode => <Example unavailable /> };
export const StorageUnavailable = { render: (): ReactNode => <Example saveFailed /> };
export const Empty = { render: (): ReactNode => <Example empty /> };
export const DarkReady = { ...Ready, globals: { ground: 'dark' } };
