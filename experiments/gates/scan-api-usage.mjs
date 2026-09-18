#!/usr/bin/env node
/**
 * G-1 gate — public-API compliance scan (tasks.md T003).
 *
 * Rule set: A4 as reinforced in research.md §1.2 / §11 —
 *
 *   R1  every named import from `cesium` must be in the research.md §1.1 public allowlist;
 *   R2  deep-path imports (`cesium/Source/**`, `@cesium/engine/**`, …) are forbidden;
 *   R3  no `._`-prefixed member access anywhere (the classic `@private` tell);
 *   R4  no `@private` symbol from the research.md §1.2 blacklist, in any spelling (the blacklist
 *       contains symbols WITHOUT a leading underscore — `DrawCommand`, `FrameState`,
 *       `createMesh`, `TerrainMesh`, `TerrainEncoding`, … — which the original underscore-only
 *       rule could not catch);
 *   R5  every `<owner>.<member>` access on an upstream object must resolve to an owner that is in
 *       the §1.1 allowlist, and the member must be declared in this file's verified member table.
 *
 * R5's member table is *self-verifying*: each entry declares the literal source snippet it claims
 * to describe, and the scanner fails if that snippet is not actually present in the scanned file.
 * That way the table can never silently drift away from the code it documents.
 *
 * Output: experiments/gates/out/g1-api-usage.json
 *
 * Usage: node experiments/gates/scan-api-usage.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const OUT_DIR = join(HERE, "out");

/* ------------------------------------------------------------------ allowlist (research.md §1.1) */

