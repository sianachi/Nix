import { z } from 'zod';
import { items, recurrence, search, structure, views } from '@nix/api-client';
import {
  applySpecSchema,
  entriesSpecSchema,
  fieldsSpecSchema,
  formEditSpecSchema,
  recurrenceSpecSchema,
  compileAddFields,
  compileEditForm,
  compileRecurrence,
  structuredSpecSchema,
  validateSpec,
  viewSetupSpecSchema,
} from '@nix/structure-spec';
import type { CompanionPorts } from './ports.js';
import { applyTemplate } from './templates/apply.js';
import { listTemplates } from './templates/list.js';
import { readTemplate } from './templates/read.js';
import { loadPreviewContext } from './context.js';
import { checkItem, type StructureFingerprint } from './guards.js';
import { readStructure } from './structure/read-structure.js';
import * as createStructured from './structure/create-structured.js';
import * as addView from './structure/add-view.js';
import * as createEntries from './structure/create-entries.js';
import { READ_ONLY_OPERATIONS, WorkspaceToolRefusal, workspaceToolSchema } from './tool-args.js';
import { toPropertyDefinitionRequest, toViewRequest } from './structure/create-structured.js';

export { WorkspaceToolRefusal } from './tool-args.js';

export interface RunOptions {
  mode?: 'chat' | 'consult';
  toolId?: string;
  claimId?: string;
  fence?: StructureFingerprint;
}

export interface WorkspaceToolOutcome {
  text: string;
  readOnly: boolean;
  touchedParents: (string | null)[];
}

