/**
 * G-3 gate bundle entry (tasks.md T020).
 *
 * The gate records the **upstream, unmodified** WebGL2 path, so this bundle deliberately applies **no
 * replacement manifest** (the T008 alias plugin is not even part of the build): everything comes from
 * the installed `@cesium/engine`, and `build.mjs` asserts that the upstream `Renderer/Context.js` is the
 * one in the graph. The page then drives one complete frame of the globe/terrain path through the real
 * `CesiumWidget` while `platform-trace.js` records the platform calls.
 */
import CesiumWidget from "@cesium/engine/Source/Widget/CesiumWidget.js";
import EllipsoidTerrainProvider from "@cesium/engine/Source/Core/EllipsoidTerrainProvider.js";
import GeographicTilingScheme from "@cesium/engine/Source/Core/GeographicTilingScheme.js";
import HeightmapTerrainData from "@cesium/engine/Source/Core/HeightmapTerrainData.js";
import Rectangle from "@cesium/engine/Source/Core/Rectangle.js";
import TerrainProvider from "@cesium/engine/Source/Core/TerrainProvider.js";
import Scene from "@cesium/engine/Source/Scene/Scene.js";
import Context from "@cesium/engine/Source/Renderer/Context.js";

export { CesiumWidget, Context, EllipsoidTerrainProvider, GeographicTilingScheme, HeightmapTerrainData, Rectangle, Scene, TerrainProvider };

/** `true` when the bundle really carries the upstream `Renderer/Context.js` (no replacement applied). */
export const upstreamContextIsPresent = typeof Context === "function" && Context.name === "Context";
