import {
  cloneSerializedProject,
  PROJECT_FORMAT_VERSION,
} from './projectState';
import type { SerializedProject } from './projectState';

export const PROJECT_DATABASE_NAME = 'pedf-projects';
export const MAX_SAVED_PROJECTS = 10;

export interface ProjectMetadata {
  readonly id: string;
  readonly fileName: string;
  readonly fileSize: number;
  readonly sha256: string;
  /** The current number of pages, including page-plan changes. */
  readonly pageCount: number;
  readonly lastPage: number;
  readonly zoom: number;
  readonly changeCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly formatVersion: typeof PROJECT_FORMAT_VERSION;
}

export interface StoredProject {
  readonly metadata: ProjectMetadata;
  readonly original: Blob;
  readonly state: SerializedProject;
}

export interface CreateProjectInput {
  readonly id?: string;
  readonly fileName: string;
  readonly fileSize: number;
  readonly sha256: string;
  readonly pageCount: number;
  readonly lastPage: number;
  readonly zoom: number;
  readonly changeCount: number;
  readonly original: Blob;
  readonly state: SerializedProject;
}

export interface SaveProjectProgress {
  /** The current number of pages, including page-plan changes. */
  readonly pageCount: number;
  readonly lastPage: number;
  readonly zoom: number;
  readonly changeCount: number;
}

export type ProjectStoreResult<T> =
  | { readonly status: 'ok'; readonly value: T; readonly evicted?: ProjectMetadata }
  | { readonly status: 'full' }
  | { readonly status: 'unavailable' };

export interface ProjectStore {
  subscribe(listener: () => void): () => void;
  create(input: CreateProjectInput): Promise<ProjectStoreResult<ProjectMetadata>>;
  saveState(
    id: string,
    state: SerializedProject,
    progress: SaveProjectProgress,
  ): Promise<ProjectStoreResult<ProjectMetadata>>;
  load(id: string): Promise<ProjectStoreResult<StoredProject | undefined>>;
  list(): Promise<ProjectStoreResult<readonly ProjectMetadata[]>>;
  delete(id: string): Promise<ProjectStoreResult<void>>;
  deleteAll(): Promise<ProjectStoreResult<void>>;
}

type ProjectOperation = 'create' | 'saveState' | 'load' | 'list' | 'delete' | 'deleteAll';
type FailureFactory = (operation: ProjectOperation) => unknown;