/** Execute only after the caller claims and approves this exact tool request. */
export async function runWorkspaceTool(
  ports: CompanionPorts,
  workspaceId: string,
  raw: string,
  signal: AbortSignal,
  options: RunOptions = {},
): Promise<WorkspaceToolOutcome> {
  const client = ports.core;
  const bodies = ports.bodies;
  if (raw.length > 40000) throw new Error('Tool arguments are too large.');
  const args = workspaceToolSchema.parse(JSON.parse(raw));
  const requestOptions = { signal, forceRefresh: true };
  let result: unknown;
  const check = (id: string) => checkItem(ports, workspaceId, id, signal);
  const rawSpec: unknown = args.specJson ? JSON.parse(args.specJson) : {};
  // Scope guards supplement, never replace, permission checks in Core and collab. Check every
  // named item identity before loading schema, views, paths, template preflight, or bodies.
  if (
    args.operation !== 'apply_template' &&
    args.operation !== 'read_template' &&
    args.operation !== 'restore_item' &&
    ![
      'list_items',
      'search',
      'create_note',
      'create_structured',
      'create_entries',
      'add_fields',
      'edit_form',
      'list_templates',
    ].includes(args.operation)
  ) {
    await check(args.itemId);
  }
  if (args.parentId) await check(args.parentId);
  let templatePreflight;
  if (args.operation === 'apply_template') {
    applySpecSchema.parse(rawSpec);
    const context = await loadPreviewContext(ports, workspaceId, args, signal);
    templatePreflight = context.preflight;
  }
  if (
    [
      'create_structured',
      'add_view',
      'create_entries',
      'add_fields',
      'edit_form',
      'set_recurrence',
    ].includes(args.operation)
  ) {
    const context = await loadPreviewContext(ports, workspaceId, args, signal);
    if (options.fence === undefined || context.fingerprint !== options.fence)
      throw new WorkspaceToolRefusal(
        'The item changed since you approved this. Ask the pet to look again.',
      );
    if (args.operation === 'create_structured') {
      const spec = structuredSpecSchema.parse(rawSpec);
      const report = validateSpec('create_structured', spec, {
        inheritedFields: context.inheritedFields,
        today: ports.clock.today(),
      });
      if (!report.ok)
        throw new WorkspaceToolRefusal(
          report.problems.map((problem) => `${problem.path}: ${problem.message}`).join('\n'),
        );
      result = await createStructured.execute(
        ports,
        workspaceId,
        createStructured.compile(spec, {
          parentId: args.parentId || null,
          title: args.title,
          inheritedFields: context.inheritedFields,
        }),
        signal,
      );
    } else if (args.operation === 'add_view') {
      const spec = viewSetupSpecSchema.parse(rawSpec);
      const existing = context.existing;
      if (existing === undefined) throw new Error('add_view preview context is missing.');
      const report = validateSpec('add_view', spec, {
        inheritedFields: context.inheritedFields,
        existing,
        today: ports.clock.today(),
      });
      if (!report.ok)
        throw new WorkspaceToolRefusal(
          report.problems.map((problem) => `${problem.path}: ${problem.message}`).join('\n'),
        );
      const steps = addView.compile(spec, {
        itemId: args.itemId,
        existing: {
          declared: existing.declared,
          effective: existing.effective,
          views: existing.views,
        },
      });
      result = await addView.execute(ports, steps, signal);
    } else if (args.operation === 'create_entries') {
      const spec = entriesSpecSchema.parse(rawSpec);
      result = await createEntries.execute(
        ports,
        workspaceId,
        args.parentId,
        spec,
        context.inheritedFields,
        signal,
      );
    } else if (args.operation === 'add_fields') {
      const spec = fieldsSpecSchema.parse(rawSpec);
      const existing = context.existing;
      if (existing === undefined) throw new Error('add_fields preview context is missing.');
      const report = validateSpec('add_fields', spec, { ...context, today: ports.clock.today() });
      if (!report.ok)
        throw new WorkspaceToolRefusal(
          report.problems.map((p) => `${p.path}: ${p.message}`).join('\n'),
        );
      const step = compileAddFields(spec, { itemId: args.itemId, existing })[0];
      if (step?.kind !== 'appendViewSetup')
        throw new Error('add_fields compiled to an unexpected plan.');
      result = await client.execute(
        views.appendViewSetup(step.itemId, {
          properties: step.properties.map(toPropertyDefinitionRequest),
          views: step.views.map(toViewRequest),
          makeDefault: step.makeDefault,
          publishInteractiveFormViewId: null,
        }),
        requestOptions,
      );
    } else if (args.operation === 'edit_form') {
      const spec = formEditSpecSchema.parse(rawSpec);
      const existing = context.existing;
      if (existing === undefined) throw new Error('edit_form preview context is missing.');
      const report = validateSpec('edit_form', spec, { ...context, today: ports.clock.today() });
      if (!report.ok)
        throw new WorkspaceToolRefusal(
          report.problems.map((p) => `${p.path}: ${p.message}`).join('\n'),
        );
      const view = existing.views.find((candidate) => candidate.id === spec.viewId);
      if (view === undefined) throw new WorkspaceToolRefusal('The form view no longer exists.');
      const step = compileEditForm(spec, { itemId: args.itemId, existing, view })[0];
      if (step?.kind !== 'replaceViewSetup')
        throw new Error('edit_form compiled to an unexpected plan.');
      result = await client.execute(
        views.replaceViewSetup(step.itemId, step.viewId, {
          schema: {
            properties: step.schema.properties.map(toPropertyDefinitionRequest),
            inherit: step.schema.inherit,
          },
          originalPropertyKeys: step.originalPropertyKeys,
          views: step.views.map(toViewRequest),
          publishInteractiveFormViewId: null,
        }),
        requestOptions,
      );
    } else {
      const spec = recurrenceSpecSchema.parse(rawSpec);
      const existing = context.existing;
      if (existing === undefined) throw new Error('set_recurrence preview context is missing.');
      const report = validateSpec('set_recurrence', spec, {
        ...context,
        today: ports.clock.today(),
      });
      if (!report.ok)
        throw new WorkspaceToolRefusal(
          report.problems.map((p) => `${p.path}: ${p.message}`).join('\n'),
        );
      const step = compileRecurrence(spec, { itemId: args.itemId })[0];
      if (step?.kind !== 'setRecurrence' || !('itemId' in step.target))
        throw new Error('set_recurrence compiled to an unexpected plan.');
      result = await client.execute(
        recurrence.setRecurrence(step.target.itemId, {
          freq: step.rule.freq as 'daily' | 'weekly' | 'monthly' | 'yearly',
          interval: step.rule.interval,
          weekdays:
            step.rule.weekdays?.map(
              (day) =>
                ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'][day - 1] as
                  'mo' | 'tu' | 'we' | 'th' | 'fr' | 'sa' | 'su',
            ) ?? null,
          until: step.rule.until,
        }),
        requestOptions,
      );
    }
  }
  switch (args.operation) {
    case 'create_structured':
    case 'add_view':
    case 'create_entries':
    case 'add_fields':
    case 'edit_form':
    case 'set_recurrence':
      break;
    case 'restore_item': {
      // Ordinary item reads intentionally hide deleted rows. Establish the exact
      // target through Core's workspace-scoped trash query before restoring it.
      let found = false;
      let checked = 0;
      for await (const item of client.paginate(items.listTrash(workspaceId, 50), requestOptions)) {
        if (++checked > 500) break;
        if (item.id === args.itemId && item.workspaceId === workspaceId) {
          found = true;
          break;
        }
      }
      if (!found)
        throw new WorkspaceToolRefusal(
          'The item was not found in this workspace’s first 500 trash entries. No restore was attempted.',
        );
      result = await client.execute(items.restoreItem(workspaceId, args.itemId), requestOptions);
      break;
    }
    case 'list_items': {
      const rows = [];
      let truncated = false;
      for await (const item of client.paginate(
        items.listItems(workspaceId, { parentId: args.parentId || undefined, pageSize: 50 }),
        requestOptions,
      )) {
        if (rows.length >= 50) {
          truncated = true;
          break;
        }
        rows.push({
          id: item.id,
          title: item.title,
          type: item.type,
          hasChildren: item.hasChildren,
        });
      }
      result = { items: rows, truncated };
      break;
    }
    case 'search': {
      if (!args.query.trim()) throw new Error('A search query is required.');
      if (z.uuid().safeParse(args.query.trim()).success) {
        const item = await check(args.query.trim());
        result = {
          results: [
            { id: item.id, workspaceId: item.workspaceId, title: item.title, type: item.type },
          ],
          truncated: false,
        };
        break;
      }
      const found = await client.query(search.searchItems(args.query, 50), requestOptions);
      result = {
        results: found.results.filter((item) => item.workspaceId === workspaceId),
        truncated: found.truncated,
      };
      break;
    }
    case 'create_note': {
      if (!args.title.trim()) throw new Error('A title is required.');
      const item = await client.execute(
        items.createItem(workspaceId, {
          type: 'note',
          title: args.title,
          parentId: args.parentId || null,
        }),
        requestOptions,
      );
      if (args.markdown) {
        try {
          await bodies.append(item.id, args.markdown, signal);
        } catch {
          return {
            text: JSON.stringify({
              id: item.id,
              created: true,
              contentConfirmed: false,
              instruction:
                'Note created but content was not confirmed. Read this note before retrying. Do not create another note.',
            }),
            readOnly: false,
            touchedParents: [args.parentId || null],
          };
        }
      }
      result = { id: item.id, title: item.title, created: true, contentConfirmed: true };
      break;
    }
    case 'list_templates': {
      result = await listTemplates(ports, workspaceId, args.query, signal);
      break;
    }
    case 'read_template': {
      result = await readTemplate(ports, workspaceId, args.itemId, signal);
      break;
    }
    case 'apply_template': {
      const spec = applySpecSchema.parse(rawSpec);
      result = await applyTemplate(
        ports,
        workspaceId,
        {
          templateId: args.itemId,
          parentId: args.parentId || null,
          title: args.title,
          ...(spec.inputs ? { inputs: spec.inputs } : {}),
        },
        { toolId: options.toolId, claimId: options.claimId },
        signal,
        templatePreflight,
      );
      break;
    }
    default: {
      const item = await check(args.itemId);
      switch (args.operation) {
        case 'read_item':
          result = item;
          break;
        case 'read_structure':
          result = await readStructure(ports, workspaceId, item.id, signal);
          break;
        case 'read_note':
        case 'append_note':
          if (item.type !== 'note') throw new Error('This operation supports note bodies only.');
          result =
            args.operation === 'read_note'
              ? await bodies.read(item.id, signal)
              : await bodies.append(item.id, args.markdown, signal);
          break;
        case 'rename_item':
          if (!args.title.trim()) throw new Error('A title is required.');
          result = await client.execute(
            items.renameItem(workspaceId, item.id, args.title),
            requestOptions,
          );
          break;
        case 'move_item':
          result = await client.execute(
            items.moveItem(workspaceId, item.id, { parentId: args.parentId || null }),
            requestOptions,
          );
          break;
        case 'set_properties': {
          const properties = z
            .record(z.string().max(160), z.unknown())
            .parse(JSON.parse(args.propertiesJson));
          result = await client.execute(
            structure.setItemProperties(item.id, properties),
            requestOptions,
          );
          break;
        }
        case 'trash_item':
          await client.execute(items.deleteItem(workspaceId, item.id), requestOptions);
          result = { id: item.id, trashed: true };
          break;
      }
    }
  }
  const text = JSON.stringify(result);
  return {
    text:
      text.length <= 16000
        ? text
        : JSON.stringify({ truncated: true, preview: text.slice(0, 15000) }),
    readOnly: READ_ONLY_OPERATIONS.has(args.operation),
    touchedParents: [
      'create_note',
      'move_item',
      'apply_template',
      'create_structured',
      'create_entries',
    ].includes(args.operation)
      ? [args.parentId || null]
      : ['add_view', 'add_fields', 'edit_form', 'set_recurrence'].includes(args.operation)
        ? [args.itemId]
        : [],
  };
}
