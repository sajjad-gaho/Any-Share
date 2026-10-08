import {
  contactInputSchema,
  contactSchema,
  type Contact,
  type ContactInput,
} from '@remote-desktop/shared';
import { z } from 'zod';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { validatedMerge } from '@/lib/persist';

export type AddContactResult = { ok: true; contact: Contact } | { ok: false; error: string };

interface AddressBookState {
  contacts: Contact[];
  addContact: (input: ContactInput) => AddContactResult;
  removeContact: (id: string) => void;
}

export const DUPLICATE_CONTACT_ERROR = 'This device is already in your address book';

const byAlias = (a: Contact, b: Contact) => a.alias.localeCompare(b.alias);
const persistedSchema = z.object({ contacts: z.array(contactSchema) }).partial();

/**
 * Local address book (stored on this device only).
 * TODO(phase-3): sync to the user's account once authentication exists.
 */
export const useAddressBookStore = create<AddressBookState>()(
  persist(
    (set, get) => ({
      contacts: [],
      addContact: (input) => {
        const parsed = contactInputSchema.safeParse(input);
        if (!parsed.success) {
          return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid contact' };
        }
        if (get().contacts.some((contact) => contact.deviceId === parsed.data.deviceId)) {
          return { ok: false, error: DUPLICATE_CONTACT_ERROR };
        }
        const contact: Contact = {
          id: crypto.randomUUID(),
          ...parsed.data,
          createdAt: new Date().toISOString(),
        };
        set({ contacts: [...get().contacts, contact].sort(byAlias) });
        return { ok: true, contact };
      },
      removeContact: (id) => set({ contacts: get().contacts.filter((c) => c.id !== id) }),
    }),
    {
      name: 'kestrel.address-book',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: ({ contacts }) => ({ contacts }),
      merge: validatedMerge<AddressBookState>(persistedSchema),
    },
  ),
);
