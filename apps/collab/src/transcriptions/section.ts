import { nixSchema } from '@nix/editor-schema';
import { prosemirrorJSONToYXmlFragment } from 'y-prosemirror';
import * as Y from 'yjs';

/**
 * The transcript section of a note: what it is made of, where it goes, and how it is written
 * into a live Yjs document.
 *
 * Everything here is pure or works on a `Y.Doc` held in memory - no database, no HTTP - so the
 * shape of the section and the rule for replacing it are testable on their own. The service in
 * `append.ts` owns the transaction, the fence and the refusals.
 */

export type TranscriptSpeaker = '' | 'me' | 'others';

export interface TranscriptParagraph {
  readonly startMillis: number;
  readonly speaker: TranscriptSpeaker;
  readonly text: string;
}

/** The recording a transcript came from, as the section names and links it. */
export interface TranscriptSource {
  readonly workspaceId: string;
  readonly audioItemId: string;
  readonly audioTitle: string;
  readonly durationMillis: number;
}

/** A ProseMirror node in its JSON form, as far as this module builds one. */
export interface ProseNodeJson {
  readonly type: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
  readonly content?: readonly ProseNodeJson[];
  readonly marks?: readonly { readonly type: string; readonly attrs?: Record<string, unknown> }[];
  readonly text?: string;
}

/**
 * The heading every transcript section opens with.
 *
 * **The heading is not the identity; the recording is.** A note can hold the transcripts of
 * several recordings, each under a heading reading the same thing, so the heading only says
 * "a transcript starts here". Which recording's it is comes from the line under it - see
 * {@link placeTranscriptSection}. The heading's text is compared after trimming, so stray
 * whitespace around it does not orphan a section.
 */
export const TRANSCRIPT_HEADING = 'Transcript';
const TRANSCRIPT_HEADING_LEVEL = 2;

/** The sentence that stands in for the paragraphs of a recording nobody spoke in. */
const NO_SPEECH = 'No speech was detected.';

const SPEAKER_LABELS: Readonly<Record<Exclude<TranscriptSpeaker, ''>, string>> = {
  me: 'Me:',
  others: 'Others:',
};

/** `m:ss` under an hour, `h:mm:ss` from there: the clock a player shows, to whole seconds. */
export function formatClock(millis: number): string {
  const totalSeconds = Math.floor(millis / 1000);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  return hours > 0
    ? `${String(hours)}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${String(minutes)}:${seconds}`;
}

/**
 * The nodes every section opens with: the heading, the line naming the recording, and - for a
 * recording nobody spoke in - the sentence that says so, because a heading over nothing reads as
 * a transcription that failed.
 */
export function sectionOpening(source: TranscriptSource, silent: boolean): ProseNodeJson[] {
  const opening: ProseNodeJson[] = [
    {
      type: 'heading',
      attrs: { level: TRANSCRIPT_HEADING_LEVEL },
      content: [{ type: 'text', text: TRANSCRIPT_HEADING }],
    },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'From ' },
        {
          type: 'reference',
          attrs: { kind: 'item', targetId: source.audioItemId, label: source.audioTitle },
        },
        { type: 'text', text: `, ${formatClock(source.durationMillis)} long.` },
      ],
    },
  ];
  if (silent) {
    opening.push({
      type: 'paragraph',
      content: [{ type: 'text', text: NO_SPEECH }],
    });
  }
  return opening;
}

/**
 * One transcript paragraph: a timestamp that seeks the recording, who spoke, what was said.
 *
 * The timestamp is an ordinary link mark on purpose. The web app intercepts in-app addresses of
 * this shape and seeks the audio instead of navigating, and anything that does not know to do
 * that - an export, another client - still has a link that opens the recording.
 */
export function transcriptParagraph(
  source: TranscriptSource,
  paragraph: TranscriptParagraph,
): ProseNodeJson {
  const seconds = Math.floor(paragraph.startMillis / 1000);
  const href = `/w/${source.workspaceId}?item=${source.audioItemId}&t=${String(seconds)}`;
  const content: ProseNodeJson[] = [
    {
      type: 'text',
      text: `[${formatClock(paragraph.startMillis)}]`,
      marks: [{ type: 'link', attrs: { href } }],
    },
    { type: 'text', text: ' ' },
  ];
  if (paragraph.speaker !== '') {
    content.push(
      { type: 'text', text: SPEAKER_LABELS[paragraph.speaker], marks: [{ type: 'bold' }] },
      { type: 'text', text: ' ' },
    );
  }
  content.push({ type: 'text', text: paragraph.text });
  return { type: 'paragraph', content };
}

