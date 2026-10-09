import type { FileRecord } from '@nix/api-client';
import type { ReactElement } from 'react';

import { FileDetails } from './file-details';

export default { title: 'Nix/Files/Details', parameters: { layout: 'padded' } };

const current = {
  id: 'version-2',
  version: 2,
  fileName: `${'long-filename-'.repeat(8)}.pdf`,
  mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  byteLength: 2048,
  sha256: 'a'.repeat(64),
  previewable: true,
  pixelWidth: null,
  pixelHeight: null,
  createdAt: '2026-10-09T09:00:00Z',
  current: true,
  thumbnail: null,
};
const record: FileRecord = {
  itemId: 'file-item',
  workspaceId: 'workspace',
  current,
  versions: [current, { ...current, id: 'version-1', version: 1, current: false }],
};

export function TinyScreen(): ReactElement {
  return (
    <div className="w-64 max-w-full">
      <FileDetails record={record} downloading={false} onDownloadVersion={() => undefined} />
    </div>
  );
}

export function Desktop(): ReactElement {
  return (
    <div className="max-w-lg">
      <FileDetails record={record} downloading={false} onDownloadVersion={() => undefined} />
    </div>
  );
}
