/**
 * `nixctl views get`: the views a container offers, and which of them can draw.
 *
 * A view is a way of looking at a container's children; this says which views exist, which cannot
 * currently render (their configured property is gone or no longer fits), and which one opens by
 * default. Paired with `query`, it is how a stress run opens a container "in every view it offers":
 * `views get` lists them, `query` walks each. The renderable/unrenderable split is surfaced so a
 * board that cannot draw is named rather than looking like a container with nothing in it.
 */

import { views } from '@nix/api-client';
import { resolveSession, type SessionDeps } from './shared.ts';
import { printResult, type OutputOptions } from '../output.ts';

/** Lists a container's views, marking which cannot render and which opens by default. */
export async function getViews(
  profileName: string | undefined,
  itemId: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  const answer = await session.client.query(views.containerViews(itemId));

  const unrenderable = new Set(answer.unrenderable);
  printResult(
    {
      views: answer.views.map((view) => ({
        id: view.id,
        name: view.name,
        kind: view.kind,
        renderable: !unrenderable.has(view.id),
      })),
      count: answer.views.length,
      default: answer.default,
    },
    output,
  );
}
