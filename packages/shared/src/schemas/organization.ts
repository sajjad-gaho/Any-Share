import { z } from 'zod';
import { boundedText, timestampSchema, uuidSchema } from './common';
import { roleSchema } from './permission';
import { emailSchema } from './user';

export const ORGANIZATION_PLANS = ['free', 'team', 'enterprise'] as const;

export const organizationSlugSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/, 'Use 3-48 lowercase letters, digits or dashes');

export const organizationSchema = z.object({
  id: uuidSchema,
  name: boundedText(1, 100, 'Organization name'),
  slug: organizationSlugSchema,
  plan: z.enum(ORGANIZATION_PLANS),
  createdAt: timestampSchema,
});
export type Organization = z.infer<typeof organizationSchema>;

/** Organisation plus the caller's role in it (read from the database, not the client). */
export const organizationWithRoleSchema = organizationSchema.extend({ role: roleSchema });
export type OrganizationWithRole = z.infer<typeof organizationWithRoleSchema>;

export const organizationCreateInputSchema = z.object({
  name: boundedText(1, 100, 'Organization name'),
  slug: organizationSlugSchema,
});

export const organizationMemberSchema = z.object({
  organizationId: uuidSchema,
  userId: uuidSchema,
  displayName: z.string().nullable(),
  role: roleSchema,
  createdAt: timestampSchema,
});
export type OrganizationMember = z.infer<typeof organizationMemberSchema>;

/** Adds an existing account by email. Inviting unregistered people is a later phase. */
export const memberAddInputSchema = z.object({
  email: emailSchema,
  role: roleSchema,
});

export const memberUpdateInputSchema = z.object({ role: roleSchema });
