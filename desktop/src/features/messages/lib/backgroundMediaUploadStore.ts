import * as React from "react";

import type { BlobDescriptor } from "@/shared/api/tauri";
import { uploadMediaFile } from "@/shared/api/tauriMedia";

export type QueuedMediaAttachment = {
  file: File;
  id: number;
  previewUrl?: string;
};

type BackgroundUploadTask = {
  canceled: boolean;
  fileProgress: number[];
  id: number;
};

type BackgroundUploadSnapshot = {
  isUploading: boolean;
  percentage: number;
};

type EnqueueBackgroundUploadOptions = {
  attachments: QueuedMediaAttachment[];
  onComplete: (descriptors: BlobDescriptor[]) => Promise<void>;
  onError: (error: unknown) => void;
};

type StartBackgroundUploadOptions = Omit<
  EnqueueBackgroundUploadOptions,
  "attachments"
>;

export type PreparedBackgroundMediaUpload = {
  cancel: () => void;
  start: (options: StartBackgroundUploadOptions) => boolean;
};

const tasks = new Map<number, BackgroundUploadTask>();
const listeners = new Set<() => void>();
let nextTaskId = 0;
let snapshot: BackgroundUploadSnapshot = {
  isUploading: false,
  percentage: 0,
};
let stopProgressListener: (() => void) | null = null;
let progressListenerPromise: Promise<void> | null = null;

function progressId(taskId: number, fileIndex: number): string {
  return `background-media-upload-${taskId}-${fileIndex}`;
}

function rebuildSnapshot(): void {
  const allProgress = [...tasks.values()].flatMap((task) => task.fileProgress);
  snapshot = {
    isUploading: allProgress.length > 0,
    percentage:
      allProgress.length === 0
        ? 0
        : Math.round(
            allProgress.reduce((total, progress) => total + progress, 0) /
              allProgress.length,
          ),
  };
  for (const listener of listeners) listener();
}

async function ensureProgressListener(): Promise<void> {
  if (stopProgressListener || progressListenerPromise) return;
  progressListenerPromise = (async () => {
    try {
      const { listen } = await import("@tauri-apps/api/event");
      const dispose = await listen<{
        id: string;
        sent: number;
        total: number;
      }>("media-upload-progress", (event) => {
        const match = /^background-media-upload-(\d+)-(\d+)$/.exec(
          event.payload.id,
        );
        if (!match || event.payload.total <= 0) return;

        const task = tasks.get(Number(match[1]));
        const fileIndex = Number(match[2]);
        if (!task || fileIndex >= task.fileProgress.length) return;

        task.fileProgress[fileIndex] = Math.min(
          100,
          Math.max(
            0,
            Math.round((event.payload.sent / event.payload.total) * 100),
          ),
        );
        rebuildSnapshot();
      });
      if (tasks.size === 0) dispose();
      else stopProgressListener = dispose;
    } catch {
      // Browser and E2E runtimes do not emit native byte-level progress.
    } finally {
      progressListenerPromise = null;
    }
  })();
  await progressListenerPromise;
}

function finishTask(taskId: number): void {
  tasks.delete(taskId);
  rebuildSnapshot();
  if (tasks.size === 0 && stopProgressListener) {
    stopProgressListener();
    stopProgressListener = null;
  }
}

function yieldForUploadFeedback(): Promise<void> {
  if (
    typeof window === "undefined" ||
    typeof window.requestAnimationFrame !== "function" ||
    document.visibilityState === "hidden"
  ) {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  return new Promise((resolve) => {
    window.requestAnimationFrame(() => window.setTimeout(resolve, 0));
  });
}

export function prepareBackgroundMediaUpload(
  attachments: QueuedMediaAttachment[],
): PreparedBackgroundMediaUpload {
  if (attachments.length === 0) {
    let started = false;
    return {
      cancel: () => undefined,
      start: ({ onComplete, onError }) => {
        if (started) return false;
        started = true;
        void onComplete([]).catch(onError);
        return true;
      },
    };
  }

  const taskId = nextTaskId;
  nextTaskId += 1;
  const task: BackgroundUploadTask = {
    canceled: false,
    fileProgress: attachments.map(() => 0),
    id: taskId,
  };
  let started = false;
  tasks.set(taskId, task);
  rebuildSnapshot();

  return {
    cancel: () => {
      if (task.canceled) return;
      task.canceled = true;
      finishTask(taskId);
    },
    start: ({ onComplete, onError }) => {
      if (started || task.canceled) return false;
      started = true;
      void ensureProgressListener();

      void (async () => {
        try {
          // Let React commit and paint the 0% task before file reads or native
          // IPC begin, so large attachments never hide the initial feedback.
          await yieldForUploadFeedback();
          const descriptors: BlobDescriptor[] = [];
          for (let index = 0; index < attachments.length; index += 1) {
            if (task.canceled) return;
            const attachment = attachments[index];
            const descriptor = await uploadMediaFile(
              attachment.file,
              progressId(taskId, index),
            );
            if (task.canceled) return;
            task.fileProgress[index] = 100;
            rebuildSnapshot();
            descriptors.push(descriptor);
          }

          if (!task.canceled) await onComplete(descriptors);
        } catch (error) {
          if (!task.canceled) onError(error);
        } finally {
          finishTask(taskId);
        }
      })();
      return true;
    },
  };
}

export function enqueueBackgroundMediaUpload({
  attachments,
  onComplete,
  onError,
}: EnqueueBackgroundUploadOptions): PreparedBackgroundMediaUpload {
  const preparedUpload = prepareBackgroundMediaUpload(attachments);
  preparedUpload.start({ onComplete, onError });
  return preparedUpload;
}

export function cancelBackgroundMediaUploads(): void {
  for (const task of tasks.values()) task.canceled = true;
  tasks.clear();
  rebuildSnapshot();
  stopProgressListener?.();
  stopProgressListener = null;
}

export const resetBackgroundMediaUploads = cancelBackgroundMediaUploads;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): BackgroundUploadSnapshot {
  return snapshot;
}

export function useBackgroundMediaUpload(): BackgroundUploadSnapshot {
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
