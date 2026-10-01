/**
 * The suggestion resource: the only place the related-items and mention URLs appear.
 *
 * Model-free signals for the editor. `listRelatedItems` is an item's co-citations; `findMentions`
 * is the readable items whose titles a passage names. `findMentions` is a POST only because the
 * passage is too long for a URL — it reads and changes nothing, so it invalidates nothing — and it
 * has its own per-address rate limit (`suggestions`), separate from writes, so send it when typing
 * pauses, not per keystroke, and wait out a 429's `Retry-After` before the next lookup.
 */

import {
  defineCommand,
  defineQuery,
  type CommandEndpoint,
  type QueryEndpoint,
} from '../endpoints.js';
import {
  mentionsSchema,
  relatedItemsSchema,
  type Mentions,
  type RelatedItems,
} from '../schemas/index.js';

/** The most characters `findMentions` accepts; longer text is refused with `search.mention_text_too_long`. */
export const MAXIMUM_MENTION_TEXT_LENGTH = 4000;

/**
 * The most identifiers `findMentions` excludes; more are refused with
 * `search.too_many_mention_exclusions`. The note being edited plus what it already links to.
 */
export const MAXIMUM_MENTION_EXCLUSIONS = 256;

/** What a mention lookup matches against. */
export interface MentionLookup {
  /** The passage, at most {@link MAXIMUM_MENTION_TEXT_LENGTH} characters. */
  readonly text: string;
  /** The workspace whose titles are matched; Core intersects it with what the caller may read. */
  readonly workspaceId: string;
  /** Items never to suggest: the note itself and the items it already links to. */
  readonly excludeIds?: readonly string[];
}

/**
 * The items most often linked from the same documents as `itemId`. `limit` defaults to 10 and is
 * capped at 25 by Core. An item the caller may not read fails with `items.not_found`.
 */
export const listRelatedItems = (itemId: string, limit?: number): QueryEndpoint<RelatedItems> =>
  defineQuery<RelatedItems>({
    operation: 'items.related',
    path: `/api/v1/items/${itemId}/related`,
    query: { limit },
    schema: relatedItemsSchema,
    cacheKey: ['items', itemId, 'related', ...(limit === undefined ? [] : [String(limit)])],
  });

/**
 * The readable items in `workspaceId` whose title appears in `text` as a whole-word phrase,
 * ignoring case, longest phrase first, at most 20 and at most three per phrase. Items named in
 * `excludeIds` are never returned, so the server spends no result slot on the note itself or on a
 * target it already links to.
 */
export const findMentions = (lookup: MentionLookup): CommandEndpoint<Mentions> =>
  defineCommand<Mentions>({
    operation: 'search.mentions',
    method: 'POST',
    path: '/api/v1/search/mentions',
    body: {
      text: lookup.text,
      workspaceId: lookup.workspaceId,
      excludeIds: lookup.excludeIds ?? [],
    },
    schema: mentionsSchema,
    invalidates: [],
  });
