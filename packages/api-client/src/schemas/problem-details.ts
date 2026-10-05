/**
 * RFC 9457 problem details, as Core emits them.
 *
 * Core's contract adds one required extension member on top of the RFC: a
 * stable machine-readable `code`. The frontend switches on that code and never
 * on `title` or `detail`, which are human-facing and may be localised or
 * reworded at any time. `code` is therefore required here - a problem document
 * without one means the backend contract broke, which is a telemetry event
 * (see `parseAtBoundary`), not something to paper over.
 *
 * The object is loose because RFC 9457 explicitly allows extension members;
 * unknown members are preserved rather than stripped.
 */

import { z } from 'zod';

export const problemDetailsSchema = z.looseObject({
  type: z.string().optional(),
  title: z.string().optional(),
  status: z.number().int().optional(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  /** Stable machine-readable discriminator, e.g. `item.not_found`. */
  code: z.string().min(1),
  traceId: z.string().optional(),
  /** ASP.NET validation problem shape: field name to messages. */
  errors: z.record(z.string(), z.array(z.string())).optional(),
});

export type ProblemDetails = z.infer<typeof problemDetailsSchema>;
