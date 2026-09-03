import * as THREE from 'three';
import type { GrassFieldBounds } from '../models/grass';
import {
  GRASS_TRAIL_STAMP_FRAGMENT_SHADER,
  GRASS_TRAIL_STAMP_VERTEX_SHADER,
} from '../shaders/grass';
import type { GrassTrailPath, GrassTrailPoint } from './GrassTrailPath';
import type { GrassTrailRecorder } from './GrassTrailRecorder';

/** 弯曲纹理的默认边长。32 米窗口下约 0.125 米/像素，够画出脚印的宽度。 */
const DEFAULT_BEND_TEXTURE_SIZE = 256;

/** 中性状态：方向为零向量（编码成 0.5），强度为 0。 */
const NEUTRAL_BEND_COLOR = Object.freeze(new THREE.Color(0.5, 0.5, 0));

/** 每段路径盖章时，方向里混入多少「沿行进方向推倒」。其余是径向推开。 */
const DEFAULT_ALONG_BIAS = 0.35;

/** 每段线段占的浮点数：start.xy + end.xy + (radius, startStrength, endStrength)。 */
const FLOATS_PER_SEGMENT_START = 2;
const FLOATS_PER_SEGMENT_END = 2;
const FLOATS_PER_SEGMENT_SHAPE = 3;

export interface GrassBendFieldOptions {
  textureSize?: number;
  /** 线段实例的上界，直接决定这块显存有多大。 */
  maxSegments?: number;
  alongBias?: number;
}

/**
 * 草地弯曲向量场。
 *
 * 它是**路径的一个纯函数**：每帧清成中性色，再把当前所有足迹路径按线段盖上去。
 * 这一点是刻意的，换来三件以前做不到的事：
 *
 * - 滑动窗口移动时不需要把旧纹理重投影到新坐标——直接用新范围重画一遍即可，
 *   边缘不再丢失压痕，大幅传送也不会拖着上一处的鬼影。
 * - 新流进来的 chunk 立刻带着已有的足迹，而不是从中性状态慢慢重新被踩出来。
 * - 场的内容可以从网络同步的路径重建，不再是只存在于 GPU 上的历史。
 *
 * 成本也从「每帧一次全屏 pass + 每个冲量再来一次」降到「每帧一次清屏 + 一次
 * 实例化绘制」，绘制面积只覆盖足迹本身而不是整张纹理。
 */
export class GrassBendField {
  private readonly scene = new THREE.Scene();
  /** 盖章着色器直接写裁剪空间坐标，这台相机只是 render() 的必填参数。 */
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly geometry = new THREE.InstancedBufferGeometry();
  private readonly material: THREE.ShaderMaterial;
  private readonly target: THREE.WebGLRenderTarget;
  private readonly bounds: THREE.Vector4;
  private readonly maxSegments: number;
  private readonly segmentStarts: Float32Array;
  private readonly segmentEnds: Float32Array;
  private readonly segmentShapes: Float32Array;
  private readonly startAttribute: THREE.InstancedBufferAttribute;
  private readonly endAttribute: THREE.InstancedBufferAttribute;
  private readonly shapeAttribute: THREE.InstancedBufferAttribute;
  private readonly scratchPoint: GrassTrailPoint = {
    x: 0,
    z: 0,
    radius: 0,
    strength: 0,
    age: 0,
  };
  private readonly scratchClearColor = new THREE.Color();
  private readonly previousPoint: GrassTrailPoint = {
    x: 0,
    z: 0,
    radius: 0,
    strength: 0,
    age: 0,
  };
  private segmentCount = 0;

