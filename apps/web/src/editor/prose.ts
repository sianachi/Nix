import { CALLOUT_TONES, type CalloutTone } from '@nix/editor-schema';

/**
 * The document's typography, as class strings.
 *
 * **Why this file exists.** Tailwind's preflight resets the browser's default typography to
 * nothing: no heading sizes, no list markers, no quote indent, no table borders. A rich document
 * rendered under it is a column of identical plain text, and the editor looks broken when in fact
 * only its clothes are missing. These strings are the clothes.
 *
 * **Why class strings and not a stylesheet.** The repository allows exactly two `.css` files - the
 * Tailwind entry and the design-token sheet - so there is nowhere to put a `.prose h1 { ... }` rule
 * and no wish for one. The upside is that the styles are ordinary source: greppable, diffable, and
 * checked by a test rather than by eye.
 *
 * **Why here and not in `@nix/editor-schema`.** The collaboration service builds the same
 * extension list in Node to check that an accepted update still parses. It renders nothing, and a
 * presentation concern in that package would be a concern it has to carry into a process that has
 * no DOM. The schema says what a document may contain; this file says what it looks like.
 *
 * **How they reach the document.** ProseMirror renders the document, so React never sees a heading
 * to put a `className` on. `note-editor.tsx` instead hands each string to its extension as
 * `HTMLAttributes.class`, which TipTap merges into that node's rendered element - see the mapping
 * there.
 *
 * **No arbitrary values, anywhere.** Every size is a step on the token sheet's type or spacing
 * scale and every colour is a role or a ramp step. One hard-coded length here is how a type scale
 * quietly stops being one, so `prose.test.ts` sweeps this file for them rather than trusting
 * review to notice.
 */

/**
 * The gap above a block, cancelled for the first block in any container.
 *
 * `first:mt-0` is what keeps the top of a note, a list item and a table cell flush with its
 * container instead of opening with a blank band.
 */
const BLOCK_GAP = 'mt-4 first:mt-0';

/**
 * The editable element itself: the measure, the ground, and the pieces of the document that
 * ProseMirror draws rather than the schema.
 *
 * The decoration classes below are ProseMirror's and prosemirror-tables', invented by those
 * libraries and normally styled by stylesheets those packages ship. We import neither stylesheet,
 * so the selection, the gap cursor and the column resize handle would otherwise be invisible -
 * present in the DOM, doing nothing a reader can see. They are reached with descendant variants
 * because there is no extension whose `HTMLAttributes` they pass through.
 */
