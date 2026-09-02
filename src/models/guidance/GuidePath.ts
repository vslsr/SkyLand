import * as THREE from 'three';

export const MAX_GUIDE_WAYPOINTS = 64;
export const MAX_GUIDE_SAMPLES = 256;

export type GuidePathPoint = readonly [number, number, number] | THREE.Vector3;

export interface GuidePathOptions {
  points: readonly GuidePathPoint[];
  curve?: 'linear' | 'catmull-rom';
  lineColor?: THREE.ColorRepresentation;
  markerColor?: THREE.ColorRepresentation;
  lineWidth?: number;
  dashLength?: number;
  gapLength?: number;
  dashSpeed?: number;
  markerSize?: number;
}

interface MarkerVisual {
  readonly root: THREE.Group;
  readonly material: THREE.SpriteMaterial;
  alpha: number;
  targetAlpha: number;
}

const DEFAULT_RESOLUTION = new THREE.Vector2(1, 1);
const MIN_SEGMENT_LENGTH = 0.000_1;
let sharedMarkerTexture: THREE.DataTexture | undefined;
let sharedMarkerTextureReferences = 0;

/**
 * 有上限的客户端引导路径表现。CPU/GPU 成本只和最多 64 个路点、256 个采样点有关，
 * 不随场景或流式世界面积增长。
 */
export class GuidePath {
  public readonly root = new THREE.Group();
  private readonly geometry = new GuidePathGeometry();
  private readonly lineMaterial: THREE.ShaderMaterial;
  private readonly lineMesh: THREE.Mesh;
  private readonly markerTexture: THREE.DataTexture;
  private readonly markerRoot = new THREE.Group();
  private readonly marker: MarkerVisual;
  private readonly waypoints: THREE.Vector3[] = [];
  private readonly markerSize: number;
  private elapsedSeconds = 0;
  private reveal = 0;
  private activeMarker = 0;
  private enabled = true;
  private disposed = false;

  public constructor(options: GuidePathOptions) {
    // 在分配 GPU 资源前先校验，避免无效配置抛错时遗留材质或共享纹理引用。
    validatePathPoints(options.points);
    this.markerSize = Math.max(0.01, options.markerSize ?? 0.55);
    this.lineMaterial = createLineMaterial({
      color: options.lineColor ?? 0xfffdf4,
      width: options.lineWidth ?? 5,
      dashLength: options.dashLength ?? 0.8,
      gapLength: options.gapLength ?? 0.55,
      dashSpeed: options.dashSpeed ?? 0.5,
      opacity: 1,
    });
    this.lineMesh = new THREE.Mesh(this.geometry, this.lineMaterial);
    this.lineMesh.name = 'guide-path-line';
    this.lineMesh.renderOrder = 41;

    this.markerTexture = acquireMarkerTexture();
    this.marker = createMarker(this.markerTexture, options.markerColor ?? 0xfffdf4, this.markerSize);
    this.markerRoot.name = 'guide-path-markers';
    this.markerRoot.add(this.marker.root);
    this.root.name = 'guide-path';
    this.root.add(this.lineMesh, this.markerRoot);
    this.setPath(options.points, options.curve ?? 'catmull-rom', options.markerColor ?? 0xfffdf4);
  }

  public get currentMarkerIndex(): number {
    return this.activeMarker < this.waypoints.length ? this.activeMarker : -1;
  }

  public get markerCount(): number {
    return this.waypoints.length;
  }

  public get isComplete(): boolean {
    return this.activeMarker >= this.waypoints.length;
  }

  public setPath(
    points: readonly GuidePathPoint[],
    curve: 'linear' | 'catmull-rom' = 'catmull-rom',
    markerColor: THREE.ColorRepresentation = 0xfffdf4,
  ): void {
    this.assertUsable();
    validatePathPoints(points);
    this.waypoints.length = 0;
    for (const point of points) {
      const vector = point instanceof THREE.Vector3
        ? point.clone()
        : new THREE.Vector3(point[0], point[1], point[2]);
      if (![vector.x, vector.y, vector.z].every(Number.isFinite)) {
        throw new TypeError('GuidePath 路点必须是有限数字');
      }
      this.waypoints.push(vector);
    }

    const samples = samplePath(this.waypoints, curve);
    this.geometry.updatePath(samples);
    this.marker.material.color.set(markerColor);
    this.reset();
  }

