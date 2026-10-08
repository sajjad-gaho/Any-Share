import type { z } from 'zod';

/**
 * Builds a zustand `persist` merge function that validates what was read from
 * localStorage. Anything that fails validation (tampering, an old format) is
 * discarded and the in-memory defaults are kept.
 */
export function validatedMerge<TState extends object>(schema: z.ZodType<Partial<TState>>) {
  return (persisted: unknown, current: TState): TState => {
    const result = schema.safeParse(persisted);
    return result.success ? { ...current, ...result.data } : current;
  };
}
