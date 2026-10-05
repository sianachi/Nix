import { nixSchema } from '@nix/editor-schema';
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import {
  batchWithinBudget,
  buildTranscriptSection,
  formatClock,
  outlineOf,
  placeTranscriptSection,
  writeTranscriptSection,
  type ProseNodeJson,
  type TopLevelBlock,
  type TranscriptParagraph,
  type TranscriptSource,
} from './section.ts';

const WORKSPACE = '44444444-4444-4444-8444-444444444444';
const AUDIO = '66666666-6666-4666-8666-666666666666';
const FRAGMENT = 'default';

const SOURCE: TranscriptSource = {
  workspaceId: WORKSPACE,
  audioItemId: AUDIO,
  audioTitle: 'Planning call',
  durationMillis: 125_000,
};

const SPOKEN: readonly TranscriptParagraph[] = [
  { startMillis: 0, speaker: 'me', text: 'Shall we start?' },
  { startMillis: 65_400, speaker: 'others', text: 'Yes, the budget first.' },
  { startMillis: 3_725_000, speaker: '', text: 'Unattributed remark.' },
];

function paragraph(text: string): ProseNodeJson {
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}

function heading(level: number, text: string): ProseNodeJson {
  return { type: 'heading', attrs: { level }, content: [{ type: 'text', text }] };
}

function noteOf(nodes: readonly ProseNodeJson[]): Y.Doc {
  const doc = new Y.Doc();
  if (nodes.length > 0) {
    prosemirrorJSONToYXmlFragment(
      nixSchema,
      { type: 'doc', content: nodes },
      doc.getXmlFragment(FRAGMENT),
    );
  }
  return doc;
}

/** The note as lines of text, one per top-level node, after checking it against the schema. */
function linesOf(doc: Y.Doc): string[] {
  const root = yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment(FRAGMENT), nixSchema);
  root.check();
  const lines: string[] = [];
  root.forEach((node) => {
    lines.push(node.textBetween(0, node.content.size));
  });
  return lines;
}

function write(
  doc: Y.Doc,
  paragraphs: readonly TranscriptParagraph[] = SPOKEN,
  source: TranscriptSource = SOURCE,
  batchBytes = 1_000_000,
): Uint8Array[] {
  return [...writeTranscriptSection(doc, FRAGMENT, source, paragraphs, batchBytes)];
}

const SECTION_LINES = [
  'Transcript',
  'From Planning call, 2:05 long.',
  '[0:00] Me: Shall we start?',
  '[1:05] Others: Yes, the budget first.',
  '[1:02:05] Unattributed remark.',
];

describe('the transcript clock', () => {
  it('shows minutes and seconds under an hour and adds hours from there', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(5_999)).toBe('0:05');
    expect(formatClock(754_000)).toBe('12:34');
    expect(formatClock(3_600_000)).toBe('1:00:00');
    expect(formatClock(36_610_000)).toBe('10:10:10');
  });
});

describe('the transcript section, as ProseMirror nodes', () => {
  it('is valid against the shared schema and links each timestamp to its second', () => {
    const nodes = buildTranscriptSection(SOURCE, SPOKEN);
    const root = nixSchema.nodeFromJSON({ type: 'doc', content: nodes });
    root.check();

    expect(nodes[0]).toEqual({
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Transcript' }],
    });
    expect(nodes[1]?.content?.[1]).toEqual({
      type: 'reference',
      attrs: { kind: 'item', targetId: AUDIO, label: 'Planning call' },
    });

    const second = root.child(3);
    const stamp = second.child(0);
    expect(stamp.text).toBe('[1:05]');
    expect(stamp.marks.map((mark) => mark.type.name)).toEqual(['link']);
    expect(stamp.marks[0]?.attrs.href).toBe(`/w/${WORKSPACE}?item=${AUDIO}&t=65`);

    const label = second.child(2);
    expect(label.text).toBe('Others:');
    expect(label.marks.map((mark) => mark.type.name)).toEqual(['bold']);
  });

  it('carries no speaker label when the speaker is unknown', () => {
    const nodes = buildTranscriptSection(SOURCE, [
      { startMillis: 1_000, speaker: '', text: 'Hello.' },
    ]);
    expect(nodes[2]?.content?.map((node) => node.text)).toEqual(['[0:01]', ' ', 'Hello.']);
  });

  it('says so when nothing was said', () => {
    const nodes = buildTranscriptSection(SOURCE, []);
    nixSchema.nodeFromJSON({ type: 'doc', content: nodes }).check();
    expect(nodes).toHaveLength(3);
    expect(nodes[2]).toEqual(paragraph('No speech was detected.'));
  });
});

