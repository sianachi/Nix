#!/usr/bin/env node
// Exercise the public product path through nixctl, including the actual Go transfers.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const profile = process.env.NIXCTL_PROFILE;
const workspace = process.env.NIX_SMOKE_WORKSPACE;
const expectedOrigin = process.env.NIX_SMOKE_ORIGIN;
const cli = process.env.NIXCTL_BIN ?? join(dirname(fileURLToPath(import.meta.url)), 'nixctl.sh');
if (!profile || !workspace || !expectedOrigin) throw new Error('Set NIXCTL_PROFILE, NIX_SMOKE_WORKSPACE and NIX_SMOKE_ORIGIN.');
const expectedURL = new URL(expectedOrigin);
if (expectedURL.protocol !== 'https:' || expectedURL.href !== `${expectedURL.origin}/`) throw new Error('NIX_SMOKE_ORIGIN must be an HTTPS origin.');

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cli, ['--profile', profile, '--json', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let timedOut = false;
    // Do not print CLI diagnostics that may contain sensitive response details.
    child.stderr.resume();
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, 180_000);
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 185_000);
    child.stdout.on('data', (data) => {
      output += data;
      if (output.length > 1_048_576) child.kill('SIGKILL');
    });
    child.on('error', (error) => { clearTimeout(timer); clearTimeout(killTimer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer); clearTimeout(killTimer);
      if (code !== 0 || timedOut) return reject(new Error(`nixctl ${args[0]} failed${timedOut ? ' (180s timeout)' : ''}; inspect job state using nixctl/MCP.`));
      try { resolve(JSON.parse(output)); } catch { reject(new Error(`nixctl ${args[0]} returned invalid JSON.`)); }
    });
  });
}

execFileSync('python3', ['--version']);
execFileSync('pdftotext', ['-v'], { stdio: 'ignore' });
const auth = await run(['auth', 'status']);
if (auth.apiUrl?.replace(/\/$/, '') !== expectedURL.origin) throw new Error('nixctl profile URL does not match this deployment; refusing to verify another instance.');
await run(['item', 'ls', '--workspace', workspace]);
if (process.argv.includes('--preflight')) {
  console.log('nixctl authentication and smoke workspace are available.');
  process.exit(0);
}
const directory = await mkdtemp(join(tmpdir(), 'nix-release-smoke-'));
let root;
let failure;
try {
  const source = join(directory, 'release-smoke.txt');
  await writeFile(source, 'Nix release smoke test\n\nStorage transfer and document conversion verification.\n');
  const report = await run(['import', source, '--workspace', workspace]);
  root = report.rootItemId;
  if (!root || report.createdCount !== 2 || !report.atomic || report.omissions?.length || report.loss?.length) {
    throw new Error('Document import did not publish the expected note and retained attachment without omissions.');
  }
  console.log(`Document import passed; temporary root ${root}.`);
  const children = await run(['item', 'ls', '--workspace', workspace, '--parent', root]);
  const original = children.items?.find((item) => item.type === 'file');
  if (!original || children.items.length !== 1) throw new Error('Import did not retain exactly one original attachment.');
  const retained = join(directory, 'retained.txt');
  await run(['file', 'download', original.id, '--out', retained]);
  if (!(await readFile(source)).equals(await readFile(retained))) throw new Error('Retained attachment differs from the imported source.');
  console.log('Retained attachment download matches the imported source.');
  for (const [format, magic] of [['nix', 'PK'], ['pdf', '%PDF-'], ['docx', 'PK']]) {
    const out = join(directory, `export.${format}`);
    // Archive v1 cannot embed file bytes; verify the attachment separately above.
    const result = await run(['export', root, '--format', format, '--scope', 'item', '--out', out]);
    if (result.omissions?.length || result.omitted > 0) throw new Error(`${format} export omitted content.`);
    const bytes = await readFile(out);
    if (!bytes.subarray(0, magic.length).equals(Buffer.from(magic))) throw new Error(`${format} export has an invalid file signature.`);
    execFileSync('python3', [join(dirname(fileURLToPath(import.meta.url)), 'verify-artifact.py'), format, out], { stdio: 'pipe' });
    console.log(`${format} export and checksum-verified download passed (${bytes.length} bytes).`);
  }
} catch (error) {
  failure = error;
} finally {
  if (root) {
    try {
      await run(['item', 'rm', root, '--workspace', workspace]);
      console.log(`Temporary import ${root} soft-deleted.`);
    } catch {
      failure ??= new Error(`Cleanup failed: soft-delete temporary root ${root} in workspace ${workspace}.`);
      console.error(`Cleanup required: temporary root ${root}.`);
    }
  } else if (failure) {
    console.error('Import did not return a root ID. Inspect recent imports for a timed-out or partially published smoke job.');
  }
  await rm(directory, { recursive: true, force: true });
}
if (failure) throw failure;
console.log('Public import and export smoke checks passed. Browser sign-in, paste/drop uploads and collaboration still require the runbook checks.');