/** The whole section, in document order. */
export function buildTranscriptSection(
  source: TranscriptSource,
  paragraphs: readonly TranscriptParagraph[],
): ProseNodeJson[] {
  return [
    ...sectionOpening(source, paragraphs.length === 0),
    ...paragraphs.map((paragraph) => transcriptParagraph(source, paragraph)),
  ];
}

/** One top-level node of a note, reduced to what placement needs to know about it. */
export interface TopLevelBlock {
  readonly type: string;

  /** A heading's level; null for every other node, and for a heading whose level is unreadable. */
  readonly level: number | null;

  /** The block's own text, marks ignored and inline atoms skipped. */
  readonly text: string;

  /** The items the block's `reference` nodes point at, in order. */
  readonly referenceTargets: readonly string[];

  /**
   * The address of the link mark on the block's first inline child, when that child is text and
   * carries one; null otherwise. A transcript paragraph opens with its timestamp link, and that
   * is the only thing about a paragraph placement goes by.
   */
  readonly leadingLinkHref: string | null;
}

/** A range of top-level nodes: where the section goes, and how many nodes it replaces there. */
export interface SectionPlacement {
  readonly index: number;
  readonly deleteCount: number;
}

/**
 * Where the transcript section for one recording goes.
 *
 * **A section is recognised by its recording, never by its position or its heading alone.** One
 * exists when a top-level level-2 `Transcript` heading is immediately followed by a paragraph
 * holding a reference to this audio item - the "From <recording>" line. The section is then:
 *
 * - that heading and that line;
 * - the `No speech was detected.` paragraph, when it comes directly after the line;
 * - every following consecutive paragraph that opens with a timestamp link addressing this
 *   audio item.
 *
 * It ends at the first block that is anything else, and that range is what a re-transcription
 * replaces. With no such section the new one is appended at the end of the note.
 *
 * **Everything that is not provably this recording's transcript is left alone.** A note can hold
 * several recordings, and their sections read identically from the heading down to the name on
 * the From line; matching by heading would have recording B's transcription delete recording
 * A's. And a section that ran to the next heading would take with it whatever somebody typed
 * under the transcript - which is where people write their notes on a meeting. Ending at the
 * first block this service did not write errs the other way on purpose: a transcript paragraph
 * whose timestamp somebody deleted is kept as theirs, which costs a stale line rather than a
 * lost one.
 *
 * Should the same recording somehow have two sections, the last is the one replaced - sections
 * are appended, so the last is the most recent - and the earlier one is left as it is.
 */
export function placeTranscriptSection(
  blocks: readonly TopLevelBlock[],
  audioItemId: string,
): SectionPlacement {
  const audio = audioItemId.toLowerCase();

  let start = -1;
  for (const [index, block] of blocks.entries()) {
    const line = blocks[index + 1];
    if (
      block.type === 'heading' &&
      block.level === TRANSCRIPT_HEADING_LEVEL &&
      block.text.trim() === TRANSCRIPT_HEADING &&
      line?.type === 'paragraph' &&
      line.referenceTargets.some((target) => target.toLowerCase() === audio)
    ) {
      start = index;
    }
  }
  if (start === -1) {
    return { index: blocks.length, deleteCount: 0 };
  }

  // Past the heading and the From line.
  let end = start + 2;
  if (isNoSpeechParagraph(blocks[end])) {
    end += 1;
  }
  while (isTranscriptParagraphOf(blocks[end], audio)) {
    end += 1;
  }
  return { index: start, deleteCount: end - start };
}

function isNoSpeechParagraph(block: TopLevelBlock | undefined): boolean {
  return (
    block?.type === 'paragraph' &&
    block.text === NO_SPEECH &&
    block.referenceTargets.length === 0 &&
    block.leadingLinkHref === null
  );
}

