import * as THREE from 'three';
import type { ChunkGeometryData } from '../../shared/world/chunkGenerator.mjs';
import { readChunkProps } from '../../shared/world/chunkContent.mjs';
import { PROP_KIND } from '../../shared/world/worldConfig.mjs';
import {
  createEnvironmentUniforms,
  type FillMaterialEnvironment,
} from '../materials/createFillMaterial';
import {
  createPlacedGrassGeometry,
  type GrassClusterPlacement,
  type GrassFieldBounds,
  type GrassFieldGeometry,
} from '../models/grass';
import { createGrassPatchGeometry } from '../models/grassPatch';
import type { SceneUpdateContext, SceneVisualSystem } from '../scene/SceneVisualSystem';
import {
  GRASS_FILL_FRAGMENT_SHADER,
  GRASS_FILL_VERTEX_SHADER,
  GRASS_OUTLINE_FRAGMENT_SHADER,
  GRASS_OUTLINE_VERTEX_SHADER,
} from '../shaders/grass';
import { GrassBendField } from './GrassBendField';
import {
  generateChunkGrassPatches,
  type GrassPatchConfig,
} from './grassPatchField';
import { GrassInteractionQueue, type GrassInteractionTarget } from './GrassInteraction';

const GRASS_LOD_NEAR_DISTANCE = 10;
const GRASS_LOD_FAR_DISTANCE = 28;
// 固定 32 m / 256 px（0.125 m/px）的双缓冲窗口；成本不随世界尺寸增长。
const DEFAULT_BEND_WINDOW_SIZE = 32;
const DEFAULT_BEND_WINDOW_STEP = 4;
const DEFAULT_BEND_TEXTURE_SIZE = 256;
/**
 * 单个 chunk 的密草叶片上限。
 *
 * 草丛数与半径都有上界，这里再兜一层：无论配置怎么写，keepRadius 内的草丛
 * 实例数都是「chunk 数 × 这个常量」，不随世界面积增长。
 */
const MAX_PATCH_BLADES_PER_CHUNK = 4_000;

interface StreamingGrassSystemOptions {
  color: THREE.ColorRepresentation;
  environment: FillMaterialEnvironment;
  bendTextureSize?: number;
  bendWindowSize?: number;
  bendWindowStep?: number;
  /** 成片密草的生成参数；不给就只渲染生成器放置的稀疏草簇。 */
  patches?: GrassPatchConfig;
}

/** 挂载一个 chunk 时，密草需要知道的世界信息。 */
export interface GrassChunkAnchor {
  worldSeed: number;
  chunkX: number;
  chunkZ: number;
  /** 草根贴地采样；返回 undefined 表示该点不长草（水面等）。 */
  sampleAnchor: (x: number, z: number) => number | undefined;
}

interface GrassChunkView {
  root: THREE.Group;
  geometries: GrassFieldGeometry[];
}

/**
 * 为流式世界单独渲染草簇，同时让所有已加载 chunk 共用一张局部滑动弯曲纹理。
 * 静态 chunk 仍负责地面、树和岩石；草簇的放置记录只在这里换成实例叶片。
 */
export class StreamingGrassSystem implements SceneVisualSystem {
  public readonly root = new THREE.Group();
  public readonly interaction: GrassInteractionTarget;

  private readonly interactionQueue = new GrassInteractionQueue();
  private readonly bendField: GrassBendField;
  private readonly sharedUniforms: Record<string, THREE.IUniform>;
  private readonly fillMaterial: THREE.ShaderMaterial;
  private readonly outlineMaterial: THREE.ShaderMaterial;
  private readonly chunks = new Map<string, GrassChunkView>();
  private readonly patchConfig?: GrassPatchConfig;
  private readonly requestedFieldBounds = new THREE.Vector4();
  private readonly renderedFieldBounds = new THREE.Vector4();
  private readonly bendWindowSize: number;
  private readonly bendWindowStep: number;
  private bendWindowCenterX = 0;
  private bendWindowCenterZ = 0;
  private pendingDeltaSeconds = 0;

