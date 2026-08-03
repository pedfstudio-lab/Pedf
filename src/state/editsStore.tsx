/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useMemo, useReducer } from 'react';
import type { ReactNode } from 'react';
import type { Edit } from '@/lib/export/types';

type Action =
  | { readonly type: 'add'; readonly edits: readonly Edit[] }
  | { readonly type: 'update'; readonly edit: Edit }
  | { readonly type: 'remove'; readonly id: string }
  | { readonly type: 'replace'; readonly removeIds: readonly string[]; readonly edits: readonly Edit[] }
  | { readonly type: 'reset' };

function editsReducer(state: readonly Edit[], action: Action): readonly Edit[] {
  switch (action.type) {
    case 'add':
      return [...state, ...action.edits];
    case 'update':
      return state.map((edit) => (edit.id === action.edit.id ? action.edit : edit));
    case 'remove':
      return state.filter((edit) => edit.id !== action.id);
    case 'replace': {
      const removeIds = new Set(action.removeIds);
      return [...state.filter((edit) => !removeIds.has(edit.id)), ...action.edits];
    }
    case 'reset':
      return [];
  }
}

interface EditsStoreValue {
  readonly edits: readonly Edit[];
  addEdits(edits: readonly Edit[]): void;
  updateEdit(edit: Edit): void;
  removeEdit(id: string): void;
  replaceEdits(removeIds: readonly string[], edits: readonly Edit[]): void;
  resetEdits(): void;
}

const EditsStoreContext = createContext<EditsStoreValue | null>(null);

export function EditsStoreProvider({ children }: { readonly children: ReactNode }) {
  const [edits, dispatch] = useReducer(editsReducer, []);
  const addEdits = useCallback((next: readonly Edit[]) => dispatch({ type: 'add', edits: next }), []);
  const updateEdit = useCallback((edit: Edit) => dispatch({ type: 'update', edit }), []);
  const removeEdit = useCallback((id: string) => dispatch({ type: 'remove', id }), []);
  const replaceEdits = useCallback(
    (removeIds: readonly string[], next: readonly Edit[]) =>
      dispatch({ type: 'replace', removeIds, edits: next }),
    [],
  );
  const resetEdits = useCallback(() => dispatch({ type: 'reset' }), []);
  const value = useMemo<EditsStoreValue>(
    () => ({
      edits,
      addEdits,
      updateEdit,
      removeEdit,
      replaceEdits,
      resetEdits,
    }),
    [addEdits, edits, removeEdit, replaceEdits, resetEdits, updateEdit],
  );

  return <EditsStoreContext.Provider value={value}>{children}</EditsStoreContext.Provider>;
}

export function useEdits(): EditsStoreValue {
  const store = useContext(EditsStoreContext);
  if (!store) throw new Error('useEdits must be used inside EditsStoreProvider');
  return store;
}
