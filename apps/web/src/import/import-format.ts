import type { PathReason } from './import-plan';

export function pathOf(file: File): string {
  // Optional in fact, not just in type: only a folder pick fills it, and test doubles of File do
  // not carry it at all.
  return typeof file.webkitRelativePath === 'string' && file.webkitRelativePath.length > 0
    ? file.webkitRelativePath
    : file.name;
}

export function documentFormat(name: string): 'nix' | 'docx' | 'pdf' | 'txt' | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.nix')) return 'nix';
  if (lower.endsWith('.docx')) return 'docx';
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.txt')) return 'txt';
  return null;
}

export function documentMediaType(
  format: 'nix' | 'docx' | 'pdf' | 'txt',
  browserType: string,
): string {
  if (format === 'pdf') return 'application/pdf';
  if (format === 'txt') return 'text/plain';
  if (format === 'docx') {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }
  return browserType || 'application/vnd.nix.archive';
}

export function withoutExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? name : name.slice(0, dot);
}

export interface ReasonGroup {
  readonly reason: string;
  readonly paths: readonly string[];
}

/** One group per distinct reason, each keeping the paths it covers - never a bare count. */
export function groupByReason(rows: readonly PathReason[]): readonly ReasonGroup[] {
  const groups = new Map<string, string[]>();
  for (const row of rows) {
    const paths = groups.get(row.reason);
    if (paths === undefined) {
      groups.set(row.reason, [row.path]);
    } else {
      paths.push(row.path);
    }
  }
  return [...groups.entries()].map(([reason, paths]) => ({ reason, paths }));
}

/** The first few paths by name, then an honest count of the rest. */
export function pathsClause(paths: readonly string[]): string {
  const shown = paths.slice(0, 5);
  const rest = paths.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${String(rest)} more` : shown.join(', ');
}

/** The distinct reasons, joined; used where paths would drown the sentence. */
export function distinctReasons(rows: readonly PathReason[]): string {
  return [...new Set(rows.map((row) => withoutDot(row.reason)))].join('; ');
}

/** Reasons arrive both as fragments and as full sentences; strip the dot so ours is the only one. */
export function withoutDot(text: string): string {
  return text.endsWith('.') ? text.slice(0, -1) : text;
}

export function affectedPathsClause(paths: readonly string[]): string {
  const shown = paths.slice(0, 5);
  const rest = paths.length - shown.length;
  return rest > 0 ? `${shown.join('; ')}; and ${String(rest)} more` : shown.join('; ');
}