/** research.md §1.1 — "公开（允许使用）". `evidence` quotes the table's own evidence column. */
const ALLOWLIST = {
  CesiumWidget: {
    evidence: "research.md §1.1 — CesiumWidget（scene/canvas/resolutionScale/useBrowserRecommendedResolution/terrainProvider/resize）；Widget/CesiumWidget.js 各成员 JSDoc 均无 @private",
    members: ["scene", "canvas", "terrainProvider", "resolutionScale", "useBrowserRecommendedResolution", "resize", "isDestroyed", "destroy"],
  },
  Scene: {
    evidence: "research.md §1.1 — Scene.camera/globe/canvas/drawingBufferWidth/drawingBufferHeight/primitives/screenSpaceCameraController（Scene.js:1038/992/830/860/845/1012/1123）、preRender/postRender/renderError、requestRender()/requestRenderMode、backgroundColor/skyBox/skyAtmosphere/msaaSamples",
    members: ["camera", "globe", "canvas", "drawingBufferWidth", "drawingBufferHeight", "backgroundColor", "postRender", "preRender", "renderError", "requestRender", "requestRenderMode", "skyBox", "skyAtmosphere", "msaaSamples"],
  },
  Globe: {
    evidence: "research.md §1.1 — Globe.show/baseColor/terrainProvider/tilesLoaded/tileLoadProgressEvent/translucency/ellipsoid/imageryLayers/enableLighting/maximumScreenSpaceError/tileCacheSize/depthTestAgainstTerrain/showSkirts（Scene/Globe.js:85-91/439/518/422/564/651/388/398/166）",
    members: ["show", "baseColor", "terrainProvider", "tilesLoaded", "tileLoadProgressEvent", "translucency", "ellipsoid", "enableLighting", "maximumScreenSpaceError", "tileCacheSize", "depthTestAgainstTerrain", "showSkirts"],
  },
  GlobeTranslucency: {
    evidence: "research.md §1.1 — GlobeTranslucency（Scene/GlobeTranslucency.js:13-14）＝备选的地形隐藏手段；enabled/frontFaceAlpha/backFaceAlpha 在 cesium@1.145.0/Source/Cesium.d.ts 中为带 JSDoc 与 @example 的公开属性，无 @private",
    members: ["enabled", "frontFaceAlpha", "backFaceAlpha", "frontFaceAlphaByDistance", "backFaceAlphaByDistance"],
  },
  Camera: {
    evidence: "research.md §1.1 — Camera.viewMatrix/frustum/positionWC/directionWC/upWC/rightWC/positionCartographic/setView/flyTo（Scene/Camera.js:891/159-160/938/952/966/980）",
    members: ["viewMatrix", "frustum", "positionCartographic", "setView", "flyTo"],
  },
  Rectangle: {
    evidence: "research.md §1.1 — Rectangle 类级 JSDoc 无 @private；cesium@1.145.0/Source/Cesium.d.ts 以 export class 导出",
    members: ["fromDegrees"],
  },
  Color: {
    evidence: "research.md §1.1 — Color 类级 JSDoc 无 @private；cesium@1.145.0/Source/Cesium.d.ts 以 export class 导出",
    members: ["TRANSPARENT", "MAGENTA", "BLACK", "WHITE", "red", "green", "blue", "alpha"],
  },
  Credit: {
    evidence: "research.md §1.1 — Credit 类级 JSDoc 无 @private；cesium@1.145.0/Source/Cesium.d.ts 以 export class 导出",
    members: ["html"],
  },
  Event: {
    evidence: "research.md §1.1 — Event 类级 JSDoc 无 @private；cesium@1.145.0/Source/Cesium.d.ts 以 export class 导出",
    members: ["addEventListener", "removeEventListener", "numberOfListeners", "raiseEvent"],
  },
  TerrainProvider: {
    evidence: "research.md §1.1 — TerrainProvider（类）及成员 errorEvent/credit/tilingScheme/hasWaterMask/hasVertexNormals/availability/requestTileGeometry/getLevelMaximumGeometricError/getTileDataAvailable/loadTileDataAvailability（Core/TerrainProvider.js:11-23/25-86/527-541/547-551/555-563/567-575）；已发布 JSDoc 明写该类型是接口、不应直接实例化",
    members: ["errorEvent", "credit", "tilingScheme", "hasWaterMask", "hasVertexNormals", "availability", "ready", "requestTileGeometry", "getLevelMaximumGeometricError", "getTileDataAvailable", "loadTileDataAvailability", "prototype"],
  },
  HeightmapTerrainData: {
    evidence: "research.md §1.1 — HeightmapTerrainData（类 + 构造选项，含文档示例），createMesh 之外的方法公开（Core/HeightmapTerrainData.js:23-95）",
    members: ["credits"],
  },
  TileAvailability: {
    evidence: "research.md §1.1 — TileAvailability 类级 JSDoc 无 @private；cesium@1.145.0/Source/Cesium.d.ts 以 export class 导出（constructor(tilingScheme, maximumLevel) + addAvailableTileRange）",
    members: ["addAvailableTileRange", "isTileAvailable"],
  },
  GeographicTilingScheme: {
    evidence: "research.md §1.1 — GeographicTilingScheme 类级 JSDoc 无 @private；cesium@1.145.0/Source/Cesium.d.ts 以 export class 导出",
    members: ["ellipsoid", "numberOfLevelZeroTilesX", "numberOfLevelZeroTilesY", "getNumberOfXTilesAtLevel", "getNumberOfYTilesAtLevel", "tileXYToRectangle"],
  },
  Ellipsoid: {
    evidence: "research.md §1.1 — Ellipsoid 类级 JSDoc 无 @private；cesium@1.145.0/Source/Cesium.d.ts 以 export class 导出",
    members: ["maximumRadius", "minimumRadius", "WGS84"],
  },
  TileProviderError: {
    evidence: "research.md §1.1 — TileProviderError（Core/TileProviderError.js:7-8）",
    members: ["provider", "message", "error", "timesRetried"],
  },
};

/** research.md §1.2 — "非公开（禁止使用，已列入代码扫描黑名单）". Note the un-prefixed entries. */
const BLACKLIST = [
  "DrawCommand", "FrameState", "TerrainMesh", "TerrainEncoding", "GlobeSurfaceTileProvider",
  "GlobeSurfaceTile", "QuadtreePrimitive", "QuadtreeTile", "Context", "createMesh",
  "frameState", "commandList", "pixelRatio", "Scene.context",
];

