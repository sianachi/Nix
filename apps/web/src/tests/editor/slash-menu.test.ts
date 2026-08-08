import { describe, expect, it } from 'vitest';

import { SLASH_COMMANDS, filterSlashCommands } from '../../editor/slash-menu';

describe('the slash menu', () => {
  it('offers every block the schema defines a way to insert', () => {
    const ids = SLASH_COMMANDS.map((command) => command.id);

    // A block in the schema with no way to insert it is a block nobody can use. Tables and
    // callouts are here because they are exactly the two a thin first cut always omits.
    expect(ids).toEqual(
      expect.arrayContaining([
        'paragraph',
        'heading-1',
        'heading-2',
        'heading-3',
        'bullet-list',
        'ordered-list',
        'task-list',
        'blockquote',
        'code-block',
        'callout',
        'divider',
        'table',
        'image',
      ]),
    );
  });

  it('shows everything when nothing has been typed', () => {
    expect(filterSlashCommands('')).toHaveLength(SLASH_COMMANDS.length);
    expect(filterSlashCommands('   ')).toHaveLength(SLASH_COMMANDS.length);
  });

  it('matches on the label', () => {
    expect(filterSlashCommands('table').map((command) => command.id)).toEqual(['table']);
  });

  it('matches on the words people actually reach for', () => {
    // "bullet", "ul" and "list" all have to find the same thing: people type the word they know,
    // not the word the schema uses.
    for (const query of ['bullet', 'ul', 'unordered']) {
      expect(filterSlashCommands(query).map((command) => command.id)).toContain('bullet-list');
    }

    expect(filterSlashCommands('todo').map((command) => command.id)).toContain('task-list');
    expect(filterSlashCommands('admonition').map((command) => command.id)).toContain('callout');
  });

  it('ignores case and surrounding space', () => {
    expect(filterSlashCommands('  TABLE ').map((command) => command.id)).toEqual(['table']);
  });

  it('returns nothing when nothing matches', () => {
    expect(filterSlashCommands('spreadsheet')).toEqual([]);
  });
});
