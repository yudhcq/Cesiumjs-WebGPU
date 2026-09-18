/**
 * Error subscription surface (contract render-path-api.md §6).
 *
 * Failures are delivered to every subscriber exactly once and are **never** swallowed: with no
 * subscriber registered the diagnostic goes to a sink (an injected one, or `.error` on the
 * console by default). A subscriber that throws does not hide the diagnostic from the others —
 * the reporting failure is surfaced through the same sink.
 *
 * Public API surface: backend-agnostic (rule A1), no patch-layer import (rule A2).
 */
import type { DiagnosticError } from "./types.js";
import { isDiagnosticError, type DiagnosticCategory } from "./errors.js";

/** Receives every diagnostic reported while it is subscribed. */
export type DiagnosticListener = (error: DiagnosticError) => void;

/** Where diagnostics go when nobody is listening (or when a listener itself fails). */
export type DiagnosticSink = (error: DiagnosticError) => void;

/** The subscription object exposed as `TerrainSceneHandle.diagnostics`. */
export interface Diagnostics {
  /** Subscribe; returns the unsubscribe function (idempotent). */
  onError(listener: DiagnosticListener): () => void;
  /** Report a diagnostic to every subscriber and to the sink. */
  report(error: DiagnosticError): void;
  /** Normalised failure history, in report order (bounded by `historyLimit`). */
  history(): readonly DiagnosticError[];
  /** Number of reported diagnostics per category. */
  counts(): Readonly<Record<string, number>>;
  /** Currently subscribed listener count. */
  listenerCount(): number;
}

export interface DiagnosticsOptions {
  /** Sink used when no subscriber is registered; defaults to the console's error channel. */
  sink?: DiagnosticSink;
  /** Maximum number of diagnostics kept in `history()`; defaults to 100. */
  historyLimit?: number;
  /** Optional filter applied to reported categories (all categories by default). */
  categories?: readonly DiagnosticCategory[];
}

/** Default sink: the diagnostic MUST remain visible even without a subscriber. */
const consoleSink: DiagnosticSink = (error) => {
  // eslint-disable-next-line no-console
  console.error(`[cesium-webgpu] ${error.category}: ${error.message}`, error.cause ?? "");
};

/** Create the diagnostics subscription object. */
export function createDiagnostics(options: DiagnosticsOptions = {}): Diagnostics {
  const sink = options.sink ?? consoleSink;
  const historyLimit = options.historyLimit ?? 100;
  const categories = options.categories === undefined ? null : new Set<string>(options.categories);
  const listeners = new Set<DiagnosticListener>();
  const reported: DiagnosticError[] = [];
  const counts: Record<string, number> = {};

  return {
    onError(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    report(error) {
      if (!isDiagnosticError(error)) {
        // A non-diagnostic value MUST NOT disappear: it is reported as an internal failure.
        sink({
          category: "internal",
          message: `diagnostics.report received a non-diagnostic value: ${String(error)}`,
        } as DiagnosticError);
        return;
      }
      if (categories !== null && !categories.has(error.category)) return;

      reported.push(error);
      if (reported.length > historyLimit) reported.splice(0, reported.length - historyLimit);
      counts[error.category] = (counts[error.category] ?? 0) + 1;

      if (listeners.size === 0) {
        sink(error);
        return;
      }
      for (const listener of [...listeners]) {
        try {
          listener(error);
        } catch (listenerFailure) {
          // A failing subscriber MUST NOT swallow the diagnostic: keep notifying the others and
          // surface the subscriber failure through the sink.
          sink({
            category: "internal",
            message: `diagnostics listener threw while handling "${error.category}": ${
              listenerFailure instanceof Error ? listenerFailure.message : String(listenerFailure)
            }`,
            cause: listenerFailure,
          } as DiagnosticError);
        }
      }
    },

    history() {
      return [...reported];
    },

    counts() {
      return { ...counts };
    },

    listenerCount() {
      return listeners.size;
    },
  };
}
