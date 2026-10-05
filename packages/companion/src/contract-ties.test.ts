import type {
  AppendViewSetupRequestContract,
  CreateItemRequestContract,
  CreateStructuredItemRequestContract,
  TemplatePreflight,
} from '@nix/api-client';
import type { Problem, Step, StructureProperty, StructureView } from '@nix/structure-spec';
import { describe, expect, it } from 'vitest';
import type { PreviewContext } from './context.js';

interface DescribePreviewContext {
  destination: { title: string; path: string[] };
  existing?: {
    declared: readonly StructureProperty[];
    effective: readonly StructureProperty[];
    views: readonly StructureView[];
  };
  inheritedFields: readonly StructureProperty[];
  preflight?: TemplatePreflight;
  problems: Problem[];
  warnings?: Problem[];
}

const previewContextCompatibility: DescribePreviewContext = {} as PreviewContext;

const structuredBody = {
  type: 'note',
  title: 'Board',
  parentId: null,
  schema: { properties: [], inherit: true },
  views: { views: [], default: 'view' },
  publishInteractiveFormViewId: null,
} satisfies CreateStructuredItemRequestContract;

const appendBody = {
  properties: [],
  views: [],
  makeDefault: false,
  publishInteractiveFormViewId: null,
} satisfies AppendViewSetupRequestContract;

const entryBody = {
  type: 'note',
  title: 'Entry',
  parentId: null,
  properties: null,
} satisfies CreateItemRequestContract;

const steps = [
  {
    kind: 'createStructuredItem',
    parentId: null,
    title: 'Board',
    schema: { properties: [], inherit: true },
    views: [],
    defaultViewId: 'view',
  },
  { kind: 'appendViewSetup', itemId: 'item', properties: [], views: [], makeDefault: false },
  { kind: 'createItem', parentId: null, title: 'Entry', properties: null },
] satisfies Step[];

void [structuredBody, appendBody, entryBody, steps, previewContextCompatibility];

describe('generated request contract ties', () => {
  it('keeps the contract fixtures compile-time checked', () => {
    expect(steps).toHaveLength(3);
  });
});
