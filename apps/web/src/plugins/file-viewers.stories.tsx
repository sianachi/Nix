import type { ReactElement } from 'react';

import { CsvViewer } from './csv-viewer';
import { MarkdownViewer } from './markdown-viewer';
import { TextViewer } from './text-viewer';

export default { title: 'Nix/Files/Viewers', parameters: { layout: 'fullscreen' } };

function Stage({ children }: { readonly children: ReactElement }): ReactElement {
  return <div className="flex h-screen flex-col">{children}</div>;
}

const CSV = [
  'region,quarter,revenue,notes',
  'North,Q1,"1,204","Includes ""pilot"" accounts"',
  'North,Q2,"1,318",',
  'South,Q1,980,Late invoices',
  'South,Q2,"1,022",',
  'West,Q1,"1,511",',
].join('\n');

export const Csv = {
  render: (): ReactElement => (
    <Stage>
      <CsvViewer fileName="revenue.csv" source={CSV} />
    </Stage>
  ),
};

const GO = `package main

import "fmt"

// main prints the runbook's first step.
func main() {
\tfor step := 1; step <= 3; step++ {
\t\tfmt.Printf("step %d\\n", step)
\t}
}
`;

export const SourceCode = {
  render: (): ReactElement => (
    <Stage>
      <TextViewer fileName="main.go" source={GO} />
    </Stage>
  ),
};

const README = `# Deploy runbook

Run these steps in order. Each one is **idempotent**.

1. Build the image
2. Push to the registry
3. Roll the deployment

| Step | Owner | Time |
| --- | --- | --- |
| Build | CI | 4 min |
| Roll | On-call | 2 min |

> Rollback is the same steps with the previous tag.
`;

export const Markdown = {
  render: (): ReactElement => (
    <Stage>
      <MarkdownViewer fileName="README.md" source={README} />
    </Stage>
  ),
};
