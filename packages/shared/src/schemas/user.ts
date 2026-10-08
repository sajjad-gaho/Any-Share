import { z } from 'zod';
import { deviceIdSchema } from '../device-id';
import { boundedText, timestampSchema, uuidSchema } from './common';
import { roleSchema } from './permission';

export const displayNameSchema = boundedText(1, 64, 'Display name');
export const emailSchema = z.email('Enter a valid email address').max(254);

/** The signed-in user as returned by the API (`/api/v1/users/me`). */
export const userSchema = z.object({
  id: uuidSchema,
  email: emailSchema,
  displayName: displayNameSchema.nullable(),
  avatarUrl: z.url({ protocol: /^https$/ }).nullable(),
  createdAt: timestampSchema,
  memberships: z.array(
    z.object({
      organizationId: uuidSchema,
      organizationName: z.string(),
      role: roleSchema,
    }),
  ),
});
export type User = z.infer<typeof userSchema>;

// ---------------------------------------------------------------------------
// User input. These schemas validate data typed into forms in the desktop app.
// ---------------------------------------------------------------------------

/** Editable local profile fields. */
export const profileInputSchema = z.object({
  displayName: displayNameSchema,
});
export type ProfileInput = z.infer<typeof profileInputSchema>;

/** Free-text search boxes. Bounded so a paste cannot stall filtering. */
export const searchQuerySchema = z.string().trim().max(100);

const contactAliasSchema = boundedText(1, 64, 'Name');
const contactNotesSchema = z.string().trim().max(500, 'Notes must be at most 500 characters');

/** An entry the user types into the address book form. Blank notes are dropped. */
export const contactInputSchema = z.object({
  alias: contactAliasSchema,
  deviceId: deviceIdSchema,
  notes: contactNotesSchema.optional().transform((value) => (value ? value : undefined)),
});
export type ContactInput = z.input<typeof contactInputSchema>;

/** An address-book entry as stored. */
export const contactSchema = z.object({
  id: uuidSchema,
  alias: contactAliasSchema,
  deviceId: deviceIdSchema,
  notes: contactNotesSchema.optional(),
  createdAt: timestampSchema,
});
export type Contact = z.output<typeof contactSchema>;
