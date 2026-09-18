/**
 * Render-path status model (data-model §2.5, FR-009).
 *
 * `RenderPathStatus` is an **observation** surface: callers may display it or log it, but business
 * code MUST NOT branch on `active` (the path is chosen once, at initialisation, per principle II).
 * The model enforces the one hard invariant of the contract:
 *
 *   `degraded === true`  ⇒  `notes` is non-empty
 *
 * so a degraded run can never be reported without saying what is degraded (FR-023).
 *
 * Public status surface: backend-agnostic (rule A1), no patch-layer import (rule A2).
 */
import type { BackendKind, RenderPathStatus } from "../api/types.js";

/** The reason categories of data-model §2.2, in contract order. */
export type RenderPathReason = RenderPathStatus["reason"];

export const RENDER_PATH_REASONS: readonly RenderPathReason[] = [
  "ok",
  "no-navigator-gpu",
  "no-adapter",
  "device-request-failed",
  "missing-feature",
  "below-limit",
  "timeout",
];

/** Input accepted by `createRenderPathStatus`. */
export interface RenderPathStatusInit {
  readonly active: BackendKind;
  readonly reason: RenderPathReason;
  readonly degraded?: boolean;
  readonly notes?: readonly string[];
}

/** Thrown when a status would violate the contract (degraded without notes). */
export class StatusInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StatusInvariantError";
  }
}

/**
 * Build a status object, validating the invariant.
 *
 * @throws StatusInvariantError when `degraded === true` and no note explains the degradation.
 */
export function createRenderPathStatus(init: RenderPathStatusInit): RenderPathStatus {
  const degraded = init.degraded === true;
  const notes = [...(init.notes ?? [])];
  if (!RENDER_PATH_REASONS.includes(init.reason)) {
    throw new StatusInvariantError(`unknown render-path reason "${String(init.reason)}"`);
  }
  if (degraded && notes.length === 0) {
    throw new StatusInvariantError(
      "a degraded render path MUST carry at least one note explaining the degradation (FR-023, data-model §2.5)",
    );
  }
  if (notes.some((note) => typeof note !== "string" || note.trim().length === 0)) {
    throw new StatusInvariantError("status notes MUST be non-empty strings");
  }
  return { active: init.active, reason: init.reason, degraded, notes };
}

/** Check the invariant on an arbitrary value (used by the contract tests and the status emitter). */
export function assertStatusInvariant(status: Pick<RenderPathStatus, "degraded" | "notes">): void {
  if (status.degraded === true && (status.notes ?? []).length === 0) {
    throw new StatusInvariantError("degraded === true requires non-empty notes (FR-023)");
  }
}

/** True when the status describes the healthy case: the preferred path was taken, no degradation. */
export function isHealthy(status: RenderPathStatus): boolean {
  return status.reason === "ok" && status.degraded === false;
}

/**
 * Emit status updates at most once per distinct status.
 *
 * The observer is a *reporter*: a failures in the caller-supplied callback is surfaced to the
 * `onObserverError` hook (default: rethrown) instead of being swallowed.
 */
export function createStatusEmitter(options: {
  onStatus?: (status: RenderPathStatus) => void;
  onObserverError?: (error: unknown) => void;
}): { emit(init: RenderPathStatusInit): RenderPathStatus; last(): RenderPathStatus | undefined } {
  let last: RenderPathStatus | undefined;
  const handleObserverError =
    options.onObserverError ??
    ((error: unknown) => {
      throw error;
    });

  return {
    emit(init) {
      const status = createRenderPathStatus(init);
      const unchanged =
        last !== undefined &&
        last.active === status.active &&
        last.reason === status.reason &&
        last.degraded === status.degraded &&
        last.notes.length === status.notes.length &&
        last.notes.every((note, index) => note === status.notes[index]);
      last = status;
      if (!unchanged && options.onStatus !== undefined) {
        try {
          options.onStatus(status);
        } catch (error) {
          handleObserverError(error);
        }
      }
      return status;
    },
    last() {
      return last;
    },
  };
}