describe('placing the transcript section', () => {
  const OTHER_AUDIO = '99999999-9999-4999-8999-999999999999';

  const block = (type: string, extra: Partial<TopLevelBlock> = {}): TopLevelBlock => ({
    type,
    level: null,
    text: '',
    referenceTargets: [],
    leadingLinkHref: null,
    ...extra,
  });
  const heading2 = (text: string): TopLevelBlock => block('heading', { level: 2, text });
  const fromLine = (audio: string): TopLevelBlock =>
    block('paragraph', { text: 'From , 2:05 long.', referenceTargets: [audio] });
  const spoken = (audio: string, seconds = 0): TopLevelBlock =>
    block('paragraph', {
      text: '[0:00] Hello.',
      leadingLinkHref: `/w/${WORKSPACE}?item=${audio}&t=${String(seconds)}`,
    });
  const typed = (text = 'My own note.'): TopLevelBlock => block('paragraph', { text });
  const noSpeech = (): TopLevelBlock => block('paragraph', { text: 'No speech was detected.' });

  it('appends to an empty note and after existing content', () => {
    expect(placeTranscriptSection([], AUDIO)).toEqual({ index: 0, deleteCount: 0 });
    expect(placeTranscriptSection([typed(), heading2('Notes')], AUDIO)).toEqual({
      index: 2,
      deleteCount: 0,
    });
  });

  it('replaces the heading, the From line and the paragraphs of this recording', () => {
    const blocks = [
      typed(),
      heading2(' Transcript '),
      fromLine(AUDIO),
      spoken(AUDIO, 0),
      spoken(AUDIO, 30),
      heading2('Actions'),
      typed(),
    ];
    expect(placeTranscriptSection(blocks, AUDIO)).toEqual({ index: 1, deleteCount: 4 });
  });

  it('ends at the first block that is not a transcript paragraph, heading or not', () => {
    const blocks = [
      heading2('Transcript'),
      fromLine(AUDIO),
      spoken(AUDIO),
      typed('What I thought of that.'),
      // Looks like a transcript paragraph, but it is past something the user wrote.
      spoken(AUDIO, 40),
    ];
    expect(placeTranscriptSection(blocks, AUDIO)).toEqual({ index: 0, deleteCount: 3 });

    const list = [heading2('Transcript'), fromLine(AUDIO), block('bulletList'), spoken(AUDIO)];
    expect(placeTranscriptSection(list, AUDIO)).toEqual({ index: 0, deleteCount: 2 });
  });

  it('takes the silent sentence only directly under the From line', () => {
    expect(
      placeTranscriptSection([heading2('Transcript'), fromLine(AUDIO), noSpeech(), typed()], AUDIO),
    ).toEqual({ index: 0, deleteCount: 3 });

    // The same sentence typed by somebody further down is theirs.
    expect(
      placeTranscriptSection(
        [heading2('Transcript'), fromLine(AUDIO), spoken(AUDIO), noSpeech()],
        AUDIO,
      ),
    ).toEqual({ index: 0, deleteCount: 3 });
  });

  it('does not match another recording under an identical heading', () => {
    const blocks = [heading2('Transcript'), fromLine(OTHER_AUDIO), spoken(OTHER_AUDIO)];
    expect(placeTranscriptSection(blocks, AUDIO)).toEqual({ index: 3, deleteCount: 0 });
  });

  it('finds its own recording among several, wherever it sits', () => {
    const blocks = [
      heading2('Transcript'),
      fromLine(AUDIO),
      spoken(AUDIO),
      spoken(AUDIO, 5),
      heading2('Transcript'),
      fromLine(OTHER_AUDIO),
      spoken(OTHER_AUDIO),
    ];
    expect(placeTranscriptSection(blocks, AUDIO)).toEqual({ index: 0, deleteCount: 4 });
    expect(placeTranscriptSection(blocks, OTHER_AUDIO)).toEqual({ index: 4, deleteCount: 3 });
  });

  it('stops at a paragraph whose timestamp seeks a different recording', () => {
    const blocks = [heading2('Transcript'), fromLine(AUDIO), spoken(AUDIO), spoken(OTHER_AUDIO)];
    expect(placeTranscriptSection(blocks, AUDIO)).toEqual({ index: 0, deleteCount: 3 });
  });

  it('needs the reference directly under the heading', () => {
    // A heading somebody wrote themselves, with the real section's From line not adjacent.
    const blocks = [heading2('Transcript'), typed(), fromLine(AUDIO), spoken(AUDIO)];
    expect(placeTranscriptSection(blocks, AUDIO)).toEqual({ index: 4, deleteCount: 0 });
  });

  it('does not match a heading that merely contains the word, or one at another level', () => {
    for (const candidate of [
      heading2('Transcript notes'),
      heading2('transcript'),
      block('heading', { level: 1, text: 'Transcript' }),
      block('heading', { level: 3, text: 'Transcript' }),
      typed('Transcript'),
    ]) {
      const blocks = [candidate, fromLine(AUDIO), spoken(AUDIO)];
      expect(placeTranscriptSection(blocks, AUDIO)).toEqual({ index: 3, deleteCount: 0 });
    }
  });

  it('reads a timestamp address by meaning: any workspace, any case, but always item and t', () => {
    const led = (href: string): TopLevelBlock[] => [
      heading2('Transcript'),
      fromLine(AUDIO),
      block('paragraph', { leadingLinkHref: href }),
    ];
    const taken = (href: string): number => placeTranscriptSection(led(href), AUDIO).deleteCount;

    expect(taken(`/w/${OTHER_AUDIO}?item=${AUDIO}&t=12`)).toBe(3);
    expect(taken(`/w/${WORKSPACE}?t=12&item=${AUDIO.toUpperCase()}`)).toBe(3);
    // A link to the recording that is not a timestamp, and links that go elsewhere.
    expect(taken(`/w/${WORKSPACE}?item=${AUDIO}`)).toBe(2);
    expect(taken(`https://example.com/w/x?item=${AUDIO}&t=1`)).toBe(2);
    expect(taken(`/elsewhere?item=${AUDIO}&t=1`)).toBe(2);
    expect(taken('http://[not a url')).toBe(2);
  });

  it('replaces the last of two sections for the same recording', () => {
    const blocks = [
      heading2('Transcript'),
      fromLine(AUDIO),
      spoken(AUDIO),
      heading2('Transcript'),
      fromLine(AUDIO),
      spoken(AUDIO),
    ];
    expect(placeTranscriptSection(blocks, AUDIO)).toEqual({ index: 3, deleteCount: 3 });
  });
});

