#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { loadFixture, writeSite } from './fixture.js';
import { renderSite } from './render.js';
import { createPreviewServer } from './serve.js';
import { loadPreviewRasterizer } from './theme/preview-image.js';

/**
 * nix-site-render build --fixture <dir> --out <dir>
 * nix-site-render serve --dir <dir> [--port 4600] [--host 127.0.0.1]
 */

const USAGE = `Usage:
  nix-site-render build --fixture <dir> --out <dir>
  nix-site-render serve --dir <dir> [--port 4600] [--host 127.0.0.1]`;

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: [...rest],
    options: {
      fixture: { type: 'string' },
      out: { type: 'string' },
      dir: { type: 'string' },
      port: { type: 'string', default: '4600' },
      host: { type: 'string', default: '127.0.0.1' },
    },
  });

  if (command === 'build' && values.fixture !== undefined && values.out !== undefined) {
    const site = renderSite({
      ...(await loadFixture(values.fixture)),
      previews: await loadPreviewRasterizer(),
    });
    await writeSite(site.files, values.out);
    process.stdout.write(`Wrote ${String(site.files.length)} files to ${values.out}\n`);
    for (const entry of site.loss) {
      process.stdout.write(`  ${entry.kind}: ${entry.detail}\n`);
    }
    return 0;
  }

  if (command === 'serve' && values.dir !== undefined) {
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      process.stderr.write(`Not a port: ${values.port}\n`);
      return 2;
    }
    const server = createPreviewServer(values.dir);
    server.listen(port, values.host, () => {
      process.stdout.write(
        `Serving ${values.dir ?? ''} at http://${values.host}:${String(port)}/\n`,
      );
    });
    return await new Promise<number>(() => undefined);
  }

  process.stderr.write(`${USAGE}\n`);
  return 2;
}

// Run when executed directly (also through the package's bin symlink), not when imported.
const invoked =
  process.argv[1] === undefined ? '' : pathToFileURL(realpathSync(process.argv[1])).href;
if (import.meta.url === invoked) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
