import { describe, expect, it } from 'vitest';
import { canApplyWithoutAsking, hasExternalLink } from './auto-apply.js';
import { READ_ONLY_OPERATIONS, workspaceToolSchema } from './tool-args.js';

const everyOperation = workspaceToolSchema.shape.operation.options;
const alwaysAsk = ['trash_item', 'move_item', 'save_as_template'] as const;

describe('canApplyWithoutAsking', () => {
  it('never answers for a read or a design check: those have their own switch', () => {
    for (const operation of READ_ONLY_OPERATIONS)
      expect(canApplyWithoutAsking(operation)).toBe(false);
    expect(canApplyWithoutAsking('validate_blueprint')).toBe(false);
  });

  it('keeps the audience-changing writes asking and lets every other write run', () => {
    for (const operation of alwaysAsk) expect(canApplyWithoutAsking(operation)).toBe(false);
    const writes = everyOperation.filter(
      (operation) =>
        !READ_ONLY_OPERATIONS.has(operation) &&
        operation !== 'validate_blueprint' &&
        !(alwaysAsk as readonly string[]).includes(operation),
    );
    expect(writes.length).toBeGreaterThan(5);
    for (const operation of writes) expect(canApplyWithoutAsking(operation)).toBe(true);
  });
});

describe('hasExternalLink', () => {
  it('finds links to another host in any form the editor would keep', () => {
    expect(hasExternalLink(['see https://example.test/p?d=secret'])).toBe(true);
    expect(hasExternalLink(['![](http://example.test/a.png)'])).toBe(true);
    expect(hasExternalLink(['<//example.test/x>'])).toBe(true);
    expect(hasExternalLink(['plain', 'HTTPS://EXAMPLE.TEST'])).toBe(true);
  });

  it('lets ordinary text, item links and slashes through', () => {
    expect(hasExternalLink(['Weekly plan', '/w/123?item=456', 'a / b', 'http not a link'])).toBe(
      false,
    );
    expect(hasExternalLink([])).toBe(false);
  });
});