  public constructor(bounds: GrassFieldBounds, options: GrassBendFieldOptions = {}) {
    this.bounds = new THREE.Vector4(
      bounds.minimumX,
      bounds.minimumZ,
      bounds.maximumX,
      bounds.maximumZ,
    );
    this.maxSegments = Math.max(1, Math.floor(
      positiveFiniteOr(options.maxSegments, 192),
    ));
    this.target = createBendTarget(
      positiveFiniteOr(options.textureSize, DEFAULT_BEND_TEXTURE_SIZE),
    );

    const quad = new THREE.PlaneBufferGeometry(2, 2);
    if (quad.index) this.geometry.setIndex(quad.index.clone());
    for (const [name, attribute] of Object.entries(quad.attributes)) {
      this.geometry.setAttribute(name, (attribute as THREE.BufferAttribute).clone());
    }
    quad.dispose();

    this.segmentStarts = new Float32Array(this.maxSegments * FLOATS_PER_SEGMENT_START);
    this.segmentEnds = new Float32Array(this.maxSegments * FLOATS_PER_SEGMENT_END);
    this.segmentShapes = new Float32Array(this.maxSegments * FLOATS_PER_SEGMENT_SHAPE);
    this.startAttribute = new THREE.InstancedBufferAttribute(
      this.segmentStarts,
      FLOATS_PER_SEGMENT_START,
    );
    this.endAttribute = new THREE.InstancedBufferAttribute(
      this.segmentEnds,
      FLOATS_PER_SEGMENT_END,
    );
    this.shapeAttribute = new THREE.InstancedBufferAttribute(
      this.segmentShapes,
      FLOATS_PER_SEGMENT_SHAPE,
    );
    this.startAttribute.setUsage(THREE.DynamicDrawUsage);
    this.endAttribute.setUsage(THREE.DynamicDrawUsage);
    this.shapeAttribute.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('aSegmentStart', this.startAttribute);
    this.geometry.setAttribute('aSegmentEnd', this.endAttribute);
    this.geometry.setAttribute('aSegmentShape', this.shapeAttribute);
    this.geometry.instanceCount = 0;

    this.material = new THREE.ShaderMaterial({
      vertexShader: GRASS_TRAIL_STAMP_VERTEX_SHADER,
      fragmentShader: GRASS_TRAIL_STAMP_FRAGMENT_SHADER,
      uniforms: {
        uFieldBounds: { value: this.bounds },
        uAlongBias: { value: clamp01(positiveFiniteOr(options.alongBias, DEFAULT_ALONG_BIAS)) },
      },
      // 普通混合就够：越晚画的一段权重越高，新足迹自然覆盖旧足迹，
      // 不需要浮点渲染目标去做有符号向量的累加。
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });

    const mesh = new THREE.Mesh(this.geometry, this.material);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
  }

  public get texture(): THREE.Texture {
    return this.target.texture;
  }

  /** 当前这一帧实际盖了多少段；供诊断与回归测试读取。 */
  public get stampedSegmentCount(): number {
    return this.segmentCount;
  }

  /**
   * 设定局部世界窗口。
   *
   * 立即生效：场是路径的纯函数，换范围只要下一帧按新范围重画，
   * 没有「旧纹理」需要重投影。
   */
  public setBounds(bounds: GrassFieldBounds): void {
    if (
      !Number.isFinite(bounds.minimumX)
      || !Number.isFinite(bounds.maximumX)
      || !Number.isFinite(bounds.minimumZ)
      || !Number.isFinite(bounds.maximumZ)
      || bounds.minimumX >= bounds.maximumX
      || bounds.minimumZ >= bounds.maximumZ
    ) {
      throw new RangeError('草地弯曲窗口必须是有限且非空的范围');
    }
    this.bounds.set(bounds.minimumX, bounds.minimumZ, bounds.maximumX, bounds.maximumZ);
  }

  public copyBounds(target: THREE.Vector4): void {
    target.copy(this.bounds);
  }

  /** 重画整张场。窗口外的路径整条跳过，绘制量因此只跟看得见的足迹有关。 */
  public render(renderer: THREE.WebGLRenderer, recorder: GrassTrailRecorder): void {
    this.prepareSegments(recorder);
    const previousTarget = renderer.getRenderTarget();
    const previousClearColor = renderer.getClearColor(this.scratchClearColor).clone();
    const previousClearAlpha = renderer.getClearAlpha();

    const previousAutoClear = renderer.autoClear;
    renderer.setClearColor(NEUTRAL_BEND_COLOR, 1);
    renderer.setRenderTarget(this.target);
    // 自己清一次就够，render 再清一遍是白费一整张纹理的写入。
    renderer.autoClear = false;
    renderer.clear(true, false, false);
    if (this.segmentCount > 0) renderer.render(this.scene, this.camera);
    renderer.autoClear = previousAutoClear;
    renderer.setRenderTarget(previousTarget);
    renderer.setClearColor(previousClearColor, previousClearAlpha);
  }