  public setResolution(width: number, height: number): void {
    const safeWidth = Number.isFinite(width) ? Math.max(1, width) : 1;
    const safeHeight = Number.isFinite(height) ? Math.max(1, height) : 1;
    this.lineMaterial.uniforms.uResolution.value.set(safeWidth, safeHeight);
  }

  public getCurrentMarkerPosition(target: THREE.Vector3): boolean {
    const marker = this.waypoints[this.activeMarker];
    if (!marker) return false;
    target.copy(marker);
    return true;
  }

  /** 推进到下一个节点；返回 true 表示整条引导已经完成。 */
  public advance(): boolean {
    this.assertUsable();
    if (this.isComplete) return true;
    this.marker.targetAlpha = 0;
    this.activeMarker += 1;
    if (!this.isComplete) {
      this.marker.root.position.copy(this.waypoints[this.activeMarker]);
      this.marker.alpha = 0;
      this.marker.targetAlpha = 1;
    }
    this.updateCompletedProgress();
    return this.isComplete;
  }

  /** 应用服务器复制的当前节点；points.length 表示已完成。 */
  public setCurrentMarkerIndex(index: number): void {
    this.assertUsable();
    if (!Number.isInteger(index) || index < 0 || index > this.waypoints.length) {
      throw new RangeError(`GuidePath 节点索引必须在 0-${this.waypoints.length} 内`);
    }
    if (this.activeMarker !== index) {
      this.activeMarker = index;
      this.marker.alpha = 0;
    }
    this.marker.targetAlpha = this.isComplete ? 0 : 1;
    if (!this.isComplete) this.marker.root.position.copy(this.waypoints[this.activeMarker]);
    this.updateCompletedProgress();
  }

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.root.visible = enabled;
  }

  public reset(): void {
    this.assertUsable();
    this.activeMarker = 0;
    this.elapsedSeconds = 0;
    this.reveal = 0;
    this.marker.root.position.copy(this.waypoints[0]);
    this.marker.alpha = 1;
    this.marker.targetAlpha = 1;
    this.applyMarkerVisual(this.marker, 1);
    this.updateCompletedProgress();
    this.setRevealUniforms(0);
  }

  public update(deltaSeconds: number): void {
    if (this.disposed || !this.enabled || !Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;
    const delta = Math.min(deltaSeconds, 0.1);
    this.elapsedSeconds += delta;
    this.reveal = Math.min(1, this.reveal + delta * 1.15);
    this.lineMaterial.uniforms.uTime.value = this.elapsedSeconds;
    this.setRevealUniforms(this.reveal);

    const response = 1 - Math.exp(-10 * delta);
    this.marker.alpha += (this.marker.targetAlpha - this.marker.alpha) * response;
    const pulse = this.isComplete ? 1 : 1 + Math.sin(this.elapsedSeconds * 3.2) * 0.08;
    this.applyMarkerVisual(this.marker, pulse);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.parent?.remove(this.root);
    this.geometry.dispose();
    this.lineMaterial.dispose();
    this.marker.material.dispose();
    releaseMarkerTexture(this.markerTexture);
    this.root.clear();
  }

  private applyMarkerVisual(marker: MarkerVisual, pulse: number): void {
    marker.root.visible = marker.alpha > 0.001;
    marker.root.scale.setScalar(Math.max(0.001, marker.alpha * pulse));
    marker.material.opacity = marker.alpha;
  }

  private updateCompletedProgress(): void {
    const denominator = Math.max(1, this.waypoints.length - 1);
    const completed = this.isComplete ? 1 : Math.max(0, this.activeMarker / denominator);
    this.lineMaterial.uniforms.uCompleted.value = completed;
  }

  private setRevealUniforms(value: number): void {
    this.lineMaterial.uniforms.uReveal.value = value;
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('GuidePath 已释放');
  }
}

function validatePathPoints(points: readonly GuidePathPoint[]): void {
  if (points.length < 2 || points.length > MAX_GUIDE_WAYPOINTS) {
    throw new RangeError(`GuidePath 需要 2-${MAX_GUIDE_WAYPOINTS} 个路点`);
  }
  for (const point of points) {
    const values = point instanceof THREE.Vector3 ? [point.x, point.y, point.z] : point;
    if (!values.every(Number.isFinite)) throw new TypeError('GuidePath 路点必须是有限数字');
  }
}