function isTranscriptParagraphOf(block: TopLevelBlock | undefined, audio: string): boolean {
  if (block?.type !== 'paragraph' || block.leadingLinkHref === null) {
    return false;
  }
  return timestampTarget(block.leadingLinkHref) === audio;
}

/**
 * The audio item a timestamp address seeks, lower-cased; null when the address is not one.
 *
 * Read the way the web app reads it - an in-app `/w/<workspace>` address with an `item` and a `t`
 * - rather than compared against the string this service would write, so a section survives
 * being moved to another workspace and anything else that changes the path but not the meaning.
 */
function timestampTarget(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href, 'https://nix.invalid');
  } catch {
    return null;
  }
  const item = url.searchParams.get('item');
  if (
    url.origin !== 'https://nix.invalid' ||
    !url.pathname.startsWith('/w/') ||
    item === null ||
    !url.searchParams.has('t')
  ) {
    return null;
  }
  return item.toLowerCase();
}

/**
 * Reads a note's top level straight off its Yjs fragment.
 *
 * Deliberately not through ProseMirror: converting a fragment to a ProseMirror document drops
 * nodes the schema does not know *from the Yjs document itself* (see `explainProse` in
 * `documents/body-kinds.ts`), and a read that can delete is not one to run on a document that is
 * about to be written back.
 */
export function outlineOf(fragment: Y.XmlFragment): TopLevelBlock[] {
  return fragment.toArray().map((child): TopLevelBlock => {
    if (!(child instanceof Y.XmlElement)) {
      return { type: 'text', level: null, text: '', referenceTargets: [], leadingLinkHref: null };
    }

    const level: unknown = child.nodeName === 'heading' ? child.getAttribute('level') : null;
    const inline = child.toArray();
    let text = '';
    const referenceTargets: string[] = [];
    for (const node of inline) {
      if (node instanceof Y.XmlText) {
        for (const run of node.toDelta() as TextRun[]) {
          if (typeof run.insert === 'string') {
            text += run.insert;
          }
        }
      } else if (node instanceof Y.XmlElement && node.nodeName === 'reference') {
        const target: unknown = node.getAttribute('targetId');
        if (typeof target === 'string') {
          referenceTargets.push(target);
        }
      }
    }

    return {
      type: child.nodeName,
      level: typeof level === 'number' ? level : null,
      text,
      referenceTargets,
      leadingLinkHref: leadingLinkHref(inline[0]),
    };
  });
}

