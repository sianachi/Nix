import { templates } from '@nix/api-client';
import type { CompanionPorts } from '../ports.js';

export interface TemplateSummaryView {
  id: string;
  title: string;
  description: string | null;
  origin: string;
  fieldCount: number;
  viewKinds: string[];
  childCount: number;
}

export interface ListTemplatesResult {
  templates: TemplateSummaryView[];
  truncated: boolean;
}

/** Case-insensitive filter over title and description, capped at 50 summaries. */
export async function listTemplates(
  ports: CompanionPorts,
  workspaceId: string,
  query: string,
  signal: AbortSignal,
): Promise<ListTemplatesResult> {
  const catalog = await ports.core.query(templates.listTemplates(workspaceId), {
    signal,
    forceRefresh: true,
  });
  const needle = query.trim().toLowerCase();
  const matches = needle
    ? catalog.templates.filter(
        (template) =>
          template.title.toLowerCase().includes(needle) ||
          (template.description ?? '').toLowerCase().includes(needle),
      )
    : catalog.templates;
  return {
    templates: matches.slice(0, 50).map((template) => ({
      id: template.id,
      title: template.title,
      description: template.description,
      origin: template.origin,
      fieldCount: template.fieldCount,
      viewKinds: template.viewKinds,
      childCount: template.childCount,
    })),
    truncated: matches.length > 50,
  };
}
