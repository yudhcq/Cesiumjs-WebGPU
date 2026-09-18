/**
 * Demo page entry — imports ONLY the package entry point.
 *
 * Contract render-path-api.md §5 C-5 / data-model §11 A5: this file MUST NOT contain any
 * render-path branch. The backend preference is read as an opaque configuration value and
 * handed to the package; which backend ends up running is observable through `onStatus`,
 * never decided here. The status area is display-only (FR-009).
 */
import { createTerrainScene } from "cesium-webgpu";
import type {
  DiagnosticError,
  RenderPathStatus,
  TerrainSceneHandle,
  TerrainSceneOptions,
} from "cesium-webgpu";

/** Dataset that ships with the package (see contracts/terrain-source.md §2). */
const DEFAULT_DATASET_ID = "matterhorn-z0-12";

interface DemoElements {
  container: HTMLElement;
  state: HTMLElement;
  active: HTMLElement;
  reason: HTMLElement;
  degraded: HTMLElement;
  notes: HTMLElement;
  message: HTMLElement;
  tiles: HTMLElement;
  tilesProgress: HTMLProgressElement;
  dataset: HTMLElement;
  lossButton: HTMLButtonElement;
}

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) {
    throw new Error(`demo: required element "${selector}" is missing from index.html`);
  }
  return element;
}

function collectElements(): DemoElements {
  return {
    container: requireElement<HTMLElement>("[data-demo-container]"),
    state: requireElement<HTMLElement>('[data-field="state"]'),
    active: requireElement<HTMLElement>('[data-field="active"]'),
    reason: requireElement<HTMLElement>('[data-field="reason"]'),
    degraded: requireElement<HTMLElement>('[data-field="degraded"]'),
    notes: requireElement<HTMLElement>('[data-field="notes"]'),
    message: requireElement<HTMLElement>('[data-field="message"]'),
    tiles: requireElement<HTMLElement>('[data-field="tiles"]'),
    tilesProgress: requireElement<HTMLProgressElement>('[data-field="tiles-progress"]'),
    dataset: requireElement<HTMLElement>('[data-field="dataset"]'),
    lossButton: requireElement<HTMLButtonElement>('[data-action="simulate-device-loss"]'),
  };
}

function renderStatus(elements: DemoElements, status: RenderPathStatus): void {
  elements.state.textContent = "已就绪";
  elements.active.textContent = status.active;
  elements.reason.textContent = status.reason;
  elements.degraded.textContent = status.degraded ? "是（见盲区备注）" : "否";
  elements.notes.textContent = status.notes.length > 0 ? status.notes.join("；") : "无";
}

function renderDiagnostic(elements: DemoElements, error: DiagnosticError): void {
  elements.state.textContent = `诊断：${error.category}`;
  elements.message.textContent = error.message;
}

/** Opaque configuration value: the demo never inspects it (no backend branch in the caller). */
function readPreference(): NonNullable<TerrainSceneOptions["preference"]> {
  const raw = new URLSearchParams(globalThis.location?.search ?? "").get("preference");
  return (raw ?? "auto") as NonNullable<TerrainSceneOptions["preference"]>;
}

export function start(datasetId: string = DEFAULT_DATASET_ID): TerrainSceneHandle | undefined {
  const elements = collectElements();
  elements.dataset.textContent = datasetId;
  elements.tilesProgress.value = 0;
  elements.tiles.textContent = "— / —";
  const errors: DiagnosticError[] = [];

  const options: TerrainSceneOptions = {
    container: elements.container,
    datasetId,
    preference: readPreference(),
    camera: { longitude: 7.6586, latitude: 45.9763, height: 12_000, heading: 0, pitch: -35, roll: 0 },
    viewport: {
      width: elements.container.clientWidth,
      height: elements.container.clientHeight,
      devicePixelRatio: globalThis.devicePixelRatio ?? 1,
    },
    onStatus: (status) => renderStatus(elements, status),
  };

  try {
    const handle = createTerrainScene(options);
    handle.diagnostics.onError((error) => {
      errors.push(error);
      renderDiagnostic(elements, error);
    });
    return handle;
  } catch (error) {
    const diagnostic = error as DiagnosticError;
    renderDiagnostic(elements, {
      category: typeof diagnostic.category === "string" ? diagnostic.category : "internal",
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

// "模拟设备丢失" placeholder: the stop/destroy/re-probe/rebuild flow is wired in the
// device-loss phase; here the entry only reports its own state.
document.addEventListener("DOMContentLoaded", () => {
  const elements = collectElements();
  elements.lossButton.addEventListener("click", () => {
    elements.message.textContent =
      "占位入口：设备丢失恢复流程尚未接入（需要先有可用的场景句柄）。";
  });
});
