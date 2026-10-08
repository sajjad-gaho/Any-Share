import { z } from 'zod';
import { displayNameSchema, emailSchema } from './user';

/**
 * Passwords are checked for length only; strength rules beyond that belong to
 * Supabase Auth's password policy. The upper bound stops oversized payloads.
 */
export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(128, 'Password must be at most 128 characters');

export const registerInputSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: displayNameSchema,
});
export type RegisterInput = z.input<typeof registerInputSchema>;

export const loginInputSchema = z.object({
  email: emailSchema,
  // Not passwordSchema: existing accounts may predate the current length rule.
  password: z.string().min(1, 'Enter your password').max(128),
});
export type LoginInput = z.input<typeof loginInputSchema>;

export const refreshInputSchema = z.object({
  refreshToken: z.string().min(1).max(512),
});

export const passwordResetRequestSchema = z.object({ email: emailSchema });
export type PasswordResetRequestInput = z.input<typeof passwordResetRequestSchema>;

/** Completes a reset with the one-time code from the recovery email. */
export const passwordResetConfirmSchema = z.object({
  email: emailSchema,
  code: z
    .string()
    .trim()
    .regex(/^\d{6,10}$/, 'Enter the code from the email'),
  newPassword: passwordSchema,
});
export type PasswordResetConfirmInput = z.input<typeof passwordResetConfirmSchema>;

/** Tokens issued on login/refresh. Kept in the desktop main process, never the renderer. */
export const authTokensSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  /** Unix seconds. */
  expiresAt: z.number().int().positive(),
});
export type AuthTokens = z.infer<typeof authTokensSchema>;

export const authResultSchema = z.object({
  user: z.object({ id: z.uuid(), email: emailSchema }),
  /** Null when the account still needs email confirmation. */
  tokens: authTokensSchema.nullable(),
});
export type AuthResult = z.infer<typeof authResultSchema>;