export class GuidePathGeometry extends THREE.BufferGeometry {
  public totalDistance = 0;

  public updatePath(points: readonly THREE.Vector3[]): void {
    const positions: number[] = [];
    const previous: number[] = [];
    const next: number[] = [];
    const sides: number[] = [];
    const distances: number[] = [];
    const indices: number[] = [];
    this.totalDistance = 0;

    for (let index = 0; index < points.length; index += 1) {
      const point = points[index];
      const before = points[Math.max(0, index - 1)];
      const after = points[Math.min(points.length - 1, index + 1)];
      if (index > 0) this.totalDistance += point.distanceTo(points[index - 1]);
      positions.push(point.x, point.y, point.z, point.x, point.y, point.z);
      previous.push(before.x, before.y, before.z, before.x, before.y, before.z);
      next.push(after.x, after.y, after.z, after.x, after.y, after.z);
      sides.push(-1, 1);
      distances.push(this.totalDistance, index / Math.max(1, points.length - 1));
      distances.push(this.totalDistance, index / Math.max(1, points.length - 1));
      if (index < points.length - 1) {
        const vertex = index * 2;
        indices.push(vertex, vertex + 1, vertex + 2, vertex + 2, vertex + 1, vertex + 3);
      }
    }

    this.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    this.setAttribute('aPrevious', new THREE.Float32BufferAttribute(previous, 3));
    this.setAttribute('aNext', new THREE.Float32BufferAttribute(next, 3));
    this.setAttribute('aSide', new THREE.Float32BufferAttribute(sides, 1));
    this.setAttribute('aDistance', new THREE.Float32BufferAttribute(distances, 2));
    this.setIndex(indices);
    this.computeBoundingBox();
    this.computeBoundingSphere();
  }
}

function samplePath(
  waypoints: readonly THREE.Vector3[],
  curveMode: 'linear' | 'catmull-rom',
): THREE.Vector3[] {
  if (curveMode === 'linear' || waypoints.length === 2) return waypoints.map((point) => point.clone());
  let approximateLength = 0;
  for (let index = 1; index < waypoints.length; index += 1) {
    approximateLength += waypoints[index].distanceTo(waypoints[index - 1]);
  }
  const sampleCount = THREE.MathUtils.clamp(
    Math.ceil(Math.max(MIN_SEGMENT_LENGTH, approximateLength) / 1.25),
    waypoints.length * 3,
    MAX_GUIDE_SAMPLES - 1,
  );
  return new THREE.CatmullRomCurve3(
    waypoints.map((point) => point.clone()),
    false,
    'catmullrom',
    0.5,
  ).getSpacedPoints(sampleCount);
}