export const proseRoot = [
  // A measure. Text that runs the full width of a wide pane is measurably harder to read; 65ch is
  // Tailwind's prose measure and lands near the classic 45-75 character band.
  'max-w-prose font-body text-md text-foreground',

  // The caret and the text selection. The selection fill is a fixed ramp step rather than a role
  // because a highlight is a physical light wash: dark ink on a pale accent reads on either
  // ground, whereas a role-coloured selection would invert with the theme and stop looking like a
  // selection at all.
  'caret-foreground selection:bg-accent-200 selection:text-neutral-900',

  // A selected block - an image, a rule - carries the same accent ring as a focused control.
  '[&_.ProseMirror-selectednode]:outline-2 [&_.ProseMirror-selectednode]:outline-offset-2 [&_.ProseMirror-selectednode]:outline-accent',

  // The gap cursor: the caret shown between two blocks that cannot hold text. Drawn as a hairline
  // on the element itself, since a pseudo-element would need a stylesheet.
  '[&_.ProseMirror-gapcursor]:block [&_.ProseMirror-gapcursor]:border-t [&_.ProseMirror-gapcursor]:border-foreground',

  // Table column resizing. The handle is a bare widget with no dimensions of its own; without
  // these it is a zero-size div and the column edge is undraggable in practice.
  '[&.resize-cursor]:cursor-col-resize',
  '[&_.column-resize-handle]:pointer-events-none [&_.column-resize-handle]:absolute [&_.column-resize-handle]:top-0 [&_.column-resize-handle]:bottom-0 [&_.column-resize-handle]:-right-px [&_.column-resize-handle]:w-0.5 [&_.column-resize-handle]:bg-accent',

  // A cell selection, tinted rather than filled so the text inside stays legible on either ground.
  '[&_.selectedCell]:bg-accent/25',

  // The text palette, selected on the attribute the mark writes. Descendant variants rather
  // than one class per colour because the mark's own class string cannot vary by attribute -
  // the same constraint that gives `heading` and `callout` their functions, solved the other
  // way because a colour is one declaration and a heading is six.
  //
  // Three names, because three is what a mono token sheet can render distinguishably. The set
  // was briefly six - with `success`, `warning` and `danger` - and three of those rendered
  // identically, which would have been a picker offering choices the product never honoured,
  // stored permanently in documents. `marks.ts` holds the reasoning; widening the set is an
  // ADR adding a semantic ramp to the tokens, not a class string here.
  '[&_[data-text-color="accent"]]:text-accent-text',
  '[&_[data-text-color="muted"]]:text-muted',
  '[&_[data-background-color="accent"]]:bg-accent-100',
  '[&_[data-background-color="muted"]]:bg-surface',

  // A toggle presenting as a heading matches the real heading of that rank, so a document does
  // not have two visual hierarchies. Size only - the weight and spacing come from the summary
  // rule above, which already applies.
  '[&_[data-toggle-level="1"]_summary]:font-heading [&_[data-toggle-level="1"]_summary]:text-2xl',
  '[&_[data-toggle-level="2"]_summary]:font-heading [&_[data-toggle-level="2"]_summary]:text-xl',
  '[&_[data-toggle-level="3"]_summary]:font-heading [&_[data-toggle-level="3"]_summary]:text-lg',

  // A column takes an equal share unless it states a width, which arrives as an inline
  // flex-grow from `note-editor.tsx` - a fraction cannot be a class. `min-w-0` is what lets a
  // long word or a wide table inside a column shrink rather than force the row wider.
  '[&_[data-column]]:min-w-0 [&_[data-column]]:flex-1 [&_[data-column]]:basis-0',
].join(' ');

/**
 * One class string per schema node and mark, keyed by the name TipTap knows it as.
 *
 * `heading` and `callout` are absent on purpose: their appearance depends on an attribute (the
 * level, the tone), which a single string cannot express. They have functions below.
 */
