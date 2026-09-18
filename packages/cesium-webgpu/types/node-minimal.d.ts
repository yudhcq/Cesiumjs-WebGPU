/**
 * Minimal ambient declarations for the handful of Node built-ins the patch layer's **tool-side
 * loaders** use.
 *
 * WHY THIS FILE EXISTS
 *   `packages/cesium-webgpu/tsconfig.json` compiles the backend for the **browser bundle**
 *   (`lib: ES2023 + DOM`, `types: ["@webgpu/types"]`), so `node:*` has no declarations and `process`
 *   is undefined. That is deliberate: nothing on the runtime path may touch the filesystem. A few
 *   modules nevertheless carry a *loader* used only by `tools/**` and `node --test` — today that is
 *   `backend-webgpu/webgpu/wgsl/index.ts` (`loadShaderLibrary` / `readWgslModule`, the
 *   `shader-leaf-map.json` reader architecture rule A11 needs). Rather than install `@types/node`
 *   (a new dependency) or move the loader to an untypechecked `.mjs` (which would lose the types on
 *   its callers), the exact surface those loaders use is declared here.
 *
 * SCOPE RULE (do not relax)
 *   Declare ONLY the members listed below, and ONLY because a module in this repository consumes
 *   them. Every block names its consumer. The browser-runtime counterpart of the WGSL library
 *   (`webgpu/wgsl/leaves.ts`) is fs-free and MUST stay that way — a new module that imports
 *   `node:*` from the *runtime* path is a defect, not a reason to extend this file.
 */

declare module "node:fs" {
  /** Consumer: `webgpu/wgsl/index.ts` (leaf-map + `.wgsl` reader used by tools and tests). */
  const fs: {
    existsSync(path: string): boolean;
    readFileSync(path: string, encoding: "utf8"): string;
    writeFileSync(path: string, data: string, encoding?: "utf8"): void;
    mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;
    readdirSync(path: string, options?: { withFileTypes?: boolean }): string[];
  };
  export default fs;
}

declare module "node:path" {
  /** Consumer: `webgpu/wgsl/index.ts`. */
  const path: {
    dirname(value: string): string;
    join(...parts: string[]): string;
    resolve(...parts: string[]): string;
    relative(from: string, to: string): string;
    readonly sep: string;
  };
  export default path;
}

declare module "node:url" {
  /** Consumer: `webgpu/wgsl/index.ts` (`fileURLToPath(import.meta.url)`). */
  export function fileURLToPath(url: string | URL): string;
}

declare module "node:crypto" {
  /** Consumer: `webgpu/wgsl/index.ts` (leaf text hashes, the same encoding the leaf map uses). */
  export function createHash(algorithm: string): {
    update(data: string): { digest(encoding: "hex"): string };
  };
}

/**
 * `process` is reached only from a loader's defensive `try/catch` fallback (a bundler that does not
 * define `import.meta.url`). Declared so the loader typechecks; the runtime path never reads it.
 */
declare const process: { cwd(): string };
