import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import { cn } from "@/shared/lib/cn";

export function ComposerUploadProgressPill({
  isUploading,
  onCancel,
  percentage,
}: {
  isUploading: boolean;
  onCancel: () => void;
  percentage: number;
}) {
  const reducedMotion = useReducedMotion();

  return (
    <AnimatePresence initial={false}>
      {isUploading ? (
        <motion.div
          animate="visible"
          className="relative z-0 flex justify-center pb-2"
          data-testid="composer-upload-progress-motion"
          exit="hidden"
          initial="hidden"
          variants={{
            hidden: {
              opacity: reducedMotion ? 1 : 0,
              transition: reducedMotion
                ? { duration: 0 }
                : { duration: 0.18, ease: "easeOut" },
              y: reducedMotion ? 0 : 28,
            },
            visible: {
              opacity: 1,
              transition: reducedMotion
                ? { duration: 0 }
                : { duration: 0.22, ease: "easeIn" },
              y: 0,
            },
          }}
        >
          <div
            aria-label={`Uploading ${percentage}%`}
            aria-live="polite"
            className="relative h-9 w-[18.75rem] max-w-full overflow-hidden rounded-full border border-primary bg-primary text-primary-foreground"
            data-testid="composer-upload-progress"
            role="status"
          >
            <motion.div
              animate={{ width: `${percentage}%` }}
              className="absolute inset-y-0 left-0 bg-primary-foreground/20"
              data-testid="composer-upload-progress-fill"
              initial={false}
              transition={
                reducedMotion
                  ? { duration: 0 }
                  : { duration: 0.15, ease: "easeOut" }
              }
            />
            <div className="relative flex h-full items-center gap-2 pl-3 pr-1">
              <span className="min-w-0 flex-1 truncate text-sm font-semibold text-primary-foreground">
                Uploading
                <span className="text-primary-foreground/80">
                  {" · "}
                  {percentage}%
                </span>
              </span>
              <button
                className={cn(
                  "shrink-0 rounded-full bg-transparent px-2 py-1 text-sm font-semibold text-primary-foreground",
                  "transition-colors hover:bg-primary-foreground/20 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary-foreground",
                )}
                data-testid="composer-upload-cancel"
                onClick={onCancel}
                type="button"
              >
                Cancel
              </button>
            </div>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
