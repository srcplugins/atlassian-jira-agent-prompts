import { useCallback, useEffect, useRef, useState } from 'react';
import { call } from './client';
import type { Prompt, PromptPage } from './service';

export function usePromptSearch() {
  const [items, setItems] = useState<Prompt[]>([]);
  const [query, setQuery] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [nextCursor, setNextCursor] = useState<string>();
  const state = useRef({
    generation: 0,
    query: '',
    items: [] as Prompt[],
    cursor: undefined as string | undefined,
    busy: false,
  });
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      state.current.generation++;
    },
    [],
  );
  const reset = useCallback((page: PromptPage) => {
    clearTimeout(timer.current);
    state.current = {
      generation: state.current.generation + 1,
      query: '',
      items: page.prompts,
      cursor: page.nextCursor,
      busy: false,
    };
    setQuery('');
    setLoaded(false);
    setItems(page.prompts);
    setNextCursor(page.nextCursor);
    setBusy(false);
    setError(page.searchError ?? '');
  }, []);
  async function fetchPage(generation: number, append = false) {
    const current = state.current;
    if (generation !== current.generation || current.busy) return;
    current.busy = true;
    setBusy(true);
    setError('');
    try {
      const page = await call<PromptPage>('search', {
        query: current.query,
        ...(append && current.cursor ? { cursor: current.cursor } : {}),
      });
      if (state.current.generation !== generation) return;
      const merged = new Map((append ? current.items : []).map((p) => [p.id, p]));
      for (const p of page.prompts) merged.set(p.id, p);
      current.items = [...merged.values()];
      current.cursor = page.nextCursor;
      setItems(current.items);
      setLoaded(true);
      setNextCursor(current.cursor);
    } catch (e) {
      if (state.current.generation === generation)
        setError(e instanceof Error ? e.message : 'Search failed. Try again.');
    } finally {
      if (state.current.generation === generation) {
        current.busy = false;
        setBusy(false);
      }
    }
  }
  function change(value: string, immediate = false) {
    clearTimeout(timer.current);
    const generation = state.current.generation + 1;
    state.current = { generation, query: value, items: [], cursor: undefined, busy: false };
    setQuery(value);
    setLoaded(false);
    setItems([]);
    setNextCursor(undefined);
    setError('');
    setBusy(true);
    if (immediate) void fetchPage(generation);
    else timer.current = setTimeout(() => void fetchPage(generation), 300);
  }
  return {
    items,
    loaded,
    query,
    busy,
    error,
    nextCursor,
    reset,
    change,
    refresh: () => change(state.current.query, true),
    more: () =>
      state.current.cursor ? fetchPage(state.current.generation, true) : Promise.resolve(),
  };
}