function projectId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `project-${crypto.randomUUID()}`;
  }
  return `project-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function cloneMetadata(metadata: ProjectMetadata): ProjectMetadata {
  return { ...metadata };
}

function cloneBlob(blob: Blob): Blob {
  return blob.slice(0, blob.size, blob.type);
}

function classifyError(error: unknown): 'full' | 'unavailable' {
  return isRecord(error) && error.name === 'QuotaExceededError' ? 'full' : 'unavailable';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function newestFirst(projects: readonly ProjectMetadata[]): ProjectMetadata[] {
  return [...projects].sort((left, right) => right.updatedAt - left.updatedAt);
}

export class MemoryProjectStore implements ProjectStore {
  private readonly projects = new Map<string, ProjectMetadata>();
  private readonly originals = new Map<string, Blob>();
  private readonly states = new Map<string, SerializedProject>();
  private readonly originalWrites = new Map<string, number>();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly failure?: FailureFactory,
  ) {}

  originalWriteCount(id: string): number {
    return this.originalWrites.get(id) ?? 0;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A subscriber must not turn a successful storage write into a failure.
      }
    }
  }

  private async guard<T>(operation: ProjectOperation, action: () => T): Promise<ProjectStoreResult<T>> {
    try {
      const failure = this.failure?.(operation);
      if (failure) throw failure;
      return { status: 'ok', value: action() };
    } catch (error) {
      return { status: classifyError(error) };
    }
  }

  async create(input: CreateProjectInput): Promise<ProjectStoreResult<ProjectMetadata>> {
    const result = await this.guard('create', () => {
      const timestamp = this.now();
      const id = input.id ?? projectId();
      const metadata: ProjectMetadata = {
        id,
        fileName: input.fileName,
        fileSize: input.fileSize,
        sha256: input.sha256,
        pageCount: input.pageCount,
        lastPage: input.lastPage,
        zoom: input.zoom,
        changeCount: input.changeCount,
        createdAt: timestamp,
        updatedAt: timestamp,
        formatVersion: PROJECT_FORMAT_VERSION,
      };
      const evicted = !this.projects.has(id) && this.projects.size >= MAX_SAVED_PROJECTS
        ? [...this.projects.values()].sort((left, right) => left.updatedAt - right.updatedAt)[0]
        : undefined;
      this.projects.set(id, metadata);
      this.originals.set(id, cloneBlob(input.original));
      this.states.set(id, cloneSerializedProject(input.state));
      this.originalWrites.set(id, (this.originalWrites.get(id) ?? 0) + 1);
      if (evicted) {
        this.projects.delete(evicted.id);
        this.originals.delete(evicted.id);
        this.states.delete(evicted.id);
      }
      return { metadata, evicted };
    });
    if (result.status !== 'ok') return result;
    this.notify();
    return {
      status: 'ok',
      value: cloneMetadata(result.value.metadata),
      ...(result.value.evicted ? { evicted: cloneMetadata(result.value.evicted) } : {}),
    };
  }

  async saveState(
    id: string,
    state: SerializedProject,
    progress: SaveProjectProgress,
  ): Promise<ProjectStoreResult<ProjectMetadata>> {
    const result = await this.guard('saveState', () => {
      const existing = this.projects.get(id);
      if (!existing) throw new Error('Saved project not found');
      const metadata: ProjectMetadata = {
        ...existing,
        ...progress,
        updatedAt: this.now(),
      };
      this.projects.set(id, metadata);
      this.states.set(id, cloneSerializedProject(state));
      return cloneMetadata(metadata);
    });
    if (result.status === 'ok') this.notify();
    return result;
  }

  async load(id: string): Promise<ProjectStoreResult<StoredProject | undefined>> {
    return this.guard('load', () => {
      const metadata = this.projects.get(id);
      const original = this.originals.get(id);
      const state = this.states.get(id);
      if (!metadata || !original || !state) return undefined;
      return {
        metadata: cloneMetadata(metadata),
        original: cloneBlob(original),
        state: cloneSerializedProject(state),
      };
    });
  }

  async list(): Promise<ProjectStoreResult<readonly ProjectMetadata[]>> {
    return this.guard('list', () => newestFirst([...this.projects.values()]).map(cloneMetadata));
  }

  async delete(id: string): Promise<ProjectStoreResult<void>> {
    const result = await this.guard('delete', () => {
      this.projects.delete(id);
      this.originals.delete(id);
      this.states.delete(id);
      this.originalWrites.delete(id);
    });
    if (result.status === 'ok') this.notify();
    return result;
  }

  async deleteAll(): Promise<ProjectStoreResult<void>> {
    const result = await this.guard('deleteAll', () => {
      this.projects.clear();
      this.originals.clear();
      this.states.clear();
      this.originalWrites.clear();
    });
    if (result.status === 'ok') this.notify();
    return result;
  }
}

interface OriginalRecord {
  readonly id: string;
  readonly blob: Blob;
}

interface StateRecord {
  readonly id: string;
  readonly state: SerializedProject;
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
  });
}

export class IndexedDbProjectStore implements ProjectStore {
  private databasePromise?: Promise<IDBDatabase>;
  private persistenceRequested = false;
  private readonly listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A subscriber must not turn a successful storage write into a failure.
      }
    }
  }

  private async database(): Promise<IDBDatabase> {
    if (typeof indexedDB === 'undefined') throw new Error('IndexedDB unavailable');
    this.databasePromise ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(PROJECT_DATABASE_NAME, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains('projects')) {
          database.createObjectStore('projects', { keyPath: 'id' });
        }
        if (!database.objectStoreNames.contains('originals')) {
          database.createObjectStore('originals', { keyPath: 'id' });
        }
        if (!database.objectStoreNames.contains('states')) {
          database.createObjectStore('states', { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB unavailable'));
      request.onblocked = () => reject(new Error('IndexedDB blocked'));
    });
    return this.databasePromise;
  }

  private requestPersistence(): void {
    if (this.persistenceRequested) return;
    this.persistenceRequested = true;
    try {
      void navigator.storage?.persist?.().catch(() => undefined);
    } catch {
      // Persistence is a best-effort hint; IndexedDB still works without it.
    }
  }

  private async guard<T>(action: () => Promise<T>): Promise<ProjectStoreResult<T>> {
    try {
      return { status: 'ok', value: await action() };
    } catch (error) {
      return { status: classifyError(error) };
    }
  }

  async create(input: CreateProjectInput): Promise<ProjectStoreResult<ProjectMetadata>> {
    this.requestPersistence();
    const result = await this.guard(async () => {
      const database = await this.database();
      const transaction = database.transaction(['projects', 'originals', 'states'], 'readwrite');
      const projectsStore = transaction.objectStore('projects');
      const projects = await requestValue(projectsStore.getAll() as IDBRequest<ProjectMetadata[]>);
      const timestamp = Date.now();
      const metadata: ProjectMetadata = {
        id: input.id ?? projectId(),
        fileName: input.fileName,
        fileSize: input.fileSize,
        sha256: input.sha256,
        pageCount: input.pageCount,
        lastPage: input.lastPage,
        zoom: input.zoom,
        changeCount: input.changeCount,
        createdAt: timestamp,
        updatedAt: timestamp,
        formatVersion: PROJECT_FORMAT_VERSION,
      };
      const evicted = !projects.some((project) => project.id === metadata.id)
        && projects.length >= MAX_SAVED_PROJECTS
        ? [...projects].sort((left, right) => left.updatedAt - right.updatedAt)[0]
        : undefined;
      projectsStore.put(metadata);
      transaction.objectStore('originals').put({ id: metadata.id, blob: input.original } as OriginalRecord);
      transaction.objectStore('states').put({ id: metadata.id, state: input.state } as StateRecord);
      if (evicted && evicted.id !== metadata.id) {
        projectsStore.delete(evicted.id);
        transaction.objectStore('originals').delete(evicted.id);
        transaction.objectStore('states').delete(evicted.id);
      }
      await transactionDone(transaction);
      return { metadata, evicted };
    });
    if (result.status !== 'ok') return result;
    this.notify();
    return {
      status: 'ok',
      value: result.value.metadata,
      ...(result.value.evicted ? { evicted: result.value.evicted } : {}),
    };
  }

  async saveState(
    id: string,
    state: SerializedProject,
    progress: SaveProjectProgress,
  ): Promise<ProjectStoreResult<ProjectMetadata>> {
    this.requestPersistence();
    const result = await this.guard(async () => {
      const database = await this.database();
      const transaction = database.transaction(['projects', 'states'], 'readwrite');
      const projects = transaction.objectStore('projects');
      const existing = await requestValue(projects.get(id) as IDBRequest<ProjectMetadata | undefined>);
      if (!existing) throw new Error('Saved project not found');
      const metadata: ProjectMetadata = { ...existing, ...progress, updatedAt: Date.now() };
      projects.put(metadata);
      transaction.objectStore('states').put({ id, state } as StateRecord);
      await transactionDone(transaction);
      return metadata;
    });
    if (result.status === 'ok') this.notify();
    return result;
  }

  async load(id: string): Promise<ProjectStoreResult<StoredProject | undefined>> {
    return this.guard(async () => {
      const database = await this.database();
      const transaction = database.transaction(['projects', 'originals', 'states'], 'readonly');
      const [metadata, originalRecord, stateRecord] = await Promise.all([
        requestValue(transaction.objectStore('projects').get(id) as IDBRequest<ProjectMetadata | undefined>),
        requestValue(transaction.objectStore('originals').get(id) as IDBRequest<OriginalRecord | undefined>),
        requestValue(transaction.objectStore('states').get(id) as IDBRequest<StateRecord | undefined>),
      ]);
      await transactionDone(transaction);
      if (!metadata || !originalRecord?.blob || !stateRecord?.state) return undefined;
      return { metadata, original: originalRecord.blob, state: stateRecord.state };
    });
  }

  async list(): Promise<ProjectStoreResult<readonly ProjectMetadata[]>> {
    return this.guard(async () => {
      const database = await this.database();
      const transaction = database.transaction('projects', 'readonly');
      const projects = await requestValue(
        transaction.objectStore('projects').getAll() as IDBRequest<ProjectMetadata[]>,
      );
      await transactionDone(transaction);
      return newestFirst(projects);
    });
  }

  async delete(id: string): Promise<ProjectStoreResult<void>> {
    const result = await this.guard(async () => {
      const database = await this.database();
      const transaction = database.transaction(['projects', 'originals', 'states'], 'readwrite');
      for (const name of ['projects', 'originals', 'states']) transaction.objectStore(name).delete(id);
      await transactionDone(transaction);
    });
    if (result.status === 'ok') this.notify();
    return result;
  }

  async deleteAll(): Promise<ProjectStoreResult<void>> {
    const result = await this.guard(async () => {
      const database = await this.database();
      const transaction = database.transaction(['projects', 'originals', 'states'], 'readwrite');
      for (const name of ['projects', 'originals', 'states']) transaction.objectStore(name).clear();
      await transactionDone(transaction);
    });
    if (result.status === 'ok') this.notify();
    return result;
  }
}

export const projectStore: ProjectStore = new IndexedDbProjectStore();

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('SHA-256 unavailable');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}
