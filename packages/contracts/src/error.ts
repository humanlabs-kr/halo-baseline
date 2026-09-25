import { z } from 'zod';

/**
 * Every error response has exactly this shape: `{ error: { code, message } }`.
 *
 * Clients branch on `code`, never on `message`. Message text is copy and will be
 * reworded; a client that pattern-matches it breaks silently the day someone
 * fixes a typo.
 */
export const errorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

export type ErrorResponse = z.infer<typeof errorSchema>;

/** Success wrapper. Every 2xx body is `{ data: ... }`. */
export const dataSchema = <T extends z.ZodTypeAny>(schema: T) => z.object({ data: schema });

export const ERROR_CODES = [
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];