describe('reading a note outline from its fragment', () => {
  it('reports headings, references and leading timestamp links as the section writes them', () => {
    const doc = noteOf([
      paragraph('Transcript'),
      {
        type: 'heading',
        attrs: { level: 2 },
        content: [
          { type: 'text', text: 'Tran' },
          { type: 'text', text: 'script', marks: [{ type: 'bold' }] },
        ],
      },
      ...buildTranscriptSection(SOURCE, SPOKEN.slice(0, 1)).slice(1),
      // A link that is not the first thing in its paragraph does not lead it.
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'See ' },
          { type: 'text', text: 'this', marks: [{ type: 'link', attrs: { href: '/w/x?t=1' } }] },
        ],
      },
    ]);
    const none = { referenceTargets: [], leadingLinkHref: null };
    expect(outlineOf(doc.getXmlFragment(FRAGMENT))).toEqual([
      { type: 'paragraph', level: null, text: 'Transcript', ...none },
      { type: 'heading', level: 2, text: 'Transcript', ...none },
      {
        type: 'paragraph',
        level: null,
        text: 'From , 2:05 long.',
        referenceTargets: [AUDIO],
        leadingLinkHref: null,
      },
      {
        type: 'paragraph',
        level: null,
        text: '[0:00] Me: Shall we start?',
        referenceTargets: [],
        leadingLinkHref: `/w/${WORKSPACE}?item=${AUDIO}&t=0`,
      },
      { type: 'paragraph', level: null, text: 'See this', ...none },
    ]);
  });
});

