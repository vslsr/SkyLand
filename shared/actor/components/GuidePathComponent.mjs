import { ActorComponent } from '../ActorComponent.mjs';

export const GUIDE_PATH_COMPONENT = 'guide-path';
export const MAX_GUIDE_PATH_POINTS = 32;

/**
 * 服务器权威的引导路径状态。点坐标位于 Actor 局部空间；客户端只复制并渲染。
 * 私有冷却不进入快照，路径、启用态和当前节点都通过 revision 离散复制。
 */
export class GuidePathComponent extends ActorComponent {
  constructor(definition) {
    super(GUIDE_PATH_COMPONENT);
    this.curve = definition.curve ?? 'catmull-rom';
    this.lineColor = definition.lineColor ?? '#fffdf4';
    this.shadowColor = definition.shadowColor ?? '#544b43';
    this.markerColor = definition.markerColor ?? '#fffdf4';
    this.lineWidth = definition.lineWidth ?? 5;
    this.dashLength = definition.dashLength ?? 0.8;
    this.gapLength = definition.gapLength ?? 0.55;
    this.dashSpeed = definition.dashSpeed ?? 0.5;
    this.markerSize = definition.markerSize ?? 0.55;
    this.hitRadius = definition.hitRadius ?? 1.25;
    this.autoAdvance = definition.autoAdvance ?? false;
    this.loop = definition.loop ?? false;
    this.enabled = definition.enabled ?? true;
    this.points = copyPoints(definition.points);
    this.currentPointIndex = normalizePointIndex(
      definition.currentPointIndex ?? 0,
      this.points.length,
    );
    this.pathRevision = 0;
    this.revision = 0;
    this.hitCooldown = 0;
  }

  get complete() {
    return this.currentPointIndex >= this.points.length;
  }

  /** 替换权威路径；默认回到首个节点。 */
  setPath(points, options = {}) {
    const nextPoints = copyPoints(points);
    const nextCurve = options.curve ?? this.curve;
    if (nextCurve !== 'linear' && nextCurve !== 'catmull-rom') {
      throw new TypeError('GuidePath curve 必须是 linear 或 catmull-rom');
    }
    this.points = nextPoints;
    this.curve = nextCurve;
    if (options.reset !== false) this.currentPointIndex = 0;
    else this.currentPointIndex = normalizePointIndex(this.currentPointIndex, this.points.length);
    this.pathRevision += 1;
    this.revision += 1;
    return this;
  }

  setEnabled(enabled) {
    const next = Boolean(enabled);
    if (next === this.enabled) return false;
    this.enabled = next;
    this.revision += 1;
    return true;
  }

  setCurrentPointIndex(index) {
    const next = normalizePointIndex(index, this.points.length);
    if (next === this.currentPointIndex) return false;
    this.currentPointIndex = next;
    this.revision += 1;
    return true;
  }

  advance() {
    if (this.complete) return true;
    this.currentPointIndex += 1;
    this.revision += 1;
    this.hitCooldown = 0.35;
    return this.complete;
  }

  reset() {
    return this.setCurrentPointIndex(0);
  }

  tickCooldown(deltaSeconds) {
    this.hitCooldown = Math.max(0, this.hitCooldown - Math.max(0, deltaSeconds));
  }

  snapshot() {
    return {
      points: this.points.map((point) => [...point]),
      curve: this.curve,
      enabled: this.enabled,
      currentPointIndex: this.currentPointIndex,
      pathRevision: this.pathRevision,
      revision: this.revision,
    };
  }

  /** 客户端应用服务器离散状态；样式仍来自已净化的 Actor 原型。 */
  applySnapshot(state) {
    if (!state || state.revision < this.revision) return false;
    this.points = copyPoints(state.points);
    this.curve = state.curve;
    this.enabled = Boolean(state.enabled);
    this.currentPointIndex = normalizePointIndex(state.currentPointIndex, this.points.length);
    this.pathRevision = state.pathRevision;
    this.revision = state.revision;
    return true;
  }
}

function normalizePointIndex(index, pointCount) {
  if (!Number.isInteger(index)) throw new TypeError('GuidePath currentPointIndex 必须是整数');
  if (index < 0 || index > pointCount) {
    throw new RangeError(`GuidePath currentPointIndex 必须在 0-${pointCount} 内`);
  }
  return index;
}

function copyPoints(points) {
  if (!Array.isArray(points) || points.length < 2 || points.length > MAX_GUIDE_PATH_POINTS) {
    throw new RangeError(`GuidePath 需要 2-${MAX_GUIDE_PATH_POINTS} 个路点`);
  }
  return points.map((point, index) => {
    if (!Array.isArray(point) || point.length !== 3 || !point.every(Number.isFinite)) {
      throw new TypeError(`GuidePath points[${index}] 必须包含 3 个有限数字`);
    }
    return [point[0], point[1], point[2]];
  });
}