/** One run of a Yjs text's delta: what was inserted, and the marks on it keyed by mark name. */
interface TextRun {
  readonly insert?: unknown;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

/** The link address on the very first run of a block's first inline child, if it is linked text. */
function leadingLinkHref(first: unknown): string | null {
  if (!(first instanceof Y.XmlText)) {
    return null;
  }
  const run = (first.toDelta() as TextRun[])[0];
  if (run === undefined || typeof run.insert !== 'string') {
    return null;
  }
  for (const [name, attrs] of Object.entries(run.attributes ?? {})) {
    // y-prosemirror keys a mark by its name, or by `name--hash` for a mark type that may overlap
    // itself. Link does not today; reading both spellings keeps this true if that ever changes.
    if (name !== 'link' && !name.startsWith('link--')) {
      continue;
    }
    const href: unknown =
      typeof attrs === 'object' && attrs !== null ? (attrs as { href?: unknown }).href : null;
    if (typeof href === 'string') {
      return href;
    }
  }
  return null;
}

/**
 * Turns ProseMirror nodes into Yjs elements that are not yet part of any document.
 *
 * Built by y-prosemirror in a scratch document and cloned out, rather than assembled by hand,
 * so the encoding of marks and attributes is exactly the one every editor's binding reads and
 * writes. A hand-built element that differed from it in some detail would merge cleanly and
 * render wrongly, which is the worst way for that to fail.
 *
 * Throws when the nodes are not valid against the schema - the same check the parse applies.
 */
export function toYElements(nodes: readonly ProseNodeJson[]): (Y.XmlElement | Y.XmlText)[] {
  if (nodes.length === 0) {
    return [];
  }
  const scratch = new Y.Doc();
  try {
    const fragment = scratch.getXmlFragment('scratch');
    prosemirrorJSONToYXmlFragment(nixSchema, { type: 'doc', content: nodes }, fragment);
    return fragment.toArray().map((child) => {
      if (child instanceof Y.XmlElement || child instanceof Y.XmlText) {
        return child.clone();
      }
      throw new Error('A transcript section may only hold elements and text.');
    });
  } finally {
    scratch.destroy();
  }
}

/**
 * Groups items into consecutive batches whose summed cost stays within a budget.
 *
 * Always returns at least one batch, possibly empty, because the section's opening is written
 * with the first batch whether or not there are paragraphs to go with it. An item that alone
 * exceeds the budget gets a batch to itself; whether that is acceptable is for whoever applies
 * it to decide.
 */
export function batchWithinBudget<T>(
  items: readonly T[],
  costOf: (item: T) => number,
  budget: number,
): T[][] {
  const batches: T[][] = [[]];
  let spent = 0;
  for (const item of items) {
    const cost = costOf(item);
    const current = batches[batches.length - 1];
    if (current !== undefined && (current.length === 0 || spent + cost <= budget)) {
      current.push(item);
      spent += cost;
    } else {
      batches.push([item]);
      spent = cost;
    }
  }
  return batches;
}

/**
 * What one paragraph costs in an encoded update, near enough to plan with.
 *
 * Its text as UTF-8, plus a flat allowance for everything else: the link mark's attributes
 * (the address alone carries two identifiers), the speaker label, and Yjs's own bookkeeping.
 * Generous on purpose - the plan only has to stay under the update ceiling, not fill it.
 */
const PARAGRAPH_OVERHEAD_BYTES = 768;

export function paragraphCost(paragraph: TranscriptParagraph): number {
  return Buffer.byteLength(paragraph.text, 'utf8') + PARAGRAPH_OVERHEAD_BYTES;
}

/**
 * Writes the section into a live document, yielding one Yjs update per step.
 *
 * **The edit is surgical.** It deletes exactly the range {@link placeTranscriptSection} names -
 * this recording's own earlier section, if the note has one -
 * and inserts the new elements at that index, on the fragment itself. Rewriting the fragment
 * from a ProseMirror document would be simpler and would also turn every paragraph somebody is
 * typing in into a delete-and-reinsert, which is how a concurrent edit gets lost.
 *
 * **Several updates when one would not fit.** A long meeting's transcript can exceed the ceiling
 * on a single update, so the paragraphs go in batches: the first step removes the old section
 * and writes the opening with the first batch, and each later step inserts directly after the
 * one before. The caller applies them in order inside one database transaction, so a reader
 * never sees half a transcript.
 *
 * A generator, so the caller stores each update before the next is built and can stop at the
 * first refusal. Each yielded update is that step's own operations, taken from the document's
 * update event rather than as a diff against a state vector: the diff form re-sends the
 * document's entire delete set every time, and here it would be sent once per batch.
 */
export function* writeTranscriptSection(
  live: Y.Doc,
  fragmentName: string,
  source: TranscriptSource,
  paragraphs: readonly TranscriptParagraph[],
  batchBytes: number,
): Generator<Uint8Array, void, void> {
  const fragment = live.getXmlFragment(fragmentName);
  const placement = placeTranscriptSection(outlineOf(fragment), source.audioItemId);
  const batches = batchWithinBudget(paragraphs, paragraphCost, batchBytes);

  let insertAt = placement.index;
  for (const [step, batch] of batches.entries()) {
    const nodes = [
      ...(step === 0 ? sectionOpening(source, paragraphs.length === 0) : []),
      ...batch.map((paragraph) => transcriptParagraph(source, paragraph)),
    ];
    const elements = toYElements(nodes);

    const produced: Uint8Array[] = [];
    const capture = (update: Uint8Array): void => {
      produced.push(update);
    };
    live.on('update', capture);
    try {
      // One transaction per step: the old section going out and the new opening coming in are
      // never observable apart, here or wherever this update is replayed.
      Y.transact(live, () => {
        if (step === 0 && placement.deleteCount > 0) {
          fragment.delete(placement.index, placement.deleteCount);
        }
        fragment.insert(insertAt, elements);
      });
    } finally {
      live.off('update', capture);
    }
    insertAt += elements.length;

    yield produced.length === 1 && produced[0] !== undefined
      ? produced[0]
      : Y.mergeUpdates(produced);
  }
}
