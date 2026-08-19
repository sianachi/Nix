/**
 * `nixctl views get` / `nixctl views set`: the views a container offers over its children.
 *
 * A view is a way of looking at a container's children; `get` says which views exist, which cannot
 * currently render (their configured property is gone or no longer fits), and which one opens by
 * default. Paired with `query`, it is how a stress run opens a container "in every view it offers":
 * `views get` lists them, `query` walks each. `set` replaces the whole view set from a JSON file,
 * which is how the CLI authors the query-kind (smart list) view that `stress run --scenario
 * query-storm` needs to return rows.
 */

import { readFile } from 'node:fs/promises';
import { views, type SetViewsRequestContract } from '@nix/api-client';
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

/** Replaces a container's view set from a JSON file `{ "views": [...], "default": <id|null> }`. */
export async function setViews(
  profileName: string | undefined,
  itemId: string,
  file: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const body = parseViewsFile(await readFile(file, 'utf8'), file);

  const session = await resolveSession(profileName, deps);
  const answer = await session.client.execute(views.setContainerViews(itemId, body));

  printResult(
    {
      id: itemId,
      count: answer.views.length,
      default: answer.default,
      views: answer.views.map((view) => ({ id: view.id, name: view.name, kind: view.kind })),
    },
    output,
  );
}

/**
 * Parses and envelope-checks the views file. The per-view shape is the closed set the server owns —
 * a bad view answers 422 — so this checks only the envelope the command promises: a `views` array and
 * a `default` that is a string or null. That boundary is honest rather than a second, drifting copy
 * of the view schema.
 */
function parseViewsFile(text: string, path: string): SetViewsRequestContract {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON.`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${path} must be a JSON object with 'views' and 'default'.`);
  }
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.views)) {
    throw new Error(`${path} must have a 'views' array.`);
  }
  if (record.default !== null && typeof record.default !== 'string') {
    throw new Error(`${path} must have a 'default' that is a view id or null.`);
  }
  return parsed as SetViewsRequestContract;
}
