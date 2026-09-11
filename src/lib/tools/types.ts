import type { ComponentType, ReactNode } from 'react';

export interface ToolOutput {
  name: string;
  bytes: Uint8Array;
  mime: string;
  note?: { text: string; tone: 'ok' | 'warn' | 'danger' };
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
  /**
   * Shown in the file card when its thumbnail cannot be drawn (default: the reading error, in red). Repair uses a
   * calm hint instead, because damaged files are expected there and its own file check explains them.
   */
  previewFailureText?: string;
  /** Internal verification tools stay reachable by URL, but off the public grid. */
  hidden?: boolean;
}