  public constructor(options: StreamingGrassSystemOptions) {
    this.root.name = 'streaming-grass-system';
    this.interaction = this.interactionQueue;
    this.patchConfig = options.patches;
    this.bendWindowSize = positiveFiniteOr(options.bendWindowSize, DEFAULT_BEND_WINDOW_SIZE);
    this.bendWindowStep = positiveFiniteOr(options.bendWindowStep, DEFAULT_BEND_WINDOW_STEP);
    const initialBounds = createBendWindowBounds(
      0,
      0,
      this.bendWindowSize,
    );
    this.requestedFieldBounds.set(
      initialBounds.minimumX,
      initialBounds.minimumZ,
      initialBounds.maximumX,
      initialBounds.maximumZ,
    );
    this.renderedFieldBounds.copy(this.requestedFieldBounds);
    this.bendField = new GrassBendField(
      initialBounds,
      positiveFiniteOr(options.bendTextureSize, DEFAULT_BEND_TEXTURE_SIZE),
    );
    this.sharedUniforms = {
      ...createEnvironmentUniforms(options.environment),
      uTime: { value: 0 },
      uBendTexture: { value: this.bendField.texture },
      uFieldBounds: {
        value: this.renderedFieldBounds,
      },
      uGrassLodNear: { value: GRASS_LOD_NEAR_DISTANCE },
      uGrassLodFar: { value: GRASS_LOD_FAR_DISTANCE },
    };
    this.fillMaterial = new THREE.ShaderMaterial({
      vertexShader: GRASS_FILL_VERTEX_SHADER,
      fragmentShader: GRASS_FILL_FRAGMENT_SHADER,
      uniforms: {
        ...this.sharedUniforms,
        uFillColor: { value: new THREE.Color(options.color) },
      },
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    this.outlineMaterial = new THREE.ShaderMaterial({
      vertexShader: GRASS_OUTLINE_VERTEX_SHADER,
      fragmentShader: GRASS_OUTLINE_FRAGMENT_SHADER,
      uniforms: {
        ...this.sharedUniforms,
        uLineColor: { value: new THREE.Color(0x171614) },
      },
      depthWrite: false,
    });
  }

  /** 供诊断与回归测试读取；返回副本，外部不能改写运行态窗口。 */
  public get bendWindowBounds(): GrassFieldBounds {
    return {
      minimumX: this.requestedFieldBounds.x,
      minimumZ: this.requestedFieldBounds.y,
      maximumX: this.requestedFieldBounds.z,
      maximumZ: this.requestedFieldBounds.w,
    };
  }

  public mountChunk(key: string, data: ChunkGeometryData, anchor?: GrassChunkAnchor): void {
    this.unmountChunk(key);
    const geometries: GrassFieldGeometry[] = [];
    const placements: GrassClusterPlacement[] = readChunkProps(data.props, data.propCount)
      .filter((prop) => prop.kind === PROP_KIND.GRASS);
    // 生成器放置的稀疏草簇一如既往地画出来；密草是叠加上去的第二层。
    if (placements.length > 0) geometries.push(createPlacedGrassGeometry(placements));
    const patchGeometry = this.createPatchGeometry(anchor);
    if (patchGeometry) geometries.push(patchGeometry);
    if (geometries.length === 0) return;

    const root = new THREE.Group();
    root.name = `grass-chunk-${key}`;
    for (const geometry of geometries) {
      const fill = new THREE.Mesh(geometry.fill, this.fillMaterial);
      const outline = new THREE.LineSegments(geometry.outline, this.outlineMaterial);
      fill.frustumCulled = false;
      outline.frustumCulled = false;
      fill.renderOrder = 0;
      outline.renderOrder = 1;
      root.add(fill, outline);
    }
    this.root.add(root);
    this.chunks.set(key, { root, geometries });
  }

  public unmountChunk(key: string): void {
    const chunk = this.chunks.get(key);
    if (!chunk) return;
    this.chunks.delete(key);
    chunk.root.parent?.remove(chunk.root);
    for (const geometry of chunk.geometries) {
      geometry.fill.dispose();
      geometry.outline.dispose();
    }
  }

  public update(
    deltaSeconds: number,
    elapsedSeconds: number,
    context?: SceneUpdateContext,
  ): void {
    if (context) this.updateBendWindow(context.focusX, context.focusZ);
    this.pendingDeltaSeconds += deltaSeconds;
    this.sharedUniforms.uTime.value = elapsedSeconds;
  }

  public beforeRender(renderer: THREE.WebGLRenderer): void {
    const impulses = this.interactionQueue.drain().filter((impulse) => (
      impulseIntersectsBounds(impulse, this.requestedFieldBounds)
    ));
    if (impulses.length === 0) {
      this.bendField.step(renderer, this.pendingDeltaSeconds);
    } else {
      this.bendField.step(renderer, this.pendingDeltaSeconds, impulses[0]);
      for (let index = 1; index < impulses.length; index += 1) {
        this.bendField.step(renderer, 0, impulses[index]);
      }
    }
    this.pendingDeltaSeconds = 0;
    this.bendField.copyTextureBounds(this.renderedFieldBounds);
    this.sharedUniforms.uBendTexture.value = this.bendField.texture;
  }

  public dispose(): void {
    for (const key of Array.from(this.chunks.keys())) this.unmountChunk(key);
    this.interactionQueue.clear();
    this.bendField.dispose();
    this.fillMaterial.dispose();
    this.outlineMaterial.dispose();
  }

  private createPatchGeometry(anchor?: GrassChunkAnchor): GrassFieldGeometry | undefined {
    if (!this.patchConfig || !anchor) return undefined;
    const patches = generateChunkGrassPatches(
      anchor.worldSeed,
      anchor.chunkX,
      anchor.chunkZ,
      this.patchConfig,
    );
    return createGrassPatchGeometry(patches, {
      bladeDensity: this.patchConfig.bladeDensity,
      sampleAnchor: anchor.sampleAnchor,
      maximumBladeCount: MAX_PATCH_BLADES_PER_CHUNK,
    });
  }

  private updateBendWindow(focusX: number, focusZ: number): void {
    if (!Number.isFinite(focusX) || !Number.isFinite(focusZ)) return;
    // 带迟滞地按整步移动，避免网络和解在边界附近抖动时反复重投影。
    // 大幅传送仍用一次除法直接跨越任意距离，不按路程逐步循环。
    const centerX = advanceWindowCenter(
      this.bendWindowCenterX,
      focusX,
      this.bendWindowStep,
    );
    const centerZ = advanceWindowCenter(
      this.bendWindowCenterZ,
      focusZ,
      this.bendWindowStep,
    );
    if (centerX === this.bendWindowCenterX && centerZ === this.bendWindowCenterZ) return;

    this.bendWindowCenterX = centerX;
    this.bendWindowCenterZ = centerZ;
    const bounds = createBendWindowBounds(
      centerX,
      centerZ,
      this.bendWindowSize,
    );
    this.requestedFieldBounds.set(
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

function impulseIntersectsBounds(
  impulse: Readonly<{
    positionX: number;
    positionZ: number;
    startPositionX: number;
    startPositionZ: number;
    radius: number;
  }>,
  bounds: Readonly<THREE.Vector4>,
): boolean {
  const minimumX = bounds.x - impulse.radius;
  const maximumX = bounds.z + impulse.radius;
  const minimumZ = bounds.y - impulse.radius;
  const maximumZ = bounds.w + impulse.radius;
  const deltaX = impulse.positionX - impulse.startPositionX;
  const deltaZ = impulse.positionZ - impulse.startPositionZ;
  let minimumTime = 0;
  let maximumTime = 1;

  for (const [start, delta, minimum, maximum] of [
    [impulse.startPositionX, deltaX, minimumX, maximumX],
    [impulse.startPositionZ, deltaZ, minimumZ, maximumZ],
  ] as const) {
    if (Math.abs(delta) < 0.0001) {
      if (start < minimum || start > maximum) return false;
      continue;
    }
    const inverseDelta = 1 / delta;
    let nearTime = (minimum - start) * inverseDelta;
    let farTime = (maximum - start) * inverseDelta;
    if (nearTime > farTime) [nearTime, farTime] = [farTime, nearTime];
    minimumTime = Math.max(minimumTime, nearTime);
    maximumTime = Math.min(maximumTime, farTime);
    if (minimumTime > maximumTime) return false;
  }
  return true;
}

function positiveFiniteOr(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? value as number : fallback;
}
