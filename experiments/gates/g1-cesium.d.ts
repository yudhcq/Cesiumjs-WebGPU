/**
 * G-1 gate — minimal ambient type surface for `cesium@1.145.0`.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * tasks.md T001 requires the gate to be *independent of the not-yet-implemented repository code*
 * ("禁止 import 本仓库任何 src/** 产物") and the workspace has no `node_modules` yet (Phase 2 /
 * T008+T011 own that). Cesium is therefore consumed as a **published artifact** served from a
 * separate static mount, resolved in the browser through an import map (`"cesium" -> /cesium/index.js`).
 *
 * The authoritative types ship in the published package as `cesium@1.145.0/Source/Cesium.d.ts`;
 * this file is a hand-written *slice* of the public surface the gate actually touches, so `tsc`
 * can check `g1-layering.ts` without pulling ~2.4 MB of upstream declarations or a machine-specific
 * path into the repository.
 *
 * Every declaration below is a public symbol: it is declared with `export` in
 * `cesium@1.145.0/Source/Cesium.d.ts` and carries no `@private` tag (see research.md §1.1 / §1.2).
 * Symbols deliberately NOT declared here (because they are `@private` and must never be used):
 * `DrawCommand`, `FrameState`, `Scene.frameState`, `Scene.context`, `Scene.pixelRatio`,
 * `TerrainMesh`, `TerrainEncoding`, `TerrainData.createMesh`, `GlobeSurfaceTileProvider`,
 * `GlobeSurfaceTile`, `QuadtreePrimitive`, `QuadtreeTile`, `Context`.
 */
declare module "cesium" {
  export class Color {
    constructor(red?: number, green?: number, blue?: number, alpha?: number);
    static readonly TRANSPARENT: Color;
    static readonly MAGENTA: Color;
    static readonly BLACK: Color;
    static readonly WHITE: Color;
    red: number;
    green: number;
    blue: number;
    alpha: number;
  }

  export class Ellipsoid {
    static readonly WGS84: Ellipsoid;
    readonly maximumRadius: number;
    readonly minimumRadius: number;
  }

  export class Rectangle {
    static fromDegrees(
      west: number,
      south: number,
      east: number,
      north: number,
      result?: Rectangle,
    ): Rectangle;
    west: number;
    south: number;
    east: number;
    north: number;
  }

  export class Cartographic {
    longitude: number;
    latitude: number;
    height: number;
  }

  export class Credit {
    constructor(html: string, showOnScreen?: boolean);
    readonly html: string;
  }

  export class Event {
    addEventListener(listener: (...args: unknown[]) => void, scope?: unknown): () => void;
    removeEventListener(listener: (...args: unknown[]) => void, scope?: unknown): void;
    readonly numberOfListeners: number;
    raiseEvent(...args: unknown[]): void;
  }

  export class TileAvailability {
    constructor(tilingScheme: TilingScheme, maximumLevel: number);
    addAvailableTileRange(
      level: number,
      startX: number,
      startY: number,
      endX: number,
      endY: number,
    ): void;
    isTileAvailable(level: number, x: number, y: number): boolean;
  }

  export interface TilingScheme {
    readonly ellipsoid: Ellipsoid;
    readonly numberOfLevelZeroTilesX: number;
    readonly numberOfLevelZeroTilesY: number;
    getNumberOfXTilesAtLevel(level: number): number;
    getNumberOfYTilesAtLevel(level: number): number;
  }

  export class GeographicTilingScheme implements TilingScheme {
    constructor(options?: { ellipsoid?: Ellipsoid; rectangle?: Rectangle });
    readonly ellipsoid: Ellipsoid;
    readonly numberOfLevelZeroTilesX: number;
    readonly numberOfLevelZeroTilesY: number;
    getNumberOfXTilesAtLevel(level: number): number;
    getNumberOfYTilesAtLevel(level: number): number;
    tileXYToRectangle(x: number, y: number, level: number, result?: Rectangle): Rectangle;
  }

