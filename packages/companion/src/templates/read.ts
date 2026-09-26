import { templates, type TemplateItem } from '@nix/api-client';
import type { CompanionPorts } from '../ports.js';
import { WorkspaceToolRefusal } from '../tool-args.js';

export interface TemplateInputSummary {
  key: string;
  label: string;
  type: string;
  required: boolean;
}

export interface TemplateOutlineNode {
  title: string;
  fields: { key: string; type: string }[];
  viewKinds: string[];
  children: TemplateOutlineNode[];
}

export interface ReadTemplateResult {
  id: string;
  title: string;
  description: string | null;
  inputs: TemplateInputSummary[];
  tree: TemplateOutlineNode[];
  truncated: boolean;
}

const MAX_DEPTH = 4;
const MAX_NODES = 60;

/** No bodies, no property values: only the shape a pet needs to recognise a fit. */
export async function readTemplate(
  ports: CompanionPorts,
  workspaceId: string,
  templateId: string,
  signal: AbortSignal,
): Promise<ReadTemplateResult> {
  const requestOptions = { signal, forceRefresh: true };
  const catalog = await ports.core.query(templates.listTemplates(workspaceId), requestOptions);
  if (!catalog.templates.some((template) => template.id === templateId))
    throw new WorkspaceToolRefusal('The template is outside this workspace. No action was run.');
  const detail = await ports.core.query(templates.templateById(templateId), requestOptions);
  let count = 0;
  let truncated = false;
  const walk = (item: TemplateItem, depth: number): TemplateOutlineNode => {
    count++;
    const fields = (item.schema?.declared ?? []).map((property) => ({
      key: property.key,
      type: property.type,
    }));
    const viewKinds = item.views?.views.map((view) => view.kind) ?? [];
    const children: TemplateOutlineNode[] = [];
    if (depth < MAX_DEPTH) {
      for (const child of item.children) {
        if (count >= MAX_NODES) {
          truncated = true;
          break;
        }
        children.push(walk(child, depth + 1));
      }
    } else if (item.children.length > 0) {
      truncated = true;
    }
    return { title: item.title, fields, viewKinds, children };
  };

  return {
    id: detail.id,
    title: detail.title,
    description: detail.description,
    inputs: detail.initialization.inputs.map((input) => ({
      key: input.key,
      label: input.label,
      type: input.type,
      required: input.required,
    })),
    tree: [walk(detail.root, 1)],
    truncated,
  };
}
