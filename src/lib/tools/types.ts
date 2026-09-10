import type { ComponentType, ReactNode } from 'react';

export interface ToolOutput {
  name: string;
  bytes: Uint8Array;
  mime: string;
}

export type ToolOptions = Record<string, unknown>;

export interface ToolContext {
  onProgress(done: number, total: number, label: string): void;
  onWarning?(message: string): void;
  signal: AbortSignal;
}

export interface ToolOptionsProps {
  options: ToolOptions;
  onChange(options: ToolOptions): void;
  inputs: File[];
  disabled: boolean;
}

export interface ToolDefinition {
  slug: string;
  title: string;
  description: string;
  accepts: 'pdf' | 'image' | 'pdf-or-image';
  multiple: boolean;
  minInputs?: number;
  canRun?(options: ToolOptions, inputs: File[]): string | undefined;
  run(inputs: File[], options: ToolOptions, ctx: ToolContext): Promise<ToolOutput[]>;
  Options?: ComponentType<ToolOptionsProps>;
  defaultOptions: ToolOptions;
  icon?: ReactNode;
  /** Internal verification tools stay reachable by URL, but off the public grid. */
  hidden?: boolean;
}