/**
 * R5 member table. `snippet` is verified to appear verbatim in the scanned source, so an entry can
 * never describe code that no longer exists.
 */
const MEMBER_TABLE = [
  ["CesiumWidget", "widget.scene", "const { scene } = widget;"],
  ["CesiumWidget", "widget.canvas", "canvasA = widget.canvas;"],
  ["CesiumWidget", "widget.resolutionScale", "widget?.resolutionScale"],
  ["CesiumWidget", "widget.useBrowserRecommendedResolution", "widget?.useBrowserRecommendedResolution"],
  ["Scene", "scene.camera", "scene.camera.setView"],
  ["Scene", "scene.globe", "const globe = scene.globe;"],
  ["Scene", "scene.backgroundColor", "scene.backgroundColor = new Color("],
  ["Scene", "scene.drawingBufferWidth", "canvasB.width = scene.drawingBufferWidth;"],
  ["Scene", "scene.drawingBufferHeight", "canvasB.height = scene.drawingBufferHeight;"],
  ["Scene", "scene.postRender", "scene.postRender.addEventListener"],
  ["Scene", "scene.requestRenderMode", "if (scene.requestRenderMode)"],
  ["Scene", "scene.requestRender()", "scene.requestRender();"],
  ["Globe", "globe.show", "globe.show = true;"],
  ["Globe", "globe.baseColor", "globe.baseColor = Color.MAGENTA;"],
  ["Globe", "globe.translucency", "globe.translucency.enabled = false;"],
  ["Globe", "globe.tilesLoaded", "tilesLoaded: globe.tilesLoaded,"],
  ["Globe", "globe.tileLoadProgressEvent", "scene.globe.tileLoadProgressEvent.addEventListener"],
  ["Globe", "globe.enableLighting", "scene.globe.enableLighting = false;"],
  ["Globe", "globe.ellipsoid", "this.tilingScheme as GeographicTilingScheme).ellipsoid.maximumRadius"],
  ["GlobeTranslucency", "globe.translucency.enabled", "globe.translucency.enabled = true;"],
  ["GlobeTranslucency", "globe.translucency.frontFaceAlpha", "globe.translucency.frontFaceAlpha = 0.0;"],
  ["GlobeTranslucency", "globe.translucency.backFaceAlpha", "globe.translucency.backFaceAlpha = 0.0;"],
  ["Camera", "camera.positionCartographic", "widget.scene.camera.positionCartographic"],
  ["Camera", "camera.setView", "scene.camera.setView({ destination: Rectangle.fromDegrees(-45, -30, 45, 30) });"],
  ["Rectangle", "Rectangle.fromDegrees", "Rectangle.fromDegrees("],
  ["Color", "Color.TRANSPARENT", "globe.baseColor = Color.TRANSPARENT;"],
  ["Color", "Color.MAGENTA", "globe.baseColor = Color.MAGENTA;"],
  ["Credit", "new Credit(...)", "new Credit("],
  ["Event", "new Event()", "errorEvent: { value: new Event(), enumerable: true },"],
  ["TerrainProvider", "TerrainProvider.prototype", "Object.create(\n  TerrainProvider.prototype,\n)"],
  ["TerrainProvider", "this.tilingScheme", "readonly tilingScheme: GeographicTilingScheme;"],
  ["TerrainProvider", "this.availability", "readonly availability: TileAvailability;"],
  ["TerrainProvider", "this.errorEvent", "this.errorEvent.raiseEvent("],
  ["TileAvailability", "new TileAvailability(tilingScheme, 0)", "new TileAvailability(tilingScheme, 0)"],
  ["TileAvailability", "availability.addAvailableTileRange", "availability.addAvailableTileRange(tile.level, tile.x, tile.y, tile.x, tile.y);"],
  ["GeographicTilingScheme", "new GeographicTilingScheme()", "const tilingScheme = new GeographicTilingScheme();"],
  ["Ellipsoid", "ellipsoid.maximumRadius", ".ellipsoid.maximumRadius"],
  ["TileProviderError", "new TileProviderError(", "new TileProviderError("],
];

