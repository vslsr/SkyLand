import * as THREE from 'three';
import type { ChunkGeometryData } from '../../shared/world/chunkGenerator.mjs';
import { readChunkProps } from '../../shared/world/chunkContent.mjs';
import { PROP_KIND } from '../../shared/world/worldConfig.mjs';
import type { FillMaterialEnvironment } from '../materials/createFillMaterial';
import {
  createPlacedGrassGeometry,
  type GrassClusterPlacement,
  type GrassFieldBounds,
} from '../models/grass';
import type { SceneUpdateContext, SceneVisualSystem } from '../scene/SceneVisualSystem';
import type {
  GrassGradientOverrides,
  GrassHeightVariationSettings,
  GrassWindSettings,
} from './GrassAppearance';
import { GrassBendField } from './GrassBendField';
import { GrassInteractionQueue, type GrassInteractionTarget } from './GrassInteraction';
import { GrassMaterials } from './createGrassMaterials';
import { GrassTrailRecorder } from './GrassTrailRecorder';

// 固定 32 m / 256 px（0.125 m/px）的滑动窗口；成本不随世界尺寸增长。
const DEFAULT_BEND_WINDOW_SIZE = 32;
const DEFAULT_BEND_WINDOW_STEP = 4;
const DEFAULT_BEND_TEXTURE_SIZE = 256;

interface StreamingGrassSystemOptions {
  color: THREE.ColorRepresentation;
  environment: FillMaterialEnvironment;
  bendTextureSize?: number;
  bendWindowSize?: number;
  bendWindowStep?: number;
  gradient?: GrassGradientOverrides;
  wind?: Partial<GrassWindSettings>;
  heightVariation?: Partial<GrassHeightVariationSettings>;
}

interface GrassChunkView {
  root: THREE.Group;
  fillGeometry: THREE.InstancedBufferGeometry;
  outlineGeometry: THREE.InstancedBufferGeometry;
}

/**
 * 为流式世界单独渲染草簇，同时让所有已加载 chunk 共用一张局部滑动弯曲纹理。
 * 静态 chunk 仍负责地面、树和岩石；草簇的放置记录只在这里换成实例叶片。
 */
export class StreamingGrassSystem implements SceneVisualSystem {
  public readonly root = new THREE.Group();
  public readonly interaction: GrassInteractionTarget;

  private readonly interactionQueue = new GrassInteractionQueue();
  private readonly trails = new GrassTrailRecorder();
  private readonly bendField: GrassBendField;
  private readonly materials: GrassMaterials;
  private readonly chunks = new Map<string, GrassChunkView>();
  private readonly fieldBounds = new THREE.Vector4();
  private readonly bendWindowSize: number;
  private readonly bendWindowStep: number;
  private bendWindowCenterX = 0;
  private bendWindowCenterZ = 0;
  private pendingDeltaSeconds = 0;

  public constructor(options: StreamingGrassSystemOptions) {
    this.root.name = 'streaming-grass-system';
    this.interaction = this.interactionQueue;
    this.bendWindowSize = positiveFiniteOr(options.bendWindowSize, DEFAULT_BEND_WINDOW_SIZE);
    this.bendWindowStep = positiveFiniteOr(options.bendWindowStep, DEFAULT_BEND_WINDOW_STEP);
    const initialBounds = createBendWindowBounds(0, 0, this.bendWindowSize);
    this.fieldBounds.set(
      initialBounds.minimumX,
      initialBounds.minimumZ,
      initialBounds.maximumX,
      initialBounds.maximumZ,
    );
    this.bendField = new GrassBendField(initialBounds, {
      textureSize: positiveFiniteOr(options.bendTextureSize, DEFAULT_BEND_TEXTURE_SIZE),
    });
    this.materials = new GrassMaterials({
      color: options.color,
      environment: options.environment,
      bendTexture: this.bendField.texture,
      fieldBounds: this.fieldBounds,
      gradient: options.gradient,
      wind: options.wind,
      heightVariation: options.heightVariation,
    });
  }

  /** 供诊断与回归测试读取；返回副本，外部不能改写运行态窗口。 */
  public get bendWindowBounds(): GrassFieldBounds {
    return {
      minimumX: this.fieldBounds.x,
      minimumZ: this.fieldBounds.y,
      maximumX: this.fieldBounds.z,
      maximumZ: this.fieldBounds.w,
    };
  }