describe('writing the transcript section into a live document', () => {
  const OTHER: TranscriptSource = {
    workspaceId: WORKSPACE,
    audioItemId: '99999999-9999-4999-8999-999999999999',
    audioTitle: 'Retro',
    durationMillis: 60_000,
  };
  const OTHER_SPOKEN: readonly TranscriptParagraph[] = [
    { startMillis: 2_000, speaker: 'others', text: 'What went well?' },
  ];
  const OTHER_LINES = ['Transcript', 'From Retro, 1:00 long.', '[0:02] Others: What went well?'];
  const REDONE: readonly TranscriptParagraph[] = [
    { startMillis: 1_000, speaker: '', text: 'Second pass.' },
  ];
  const REDONE_LINES = ['Transcript', 'From Planning call, 2:05 long.', '[0:01] Second pass.'];

  /** The Yjs elements at the note's top level, and their serialised form, for identity checks. */
  function topLevel(doc: Y.Doc): { nodes: unknown[]; xml: string[] } {
    const nodes = doc.getXmlFragment(FRAGMENT).toArray();
    return {
      nodes,
      xml: nodes.map((node) => (node instanceof Y.XmlElement ? node.toJSON() : '')),
    };
  }

  it('gives an empty document just the section', () => {
    const doc = noteOf([]);
    const updates = write(doc);
    expect(updates).toHaveLength(1);
    expect(linesOf(doc)).toEqual(SECTION_LINES);
  });

  it('appends after existing content', () => {
    const doc = noteOf([heading(1, 'Planning'), paragraph('Agenda below.')]);
    write(doc);
    expect(linesOf(doc)).toEqual(['Planning', 'Agenda below.', ...SECTION_LINES]);
  });

  it('replaces its own earlier section in the middle and leaves both sides untouched', () => {
    const doc = noteOf([
      paragraph('Before.'),
      ...buildTranscriptSection(SOURCE, SPOKEN),
      heading(2, 'Actions'),
      paragraph('After.'),
    ]);
    const fragment = doc.getXmlFragment(FRAGMENT);
    const before = fragment.get(0);
    const after = [fragment.get(6), fragment.get(7)];

    write(doc, REDONE);

    expect(linesOf(doc)).toEqual(['Before.', ...REDONE_LINES, 'Actions', 'After.']);
    // The same Yjs elements, not equal-looking replacements: an edit in flight on either of
    // them still has something to merge into.
    expect(fragment.get(0)).toBe(before);
    expect([fragment.get(4), fragment.get(5)]).toEqual(after);
  });

  it('keeps what somebody typed directly under a transcript, with no heading in between', () => {
    const doc = noteOf([...buildTranscriptSection(SOURCE, SPOKEN), paragraph('My take: ship it.')]);
    const fragment = doc.getXmlFragment(FRAGMENT);
    const mine = fragment.get(fragment.length - 1);

    write(doc, REDONE);

    expect(linesOf(doc)).toEqual([...REDONE_LINES, 'My take: ship it.']);
    expect(fragment.get(fragment.length - 1)).toBe(mine);
  });

  it('re-transcribing one of two recordings leaves the other section exactly as it was', () => {
    const doc = noteOf([paragraph('Two meetings.')]);
    write(doc, SPOKEN, SOURCE);
    write(doc, OTHER_SPOKEN, OTHER);
    expect(linesOf(doc)).toEqual(['Two meetings.', ...SECTION_LINES, ...OTHER_LINES]);

    // Re-transcribe the second: the first is the same elements with the same content.
    const firstBefore = topLevel(doc);
    write(doc, [{ startMillis: 0, speaker: '', text: 'Retro, again.' }], OTHER);
    const afterSecond = topLevel(doc);
    expect(afterSecond.nodes.slice(0, 6)).toEqual(firstBefore.nodes.slice(0, 6));
    expect(afterSecond.xml.slice(0, 6)).toEqual(firstBefore.xml.slice(0, 6));
    for (const [index, node] of firstBefore.nodes.slice(0, 6).entries()) {
      expect(afterSecond.nodes[index]).toBe(node);
    }
    const retroLines = ['Transcript', 'From Retro, 1:00 long.', '[0:00] Retro, again.'];
    expect(linesOf(doc)).toEqual(['Two meetings.', ...SECTION_LINES, ...retroLines]);

    // And the other way round: re-transcribe the first, the second does not move or change.
    const secondBefore = topLevel(doc);
    write(doc, REDONE, SOURCE);
    const afterFirst = topLevel(doc);
    expect(linesOf(doc)).toEqual(['Two meetings.', ...REDONE_LINES, ...retroLines]);
    expect(afterFirst.xml.slice(-3)).toEqual(secondBefore.xml.slice(-3));
    for (const [index, node] of secondBefore.nodes.slice(-3).entries()) {
      expect(afterFirst.nodes[afterFirst.nodes.length - 3 + index]).toBe(node);
    }
  });

  it('appends beside a section for another recording under the identical heading', () => {
    const doc = noteOf([]);
    write(doc, OTHER_SPOKEN, OTHER);
    write(doc);
    expect(linesOf(doc)).toEqual([...OTHER_LINES, ...SECTION_LINES]);
  });

  it('replaces a silent section, and replaces a spoken one with a silent one', () => {
    const doc = noteOf([paragraph('Before.')]);
    write(doc, []);
    expect(linesOf(doc)).toEqual([
      'Before.',
      'Transcript',
      'From Planning call, 2:05 long.',
      'No speech was detected.',
    ]);

    write(doc, REDONE);
    expect(linesOf(doc)).toEqual(['Before.', ...REDONE_LINES]);

    write(doc, []);
    expect(linesOf(doc)).toHaveLength(4);
    expect(linesOf(doc).at(-1)).toBe('No speech was detected.');
  });

  it('appends rather than replacing when a heading only contains the word', () => {
    const doc = noteOf([heading(2, 'Transcript review'), paragraph('Keep me.')]);
    write(doc);
    expect(linesOf(doc)).toEqual(['Transcript review', 'Keep me.', ...SECTION_LINES]);
  });

  it('yields updates that carry the edit to another replica and merge with its typing', () => {
    const server = noteOf([paragraph('Intro.'), paragraph('Outro.')]);
    const editor = new Y.Doc();
    Y.applyUpdate(editor, Y.encodeStateAsUpdate(server));

    // Somebody types into the first paragraph while the transcript is being written.
    const typed: Uint8Array[] = [];
    editor.on('update', (update: Uint8Array) => typed.push(update));
    const first = editor.getXmlFragment(FRAGMENT).get(0) as Y.XmlElement;
    (first.get(0) as Y.XmlText).insert(6, ' Typed meanwhile.');

    for (const update of write(server)) {
      Y.applyUpdate(editor, update);
    }
    for (const update of typed) {
      Y.applyUpdate(server, update);
    }

    const expected = ['Intro. Typed meanwhile.', 'Outro.', ...SECTION_LINES];
    expect(linesOf(editor)).toEqual(expected);
    expect(linesOf(server)).toEqual(expected);
  });

  it('splits a long transcript into ordered updates that rebuild the same section', () => {
    const many: TranscriptParagraph[] = Array.from({ length: 25 }, (_, index) => ({
      startMillis: index * 1_000,
      speaker: '',
      text: `Line ${String(index)} ${'x'.repeat(200)}`,
    }));
    const whole = noteOf([paragraph('Before.')]);
    write(whole, [{ startMillis: 0, speaker: '', text: 'Old.' }]);
    const replica = new Y.Doc();
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(whole));
    const reference = new Y.Doc();
    Y.applyUpdate(reference, Y.encodeStateAsUpdate(whole));

    // Room for about four paragraphs a batch.
    const updates = write(whole, many, SOURCE, 4_000);
    expect(updates.length).toBeGreaterThan(3);
    for (const update of updates) {
      Y.applyUpdate(replica, update);
    }
    write(reference, many);

    const lines = linesOf(replica);
    expect(lines).toEqual(linesOf(reference));
    expect(lines).toHaveLength(1 + 2 + many.length);
    expect(lines[0]).toBe('Before.');
    expect(lines.some((line) => line.endsWith('Old.'))).toBe(false);
    expect(lines[3]?.startsWith('[0:00] Line 0 ')).toBe(true);
    expect(lines.at(-1)?.startsWith('[0:24] Line 24 ')).toBe(true);
  });
});

describe('batching within a budget', () => {
  const size = (value: number): number => value;

  it('always returns one batch, even for nothing', () => {
    expect(batchWithinBudget([], size, 10)).toEqual([[]]);
  });

  it('keeps order, fills each batch to the budget, and isolates an oversized item', () => {
    expect(batchWithinBudget([4, 4, 4, 30, 1, 9, 1], size, 10)).toEqual([
      [4, 4],
      [4],
      [30],
      [1, 9],
      [1],
    ]);
  });
});
