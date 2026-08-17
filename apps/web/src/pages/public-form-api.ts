import {
  defineCommand,
  defineQuery,
  type CommandEndpoint,
  type QueryEndpoint,
} from '@nix/api-client';
import { z } from 'zod';

const PublicConditionSchema = z.object({
  fieldBlockId: z.string(),
  operator: z.string(),
  value: z.string().nullable(),
});

const PublicBlockSchema = z.object({
  id: z.string(),
  kind: z.string(),
  text: z.string(),
  help: z.string().nullable(),
  required: z.boolean(),
  identityRole: z.string().nullable(),
  visibleWhen: z.array(PublicConditionSchema),
});

const PublicPageSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  visibleWhen: z.array(PublicConditionSchema),
  blocks: z.array(PublicBlockSchema),
});

const PublicFieldSchema = z.object({
  blockId: z.string(),
  type: z.string(),
  options: z.array(z.string()),
});

export const PublicFormSchema = z.object({
  name: z.string(),
  form: z.object({
    pages: z.array(PublicPageSchema),
    confirmationTitle: z.string(),
    confirmationMessage: z.string(),
  }),
  fields: z.array(PublicFieldSchema),
});

export type PublicForm = z.infer<typeof PublicFormSchema>;
export type PublicFormPage = z.infer<typeof PublicPageSchema>;
export type PublicFormCondition = z.infer<typeof PublicConditionSchema>;

export function publicFormByToken(token: string): QueryEndpoint<PublicForm> {
  return defineQuery({
    operation: 'forms.public.get',
    path: `/public/v1/forms/${encodeURIComponent(token)}`,
    schema: PublicFormSchema,
    cacheKey: ['public-forms', token],
    staleAfterMs: 0,
  });
}

export function submitPublicForm(
  token: string,
  answers: Readonly<Record<string, unknown>>,
): CommandEndpoint<undefined> {
  return defineCommand({
    operation: 'forms.public.submit',
    method: 'POST',
    path: `/public/v1/forms/${encodeURIComponent(token)}`,
    body: { answers, website: '' },
    schema: z.undefined(),
  });
}
