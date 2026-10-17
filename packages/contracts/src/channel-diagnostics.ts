import { z } from 'zod';

const safeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const durationMs = z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER);
const cleanText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value));
const boundedHeaders = z
  .record(z.string().min(1).max(128), z.string().max(8_192))
  .refine((headers) => Object.keys(headers).length <= 32);

/** Bounded, redacted evidence collected for one administrator channel probe. */
export const probeEvidenceSchema = z.strictObject({
  requestId: cleanText(128),
  startedAt: safeInteger,
  durationMs,
  execution: z.enum(['not_started', 'attempted', 'response_received']),
  request: z
    .strictObject({
      method: cleanText(16),
      url: cleanText(2_048),
      headers: boundedHeaders,
      body: z.string().max(32_768).nullable(),
      publicModelId: cleanText(128),
      upstreamModel: z.string(),
    })
    .nullable(),
  redirects: z
    .array(
      z.strictObject({
        url: cleanText(2_048),
        method: cleanText(16),
        status: z.number().int().min(100).max(599),
        strippedHeaders: z.array(cleanText(128)).max(32),
        nextUrl: cleanText(2_048).optional(),
      }),
    )
    .max(20),
  response: z
    .strictObject({
      status: z.number().int().min(100).max(599),
      url: cleanText(2_048),
      headers: boundedHeaders,
      body: z.string().max(32_768),
      format: z.enum(['json', 'text', 'empty', 'fragment']),
      capturedBytes: safeInteger.max(32_768),
      complete: z.boolean(),
      truncated: z.boolean(),
      redacted: z.boolean(),
    })
    .nullable(),
  failure: z
    .strictObject({
      source: z.enum(['cheapai', 'upstream', 'transport', 'protocol']),
      phase: z.enum(['configuration', 'dispatch', 'headers', 'body', 'validation', 'audit']),
      code: cleanText(128).nullable(),
      message: z.string().min(1).max(8_192),
      issues: z
        .array(
          z.strictObject({
            path: z.string().max(512),
            message: z.string().min(1).max(2_048),
          }),
        )
        .max(64),
    })
    .nullable(),
  phases: z
    .array(
      z.strictObject({
        name: cleanText(64),
        durationMs: durationMs.nullable(),
        state: z.enum(['completed', 'failed', 'skipped']),
      }),
    )
    .max(16),
});

export type ProbeEvidence = z.infer<typeof probeEvidenceSchema>;

/** Only this reviewed shape may be exposed as an authenticated admin error detail. */
export const channelDiagnosticErrorDetailsSchema = z.strictObject({
  diagnostic: probeEvidenceSchema,
  diagnosticId: cleanText(128).optional(),
});

export type ChannelDiagnosticErrorDetails = z.infer<typeof channelDiagnosticErrorDetailsSchema>;
