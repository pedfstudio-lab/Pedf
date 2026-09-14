import { useCallback, useEffect, useRef, useState } from 'react';
import { Toolbar } from './components/Toolbar';
import { SettingsPanel } from './components/SettingsPanel';
import { PdfChat } from './components/PdfChat';
import { PdfViewer } from './components/PdfViewer';
import { PdfDropZone } from './components/PdfDropZone';
import { SignatureModal } from './components/sign/SignatureModal';
import { loadDocument } from './lib/pdf/loadDocument';
import type { LoadedDocument } from './lib/pdf/loadDocument';
import { pdfToViewport } from './lib/export/coordinates';
import { exportPdf } from './lib/export/exportPdf';
import { sampleDominantColor } from './lib/export/colorSample';
import {
  captureZoomAnchor,
  clampZoom,
  scrollPositionForZoomAnchor,
  type ZoomAnchor,
  ZOOM_STEP,
} from './lib/pdf/zoom';
import type { PdfRect, Rgb } from './lib/export/types';
import type { SignatureAsset } from './lib/tools/signOptions';
import { editorSignatureEdit } from './lib/sign/editorSignature';
import { DocumentStoreProvider, useDocumentStore } from './state/documentStore';
import { EditsStoreProvider, useEdits } from './state/editsStore';
import { createPagePlan, planToGeometry } from './state/pagePlan';
import { PrefsStoreProvider } from './state/prefsStore';
import { takePendingFile, takePendingProject } from './lib/site/pendingFile';
import { setPendingFiles } from './lib/site/pendingFiles';
import { navigate } from './lib/site/navigate';
import { isPdf } from './lib/site/pdfFile';
import { ContinueEditingCard } from './components/ContinueEditingCard';
import { SavedFilesColumn } from './components/SavedFilesColumn';
import { projectStore, sha256Hex } from './lib/projects/projectStore';
import type { ProjectMetadata } from './lib/projects/projectStore';
import {
  deserializeProject,
  hasDocumentChanges,
  serializeProject,
} from './lib/projects/projectState';
import { useProjectAutosave } from './lib/projects/useProjectAutosave';
import type {
  CreateProjectResult,
  SaveStatus,
} from './lib/projects/useProjectAutosave';

function pageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `page-${crypto.randomUUID()}`;
  }
  return `page-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target.matches('input, textarea') || target.isContentEditable);
}

function useEditHistoryShortcuts(): void {
  const { undo, redo, canUndo, canRedo } = useEdits();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented
        || event.altKey
        || (!event.ctrlKey && !event.metaKey)
        || isEditableTarget(event.target)
      ) return;

      const key = event.key.toLowerCase();
      const shouldUndo = key === 'z' && !event.shiftKey;
      const shouldRedo = (key === 'z' && event.shiftKey) || key === 'y';

      if (shouldUndo && canUndo) {
        event.preventDefault();
        undo();
      } else if (shouldRedo && canRedo) {
        event.preventDefault();
        redo();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [canRedo, canUndo, redo, undo]);
}

function useZoomShortcuts(
  zoomIn: () => void,
  zoomOut: () => void,
  zoomReset: () => void,
): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented
        || event.altKey
        || (!event.ctrlKey && !event.metaKey)
        || isEditableTarget(event.target)
      ) return;

      const key = event.key.toLowerCase();
      const action = key === '=' || key === '+'
        ? zoomIn
        : key === '-'
          ? zoomOut
          : key === '0'
            ? zoomReset
            : null;
      if (!action) return;

      event.preventDefault();
      action();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [zoomIn, zoomOut, zoomReset]);
}

interface MatchingFilePrompt {
  readonly loaded: LoadedDocument;
  readonly name: string;
  readonly sha256: string;
  readonly project: ProjectMetadata;
}

interface PendingSwitch {
  readonly fileName: string;
  open(): Promise<boolean>;
}

const SAVED_FILES_COLUMN_KEY = 'pedf.savedFilesColumn';
const PHONE_SAVED_FILES_QUERY = '(max-width: 767px)';

function savedFilesColumnInitiallyOpen(): boolean {
  try {
    return localStorage.getItem(SAVED_FILES_COLUMN_KEY) !== 'hidden';
  } catch {
    return true;
  }
}

function usePhoneLayout(): boolean {
  const [phone, setPhone] = useState(() => {
    try {
      return typeof matchMedia === 'function' && matchMedia(PHONE_SAVED_FILES_QUERY).matches;
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    let query: MediaQueryList;
    try {
      query = matchMedia(PHONE_SAVED_FILES_QUERY);
    } catch {
      return;
    }
    const update = () => setPhone(query.matches);
    update();
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);

  return phone;
}

function EditorApp() {
  const { document, setDocument, getPageCanvas } = useDocumentStore();
  const {
    edits,
    pagePlan,
    history,
    revision,
    changeCount,
    resetDocument,
    restoreDocument,
    addEdits,
  } = useEdits();
  useEditHistoryShortcuts();
  const [error, setError] = useState<string | null>(null);
  const [repairFile, setRepairFile] = useState<File | null>(null);
  const [draggingOverEmpty, setDraggingOverEmpty] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [lastPage, setLastPage] = useState(0);
  const [currentProject, setCurrentProject] = useState<ProjectMetadata | null>(null);
  const [currentSha256, setCurrentSha256] = useState<string | null>(null);
  const [storageIssue, setStorageIssue] = useState<'full' | 'unavailable' | null>(null);
  const [manualSaving, setManualSaving] = useState(false);
  const [evictionNote, setEvictionNote] = useState<string | null>(null);
  const [matchingFile, setMatchingFile] = useState<MatchingFilePrompt | null>(null);
  const [saveFailure, setSaveFailure] = useState<'full' | 'unavailable' | null>(null);
  const [pendingSwitch, setPendingSwitch] = useState<PendingSwitch | null>(null);
  const [closedNote, setClosedNote] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<'saved' | 'no-changes'>();
  const [savedFilesOpen, setSavedFilesOpen] = useState(savedFilesColumnInitiallyOpen);
  const [savedFilesDrawerOpen, setSavedFilesDrawerOpen] = useState(false);
  const phoneLayout = usePhoneLayout();
  const saveBusy = useRef(false);
  const scrollRef = useRef<HTMLElement>(null);
  const openingPlan = useRef<ReturnType<typeof createPagePlan> | null>(null);
  const pendingRestorePage = useRef<number | null>(null);
  const scrollFrame = useRef<number | null>(null);
  const pendingAnchor = useRef<ZoomAnchor | null>(null);
  const captureAnchor = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    pendingAnchor.current = captureZoomAnchor(scroll);
  }, []);
  const zoomIn = useCallback(() => {
    const next = clampZoom(zoom + ZOOM_STEP);
    if (next === zoom) return;
    captureAnchor();
    setZoom(next);
  }, [captureAnchor, zoom]);
  const zoomOut = useCallback(() => {
    const next = clampZoom(zoom - ZOOM_STEP);
    if (next === zoom) return;
    captureAnchor();
    setZoom(next);
  }, [captureAnchor, zoom]);
  const zoomReset = useCallback(() => {
    if (zoom === 1) return;
    captureAnchor();
    setZoom(1);
  }, [captureAnchor, zoom]);
  useZoomShortcuts(zoomIn, zoomOut, zoomReset);
  const [editMode, setEditMode] = useState(false);
  const [textAddMode, setTextAddMode] = useState(false);
  const [imageMode, setImageMode] = useState(false);
  const [peek, setPeek] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [signOpen, setSignOpen] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [downloadReady, setDownloadReady] = useState<{ url: string; name: string } | null>(null);
  const pendingFileChecked = useRef(false);
  const isTextDraftOpen = useCallback(
    () => Boolean(window.document.querySelector('[contenteditable="true"]')),
    [],
  );
  // Save handlers run after awaits (e.g. committing an open text box), so they read the latest render.
  const latest = useRef({ document, history, lastPage, zoom, changeCount, currentProject, currentSha256 });
  latest.current = { document, history, lastPage, zoom, changeCount, currentProject, currentSha256 };
  const hasChanges = openingPlan.current !== null
    && hasDocumentChanges(history.present, openingPlan.current);

  const createProject = useCallback(async (): Promise<CreateProjectResult> => {
    const current = latest.current;
    const startedDocument = current.document;
    const initialPlan = openingPlan.current;
    if (!startedDocument) return { outcome: 'no-project' };
    if (current.currentProject) {
      return { outcome: 'saved', projectId: current.currentProject.id };
    }
    if (!initialPlan || !hasDocumentChanges(current.history.present, initialPlan)) {
      return { outcome: 'no-changes' };
    }
    if (!current.currentSha256) {
      setStorageIssue('unavailable');
      return { outcome: 'unavailable' };
    }

    setManualSaving(true);
    try {
      const created = await projectStore.create({
        fileName: startedDocument.fileName,
        fileSize: startedDocument.loaded.originalBytes.byteLength,
        sha256: current.currentSha256,
        pageCount: current.history.present.plan.length,
        lastPage: current.lastPage,
        zoom: current.zoom,
        changeCount: current.changeCount,
        original: new Blob([startedDocument.loaded.originalBytes.slice().buffer], { type: 'application/pdf' }),
        state: serializeProject(current.history, current.lastPage, current.zoom),
      });
      if (created.status !== 'ok') {
        if (latest.current.document === startedDocument) setStorageIssue(created.status);
        return { outcome: created.status };
      }
      if (latest.current.document === startedDocument) {
        setCurrentProject(created.value);
        setStorageIssue(null);
        if (created.evicted) {
          setEvictionNote(`Older saved file ${created.evicted.fileName} was removed to make room.`);
        }
        return { outcome: 'saved', projectId: created.value.id };
      }
      return { outcome: 'saved' };
    } catch {
      if (latest.current.document === startedDocument) setStorageIssue('unavailable');
      return { outcome: 'unavailable' };
    } finally {
      setManualSaving(false);
    }
  }, []);

  const autosave = useProjectAutosave({
    projectId: currentProject?.id,
    initialSavedAt: currentProject?.updatedAt,
    documentKey: document?.loaded ?? null,
    snapshot: {
      history,
      revision,
      pageCount: pagePlan.length,
      lastPage,
      zoom,
      changeCount,
    },
    store: projectStore,
    hasChanges,
    createProject,
    isDraftOpen: isTextDraftOpen,
  });
  const saveStatus: SaveStatus = manualSaving ? 'saving' : storageIssue ?? autosave.status;

  useEffect(() => {
    if (!saveNotice) return;
    const timer = window.setTimeout(() => setSaveNotice(undefined), 2500);
    return () => window.clearTimeout(timer);
  }, [saveNotice]);

  useEffect(() => {
    setSavedFilesDrawerOpen(false);
  }, [phoneLayout]);

  useEffect(() => {
    if (!phoneLayout || !savedFilesDrawerOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSavedFilesDrawerOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [phoneLayout, savedFilesDrawerOpen]);

  const setInlineSavedFilesOpen = useCallback((open: boolean) => {
    setSavedFilesOpen(open);
    try {
      localStorage.setItem(SAVED_FILES_COLUMN_KEY, open ? 'open' : 'hidden');
    } catch {
      // The column still works for this visit when storage is unavailable.
    }
  }, []);

  const toggleSavedFiles = useCallback(() => {
    if (phoneLayout) {
      setSavedFilesDrawerOpen((open) => !open);
    } else {
      setInlineSavedFilesOpen(!savedFilesOpen);
    }
  }, [phoneLayout, savedFilesOpen, setInlineSavedFilesOpen]);

  useEffect(() => {
    if (!currentProject && !hasChanges) setStorageIssue(null);
  }, [currentProject, hasChanges]);

  const closeTransientUi = useCallback(() => {
    setEditMode(false);
    setTextAddMode(false);
    setImageMode(false);
    setChatOpen(false);
    setSignOpen(false);
  }, []);

  const activateFreshDocument = useCallback((
    loaded: LoadedDocument,
    name: string,
    sha256: string | null,
  ) => {
    const plan = createPagePlan(loaded.pages.length, pageId);
    setDocument({ loaded, fileName: name });
    setClosedNote(null);
    resetDocument(plan);
    openingPlan.current = plan.map((entry) => ({ ...entry }));
    setZoom(1);
    setLastPage(0);
    pendingRestorePage.current = null;
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
      scrollRef.current.scrollLeft = 0;
    }
    setCurrentSha256(sha256);
    setCurrentProject(null);
    setStorageIssue(null);
    setSaveNotice(undefined);
    closeTransientUi();
  }, [closeTransientUi, resetDocument, setDocument]);

  const restoreSavedProject = useCallback(async (id: string): Promise<boolean> => {
    setError(null);
    setRepairFile(null);
    const stored = await projectStore.load(id);
    if (stored.status !== 'ok' || !stored.value) {
      setError("This saved file can't be opened.");
      return false;
    }

    let loaded: LoadedDocument | undefined;
    try {
      loaded = await loadDocument(await stored.value.original.arrayBuffer());
      const restored = deserializeProject(stored.value.state, loaded.pages.length);
      if (!restored.ok) {
        void loaded.doc.destroy();
        setError("This saved file can't be opened.");
        return false;
      }
      setDocument({ loaded, fileName: stored.value.metadata.fileName });
      setClosedNote(null);
      restoreDocument(restored.value.history, stored.value.metadata.changeCount);
      openingPlan.current = restored.value.history.present.plan.map((entry) => ({ ...entry }));
      setZoom(restored.value.zoom);
      setLastPage(restored.value.lastPage);
      pendingRestorePage.current = restored.value.lastPage;
      setCurrentProject(stored.value.metadata);
      setCurrentSha256(stored.value.metadata.sha256);
      setStorageIssue(null);
      setSaveNotice(undefined);
      closeTransientUi();
      return true;
    } catch {
      if (loaded) void loaded.doc.destroy();
      setError("This saved file can't be opened.");
      return false;
    }
  }, [closeTransientUi, restoreDocument, setDocument]);

  useEffect(() => {
    const scroll = scrollRef.current;
    const content = scroll?.firstElementChild;
    if (!scroll || !content || typeof ResizeObserver === 'undefined') return;

    let settle: number | undefined;
    const observer = new ResizeObserver(() => {
      const anchor = pendingAnchor.current;
      if (!anchor) return;

      const position = scrollPositionForZoomAnchor(anchor, scroll);
      scroll.scrollTop = position.top;
      scroll.scrollLeft = position.left;
      window.clearTimeout(settle);
      settle = window.setTimeout(() => {
        pendingAnchor.current = null;
      }, 200);
    });
    observer.observe(content);

    return () => {
      observer.disconnect();
      window.clearTimeout(settle);
      pendingAnchor.current = null;
    };
  }, [document]);

  useEffect(() => {
    if (pagePlan.length === 0) return;
    setLastPage((page) => Math.min(page, pagePlan.length - 1));
  }, [pagePlan.length]);

  useEffect(() => () => {
    if (scrollFrame.current !== null) window.cancelAnimationFrame(scrollFrame.current);
  }, []);

  const updatePageInView = useCallback(() => {
    scrollFrame.current = null;
    const scroll = scrollRef.current;
    if (!scroll) return;
    const center = scroll.getBoundingClientRect().top + scroll.clientHeight / 2;
    let closestPage = 0;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const box of scroll.querySelectorAll<HTMLElement>('[data-page-index]')) {
      const index = Number(box.dataset.pageIndex);
      if (!Number.isInteger(index)) continue;
      const rect = box.getBoundingClientRect();
      if (rect.top <= center && rect.bottom >= center) {
        closestPage = index;
        closestDistance = 0;
        break;
      }
      const distance = Math.min(Math.abs(center - rect.top), Math.abs(center - rect.bottom));
      if (distance < closestDistance) {
        closestPage = index;
        closestDistance = distance;
      }
    }
    setLastPage((page) => (page === closestPage ? page : closestPage));
  }, []);

  const trackPageInView = useCallback(() => {
    if (scrollFrame.current !== null) return;
    scrollFrame.current = window.requestAnimationFrame(updatePageInView);
  }, [updatePageInView]);

  const restorePagePosition = useCallback(() => {
    const page = pendingRestorePage.current;
    const scroll = scrollRef.current;
    if (page === null || !scroll) return;
    const box = scroll.querySelector<HTMLElement>(`[data-page-index="${page}"]`);
    if (!box) return;
    const scrollRect = scroll.getBoundingClientRect();
    const boxRect = box.getBoundingClientRect();
    scroll.scrollTop += boxRect.top - scrollRect.top - 16;
    pendingRestorePage.current = null;
  }, []);

  const open = useCallback(async (source: File | ArrayBuffer, name: string): Promise<boolean> => {
    setError(null);
    setRepairFile(null);
    let loaded: LoadedDocument;
    try {
      loaded = await loadDocument(source);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      if (source instanceof File) setRepairFile(source);
      return false;
    }

    let sha256: string;
    try {
      sha256 = await sha256Hex(loaded.originalBytes);
    } catch {
      activateFreshDocument(loaded, name, null);
      return true;
    }

    const projects = await projectStore.list();
    if (projects.status === 'ok') {
      const matching = projects.value.find((project) => project.sha256 === sha256);
      if (matching) {
        setMatchingFile({ loaded, name, sha256, project: matching });
        return true;
      }
    }
    activateFreshDocument(loaded, name, sha256);
    return true;
  }, [activateFreshDocument]);

  useEffect(() => {
    if (pendingFileChecked.current) return;
    pendingFileChecked.current = true;
    const pendingProject = takePendingProject();
    const pendingFile = takePendingFile();
    if (pendingProject) void restoreSavedProject(pendingProject);
    else if (pendingFile) void open(pendingFile, pendingFile.name);
  }, [open, restoreSavedProject]);

  useEffect(() => {
    const loaded = document?.loaded;
    return () => {
      if (loaded) void loaded.doc.destroy();
    };
  }, [document]);

  useEffect(() => {
    return () => {
      if (downloadReady) URL.revokeObjectURL(downloadReady.url);
    };
  }, [downloadReady]);

  const sampleBackground = useCallback(
    (pageIndex: number, rect: PdfRect): Rgb => {
      const registration = getPageCanvas(pageIndex);
      if (!registration) return { r: 1, g: 1, b: 1 };

      const { canvas, viewport } = registration;
      const first = pdfToViewport(viewport, { x: rect.x, y: rect.y });
      const second = pdfToViewport(viewport, { x: rect.x + rect.w, y: rect.y + rect.h });
      const left = Math.max(0, Math.floor(Math.min(first.x, second.x)));
      const top = Math.max(0, Math.floor(Math.min(first.y, second.y)));
      const right = Math.min(canvas.width, Math.ceil(Math.max(first.x, second.x)));
      const bottom = Math.min(canvas.height, Math.ceil(Math.max(first.y, second.y)));
      const width = Math.max(1, right - left);
      const height = Math.max(1, bottom - top);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return { r: 1, g: 1, b: 1 };

      return sampleDominantColor(context.getImageData(left, top, width, height).data);
    },
    [getPageCanvas],
  );

  const handleExport = useCallback(async () => {
    if (!document || exporting) return;
    setError(null);
    setWarnings([]);
    setDownloadReady(null);
    setExporting(true);
    try {
      const pages = planToGeometry(pagePlan, document.loaded.pages);
      const result = await exportPdf({
        originalBytes: document.loaded.originalBytes,
        edits: [...edits],
        pages,
        plan: pagePlan,
        sampleBackground,
      });
      const blob = new Blob([result.bytes.slice().buffer], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const anchor = window.document.createElement('a');
      const baseName = document.fileName.replace(/\.pdf$/i, '');
      anchor.href = url;
      const downloadName = `${baseName}-edited.pdf`;
      anchor.download = downloadName;
      anchor.hidden = true;
      window.document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setDownloadReady({ url, name: downloadName });
      setWarnings(result.warnings);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setExporting(false);
    }
  }, [document, edits, exporting, pagePlan, sampleBackground]);

  /** Saves now, creating the project only when this document has its first real change. */
  const saveProjectNow = autosave.saveNow;

  /** Ctrl/Cmd+S: save and keep working. An open text box is left alone; autosave picks it up on Done. */
  const handleSave = useCallback(async () => {
    if (!latest.current.document || saveBusy.current || isTextDraftOpen()) return;
    saveBusy.current = true;
    try {
      const outcome = await saveProjectNow();
      if (outcome === 'saved' || outcome === 'no-changes') setSaveNotice(outcome);
    } finally {
      saveBusy.current = false;
    }
  }, [isTextDraftOpen, saveProjectNow]);

  /** Presses the open text box's Done so its typing is part of the save. */
  const finishOpenTextBox = useCallback(async (): Promise<boolean> => {
    if (!isTextDraftOpen()) return true;
    const done = window.document.querySelector<HTMLButtonElement>('[data-text-edit-done]');
    if (!done || done.disabled) return false;
    done.click();
    for (let attempt = 0; attempt < 50 && isTextDraftOpen(); attempt++) {
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    }
    return !isTextDraftOpen();
  }, [isTextDraftOpen]);

  const saveBeforeSwitch = useCallback(async (
    fileName: string,
    openTarget: () => Promise<boolean>,
  ): Promise<boolean> => {
    if (!latest.current.document) return openTarget();
    if (saveBusy.current) return false;
    saveBusy.current = true;
    try {
      if (!(await finishOpenTextBox())) {
        setError('Finish or cancel the open text box, then open the other file.');
        return false;
      }
      const outcome = await saveProjectNow();
      if (outcome === 'saved' || outcome === 'no-changes') {
        setError(null);
        return await openTarget();
      }
      if (outcome === 'draft') {
        setError('Finish or cancel the open text box, then open the other file.');
        return false;
      }
      const failure = outcome === 'full' ? 'full' : 'unavailable';
      setPendingSwitch({ fileName, open: openTarget });
      setSaveFailure(failure);
      return false;
    } finally {
      saveBusy.current = false;
    }
  }, [finishOpenTextBox, saveProjectNow]);

  const switchToSavedProject = useCallback(async (id: string): Promise<boolean> => {
    if (latest.current.currentProject?.id === id) return true;
    if (phoneLayout) setSavedFilesDrawerOpen(false);
    const listed = await projectStore.list();
    const fileName = listed.status === 'ok'
      ? listed.value.find((project) => project.id === id)?.fileName ?? 'saved file'
      : 'saved file';
    return saveBeforeSwitch(fileName, () => restoreSavedProject(id));
  }, [phoneLayout, restoreSavedProject, saveBeforeSwitch]);

  const openFile = useCallback(
    (file: File) => saveBeforeSwitch(file.name, () => open(file, file.name)),
    [open, saveBeforeSwitch],
  );

  const closeDocument = useCallback((note: string | null) => {
    closeTransientUi();
    setSaveFailure(null);
    setPendingSwitch(null);
    setDocument(null);
    resetDocument([]);
    setCurrentProject(null);
    setCurrentSha256(null);
    openingPlan.current = null;
    setStorageIssue(null);
    setSaveNotice(undefined);
    setZoom(1);
    setLastPage(0);
    pendingRestorePage.current = null;
    setError(null);
    setRepairFile(null);
    setWarnings([]);
    setClosedNote(note);
  }, [closeTransientUi, resetDocument, setDocument]);

  /** The Save & close button: save every change, then go back to the start screen. */
  const handleSaveAndClose = useCallback(async () => {
    const fileName = latest.current.document?.fileName;
    if (!fileName || saveBusy.current) return;
    saveBusy.current = true;
    try {
      if (!(await finishOpenTextBox())) {
        setError('Finish or cancel the open text box, then press Save & close again.');
        return;
      }
      const outcome = await saveProjectNow();
      if (outcome === 'saved') {
        closeDocument(`Saved ${fileName} on this device — continue editing anytime.`);
      } else if (outcome === 'no-changes') {
        closeDocument(`No changes to save — closed ${fileName}.`);
      } else if (outcome === 'draft') {
        setError('Finish or cancel the open text box, then press Save & close again.');
      } else if (outcome === 'full' || outcome === 'unavailable') {
        setPendingSwitch(null);
        setSaveFailure(outcome);
      } else {
        setPendingSwitch(null);
        setSaveFailure('unavailable');
      }
    } finally {
      saveBusy.current = false;
    }
  }, [closeDocument, finishOpenTextBox, saveProjectNow]);

  const addSignature = useCallback((signature: SignatureAsset) => {
    if (!document) return;
    const geometries = planToGeometry(pagePlan, document.loaded.pages);
    const viewport = scrollRef.current?.getBoundingClientRect();
    let pageIndex = 0;
    let bestVisible = -1;
    for (let index = 0; index < geometries.length; index++) {
      const rect = getPageCanvas(index)?.canvas.getBoundingClientRect();
      if (!rect || !viewport) continue;
      const width = Math.max(0, Math.min(rect.right, viewport.right) - Math.max(rect.left, viewport.left));
      const height = Math.max(0, Math.min(rect.bottom, viewport.bottom) - Math.max(rect.top, viewport.top));
      const visible = width * height;
      if (visible > bestVisible) { bestVisible = visible; pageIndex = index; }
    }
    const page = geometries[pageIndex];
    if (!page) return;
    const image = editorSignatureEdit(signature, pageIndex, page, edits);
    addEdits([image]);
    setSignOpen(false);
  }, [addEdits, document, edits, getPageCanvas, pagePlan]);

  return (
    <div className="flex h-full flex-col bg-neutral-100">
      <Toolbar
        onOpen={(file) => void openFile(file)}
        fileName={document?.fileName ?? null}
        editMode={editMode}
        textAddMode={textAddMode}
        imageMode={imageMode}
        hasEdits={edits.length > 0}
        exporting={exporting}
        saveStatus={saveStatus}
        savedAt={autosave.savedAt}
        saveNotice={saveNotice}
        savedFilesOpen={phoneLayout ? savedFilesDrawerOpen : savedFilesOpen}
        zoom={zoom}
        zoomIn={zoomIn}
        zoomOut={zoomOut}
        zoomReset={zoomReset}
        onEditModeChange={(enabled) => {
          setEditMode(enabled);
          if (enabled) {
            setTextAddMode(false);
            setImageMode(false);
          }
        }}
        onTextAddModeChange={(enabled) => {
          setTextAddMode(enabled);
          if (enabled) {
            setEditMode(false);
            setImageMode(false);
          }
        }}
        onImageModeChange={(enabled) => {
          setImageMode(enabled);
          if (enabled) {
            setEditMode(false);
            setTextAddMode(false);
          }
        }}
        onOpenSign={() => setSignOpen(true)}
        onOpenChat={() => {
          setSettingsOpen(false);
          setChatOpen(true);
        }}
        onOpenSettings={() => {
          setChatOpen(false);
          setSettingsOpen(true);
        }}
        onToggleSavedFiles={toggleSavedFiles}
        onPeekChange={setPeek}
        onExport={() => void handleExport()}
        onSave={() => void handleSave()}
        onSaveAndClose={() => void handleSaveAndClose()}
      />
      <SettingsPanel
        open={settingsOpen}
        fileOpen={Boolean(document)}
        projectStore={projectStore}
        onClose={() => setSettingsOpen(false)}
      />
      <SignatureModal open={signOpen} onClose={() => setSignOpen(false)} onDone={addSignature} />
      <PdfChat
        open={chatOpen}
        doc={document?.loaded.doc ?? null}
        onClose={() => setChatOpen(false)}
        onOpenSettings={() => {
          setChatOpen(false);
          setSettingsOpen(true);
        }}
      />
      <div className="relative flex min-h-0 flex-1">
        {!phoneLayout && savedFilesOpen && (
          <SavedFilesColumn
            store={projectStore}
            currentProjectId={currentProject?.id}
            onOpen={switchToSavedProject}
            onHide={() => setInlineSavedFilesOpen(false)}
          />
        )}
        <main
          ref={scrollRef}
          className="min-w-0 flex-1 overflow-auto"
          onScroll={trackPageInView}
          onDragOver={(event) => {
            if (!document) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
          }}
          onDrop={(event) => {
            if (!document) return;
            event.preventDefault();
            const file = event.dataTransfer.files[0];
            if (!file) return;
            if (!isPdf(file)) {
              setError('Choose a PDF file.');
              return;
            }
            void openFile(file);
          }}
        >
        {error && (
          <div className="m-4 flex flex-wrap items-center gap-3 rounded bg-red-100 p-3 text-sm text-red-800">
            <span>{error}</span>
            {repairFile && <button type="button" className="rounded border border-red-300 bg-white px-3 py-2 font-semibold text-red-800"
              onClick={() => {
                setPendingFiles([repairFile]);
                navigate('/tools/repair');
              }}>Try Repair PDF</button>}
          </div>
        )}
        {document ? (
          <PdfViewer
            doc={document.loaded.doc}
            originalPages={document.loaded.pages}
            zoom={zoom}
            editMode={editMode}
            textAddMode={textAddMode}
            imageMode={imageMode}
            peek={peek}
            onLayout={restorePagePosition}
          />
        ) : (
          <div
            role="region"
            aria-label="PDF drop area"
            className={`flex h-full flex-col items-center justify-center gap-5 px-6 text-center text-neutral-500 ${draggingOverEmpty ? 'bg-blue-50 outline-2 -outline-offset-4 outline-blue-400' : ''}`}
            onDragEnter={(event) => {
              event.preventDefault();
              setDraggingOverEmpty(true);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'copy';
            }}
            onDragLeave={(event) => {
              if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
              setDraggingOverEmpty(false);
            }}
            onDrop={(event) => {
              setDraggingOverEmpty(false);
              // The shared box handles its own drops; bubbling must not open twice.
              if (event.defaultPrevented) return;
              event.preventDefault();
              const file = event.dataTransfer.files[0];
              if (!file) return;
              if (!isPdf(file)) {
                setError('Choose a PDF file.');
                return;
              }
              void openFile(file);
            }}
          >
            {closedNote && (
              <p role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-medium text-emerald-900">
                {closedNote}
              </p>
            )}
            <ContinueEditingCard store={projectStore} onContinue={restoreSavedProject} />
            <p>Open a PDF to begin.</p>
            <PdfDropZone onFile={(file) => void openFile(file)} onError={setError} />
          </div>
        )}
        </main>
        {phoneLayout && savedFilesDrawerOpen && (
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Saved files drawer"
            className="fixed inset-x-0 bottom-0 top-14 z-[170] flex bg-neutral-950/45"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setSavedFilesDrawerOpen(false);
            }}
          >
            <SavedFilesColumn
              store={projectStore}
              currentProjectId={currentProject?.id}
              mode="drawer"
              onOpen={switchToSavedProject}
              onHide={() => setSavedFilesDrawerOpen(false)}
            />
          </div>
        )}
      </div>
      {matchingFile && (
        <div className="fixed inset-0 z-[190] flex items-center justify-center bg-neutral-950/45 p-4">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="matching-save-title"
            className="w-full max-w-md rounded-xl border border-neutral-200 bg-white p-6 shadow-2xl"
          >
            <h2 id="matching-save-title" className="text-lg font-semibold text-neutral-900">
              You have saved edits for <em>{matchingFile.project.fileName}</em>
            </h2>
            <p className="mt-2 text-sm text-neutral-600">Continue from them or start fresh?</p>
            <div className="mt-5 flex flex-wrap justify-end gap-3">
              <button
                type="button"
                className="rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm font-semibold text-neutral-700 hover:bg-neutral-100"
                onClick={() => {
                  const match = matchingFile;
                  activateFreshDocument(match.loaded, match.name, match.sha256);
                  setMatchingFile(null);
                }}
              >
                Start fresh
              </button>
              <button
                type="button"
                className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-600"
                onClick={() => {
                  const match = matchingFile;
                  void restoreSavedProject(match.project.id).then((restored) => {
                    if (!restored) return;
                    void match.loaded.doc.destroy();
                    setMatchingFile(null);
                  });
                }}
              >
                Continue from them
              </button>
            </div>
          </section>
        </div>
      )}
      {saveFailure && document && (
        <div className="fixed inset-0 z-[190] flex items-center justify-center bg-neutral-950/45 p-4">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="save-failed-title"
            className="w-full max-w-md rounded-xl border border-neutral-200 bg-white p-6 shadow-2xl"
          >
            <h2 id="save-failed-title" className="text-lg font-semibold text-neutral-900">
              Couldn't save on this device
            </h2>
            <p className="mt-2 text-sm text-neutral-600">
              {saveFailure === 'full'
                ? `There isn't enough space on this device to save ${document.fileName}.`
                : `This browser isn't allowing PEDF Studio to save ${document.fileName} (for example in a private window).`}
              {' '}Your file is still open. Export your PDF to keep your work.
            </p>
            <div className="mt-5 flex flex-wrap justify-end gap-3">
              <button
                type="button"
                className="rounded-md px-4 py-2 text-sm font-semibold text-neutral-700 hover:bg-neutral-100"
                onClick={() => {
                  setSaveFailure(null);
                  setPendingSwitch(null);
                }}
              >
                Keep editing
              </button>
              <button
                type="button"
                className="rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-50"
                onClick={() => {
                  if (!pendingSwitch) {
                    closeDocument(null);
                    return;
                  }

                  const next = pendingSwitch.open;
                  setPendingSwitch(null);
                  setSaveFailure(null);
                  void next();
                }}
              >
                {pendingSwitch
                  ? `Open ${pendingSwitch.fileName} without saving`
                  : 'Close without saving'}
              </button>
              <button
                type="button"
                className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500"
                onClick={() => {
                  setSaveFailure(null);
                  setPendingSwitch(null);
                  void handleExport();
                }}
              >
                Export PDF
              </button>
            </div>
          </section>
        </div>
      )}
      {evictionNote && (
        <aside className="fixed right-4 top-16 z-[180] flex max-w-sm items-start gap-3 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-950 shadow-xl" role="status">
          <span>{evictionNote}</span>
          <button type="button" onClick={() => setEvictionNote(null)} className="rounded px-1 text-lg leading-none hover:bg-blue-100" aria-label="Dismiss saved-file notice">×</button>
        </aside>
      )}
      {warnings.length > 0 && (
        <aside className="fixed bottom-4 right-4 z-[100] max-w-md rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 shadow-xl" role="status">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-semibold">Exported with font substitutions</p>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {warnings.map((warning) => <li key={warning}>{warning}</li>)}
              </ul>
            </div>
            <button type="button" onClick={() => setWarnings([])} className="rounded px-1 text-lg leading-none hover:bg-amber-100" aria-label="Dismiss export warnings">×</button>
          </div>
        </aside>
      )}
      {downloadReady && (
        <aside className="fixed bottom-4 left-4 z-[100] flex items-center gap-3 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-950 shadow-xl" role="status">
          <span>Export ready</span>
          <a href={downloadReady.url} download={downloadReady.name} className="rounded bg-emerald-700 px-3 py-1.5 font-semibold text-white hover:bg-emerald-600">
            Download edited PDF
          </a>
          <button type="button" onClick={() => setDownloadReady(null)} className="rounded px-1 text-lg leading-none hover:bg-emerald-100" aria-label="Dismiss download">×</button>
        </aside>
      )}
    </div>
  );
}

export default function App() {
  return (
    <PrefsStoreProvider>
      <DocumentStoreProvider>
        <EditsStoreProvider>
          <EditorApp />
        </EditsStoreProvider>
      </DocumentStoreProvider>
    </PrefsStoreProvider>
  );
}