function createLineMaterial(options: {
  color: THREE.ColorRepresentation;
  width: number;
  dashLength: number;
  gapLength: number;
  dashSpeed: number;
  opacity: number;
}): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'WayfinderGuidePathMaterial',
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
    extensions: { derivatives: true },
    uniforms: {
      uResolution: { value: DEFAULT_RESOLUTION.clone() },
      uColor: { value: new THREE.Color(options.color) },
      uOpacity: { value: options.opacity },
      uWidth: { value: Math.max(0.1, options.width) },
      uDashLength: { value: Math.max(0.001, options.dashLength) },
      uGapLength: { value: Math.max(0, options.gapLength) },
      uDashSpeed: { value: options.dashSpeed },
      uTime: { value: 0 },
      uReveal: { value: 0 },
      uCompleted: { value: 0 },
    },
    vertexShader: /* glsl */ `
      attribute vec3 aPrevious;
      attribute vec3 aNext;
      attribute float aSide;
      attribute vec2 aDistance;
      uniform vec2 uResolution;
      uniform float uWidth;
      varying vec2 vDistance;

      vec2 safeNormalize(vec2 value) {
        float lengthValue = length(value);
        return lengthValue > 0.00001 ? value / lengthValue : vec2(1.0, 0.0);
      }

      void main() {
        mat4 transform = projectionMatrix * modelViewMatrix;
        vec4 currentClip = transform * vec4(position, 1.0);
        vec4 previousClip = transform * vec4(aPrevious, 1.0);
        vec4 nextClip = transform * vec4(aNext, 1.0);
        vec2 current = currentClip.xy / currentClip.w;
        vec2 previous = previousClip.xy / previousClip.w;
        vec2 next = nextClip.xy / nextClip.w;
        vec2 incoming = safeNormalize((current - previous) * uResolution);
        vec2 outgoing = safeNormalize((next - current) * uResolution);
        if (distance(current, previous) < 0.00001) incoming = outgoing;
        if (distance(current, next) < 0.00001) outgoing = incoming;
        vec2 tangent = safeNormalize(incoming + outgoing);
        vec2 normal = vec2(-tangent.y, tangent.x);
        vec2 incomingNormal = vec2(-incoming.y, incoming.x);
        float miter = clamp(1.0 / max(0.25, dot(normal, incomingNormal)), 1.0, 4.0);
        float taper = sin(3.14159265 * aDistance.y);
        taper = mix(0.35, 1.0, max(0.0, taper));
        vec2 pixelOffset = normal * aSide * uWidth * 0.5 * miter * taper;
        vec2 ndcOffset = pixelOffset * 2.0 / uResolution;
        currentClip.xy += ndcOffset * currentClip.w;
        gl_Position = currentClip;
        vDistance = aDistance;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform float uDashLength;
      uniform float uGapLength;
      uniform float uDashSpeed;
      uniform float uTime;
      uniform float uReveal;
      uniform float uCompleted;
      varying vec2 vDistance;

      void main() {
        if (vDistance.y > uReveal) discard;
        float alpha = uOpacity;
        if (vDistance.y > uCompleted + 0.0001) {
          float period = max(0.001, uDashLength + uGapLength);
          float cycle = fract((vDistance.x - uTime * uDashSpeed) / period);
          float dashRatio = uDashLength / period;
          float edge = max(fwidth(cycle), 0.002);
          alpha *= 1.0 - smoothstep(dashRatio - edge, dashRatio + edge, cycle);
        }
        if (alpha < 0.001) discard;
        gl_FragColor = vec4(uColor, alpha);
      }
    `,
  });
}

function createRadialGlowTexture(size = 64): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const center = (size - 1) / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x - center) / center;
      const dy = (y - center) / center;
      const radius = Math.sqrt(dx * dx + dy * dy);
      const haloMask = 1 - THREE.MathUtils.smoothstep(radius, 0.68, 1);
      const halo = Math.exp(-radius * radius * 3.2) * haloMask;
      const core = 1 - THREE.MathUtils.smoothstep(radius, 0.02, 0.24);
      const alpha = Math.max(0, Math.min(1, halo * 0.58 + core));
      const offset = (y * size + x) * 4;
      data[offset] = 255;
      data[offset + 1] = 255;
      data[offset + 2] = 255;
      data[offset + 3] = Math.round(255 * alpha);
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.name = 'guide-path-radial-glow';
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/** 所有已加载 GuidePath 共享同一张不可变光晕纹理，最后一个实例释放时才销毁。 */
function acquireMarkerTexture(): THREE.DataTexture {
  sharedMarkerTexture ??= createRadialGlowTexture();
  sharedMarkerTextureReferences += 1;
  return sharedMarkerTexture;
}

function releaseMarkerTexture(texture: THREE.DataTexture): void {
  sharedMarkerTextureReferences = Math.max(0, sharedMarkerTextureReferences - 1);
  if (sharedMarkerTextureReferences > 0 || sharedMarkerTexture !== texture) return;
  texture.dispose();
  sharedMarkerTexture = undefined;
}

function createMarker(
  texture: THREE.Texture,
  color: THREE.ColorRepresentation,
  size: number,
): MarkerVisual {
  const root = new THREE.Group();
  const material = new THREE.SpriteMaterial({
    map: texture,
    color,
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.name = 'guide-path-wayfinder-marker';
  sprite.scale.setScalar(size * 3.1);
  sprite.renderOrder = 42;
  root.add(sprite);
  return { root, material, alpha: 0, targetAlpha: 0 };
}
