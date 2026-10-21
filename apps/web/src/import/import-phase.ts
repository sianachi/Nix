import type { DocumentImport, DocumentImportPlan } from '@nix/api-client';

import type { ImportPlan } from './import-plan';
import type { ImportRunReport } from './import-run';

export type Phase =
  | { readonly name: 'pick'; readonly reading: boolean; readonly error: string | null }
  | { readonly name: 'preview'; readonly plan: ImportPlan; readonly losses: readonly string[] }
  | { readonly name: 'working'; readonly done: number; readonly total: number }
  | {
      readonly name: 'document-preview';
      readonly operation: DocumentImport;
      readonly plan: DocumentImportPlan;
    }
  | { readonly name: 'document-working'; readonly importId: string; readonly total: number }
  | {
      readonly name: 'document-report';
      readonly operation: DocumentImport;
      readonly plan: DocumentImportPlan;
      readonly undo: UndoState;
    }
  | {
      readonly name: 'report';
      readonly report: ImportRunReport;
      readonly undo: UndoState;
      /** Kept so a run that could not start can be retried without re-picking. */
      readonly plan: ImportPlan;
      readonly losses: readonly string[];
    };

export type UndoState =
  | { readonly name: 'available' }
  | { readonly name: 'working' }
  | { readonly name: 'done' }
  | { readonly name: 'failed'; readonly error: string };
