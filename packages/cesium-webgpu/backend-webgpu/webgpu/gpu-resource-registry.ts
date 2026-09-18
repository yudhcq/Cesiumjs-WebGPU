/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * New module of the cesium-webgpu render backend layer (not derived from any upstream file).
 *
 * T063 — `GpuResourceRecord` registry (data-model §5.1, tasks.md T063, FR-017).
 *
 * The logic layer has no idea how much GPU memory it is holding: upstream's `Texture#sizeInBytes`
 * and `Buffer#sizeInBytes` are the only numbers it ever sees, and they are per-object. FR-017 asks
 * for a **graphics-memory proxy metric**, so the backend keeps its own ledger: every `GPUBuffer` /
 * `GPUTexture` / `GPUSampler` a replaced resource class creates is registered with its estimated
 * byte cost, and released when the resource is destroyed.
 *
 * Three invariants make the metric trustworthy — each is asserted by
 * `tests/unit/gpu-resource-registry.test.mjs`:
 *
 *   1. **monotone release**: `release()` on an unknown or already-released id is a no-op that
 *      returns `false`. The total can therefore never go negative, however many times a teardown
 *      path runs (upstream's `destroy()` is called from several places: `Framebuffer#destroy`,
 *      `FramebufferManager#destroy`, `VertexArray#destroy`, …);
 *   2. **removal on destroy**: a released record leaves the *live* set immediately and keeps only
 *      its `destroyedFrame`, so `stats()` describes what is alive now (data-model §5.1 validation
 *      rule: "destroy() 后 MUST 从登记表移除");
 *   3. **frame stamping**: `Context#beginFrame` advances the frame counter, so `createdFrame` /
 *      `destroyedFrame` make the leak assertion ("the live set does not grow between frame N and
 *      frame N+K in steady state") a plain set comparison.
 *
 * The registry is a module-level singleton on purpose: the ledger is a property of the *device*,
 * and principle II allows exactly one live backend per session, so there is exactly one ledger.
 */
import { DiagnosticError } from "./errors.js";

/** `GpuResourceRecord.kind` (data-model §5.1). */
export type GpuResourceKind = "buffer" | "texture" | "sampler" | "pipeline" | "bindGroup" | "shaderModule";

/** One ledger entry (data-model §5.1). */
export interface GpuResourceRecord {
  /** Stable, unique identity of the GPU object (`label#n` or the upstream object's id). */
  readonly id: string;
  readonly kind: GpuResourceKind;
  /** Estimated bytes of graphics memory; `0` for objects that own no storage (samplers, …). */
  readonly bytes: number;
  /** Upstream class the record belongs to (`"Buffer"`, `"Texture"`, `"Sampler"`, …). */
  readonly upstreamClass: string;
  /** Frame during which the object was created (`-1` before the first `beginFrame`). */
  readonly createdFrame: number;
  /** Frame during which it was released, or `undefined` while it is alive. */
  destroyedFrame?: number;
}

/** Aggregated view of the ledger — the FR-017 proxy metric. */
export interface GpuResourceStats {
  /** Number of live records. */
  readonly live: number;
  /** Σ `bytes` over the live records. */
  readonly totalBytes: number;
  /** Per-kind live counts and bytes. */
  readonly byKind: Readonly<Record<GpuResourceKind, { readonly count: number; readonly bytes: number }>>;
  /** Per-upstream-class live counts and bytes (data-model §5.1: "便于按类统计"). */
  readonly byUpstreamClass: Readonly<Record<string, { readonly count: number; readonly bytes: number }>>;
  /** Total registrations since `reset()` (evidence that the ledger saw every creation). */
  readonly created: number;
  /** Total releases since `reset()` (may exceed `created` only if a release is repeated — it cannot). */
  readonly released: number;
  /** Highest `totalBytes` ever observed (a peak is what "graphics memory pressure" means). */
  readonly peakBytes: number;
  /** Current frame counter. */
  readonly frame: number;
}

const EMPTY_KIND_ENTRY = Object.freeze({ count: 0, bytes: 0 });

/** The ledger. One instance per device; `gpuResourceRegistry` is the module-level one. */
export class GpuResourceRegistry {
  readonly #live = new Map<string, GpuResourceRecord>();
  readonly #history: GpuResourceRecord[] = [];
  #frame = -1;
  #created = 0;
  #released = 0;
  #peakBytes = 0;

  /** Advance the frame counter; called from `Context#beginFrame`. */
  setFrame(frame: number): void {
    if (!Number.isInteger(frame) || frame < 0) {
      throw new DiagnosticError("internal", `GpuResourceRegistry.setFrame: frame MUST be a non-negative integer (got ${String(frame)}).`, {
        backend: "webgpu",
        requirementRef: "FR-017",
        entryPoint: "GpuResourceRegistry#setFrame",
      });
    }
    this.#frame = frame;
  }

  /** The current frame counter (`-1` before the first frame). */
  get frame(): number {
    return this.#frame;
  }

  /**
   * Register one GPU object.
   *
   * @throws a `DiagnosticError` when the id is already live: registering the same id twice would
   *   double-count the bytes, and the ledger would then over-report the FR-017 metric.
   */
  register(record: {
    id: string;
    kind: GpuResourceKind;
    bytes?: number;
    upstreamClass: string;
    createdFrame?: number;
  }): GpuResourceRecord {
    if (typeof record.id !== "string" || record.id.length === 0) {
      throw new DiagnosticError("internal", "GpuResourceRegistry.register: a record MUST carry a non-empty id (data-model §5.1 `id`).", {
        backend: "webgpu",
        requirementRef: "FR-017",
        entryPoint: "GpuResourceRegistry#register",
      });
    }
    if (this.#live.has(record.id)) {
      throw new DiagnosticError(
        "internal",
        `GpuResourceRegistry.register: "${record.id}" is already live. Registering it again would double-count its bytes and ` +
          "make the FR-017 graphics-memory proxy wrong; the ledger MUST stay a set (data-model §5.1).",
        { backend: "webgpu", requirementRef: "FR-017", entryPoint: "GpuResourceRegistry#register", extra: { id: record.id, kind: record.kind } },
      );
    }
    const bytes = record.bytes ?? 0;
    if (!Number.isFinite(bytes) || bytes < 0) {
      throw new DiagnosticError("internal", `GpuResourceRegistry.register: bytes MUST be a finite non-negative number (got ${String(record.bytes)}).`, {
        backend: "webgpu",
        requirementRef: "FR-017",
        entryPoint: "GpuResourceRegistry#register",
        extra: { id: record.id },
      });
    }
    const entry: GpuResourceRecord = {
      id: record.id,
      kind: record.kind,
      bytes,
      upstreamClass: record.upstreamClass,
      createdFrame: record.createdFrame ?? this.#frame,
    };
    this.#live.set(entry.id, entry);
    this.#history.push(entry);
    this.#created += 1;
    this.#peakBytes = Math.max(this.#peakBytes, this.#totalBytes());
    return entry;
  }

  /** `true` while the id is live. */
  has(id: string): boolean {
    return this.#live.has(id);
  }

  /**
   * Release one record. **Idempotent**: an unknown or already-released id returns `false` and
   * changes nothing, so a doubled teardown can never drive the totals negative (T063 requirement).
   *
   * @param frame the frame the release happened in; defaults to the current frame counter.
   */
  release(id: string, frame?: number): boolean {
    const entry = this.#live.get(id);
    if (entry === undefined) return false;
    this.#live.delete(id);
    // The record leaves the live set but keeps its identity in the history: `destroyedFrame` is the
    // leak assertion's other half (data-model §5.1).
    Object.defineProperty(entry, "destroyedFrame", { value: frame ?? this.#frame, enumerable: true, configurable: true, writable: false });
    this.#released += 1;
    return true;
  }

  /** Live records, in registration order. */
  liveRecords(): readonly GpuResourceRecord[] {
    return [...this.#live.values()];
  }

  /** Every record ever registered, with `destroyedFrame` set once it was released. */
  history(): readonly GpuResourceRecord[] {
    return this.#history.map((entry) => ({ ...entry }));
  }

  /** Ids of the live set — the leak assertion compares two of these. */
  activeIds(): readonly string[] {
    return [...this.#live.keys()].sort();
  }

  /** The FR-017 metric: live count, live bytes, per-kind and per-class breakdowns. */
  stats(): GpuResourceStats {
    const byKind: Record<GpuResourceKind, { count: number; bytes: number }> = {
      buffer: { ...EMPTY_KIND_ENTRY },
      texture: { ...EMPTY_KIND_ENTRY },
      sampler: { ...EMPTY_KIND_ENTRY },
      pipeline: { ...EMPTY_KIND_ENTRY },
      bindGroup: { ...EMPTY_KIND_ENTRY },
      shaderModule: { ...EMPTY_KIND_ENTRY },
    };
    const byUpstreamClass: Record<string, { count: number; bytes: number }> = {};
    let totalBytes = 0;
    for (const entry of this.#live.values()) {
      totalBytes += entry.bytes;
      byKind[entry.kind].count += 1;
      byKind[entry.kind].bytes += entry.bytes;
      const bucket = (byUpstreamClass[entry.upstreamClass] ??= { count: 0, bytes: 0 });
      bucket.count += 1;
      bucket.bytes += entry.bytes;
    }
    return { live: this.#live.size, totalBytes, byKind, byUpstreamClass, created: this.#created, released: this.#released, peakBytes: this.#peakBytes, frame: this.#frame };
  }

  /** Σ live bytes — the single number FR-017 asks for. */
  get totalBytes(): number {
    return this.#totalBytes();
  }

  /** Forget everything (a new device means a new ledger). */
  reset(): void {
    this.#live.clear();
    this.#history.length = 0;
    this.#frame = -1;
    this.#created = 0;
    this.#released = 0;
    this.#peakBytes = 0;
  }

  #totalBytes(): number {
    let total = 0;
    for (const entry of this.#live.values()) total += entry.bytes;
    return total;
  }
}

/**
 * The ledger of the one live backend (principle II: one backend per session).
 *
 * Deliberately stored on `globalThis` under a namespaced key rather than as a plain module-level
 * `new GpuResourceRegistry()`: the ledger is a property of the **device**, and the same module can be
 * instantiated more than once in one session — the patch layer is imported by the replacement
 * `Context` *and* by `tests/support/ts-module-loader.mjs`, which bundles each entry separately. Two
 * ledgers would each report half the graphics memory, which is exactly the silent wrongness FR-017
 * cannot afford. One key, one ledger, whoever asks.
 */
const REGISTRY_KEY = "__cesiumWebgpuGpuResourceRegistry__";

function sharedRegistry(): GpuResourceRegistry {
  const scope = globalThis as unknown as Record<string, unknown>;
  const existing = scope[REGISTRY_KEY];
  // A structural check, not `instanceof`: a second copy of this module has its own `GpuResourceRegistry`
  // class object, so `instanceof` would reject a perfectly good ledger and replace it.
  if (existing !== undefined && existing !== null && typeof (existing as GpuResourceRegistry).register === "function") {
    return existing as GpuResourceRegistry;
  }
  const created = new GpuResourceRegistry();
  scope[REGISTRY_KEY] = created;
  return created;
}

export const gpuResourceRegistry: GpuResourceRegistry = sharedRegistry();

/**
 * Estimated bytes of a 2D texture (`data-model §5.1 bytes`).
 *
 * Deliberately an *estimate* with a stated rule rather than a device query: WebGPU exposes no
 * allocation introspection, so the proxy is "every mip level of every array layer at the format's
 * bytes-per-texel". `mipLevelCount` is included because a mipmapped texture really does allocate
 * them; samplers, bind groups and pipelines own no such storage and are registered with `bytes: 0`.
 */
export function estimateTextureBytes(options: {
  width: number;
  height: number;
  bytesPerTexel: number;
  mipLevelCount?: number;
  depthOrArrayLayers?: number;
  sampleCount?: number;
}): number {
  const mipLevelCount = Math.max(1, options.mipLevelCount ?? 1);
  const layers = Math.max(1, options.depthOrArrayLayers ?? 1);
  const samples = Math.max(1, options.sampleCount ?? 1);
  let texels = 0;
  let width = Math.max(1, options.width);
  let height = Math.max(1, options.height);
  for (let level = 0; level < mipLevelCount; level += 1) {
    texels += width * height;
    width = Math.max(1, width >> 1);
    height = Math.max(1, height >> 1);
  }
  return Math.ceil(texels * layers * samples * options.bytesPerTexel);
}

/** Monotone id generator so two GPU objects can never share a ledger key. */
const COUNTER_KEY = "__cesiumWebgpuResourceCounter__";

/** Build a unique ledger id for one upstream object (`Texture#id` is reused when it exists). */
export function nextResourceId(upstreamClass: string, explicitId?: string): string {
  const scope = globalThis as unknown as Record<string, number>;
  const next = (scope[COUNTER_KEY] ?? 0) + 1;
  scope[COUNTER_KEY] = next;
  // The counter is shared with the ledger (see `gpuResourceRegistry`): two copies of this module in
  // one session would otherwise mint the same id twice and the second `register()` would be rejected.
  const suffix = explicitId ?? `${next}`;
  return `${upstreamClass}:${suffix}`;
}

/** Test hook: reset the id counter together with the ledger. */
export function resetResourceIds(): void {
  (globalThis as unknown as Record<string, number | undefined>)[COUNTER_KEY] = 0;
}