export const proseClasses: Readonly<Record<string, string>> = {
  paragraph: BLOCK_GAP,

  // Lists. `list-outside` puts the marker in the gutter so wrapped lines align with the first
  // line rather than with the bullet, and the padding is what gives the marker that gutter.
  bulletList: `${BLOCK_GAP} list-disc list-outside pl-6 marker:text-muted`,
  orderedList: `${BLOCK_GAP} list-decimal list-outside pl-6 marker:text-muted`,

  // A nested list belongs to the item above it, so it sits closer than two separate paragraphs
  // would. The parent item states that, because the nested list cannot know it is nested.
  listItem: 'mt-2 first:mt-0 [&>ul]:mt-2 [&>ol]:mt-2',

  // Task lists carry a checkbox instead of a marker. TipTap renders each item as
  // `li > label > input` plus a sibling `div` holding the content, and the checkbox has to sit on
  // the first line of that content rather than float above it - hence `items-start` with a nudge
  // down, rather than `items-center`, which would drift lower on every wrapped line.
  taskList: `${BLOCK_GAP} list-none pl-0`,
  taskItem: [
    'mt-2 first:mt-0 flex items-start gap-2',
    '[&>label]:mt-1 [&>label]:flex [&>label]:shrink-0 [&>label]:items-center',
    '[&>label>input]:size-4 [&>label>input]:accent-accent-500',
    '[&>div]:min-w-0 [&>div]:flex-1',
  ].join(' '),

  // A quote is set apart by a rule and an indent, not by italics: quoted material often contains
  // its own emphasis, and italicising the block would leave that emphasis nowhere to go.
  blockquote: `${BLOCK_GAP} border-l-2 border-l-divider pl-4 text-muted`,

  // Code is set one step below body copy - a monospace face runs visually larger at the same size
  // - and scrolls rather than wraps, because a wrapped line of code is a misread line of code.
  codeBlock: `${BLOCK_GAP} overflow-x-auto border border-divider bg-surface px-4 py-3 font-mono text-base text-foreground`,

  horizontalRule: 'my-8 border-t border-divider',

  image: `${BLOCK_GAP} block h-auto max-w-full border border-divider`,

  // Tables. `table-fixed` is what makes the column widths prosemirror-tables writes into the
  // colgroup take effect; without it the browser re-measures from content and dragging a column
  // edge appears to do nothing. Borders live on the cells and rows and collapse into the table's
  // own frame, so the grid is drawn once rather than doubled at every seam.
  table: `${BLOCK_GAP} w-full table-fixed border-collapse border border-divider text-base`,
  tableRow: 'border-b border-divider',
  tableHeader: 'border-r border-divider bg-surface px-3 py-2 text-left align-top font-semibold',
  tableCell: 'border-r border-divider px-3 py-2 align-top',

  // A row of columns - below the medium breakpoint, a stack.
  //
  // Not a nicety. Four columns is the ceiling the schema documents, and on a 375px screen less
  // the editor's own padding and the gaps, that is about sixty pixels of measure per column:
  // roughly six characters a line. Every other block in this file degrades to narrow but
  // readable; without this one, side-by-side content is the first thing that becomes
  // structurally unreadable, in stored prose somebody cannot un-author.
  columnBlock: `${BLOCK_GAP} flex flex-col gap-4 md:flex-row md:gap-6`,

  // A collapsible section. The content is hidden by the absence of `is-open` rather than by a
  // stored attribute - the open state is per-session on purpose, see `toggle.ts` - so the rule
  // is written against the class the extension toggles.
  // A collapsible section.
  //
  // The summary is a bare `<summary>` - the extension gives it no node view and no `data-type`
  // - so it is reached by tag. The content is hidden by `DetailsContent`'s own node view,
  // which sets the `hidden` attribute that Tailwind's preflight already turns into
  // `display: none`; there is nothing for this file to do about folding, and an earlier
  // attempt to select on `.is-open` here matched at the wrong depth and did nothing at all.
  //
  // `list-none` because a `<summary>` still gets `display: list-item` from the user-agent
  // stylesheet, which would draw the browser's own disclosure triangle beside ours.
  details: [
    BLOCK_GAP,
    'border-l-2 border-l-divider pl-4',
    '[&_summary]:list-none [&_summary]:font-medium',
    // The disclosure button, drawn by `renderToggleButton` in `note-editor.tsx` as a Lucide
    // chevron. Focus is not left to the browser: a control inside a contenteditable region is
    // exactly where a default outline is least likely to be visible.
    '[&>button]:mr-2 [&>button]:align-middle [&>button]:text-muted [&>button]:transition-transform',
    '[&>button]:hover:text-foreground',
    '[&>button]:focus-visible:outline-2 [&>button]:focus-visible:-outline-offset-2 [&>button]:focus-visible:outline-accent',
    '[&.is-open>button]:rotate-90',
  ].join(' '),

  // A reference resolves to a title at render; until it does, the stored label stands in. Set
  // as accent text rather than a link, because it points inside the workspace rather than out.
  reference: 'text-accent-text underline decoration-dotted underline-offset-2',

  // The two blocks computed from the document's own shape. Both are drawn by a node view that
  // walks the live document, so what is styled here is the frame it sits in.
  tableOfContents: `${BLOCK_GAP} border-l-2 border-l-divider py-1 pl-4 text-base text-muted`,
  breadcrumb: `${BLOCK_GAP} text-base text-muted`,

  // Marks. Bold is 600 rather than 700: those are the weights the app actually loads, and asking
  // for one it does not have gets a synthesised smear instead of a face.
  bold: 'font-semibold',
  italic: 'italic',
  underline: 'underline underline-offset-2',
  strike: 'line-through',
  code: 'border border-divider bg-surface px-1 py-0.5 font-mono text-base',

  // Highlight is a fixed pale wash with dark ink on top, for the same reason the text selection
  // is: it stands for a marker pen, and a marker pen does not invert.
  highlight: 'bg-accent-200 text-neutral-900',

  // Body-size accent text uses the accent-text role, which the token sheet points at a step dark
  // enough to read on paper and light enough to read on ink.
  link: 'text-accent-text underline decoration-1 underline-offset-2 hover:text-accent-hover',

  // Colour is carried by a `data-` attribute, not by this string, so the base entry only has
  // to make the span exist as a box. The palette itself is in `proseRoot` above, where a
  // descendant variant can select on the attribute.
  // A background wash needs a little air or it butts flush against the neighbouring glyphs,
  // and `box-decoration-clone` is what keeps the corners rounded on every line of a span that
  // wraps rather than only on the first and last.
  textColor: 'rounded-sm px-0.5 box-decoration-clone',

  // A commented range is marked the way a reader would mark one: underneath, not on top, so
  // the words stay the words. The thread it belongs to is on the element as an attribute.
  comment: 'border-b-2 border-b-accent-400 bg-accent/10 hover:bg-accent/20 cursor-pointer',
};

