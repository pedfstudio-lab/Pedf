/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useMemo, useReducer } from 'react';
import type { ReactNode } from 'react';
import type { Edit } from '@/lib/export/types';
import {
  deletePage as deletePageState,
  duplicatePage as duplicatePageState,
  insertBlankPage as insertBlankPageState,
} from './pagePlan';
import type { PagePlan } from './pagePlan';

type EditAction =
  | { readonly type: 'add'; readonly edits: readonly Edit[] }
  | { readonly type: 'update'; readonly edit: Edit }
  | { readonly type: 'remove'; readonly id: string }
  | { readonly type: 'replace'; readonly removeIds: readonly string[]; readonly edits: readonly Edit[] };

function editsReducer(state: readonly Edit[], action: EditAction): readonly Edit[] {
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
  }
}

export interface DocPresent {
  readonly edits: readonly Edit[];
  readonly plan: PagePlan;
}

export interface HistoryState {
  readonly past: readonly DocPresent[];
  readonly present: DocPresent;
  readonly future: readonly DocPresent[];
}

export const HISTORY_LIMIT = 100;
export const EMPTY_PRESENT: DocPresent = { edits: [], plan: [] };
export const EMPTY_HISTORY: HistoryState = { past: [], present: EMPTY_PRESENT, future: [] };

type HistoryAction = EditAction
  | { readonly type: 'undo' }
  | { readonly type: 'redo' }
  | { readonly type: 'reset-edits' }
  | { readonly type: 'reset-document'; readonly plan: PagePlan }
  | { readonly type: 'delete-page'; readonly position: number }
  | { readonly type: 'duplicate-page'; readonly position: number; readonly seed: string }
  | {
      readonly type: 'insert-blank-page';
      readonly position: number;
      readonly size: { readonly widthPt: number; readonly heightPt: number };
      readonly seed: string;
    };

function sequenceIds(seed: string): () => string {
  let index = 0;
  return () => `${seed}-${index++}`;
}

function pushPresent(state: HistoryState, present: DocPresent): HistoryState {
  if (present === state.present) return state;
  return {
    past: [...state.past, state.present].slice(-HISTORY_LIMIT),
    present,
    future: [],
  };
}

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
    case 'reset-document':
      return { past: [], present: { edits: [], plan: action.plan }, future: [] };
    case 'reset-edits':
      return { past: [], present: { edits: [], plan: state.present.plan }, future: [] };
    case 'delete-page': {
      if (state.present.plan.length <= 1) return state;
      const next = deletePageState(
        state.present.plan,
        state.present.edits,
        action.position,
      );
      return pushPresent(state, { edits: next.edits, plan: next.plan });
    }
    case 'duplicate-page': {
      const next = duplicatePageState(
        state.present.plan,
        state.present.edits,
        action.position,
        sequenceIds(action.seed),
      );
      return pushPresent(state, { edits: next.edits, plan: next.plan });
    }
    case 'insert-blank-page': {
      const next = insertBlankPageState(
        state.present.plan,
        state.present.edits,
        action.position,
        action.size,
        sequenceIds(action.seed),
      );
      return pushPresent(state, { edits: next.edits, plan: next.plan });
    }
    default: {
      const edits = editsReducer(state.present.edits, action);
      if (edits === state.present.edits) return state;
      return pushPresent(state, { edits, plan: state.present.plan });
    }
  }
}

function operationSeed(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `page-operation-${crypto.randomUUID()}`;
  }
  return `page-operation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

interface EditsStoreValue {
  readonly edits: readonly Edit[];
  readonly pagePlan: PagePlan;
  addEdits(edits: readonly Edit[]): void;
  updateEdit(edit: Edit): void;
  removeEdit(id: string): void;
  replaceEdits(removeIds: readonly string[], edits: readonly Edit[]): void;
  resetEdits(): void;
  resetDocument(plan: PagePlan): void;
  deletePage(position: number): void;
  duplicatePage(position: number): void;
  insertBlankPage(
    position: number,
    size: { readonly widthPt: number; readonly heightPt: number },
  ): void;
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
  const resetEdits = useCallback(() => dispatch({ type: 'reset-edits' }), []);
  const resetDocument = useCallback(
    (plan: PagePlan) => dispatch({ type: 'reset-document', plan }),
    [],
  );
  const deletePage = useCallback(
    (position: number) => dispatch({ type: 'delete-page', position }),
    [],
  );
  const duplicatePage = useCallback(
    (position: number) => dispatch({ type: 'duplicate-page', position, seed: operationSeed() }),
    [],
  );
  const insertBlankPage = useCallback(
    (position: number, size: { readonly widthPt: number; readonly heightPt: number }) =>
      dispatch({ type: 'insert-blank-page', position, size, seed: operationSeed() }),
    [],
  );
  const undo = useCallback(() => dispatch({ type: 'undo' }), []);
  const redo = useCallback(() => dispatch({ type: 'redo' }), []);
  const value = useMemo<EditsStoreValue>(
    () => ({
      edits: history.present.edits,
      pagePlan: history.present.plan,
      addEdits,
      updateEdit,
      removeEdit,
      replaceEdits,
      resetEdits,
      resetDocument,
      deletePage,
      duplicatePage,
      insertBlankPage,
      undo,
      redo,
      canUndo: history.past.length > 0,
      canRedo: history.future.length > 0,
    }),
    [
      addEdits,
      deletePage,
      duplicatePage,
      history,
      insertBlankPage,
      redo,
      removeEdit,
      replaceEdits,
      resetDocument,
      resetEdits,
      undo,
      updateEdit,
    ],
  );

  return <EditsStoreContext.Provider value={value}>{children}</EditsStoreContext.Provider>;
}

export function useEdits(): EditsStoreValue {
  const store = useContext(EditsStoreContext);
  if (!store) throw new Error('useEdits must be used inside EditsStoreProvider');
  return store;
}
