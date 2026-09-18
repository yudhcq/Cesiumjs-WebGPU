/**
 * G-1 gate — minimal ambient surface for the WebGPU side of the experiment.
 *
 * The product code will use `@webgpu/types` (installed by tasks.md T011). The gate must run
 * *before* Phase 2 exists, so it declares only the handful of WebGPU members it touches and
 * deliberately leaves descriptor objects loosely typed. This file is scaffolding, not product
 * type safety: nothing here is part of the deliverable library.
 */

interface GPUAdapterInfo {
  readonly vendor: string;
  readonly architecture: string;
  readonly device: string;
  readonly description: string;
  readonly subgroupMinSize?: number;
  readonly subgroupMaxSize?: number;
}

interface GPUAdapter {
  readonly info: GPUAdapterInfo;
  readonly isFallbackAdapter?: boolean;
  readonly features?: { has(name: string): boolean };
  readonly limits?: Record<string, number>;
  requestDevice(descriptor?: unknown): Promise<GPUDevice>;
}

interface GPUTextureView {}

interface GPUTexture {
  createView(descriptor?: unknown): GPUTextureView;
}

interface GPUCanvasContext {
  readonly canvas: HTMLCanvasElement;
  configure(configuration: {
    device: GPUDevice;
    format: string;
    alphaMode?: "opaque" | "premultiplied";
    usage?: number;
  }): void;
  unconfigure(): void;
  getCurrentTexture(): GPUTexture;
}

interface GPUDevice {
  readonly lost: Promise<{ reason: string; message: string }>;
  readonly queue: { submit(commandBuffers: unknown[]): void };
  createBuffer(descriptor: unknown): { destroy(): void };
  createShaderModule(descriptor: { code: string; label?: string }): unknown;
  createRenderPipeline(descriptor: unknown): unknown;
  createCommandEncoder(descriptor?: unknown): {
    beginRenderPass(descriptor: unknown): {
      setPipeline(pipeline: unknown): void;
      setVertexBuffer(slot: number, buffer: unknown): void;
      draw(vertexCount: number, instanceCount?: number): void;
      end(): void;
    };
    finish(): unknown;
  };
  destroy(): void;
}

interface GPU {
  requestAdapter(options?: {
    powerPreference?: "low-power" | "high-performance";
    forceFallbackAdapter?: boolean;
  }): Promise<GPUAdapter | null>;
  getPreferredCanvasFormat(): string;
}

interface Navigator {
  readonly gpu?: GPU;
}
