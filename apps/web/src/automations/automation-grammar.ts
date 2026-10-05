import { z } from 'zod';

/**
 * The rule grammar the editor writes: schema version 1 of the trigger, condition and action
 * documents (ADR-0051 Amendment 4).
 *
 * **Why here, and not in `@nix/api-client`.** The client package carries these documents as opaque
 * JSON on purpose, so Core stays the one authority on the grammar and a document a newer Core
 * writes still parses. The editor is the one place that needs to read a stored rule field by field,
 * and it does so through `safeParse`: a rule that does not fit is "a rule this build cannot edit",
 * never a crash and never a silently different rule.
 *
 * Core refuses unknown members, so these schemas are strict: what the editor builds with them is
 * exactly what Core reads.
 */

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm.');

/** A property key a rule may name: 1..128 characters, never a `$` system property. */
const ruleKey = z
  .string()
  .min(1)
  .max(128)
  .refine((key) => !key.startsWith('$'), 'System properties cannot be used.');

export const automationWeekdaySchema = z.enum(['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su']);

export const scheduleTriggerSchema = z.strictObject({
  type: z.literal('schedule'),
  freq: z.enum(['daily', 'weekly', 'monthly']),
  interval: z.int().min(1).max(366),
  weekdays: z.array(automationWeekdaySchema).max(7).optional(),
  time: timeOfDay,
  timeZone: z.string().min(1).max(64).optional(),
  startDate: z.iso.date().optional(),
});

export const dateArrivesTriggerSchema = z.strictObject({
  type: z.literal('date_arrives'),
  key: ruleKey,
  offsetMinutes: z.int().min(-10_080).max(10_080).optional(),
  time: timeOfDay.optional(),
});

/** A value a property-change trigger compares against; `value: null` means "cleared". */
const valueMatchSchema = z.strictObject({ value: z.unknown() });

export const propertyChangedTriggerSchema = z.strictObject({
  type: z.literal('property_changed'),
  key: ruleKey,
  from: valueMatchSchema.optional(),
  to: valueMatchSchema.optional(),
});

export const automationTriggerSchema = z.discriminatedUnion('type', [
  scheduleTriggerSchema,
  dateArrivesTriggerSchema,
  propertyChangedTriggerSchema,
]);

export const automationConditionSchema = z.strictObject({
  key: ruleKey,
  op: z.enum(['equals', 'not_equals', 'is_empty', 'is_not_empty']),
  value: z.unknown().optional(),
});

/** An item an action acts on or under. `scope` is only valid as a created item's parent. */
export const automationItemReferenceSchema = z.union([
  z.literal('triggering_item'),
  z.literal('scope'),
  z.strictObject({ itemId: z.uuid() }),
]);

export const automationActionSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('set_property'),
    target: automationItemReferenceSchema,
    key: ruleKey,
    value: z.unknown(),
  }),
  z.strictObject({
    type: z.literal('create_item'),
    parent: automationItemReferenceSchema,
    itemType: z.string().min(1).max(64),
    title: z.string().min(1).max(500),
    properties: z.record(z.string(), z.unknown()).optional(),
  }),
  // `create_from_template` is deliberately absent: Core refuses it until its worker lane ships.
  z.strictObject({
    type: z.literal('notify'),
    title: z.string().min(1).max(200),
    body: z.string().max(1000).optional(),
  }),
]);

export type AutomationWeekday = z.infer<typeof automationWeekdaySchema>;
export type AutomationTrigger = z.infer<typeof automationTriggerSchema>;
export type AutomationCondition = z.infer<typeof automationConditionSchema>;
export type AutomationConditionOperator = AutomationCondition['op'];
export type AutomationItemReference = z.infer<typeof automationItemReferenceSchema>;
export type AutomationAction = z.infer<typeof automationActionSchema>;
