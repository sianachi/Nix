import { describe, expect, it } from 'vitest';

import { checkOpenUi } from './openui-check.ts';

const reply = (block: string, info = 'openui-lang') =>
  `Here it is.\n\n\`\`\`${info}\n${block}\n\`\`\``;
const form = `root = Stack([form])
form = Form("Add task", add, [name])
name = TextInput("Task", $name, "", {required: true})
add = Button("Add", @Run(save), "primary")
save = Mutation("create_entries", {parentId: "p", spec: {entries: [{title: $name}]}})
$name = ""`;

describe('chat eval OpenUI checks', () => {
  it('pass a reply whose block parses and uses what the case names', async () => {
    await expect(
      checkOpenUi(reply(form), {
        components: ['Form', 'TextInput'],
        mutations: ['create_entries'],
      }),
    ).resolves.toEqual([]);
  });

  it('report a missing block, unknown components and missing names', async () => {
    await expect(checkOpenUi('Just text.', {})).resolves.toEqual([
      'reply has no openui-lang block',
    ]);
    const failures = await checkOpenUi(reply('root = Stack([x])\nx = Marquee("hi")'), {
      components: ['Grid'],
      functions: ['Today'],
    });
    expect(failures.some((line) => line.startsWith('openui unknown-component'))).toBe(true);
    expect(failures).toContain('openui lacks component Grid');
    expect(failures).toContain('openui lacks function @Today');
  });

  it('accept a patch without a root, and enforce absence', async () => {
    await expect(
      checkOpenUi(reply('title = Text("Bigger", "display")', 'openui-lang patch'), { patch: true }),
    ).resolves.toEqual([]);
    await expect(checkOpenUi(reply(form), { absent: true })).resolves.toEqual([
      'reply has generated UI it should not',
    ]);
  });
});