  public mountChunk(key: string, data: ChunkGeometryData): void {
    this.unmountChunk(key);
    const placements: GrassClusterPlacement[] = readChunkProps(data.props, data.propCount)
      .filter((prop) => prop.kind === PROP_KIND.GRASS);
    if (placements.length === 0) return;

    const geometry = createPlacedGrassGeometry(placements);
    const root = new THREE.Group();
    const fill = new THREE.Mesh(geometry.fill, this.materials.fill);
    const outline = new THREE.LineSegments(geometry.outline, this.materials.outline);
    root.name = `grass-chunk-${key}`;
    fill.frustumCulled = false;
    outline.frustumCulled = false;
    fill.renderOrder = 0;
    outline.renderOrder = 1;
    root.add(fill, outline);
    this.root.add(root);
    this.chunks.set(key, {
      root,
      fillGeometry: geometry.fill,
      outlineGeometry: geometry.outline,
    });
  }

  public unmountChunk(key: string): void {
    const chunk = this.chunks.get(key);
    if (!chunk) return;
    this.chunks.delete(key);
    chunk.root.parent?.remove(chunk.root);
    chunk.fillGeometry.dispose();
    chunk.outlineGeometry.dispose();
  }

  public update(
    deltaSeconds: number,
    elapsedSeconds: number,
    context?: SceneUpdateContext,
  ): void {
    if (context) {
      this.updateBendWindow(context.focusX, context.focusZ);
      this.trails.setFocus(context.focusX, context.focusZ);
    }
    this.pendingDeltaSeconds += deltaSeconds;
    this.materials.setTime(elapsedSeconds);
  }

  public beforeRender(renderer: THREE.WebGLRenderer): void {
    // 窗口外的路径照样记录、只是不盖章：玩家走回来时足迹还在，
    // 而条数上界由 GrassTrailRecorder 兜住，不随世界里的玩家总数增长。
    this.trails.ingest(this.interactionQueue.drain());
    this.trails.advance(this.pendingDeltaSeconds);
    this.pendingDeltaSeconds = 0;
    this.bendField.render(renderer, this.trails);
  }

  public dispose(): void {
    for (const key of Array.from(this.chunks.keys())) this.unmountChunk(key);
    this.interactionQueue.clear();
    this.trails.clear();
    this.bendField.dispose();
    this.materials.dispose();
  }

  private updateBendWindow(focusX: number, focusZ: number): void {
    if (!Number.isFinite(focusX) || !Number.isFinite(focusZ)) return;
    // 带迟滞地按整步移动，避免网络和解在边界附近抖动时反复重画。
    // 大幅传送仍用一次除法直接跨越任意距离，不按路程逐步循环。
    const centerX = advanceWindowCenter(this.bendWindowCenterX, focusX, this.bendWindowStep);
    const centerZ = advanceWindowCenter(this.bendWindowCenterZ, focusZ, this.bendWindowStep);
    if (centerX === this.bendWindowCenterX && centerZ === this.bendWindowCenterZ) return;

    this.bendWindowCenterX = centerX;
    this.bendWindowCenterZ = centerZ;
    const bounds = createBendWindowBounds(centerX, centerZ, this.bendWindowSize);
    // 弯曲场是路径的纯函数，换窗口不需要重投影旧纹理：下一帧按新范围重画即可，
    // 边缘不再丢失压痕，传送也不会把上一处的鬼影拖过来。
    this.fieldBounds.set(
      bounds.minimumX,
      bounds.minimumZ,
      bounds.maximumX,
      bounds.maximumZ,
    );
    this.bendField.setBounds(bounds);
  }
}

function createBendWindowBounds(
  focusX: number,
  focusZ: number,
  size: number,
): GrassFieldBounds {
  const halfSize = size * 0.5;
  return {
    minimumX: focusX - halfSize,
    maximumX: focusX + halfSize,
    minimumZ: focusZ - halfSize,
    maximumZ: focusZ + halfSize,
  };
}

function advanceWindowCenter(current: number, focus: number, step: number): number {
  const delta = focus - current;
  if (Math.abs(delta) <= step) return current;
  const steps = delta > 0 ? Math.floor(delta / step) : Math.ceil(delta / step);
  return current + steps * step;
}

function positiveFiniteOr(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? value as number : fallback;
}