  export class HeightmapTerrainData {
    constructor(options: {
      buffer:
        | Int8Array
        | Uint8Array
        | Int16Array
        | Uint16Array
        | Int32Array
        | Uint32Array
        | Float32Array
        | Float64Array;
      width: number;
      height: number;
      childTileMask?: number;
      waterMask?: Uint8Array;
      structure?: {
        heightScale?: number;
        heightOffset?: number;
        elementsPerHeight?: number;
        stride?: number;
        elementMultiplier?: number;
        isBigEndian?: boolean;
        lowestEncodedHeight?: number;
        highestEncodedHeight?: number;
      };
      createdByUpsampling?: boolean;
    });
    readonly credits: Credit[];
  }

  export class TileProviderError {
    constructor(
      provider: TerrainProvider,
      message: string,
      error: unknown,
      timesRetried?: number,
      retryFunction?: () => void,
      errorDetails?: unknown,
    );
    readonly provider: TerrainProvider;
    readonly message: string;
    readonly error: unknown;
    readonly timesRetried: number;
  }

  export class TerrainProvider {
    readonly errorEvent: Event;
    readonly credit: Credit;
    readonly tilingScheme: TilingScheme;
    readonly hasWaterMask: boolean;
    readonly hasVertexNormals: boolean;
    readonly ready: boolean;
    readonly availability: TileAvailability | undefined;
    requestTileGeometry(
      x: number,
      y: number,
      level: number,
      request?: unknown,
    ): Promise<HeightmapTerrainData | undefined> | undefined;
    getLevelMaximumGeometricError(level: number): number;
    getTileDataAvailable(x: number, y: number, level: number): boolean | undefined;
    loadTileDataAvailability(x: number, y: number, level: number): Promise<void>;
  }

  export class PerspectiveFrustum {
    readonly projectionMatrix: Float64Array;
    readonly fov: number;
    readonly aspectRatio: number;
    readonly near: number;
    readonly far: number;
  }

  export class Camera {
    readonly viewMatrix: Float64Array;
    readonly frustum: PerspectiveFrustum;
    readonly positionCartographic: Cartographic;
    setView(options: { destination: Rectangle | Cartographic | unknown }): void;
  }

  export class GlobeTranslucency {
    enabled: boolean;
    frontFaceAlpha: number;
    frontFaceAlphaByDistance: unknown;
    backFaceAlpha: number;
  }

  export class Globe {
    show: boolean;
    baseColor: Color;
    terrainProvider: TerrainProvider;
    readonly tilesLoaded: boolean;
    readonly tileLoadProgressEvent: Event;
    readonly translucency: GlobeTranslucency;
    readonly ellipsoid: Ellipsoid;
    enableLighting: boolean;
    showSkirts: boolean;
    depthTestAgainstTerrain: boolean;
    maximumScreenSpaceError: number;
    tileCacheSize: number;
  }

  export class Scene {
    readonly camera: Camera;
    readonly globe: Globe;
    readonly canvas: HTMLCanvasElement;
    readonly drawingBufferWidth: number;
    readonly drawingBufferHeight: number;
    backgroundColor: Color;
    readonly postRender: Event;
    readonly preRender: Event;
    readonly renderError: Event;
    requestRenderMode: boolean;
    requestRender(): void;
  }

  export class CesiumWidget {
    constructor(
      container: Element | string,
      options?: {
        baseLayer?: unknown | false;
        terrainProvider?: TerrainProvider;
        skyBox?: unknown | false;
        skyAtmosphere?: unknown | false;
        useBrowserRecommendedResolution?: boolean;
        resolutionScale?: number;
        requestRenderMode?: boolean;
        contextOptions?: {
          webgl?: Record<string, unknown>;
          webgl1?: Record<string, unknown>;
        };
        creditContainer?: Element | string;
        useDefaultRenderLoop?: boolean;
        msaaSamples?: number;
      },
    );
    readonly scene: Scene;
    readonly canvas: HTMLCanvasElement;
    terrainProvider: TerrainProvider;
    resolutionScale: number;
    useBrowserRecommendedResolution: boolean;
    resize(): void;
    isDestroyed(): boolean;
    destroy(): void;
  }
}
