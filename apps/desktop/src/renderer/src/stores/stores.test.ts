import { createDeviceId, type Device } from '@remote-desktop/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DUPLICATE_CONTACT_ERROR, useAddressBookStore } from './address-book-store';
import { createCollectionStore } from './collection-store';
import { useSettingsStore } from './settings-store';
import { resolveTheme, useThemeStore } from './theme-store';
import { useViewerStore } from './viewer-store';

const ID_A = createDeviceId('12345678');
const ID_B = createDeviceId('87654321');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createCollectionStore', () => {
  it('moves idle -> loading -> success', async () => {
    const pending = deferred<number[]>();
    const store = createCollectionStore(() => pending.promise);
    expect(store.getState().status).toBe('idle');

    const loading = store.getState().load();
    expect(store.getState().status).toBe('loading');

    pending.resolve([1, 2, 3]);
    await loading;
    expect(store.getState()).toMatchObject({ status: 'success', items: [1, 2, 3], error: null });
  });

  it('captures errors and recovers on retry', async () => {
    const fetchItems = vi
      .fn<() => Promise<string[]>>()
      .mockRejectedValueOnce(new Error('Network unreachable'))
      .mockResolvedValueOnce(['ok']);
    const store = createCollectionStore(fetchItems);

    await store.getState().load();
    expect(store.getState()).toMatchObject({ status: 'error', error: 'Network unreachable' });

    await store.getState().load();
    expect(store.getState()).toMatchObject({ status: 'success', items: ['ok'], error: null });
  });

  it('lets the latest request win when loads overlap', async () => {
    const first = deferred<string[]>();
    const second = deferred<string[]>();
    const fetchItems = vi
      .fn<() => Promise<string[]>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const store = createCollectionStore(fetchItems);

    const a = store.getState().load();
    const b = store.getState().load();
    second.resolve(['fresh']);
    first.resolve(['stale']);
    await Promise.all([a, b]);

    expect(store.getState().items).toEqual(['fresh']);
  });
});

describe('address book store', () => {
  beforeEach(() => useAddressBookStore.setState({ contacts: [] }));

  it('adds validated contacts sorted by name', () => {
    const { addContact } = useAddressBookStore.getState();
    expect(addContact({ alias: 'Zed', deviceId: ID_A }).ok).toBe(true);
    const result = addContact({ alias: ' Amy ', deviceId: '876 543 21' + ID_B.slice(-1) });
    expect(result.ok).toBe(true);

    const contacts = useAddressBookStore.getState().contacts;
    expect(contacts.map((c) => c.alias)).toEqual(['Amy', 'Zed']);
    expect(contacts[0]?.deviceId).toBe(ID_B);
  });

  it('rejects invalid IDs and duplicates', () => {
    const { addContact } = useAddressBookStore.getState();
    expect(addContact({ alias: 'Bad', deviceId: '123456789' })).toMatchObject({ ok: false });
    expect(addContact({ alias: 'One', deviceId: ID_A }).ok).toBe(true);
    expect(addContact({ alias: 'Two', deviceId: ID_A })).toEqual({
      ok: false,
      error: DUPLICATE_CONTACT_ERROR,
    });
    expect(useAddressBookStore.getState().contacts).toHaveLength(1);
  });

  it('removes contacts', () => {
    const result = useAddressBookStore.getState().addContact({ alias: 'One', deviceId: ID_A });
    if (!result.ok) throw new Error('setup failed');
    useAddressBookStore.getState().removeContact(result.contact.id);
    expect(useAddressBookStore.getState().contacts).toEqual([]);
  });

  it('ignores tampered persisted data', async () => {
    localStorage.setItem(
      'kestrel.address-book',
      JSON.stringify({ state: { contacts: [{ alias: 'x', deviceId: 'not-an-id' }] }, version: 1 }),
    );
    await useAddressBookStore.persist.rehydrate();
    expect(useAddressBookStore.getState().contacts).toEqual([]);
  });
});

describe('theme store', () => {
  it('resolves system preference', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('updates and persists the preference', () => {
    useThemeStore.getState().setPreference('dark');
    expect(useThemeStore.getState().preference).toBe('dark');
    expect(localStorage.getItem('kestrel.theme')).toContain('"dark"');
  });
});

describe('settings store', () => {
  it('toggles sample data and stores the display name', () => {
    useSettingsStore.getState().setShowSampleData(false);
    useSettingsStore.getState().setDisplayName('Ada');
    expect(useSettingsStore.getState()).toMatchObject({
      showSampleData: false,
      displayName: 'Ada',
    });
  });
});

describe('viewer store', () => {
  it('never reports a connection in phase 1', () => {
    useViewerStore.getState().open(ID_A);
    expect(useViewerStore.getState()).toMatchObject({
      deviceId: ID_A,
      status: 'not-connected',
      connectedAt: null,
    });
    useViewerStore.getState().close();
    expect(useViewerStore.getState().deviceId).toBeNull();
  });
});

// Type-level guard: the collection store accepts domain types without casts.
createCollectionStore<Device>(async () => []);
