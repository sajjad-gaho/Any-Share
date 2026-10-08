import { zodResolver } from '@hookform/resolvers/zod';
import {
  contactInputSchema,
  formatDeviceId,
  type Contact,
  type ContactInput,
} from '@remote-desktop/shared';
import {
  Button,
  Card,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  FieldError,
  Input,
  Label,
  Textarea,
} from '@remote-desktop/ui';
import { BookUser, Plus, Search, SearchX, Trash2 } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import type { z } from 'zod';
import { ConnectButton } from '@/components/ConnectButton';
import { PageHeader } from '@/components/PageHeader';
import { useAddressBookStore } from '@/stores/address-book-store';

type ContactOutput = z.output<typeof contactInputSchema>;

function AddContactDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const addContact = useAddressBookStore((state) => state.addContact);
  const ids = { alias: useId(), deviceId: useId(), notes: useId() };
  const {
    control,
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ContactInput, unknown, ContactOutput>({
    resolver: zodResolver(contactInputSchema),
    defaultValues: { alias: '', deviceId: '', notes: '' },
  });

  const onSubmit = handleSubmit((values) => {
    const result = addContact(values);
    if (!result.ok) {
      setError('deviceId', { message: result.error });
      return;
    }
    reset();
    onOpenChange(false);
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add contact</DialogTitle>
          <DialogDescription>Save a device so you can connect to it quickly.</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor={ids.alias}>Name</Label>
            <Input
              id={ids.alias}
              placeholder="e.g. Front desk"
              aria-invalid={Boolean(errors.alias)}
              {...register('alias')}
            />
            <FieldError>{errors.alias?.message}</FieldError>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={ids.deviceId}>Device ID</Label>
            <Controller
              control={control}
              name="deviceId"
              render={({ field, fieldState }) => (
                <Input
                  {...field}
                  id={ids.deviceId}
                  onChange={(event) => field.onChange(formatDeviceId(event.target.value))}
                  placeholder="123 456 789"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={11}
                  className="font-mono"
                  aria-invalid={fieldState.invalid}
                />
              )}
            />
            <FieldError>{errors.deviceId?.message}</FieldError>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={ids.notes}>
              Notes <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id={ids.notes}
              rows={3}
              aria-invalid={Boolean(errors.notes)}
              {...register('notes')}
            />
            <FieldError>{errors.notes?.message}</FieldError>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              Save contact
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ContactRow({ contact }: { contact: Contact }) {
  const removeContact = useAddressBookStore((state) => state.removeContact);
  return (
    <li className="flex items-center gap-4 px-4 py-3">
      <span
        aria-hidden="true"
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary"
      >
        {contact.alias.charAt(0).toUpperCase()}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{contact.alias}</p>
        <p className="font-mono text-xs text-muted-foreground">
          {formatDeviceId(contact.deviceId)}
        </p>
        {contact.notes ? (
          <p className="mt-0.5 truncate text-xs text-muted-foreground" title={contact.notes}>
            {contact.notes}
          </p>
        ) : null}
      </div>
      <ConnectButton deviceId={contact.deviceId} deviceName={contact.alias} variant="outline" />
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Remove ${contact.alias}`}
        onClick={() => removeContact(contact.id)}
      >
        <Trash2 aria-hidden="true" />
      </Button>
    </li>
  );
}

export function AddressBookPage() {
  const contacts = useAddressBookStore((state) => state.contacts);
  const [query, setQuery] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const searchId = useId();

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const digits = needle.replace(/[\s-]/g, '');
    if (!needle) return contacts;
    return contacts.filter(
      (contact) =>
        contact.alias.toLowerCase().includes(needle) ||
        (/^\d+$/.test(digits) && contact.deviceId.includes(digits)),
    );
  }, [contacts, query]);

  return (
    <>
      <PageHeader
        title="Address Book"
        description="Devices you've saved on this computer."
        actions={
          <Button onClick={() => setDialogOpen(true)}>
            <Plus aria-hidden="true" />
            Add contact
          </Button>
        }
      />

      {contacts.length === 0 ? (
        <EmptyState
          icon={<BookUser />}
          title="Your address book is empty"
          description="Save the devices you connect to often. Contacts are stored on this computer only."
          action={
            <Button variant="outline" size="sm" onClick={() => setDialogOpen(true)}>
              <Plus aria-hidden="true" />
              Add your first contact
            </Button>
          }
        />
      ) : (
        <>
          <div role="search" className="relative max-w-sm">
            <Label htmlFor={searchId} className="sr-only">
              Search contacts
            </Label>
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              id={searchId}
              type="search"
              placeholder="Search by name or ID"
              className="pl-9"
              maxLength={100}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          {visible.length === 0 ? (
            <EmptyState icon={<SearchX />} title="No matching contacts" />
          ) : (
            <Card>
              <ul className="divide-y" aria-label="Contacts">
                {visible.map((contact) => (
                  <ContactRow key={contact.id} contact={contact} />
                ))}
              </ul>
            </Card>
          )}
        </>
      )}

      <AddContactDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  );
}