/**
 * The three heading levels, each visibly a different rank.
 *
 * Size does the work - 28, 22 and 17 against 15px body copy - so the hierarchy survives a
 * screenshot, a print, and a reader who cannot distinguish the weights. The first level also
 * carries a hairline, which is the Industry grammar for the top of a section.
 */
const HEADING_CLASSES: Readonly<Record<1 | 2 | 3, string>> = {
  1: 'mt-8 first:mt-0 border-b border-divider pb-2 font-heading text-2xl font-semibold text-foreground',
  2: 'mt-6 first:mt-0 font-heading text-xl font-semibold text-foreground',
  3: 'mt-6 first:mt-0 font-heading text-lg font-semibold text-foreground',
};

/**
 * The class for a heading of `level`.
 *
 * A level the schema does not define renders as a first-level heading, matching what TipTap's own
 * renderer does with an out-of-range level: a document from a newer build shows its structure at
 * the wrong rank rather than losing it.
 */
export function headingClass(level: number): string {
  return level === 2 || level === 3 ? HEADING_CLASSES[level] : HEADING_CLASSES[1];
}

/**
 * The four callout tones.
 *
 * The Industry token sheet is deliberately mono - one steel accent, no red and no amber - so tone
 * cannot be carried by hue here without inventing a colour the sheet does not have. It is carried
 * by weight instead: a quiet hairline for a note, the accent for a tip, a thicker accent rule for
 * a warning, and full-strength ink for a danger. The `data-tone` attribute stays on the element
 * either way, so a palette that grows a semantic ramp later changes these strings and nothing
 * else.
 */
const CALLOUT_BASE = `${BLOCK_GAP} bg-surface px-4 py-3`;

const CALLOUT_CLASSES: Readonly<Record<CalloutTone, string>> = {
  note: `${CALLOUT_BASE} border-l-2 border-l-divider`,
  tip: `${CALLOUT_BASE} border-l-2 border-l-accent-500`,
  warning: `${CALLOUT_BASE} border-l-4 border-l-accent-text`,
  danger: `${CALLOUT_BASE} border-l-4 border-l-foreground font-medium`,
};

/**
 * The class for a callout of `tone`.
 *
 * Unknown tones fall back to `note`, matching the schema's own reading of the attribute: a callout
 * from a newer build is readable in the wrong tone and unreadable in no tone at all.
 */
export function calloutClass(tone: string): string {
  return isTone(tone) ? CALLOUT_CLASSES[tone] : CALLOUT_CLASSES.note;
}

function isTone(value: string): value is CalloutTone {
  return (CALLOUT_TONES as readonly string[]).includes(value);
}