  public dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.target.dispose();
  }

  /**
   * 把路径拍平成线段实例，返回这一帧要盖的段数。
   *
   * 上界是 `maxSegments`：写满就停，不会因为世界里多了几个玩家而无限增长。
   * 与窗口不相交的路径在这里整条跳过，省掉的是 GPU 的绘制而不只是像素。
   *
   * `render` 会先调用它。单独调用只用于在没有 GL 上下文的地方验证裁剪与上界。
   */
  public prepareSegments(recorder: GrassTrailRecorder): number {
    this.segmentCount = 0;
    recorder.forEachPath((path) => this.packPath(path));

    const startCount = this.segmentCount * FLOATS_PER_SEGMENT_START;
    const endCount = this.segmentCount * FLOATS_PER_SEGMENT_END;
    const shapeCount = this.segmentCount * FLOATS_PER_SEGMENT_SHAPE;
    this.startAttribute.updateRange = { offset: 0, count: startCount };
    this.endAttribute.updateRange = { offset: 0, count: endCount };
    this.shapeAttribute.updateRange = { offset: 0, count: shapeCount };
    this.startAttribute.needsUpdate = true;
    this.endAttribute.needsUpdate = true;
    this.shapeAttribute.needsUpdate = true;
    this.geometry.instanceCount = this.segmentCount;
    return this.segmentCount;
  }

  private packPath(path: GrassTrailPath): void {
    if (this.segmentCount >= this.maxSegments) return;
    if (!path.intersectsBounds(this.bounds.x, this.bounds.y, this.bounds.z, this.bounds.w)) {
      return;
    }

    // 只有一个点的路径退化成一段零长线段：盖章着色器把它当成一个圆点处理。
    if (path.length === 1) {
      path.readPoint(0, this.scratchPoint);
      this.writeSegment(
        this.scratchPoint.x,
        this.scratchPoint.z,
        this.scratchPoint.x,
        this.scratchPoint.z,
        this.scratchPoint.radius,
        path.currentStrength(0),
        path.currentStrength(0),
      );
      return;
    }

    for (let index = 1; index < path.length; index += 1) {
      if (this.segmentCount >= this.maxSegments) return;
      path.readPoint(index - 1, this.previousPoint);
      path.readPoint(index, this.scratchPoint);
      this.writeSegment(
        this.previousPoint.x,
        this.previousPoint.z,
        this.scratchPoint.x,
        this.scratchPoint.z,
        Math.max(this.previousPoint.radius, this.scratchPoint.radius),
        path.currentStrength(index - 1),
        path.currentStrength(index),
      );
    }
  }

  private writeSegment(
    startX: number,
    startZ: number,
    endX: number,
    endZ: number,
    radius: number,
    startStrength: number,
    endStrength: number,
  ): void {
    const index = this.segmentCount;
    this.segmentStarts[index * FLOATS_PER_SEGMENT_START] = startX;
    this.segmentStarts[index * FLOATS_PER_SEGMENT_START + 1] = startZ;
    this.segmentEnds[index * FLOATS_PER_SEGMENT_END] = endX;
    this.segmentEnds[index * FLOATS_PER_SEGMENT_END + 1] = endZ;
    this.segmentShapes[index * FLOATS_PER_SEGMENT_SHAPE] = radius;
    this.segmentShapes[index * FLOATS_PER_SEGMENT_SHAPE + 1] = clamp01(startStrength);
    this.segmentShapes[index * FLOATS_PER_SEGMENT_SHAPE + 2] = clamp01(endStrength);
    this.segmentCount += 1;
  }
}

function createBendTarget(textureSize: number): THREE.WebGLRenderTarget {
  const target = new THREE.WebGLRenderTarget(textureSize, textureSize, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    depthBuffer: false,
    stencilBuffer: false,
  });
  target.texture.generateMipmaps = false;
  return target;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function positiveFiniteOr(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? value as number : fallback;
}
