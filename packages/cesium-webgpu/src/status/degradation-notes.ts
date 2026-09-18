/**
 * Degradation and blind-spot catalogue (data-model §2.5, FR-023).
 *
 * A degraded run MUST say why it is degraded. Every note here is a fact measured or decided in
 * this repository — none of them is a placeholder, and each records where it comes from, so the
 * status a caller observes can be traced back to an artifact.
 */
import type { RenderPathStatus } from "../api/types.js";

/** Keys of the catalogue; the string values are the observable notes. */
export type DegradationNoteKey =
  | "software-adapter"
  | "slice-a-depth-texture"
  | "ci-no-gpu"
  | "wgsl-module-validation-only"
  | "no-gpu-timestamps"
  | "browser-version-drift";

export interface DegradationNote {
  readonly key: DegradationNoteKey;
  readonly note: string;
  /** Where the fact is recorded (CI degradation document, plan, gate conclusion, …). */
  readonly source: string;
}

/** The catalogue of declared degradations and blind spots. */
export const DEGRADATION_NOTES: readonly DegradationNote[] = [
  {
    key: "software-adapter",
    note: "software rasteriser adapter (CI): not comparable to a discrete GPU for performance",
    source: "docs/ci-degradation.md, contracts/verification-and-benchmark §8",
  },
  {
    key: "slice-a-depth-texture",
    note: "depthTexture temporarily off (slice A): the offscreen depth attachment lands in slice B",
    source: "data-model §3.1, research §4",
  },
  {
    key: "ci-no-gpu",
    note: "CI has no GPU: contract/visual/benchmark suites only run in the two-path jobs",
    source: "docs/ci-degradation.md",
  },
  {
    key: "wgsl-module-validation-only",
    note: "without a device the shader check validates WGSL modules only; varying pairing, bind layouts and pipeline compatibility are only exposed by a real createRenderPipeline call",
    source: "contracts/fork-patch-layer §8 (blind spots), G-5",
  },
  {
    key: "no-gpu-timestamps",
    note: "no GPU timestamps in the software path: frame timings are CPU-side only",
    source: "contracts/verification-and-benchmark §8",
  },
  {
    key: "browser-version-drift",
    note: "the browser build drifts between environments: the environment fingerprint is recorded with every verification run",
    source: "data-model §8.1 (EnvironmentFingerprint)",
  },
];

/** Resolve note keys into their observable strings; an unknown key is an error, never dropped. */
export function collectNotes(keys: readonly DegradationNoteKey[]): string[] {
  const byKey = new Map(DEGRADATION_NOTES.map((entry) => [entry.key, entry.note]));
  return keys.map((key) => {
    const note = byKey.get(key);
    if (note === undefined) throw new Error(`unknown degradation note key "${key}"`);
    return note;
  });
}

/** The subset of a status that the invariant cares about. */
export type StatusNoteSurface = Pick<RenderPathStatus, "degraded" | "notes">;