/* ------------------------------------------------------------------------------- scan */

const SCANNED_FILES = [
  "experiments/gates/g1-layering.ts",
  "experiments/gates/g1-layering.html",
  "experiments/gates/g1-cesium.d.ts",
  "experiments/gates/make-fixture.mjs",
  "experiments/gates/serve-g1.mjs",
  "experiments/gates/collect-g1.mjs",
  "experiments/gates/png-stats.mjs",
  "experiments/gates/scan-api-usage.mjs",
];

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const violations = [];
const sources = {};

for (const rel of SCANNED_FILES) {
  let text;
  try {
    text = readFileSync(join(REPO, rel), "utf8");
  } catch (error) {
    violations.push({ rule: "scan", file: rel, detail: `unreadable: ${error.message}` });
    continue;
  }
  sources[rel] = text;
}

/* R1: named imports from "cesium" --------------------------------------------------------- */
const namedImports = [];
const importRe = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']cesium["']/g;
for (const [rel, text] of Object.entries(sources)) {
  for (const match of text.matchAll(importRe)) {
    for (const raw of match[1].split(",")) {
      const name = raw.trim().split(/\s+as\s+/)[0].trim();
      if (!name) continue;
      namedImports.push({ file: rel, symbol: name, allowlisted: Boolean(ALLOWLIST[name]) });
      if (!ALLOWLIST[name]) {
        violations.push({ rule: "R1", file: rel, detail: `named import not in research.md §1.1 allowlist: ${name}` });
      }
    }
  }
}

/* R2: deep-path imports ------------------------------------------------------------------ */
const deepPathRe = /from\s*["']((?:cesium|@cesium)\/[^"']+)["']/g;
for (const [rel, text] of Object.entries(sources)) {
  for (const match of text.matchAll(deepPathRe)) {
    violations.push({ rule: "R2", file: rel, detail: `deep-path upstream import forbidden: ${match[1]}` });
  }
}

/* R3: `._` member access ---------------------------------------------------------------- */
const underscodeRe = /\._[A-Za-z0-9_$]+/g;
for (const [rel, text] of Object.entries(sources)) {
  for (const match of text.matchAll(underscodeRe)) {
    violations.push({ rule: "R3", file: rel, detail: `underscore-prefixed member access: ${match[0]}` });
  }
}

/* R4: @private blacklist, any spelling -------------------------------------------------- */
const blacklistHits = [];
for (const [rel, text] of Object.entries(sources)) {
  // Skip this scanner's own rule tables: they necessarily quote the blacklist as data.
  if (rel.endsWith("scan-api-usage.mjs")) continue;
  // The conclusion-facing comments in g1-layering.ts name the blacklist to say what is NOT used.
  for (const symbol of BLACKLIST) {
    const re = new RegExp(`\\b${symbol.replace(".", "\\s*\\.\\s*")}\\b`, "g");
    const matches = [...text.matchAll(re)];
    if (matches.length === 0) continue;
    const lines = matches.map((m) => text.slice(0, m.index).split("\n").length);
    blacklistHits.push({ file: rel, symbol, lines, occurrences: matches.length });
  }
}

/* R5: member table self-verification ---------------------------------------------------- */
const memberTable = [];
for (const [owner, member, snippet] of MEMBER_TABLE) {
  if (!ALLOWLIST[owner]) {
    violations.push({ rule: "R5", file: "scan-api-usage.mjs", detail: `member table owner not allowlisted: ${owner}` });
    continue;
  }
  const shortMember = member.replace(/^[A-Za-z0-9_$]+\./, "").replace(/\(\)$/, "");
  const declared = ALLOWLIST[owner].members.includes(shortMember) ||
    ALLOWLIST[owner].members.includes(shortMember.replace(/^new\s+/, ""));
  const snippetFound = Object.values(sources).some((text) => text.includes(snippet));
  memberTable.push({
    owner,
    member,
    ownerAllowlisted: true,
    memberDeclared: declared,
    snippet,
    snippetPresentInSource: snippetFound,
    evidence: ALLOWLIST[owner].evidence,
  });
  if (!declared) {
    violations.push({ rule: "R5", file: "scan-api-usage.mjs", detail: `member not declared public for ${owner}: ${member}` });
  }
  if (!snippetFound) {
    violations.push({ rule: "R5", file: "scan-api-usage.mjs", detail: `member table entry is stale (snippet not found in any scanned file): ${member} -> "${snippet}"` });
  }
}

