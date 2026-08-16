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
      return action.edits.length === 0 ? state : [...state, ...action.edits];
    case 'update': {
      const existing = state.find((edit) => edit.id === action.edit.id);
      if (!existing || existing === action.edit) return state;
      return state.map((edit) => (edit.id === action.edit.id ? action.edit : edit));
    }
    case 'remove':
      return state.some((edit) => edit.id === action.id)
        ? state.filter((edit) => edit.id !== action.id)
        : state;
    case 'replace': {
      if (action.removeIds.length === 0 && action.edits.length === 0) return state;
      const removeIds = new Set(action.removeIds);
      return [...state.filter((edit) => !removeIds.has(edit.id)), ...action.edits];
    }
    case 'reset':
      return [];
  }
}

export interface HistoryState {
  readonly past: readonly (readonly Edit[])[];
  readonly present: readonly Edit[];
  readonly future: readonly (readonly Edit[])[];
}

export const HISTORY_LIMIT = 100;
export const EMPTY_HISTORY: HistoryState = { past: [], present: [], future: [] };

type HistoryAction = Action | { readonly type: 'undo' } | { readonly type: 'redo' };

export function historyReducer(state: HistoryState, action: HistoryAction): HistoryState {
  switch (action.type) {
    case 'undo': {
      const previous = state.past.at(-1);
      if (!previous) return state;
      return {
        past: state.past.slice(0, -1),
        present: previous,
        future: [state.present, ...state.future],
      };
    }
    case 'redo': {
      const [next, ...future] = state.future;
      if (!next) return state;
      return {
        past: [...state.past, state.present],
        present: next,
        future,
      };
    }
    case 'reset':
      return EMPTY_HISTORY;
    default: {
      const present = editsReducer(state.present, action);
      if (present === state.present) return state;
      return {
        past: [...state.past, state.present].slice(-HISTORY_LIMIT),
        present,
        future: [],
      };
    }
  }
}

interface EditsStoreValue {
  readonly edits: readonly Edit[];
  addEdits(edits: readonly Edit[]): void;
  updateEdit(edit: Edit): void;
  removeEdit(id: string): void;
  replaceEdits(removeIds: readonly string[], edits: readonly Edit[]): void;
  resetEdits(): void;
  undo(): void;
  redo(): void;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

const EditsStoreContext = createContext<EditsStoreValue | null>(null);

export function EditsStoreProvider({ children }: { readonly children: ReactNode }) {
  const [history, dispatch] = useReducer(historyReducer, EMPTY_HISTORY);
  const addEdits = useCallback((next: readonly Edit[]) => dispatch({ type: 'add', edits: next }), []);
  const updateEdit = useCallback((edit: Edit) => dispatch({ type: 'update', edit }), []);
  const removeEdit = useCallback((id: string) => dispatch({ type: 'remove', id }), []);
  const replaceEdits = useCallback(
    (removeIds: readonly string[], next: readonly Edit[]) =>
      dispatch({ type: 'replace', removeIds, edits: next }),
    [],
  );
  const resetEdits = useCallback(() => dispatch({ type: 'reset' }), []);
  const undo = useCallback(() => dispatch({ type: 'undo' }), []);
  const redo = useCallback(() => dispatch({ type: 'redo' }), []);
  const value = useMemo<EditsStoreValue>(
    () => ({
      edits: history.present,
      addEdits,
      updateEdit,
      removeEdit,
      replaceEdits,
      resetEdits,
      undo,
      redo,
      canUndo: history.past.length > 0,
      canRedo: history.future.length > 0,
    }),
    [addEdits, history, redo, removeEdit, replaceEdits, resetEdits, undo, updateEdit],
  );

  return <EditsStoreContext.Provider value={value}>{children}</EditsStoreContext.Provider>;
}

export function useEdits(): EditsStoreValue {
  const store = useContext(EditsStoreContext);
  if (!store) throw new Error('useEdits must be used inside EditsStoreProvider');
  return store;
}
