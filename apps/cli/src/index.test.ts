import type { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as PetsModule from './commands/pets.ts';

const petCommand = vi.fn<typeof PetsModule.petCommand>(() => Promise.resolve());

// commander only copies a command's `_exitCallback` onto a subcommand at the moment the
// subcommand is created (`Command.copyInheritedSettings`); `buildProgram()` has already built
// the whole `pet` subtree by the time it returns, so `program.exitOverride()` alone never reaches
// `pet`'s own option parser. Apply it to every command in the tree instead, so an invalid
// `--after` throws a CommanderError here rather than calling the real `process.exit`.
function overrideExitRecursively(command: Command): void {
  command.exitOverride();
  for (const sub of command.commands) {
    overrideExitRecursively(sub);
  }
}

vi.mock('./commands/pets.ts', async () => {
  const actual = await vi.importActual<typeof PetsModule>('./commands/pets.ts');
  return {
    ...actual,
    petCommand: (...args: Parameters<typeof actual.petCommand>) => petCommand(...args),
  };
});

// buildProgram() is imported after the mock above is registered, so `pet <operation>`'s action
// calls the stub instead of driving a real session and network request.
const { buildProgram } = await import('./index.ts');

describe('pet --after validation', () => {
  afterEach(() => {
    petCommand.mockClear();
  });

  it('accepts a non-negative integer and passes it through to petCommand', async () => {
    const program = buildProgram();
    overrideExitRecursively(program);

    await program.parseAsync(
      ['pet', 'watch', '--workspace', 'w1', '--pet', 'p1', '--after', '42'],
      { from: 'user' },
    );

    expect(petCommand).toHaveBeenCalledTimes(1);
    const options = petCommand.mock.calls[0]?.[2];
    expect(options?.after).toBe(42);
  });

  it('rejects a negative --after before petCommand ever runs', async () => {
    const program = buildProgram();
    overrideExitRecursively(program);

    await expect(
      program.parseAsync(
        ['pet', 'watch', '--workspace', 'w1', '--pet', 'p1', '--after', '-1'],
        { from: 'user' },
      ),
    ).rejects.toThrow(/non-negative integer/);
    expect(petCommand).not.toHaveBeenCalled();
  });

  it('rejects a non-integer --after before petCommand ever runs', async () => {
    const program = buildProgram();
    overrideExitRecursively(program);

    await expect(
      program.parseAsync(
        ['pet', 'watch', '--workspace', 'w1', '--pet', 'p1', '--after', '1.5'],
        { from: 'user' },
      ),
    ).rejects.toThrow(/non-negative integer/);
    expect(petCommand).not.toHaveBeenCalled();
  });
});
