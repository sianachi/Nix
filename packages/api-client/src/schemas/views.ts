/**
 * A container's views, as `GET /items/{id}/views` returns them — the summary a caller needs to
 * decide what to open.
 *
 * **A summary on purpose, not the whole `ViewResponse`.** A view's full configuration — its columns,
 * grouping, filters, form — is what `query` runs, not what a caller listing a container's views
 * reads; so this parses each view down to its identity (id, name, kind) and the two container-level
 * facts (which views cannot currently render, and which one opens by default). The `satisfies` ties
 * below are to a `Pick` of the generated contract, so a rename of any field we *do* read fails this
 * package's build, while the fields we deliberately drop cost nothing to carry.
 */

import { z } from 'zod';
import type { components } from '../generated/api.js';

export const viewSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
});

export type ViewSummary = z.infer<typeof viewSummarySchema>;

export const containerViewsSchema = z.object({
  views: z.array(viewSummarySchema),

  /** Views whose configured property is gone or no longer fits, so they cannot draw. */
  unrenderable: z.array(z.string()),

  /** What opens: a view id, or `document` for the item's own body. */
  default: z.string(),
});

export type ContainerViews = z.infer<typeof containerViewsSchema>;

type ViewSummaryContract = Pick<components['schemas']['ViewResponse'], 'id' | 'name' | 'kind'>;
const _viewContract = viewSummarySchema satisfies z.ZodType<ViewSummaryContract>;
void _viewContract;

type ContainerViewsSummaryContract = Pick<
  components['schemas']['ContainerViewsResponse'],
  'unrenderable' | 'default'
> & { views: ViewSummaryContract[] };
const _containerContract = containerViewsSchema satisfies z.ZodType<ContainerViewsSummaryContract>;
void _containerContract;
