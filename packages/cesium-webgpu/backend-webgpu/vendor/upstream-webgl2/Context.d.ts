/**
 * Types for the patch-layer-private vendored copy of the upstream WebGL2 `Context`.
 *
 * The vendored file is deliberately **not** part of the TypeScript program (`allowJs` is off): it is a
 * byte-identical copy of upstream JavaScript plus a rewritten import block, produced by
 * `node tools/scripts/vendor-upstream-webgl2-context.mjs`. Typing it as `unknown`-shaped keeps the
 * delegation cast explicit at the single call site in `Renderer/Context.ts`.
 */
declare const UpstreamWebGL2Context: unknown;
export default UpstreamWebGL2Context;