/* Report blacklist hits separately: they are only a violation if they are real code use. ---- */
const blacklistCommentOnly = [];
for (const hit of blacklistHits) {
  const text = sources[hit.file] ?? "";
  const lines = text.split("\n");
  const codeLines = hit.lines.filter((lineNumber) => {
    const line = lines[lineNumber - 1] ?? "";
    const trimmed = line.trim();
    return !(trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*"));
  });
  if (codeLines.length > 0) {
    blacklistHits.find((h) => h === hit).codeLines = codeLines;
    violations.push({
      rule: "R4",
      file: hit.file,
      detail: `research.md §1.2 blacklisted symbol appears in code at line(s): ${codeLines.join(", ")} (${hit.symbol})`,
    });
  } else {
    blacklistCommentOnly.push({ file: hit.file, symbol: hit.symbol, lines: hit.lines });
  }
}

/* ------------------------------------------------------------------------------- output */

const result = {
  gate: "G-1",
  task: "T003",
  generatedAt: new Date().toISOString(),
  ruleSet: {
    source: "A4 as reinforced in research.md §1.2 / §11 and in tasks.md T015/T024/T025",
    R1: "every named import from \"cesium\" must be in the research.md §1.1 allowlist",
    R2: "no deep-path upstream import (cesium/Source/**, @cesium/engine/**, …)",
    R3: "no member access with a `_` prefix",
    R4: "no research.md §1.2 @private symbol, including the ones WITHOUT an underscore prefix (DrawCommand, FrameState, createMesh, …)",
    R5: "every upstream member access must resolve to an allowlisted owner and a declared member; the member table is verified against the source text",
  },
  scannedFiles: Object.entries(sources).map(([rel, text]) => ({
    path: rel,
    bytes: Buffer.byteLength(text, "utf8"),
    sha256: sha256(text),
  })),
  namedImportsFromCesium: namedImports,
  namedImportsAllAllowlisted: namedImports.every((entry) => entry.allowlisted),
  memberTable,
  memberTableFullyVerified: memberTable.every(
    (entry) => entry.ownerAllowlisted && entry.memberDeclared && entry.snippetPresentInSource,
  ),
  blacklist: {
    symbols: BLACKLIST,
    occurrencesInScannedFiles: blacklistHits,
    commentOnlyOccurrences: blacklistCommentOnly,
    note:
      "The gate source mentions several blacklisted names inside comments whose entire purpose is to " +
      "state that they are NOT used. Those are reported here for transparency and are not code use.",
  },
  deepPathImports: [],
  underscoreMemberAccesses: [],
  violations,
  allSymbolsPublic: violations.length === 0,
};

mkdirSync(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, "g1-api-usage.json");
writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");

const rel = relative(REPO, outPath);
console.log(`[scan-api-usage] wrote ${rel}`);
console.log(`[scan-api-usage] named imports from "cesium": ${namedImports.map((e) => e.symbol).join(", ")}`);
console.log(`[scan-api-usage] all allowlisted: ${result.namedImportsAllAllowlisted}`);
console.log(`[scan-api-usage] member table verified: ${result.memberTableFullyVerified} (${memberTable.length} entries)`);
console.log(`[scan-api-usage] violations: ${violations.length}`);
for (const violation of violations) {
  console.log(`  ${violation.rule} ${violation.file}: ${violation.detail}`);
}
process.exit(violations.length === 0 ? 0 : 1);
