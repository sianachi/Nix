export { createCompanionBodies } from './bodies.js';
export {
  defaultClock,
  defaultIds,
  type CompanionBodies,
  type CompanionClock,
  type CompanionIds,
  type CompanionPorts,
} from './ports.js';
export {
  runWorkspaceTool,
  WorkspaceToolRefusal,
  type RunOptions,
  type WorkspaceToolOutcome,
} from './run.js';
export { READ_ONLY_OPERATIONS, workspaceToolSchema, type WorkspaceToolArgs } from './tool-args.js';
export { loadPreviewContext, type PreviewContext, type PreviewDestination } from './context.js';
export { structureFingerprint, type StructureFingerprint } from './guards.js';
export { readStructure, type ReadStructureResult } from './structure/read-structure.js';
export {
  applyTemplate,
  type ApplyTemplateClaim,
  type ApplyTemplateInput,
  type ApplyTemplateResult,
} from './templates/apply.js';
export {
  listTemplates,
  type ListTemplatesResult,
  type TemplateSummaryView,
} from './templates/list.js';
export {
  readTemplate,
  type ReadTemplateResult,
  type TemplateInputSummary,
  type TemplateOutlineNode,
} from './templates/read.js';
export { describeToolCall, type PreviewToolArgs } from './preview.js';
export type { PreviewModel, PreviewNode } from '@nix/structure-spec';
export { planBuild, type BuildPlan, type PlanBuildOptions } from './blueprint/plan.js';
export { createSandbox, findSandbox, SANDBOX_TITLE } from './blueprint/sandbox.js';
