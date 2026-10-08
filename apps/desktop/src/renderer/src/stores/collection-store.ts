import { useEffect } from 'react';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

export type AsyncStatus = 'idle' | 'loading' | 'success' | 'error';

export interface CollectionState<T> {
  items: T[];
  status: AsyncStatus;
  error: string | null;
  /** Fetches the collection. Concurrent calls are safe: the latest call wins. */
  load: () => Promise<void>;
}

export type CollectionStore<T> = StoreApi<CollectionState<T>>;

export function createCollectionStore<T>(fetchItems: () => Promise<T[]>): CollectionStore<T> {
  let latestRequest = 0;

  return createStore<CollectionState<T>>()((set) => ({
    items: [],
    status: 'idle',
    error: null,
    load: async () => {
      const request = ++latestRequest;
      set({ status: 'loading', error: null });
      try {
        const items = await fetchItems();
        if (request === latestRequest) set({ items, status: 'success' });
      } catch (error) {
        if (request === latestRequest) {
          set({
            status: 'error',
            error: error instanceof Error ? error.message : 'Something went wrong',
          });
        }
      }
    },
  }));
}

export function useCollection<T, U>(
  store: CollectionStore<T>,
  selector: (state: CollectionState<T>) => U,
): U {
  return useStore(store, selector);
}

/** Triggers the first load of a collection when a page that needs it mounts. */
export function useEnsureLoaded<T>(store: CollectionStore<T>): void {
  useEffect(() => {
    if (store.getState().status === 'idle') void store.getState().load();
  }, [store]);
}
