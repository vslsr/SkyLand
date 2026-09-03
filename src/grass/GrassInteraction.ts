import {
  DEFAULT_GRASS_TRAIL_SOURCE,
  GRASS_TRAIL_MAX_SOURCES,
} from './GrassTrailRecorder';

interface GrassBendImpulseBase {
  position: Readonly<{ x: number; z: number }>;
  radius?: number;
  strength?: number;
  /**
   * 谁踩的。相同 id 的冲量会连成同一条足迹路径，省略时并入公共路径。
   *
   * 分开记而不是全部并成一条：两名玩家分头走时，一条共用路径会在他们之间
   * 连出一段谁都没走过的假足迹。
   */
  sourceId?: string;
}

export type GrassBendImpulse = GrassBendImpulseBase & (
  | {
    mode?: 'directional';
    direction: Readonly<{ x: number; z: number }>;
  }
  | {
    mode: 'radial';
    startPosition?: Readonly<{ x: number; z: number }>;
    /** 径向中心或扫掠中心线没有径向向量时使用的回退方向。 */
    direction?: Readonly<{ x: number; z: number }>;
  }
);

export interface GrassInteractionTarget {
  applyImpulse(impulse: GrassBendImpulse): void;
}

export interface NormalizedGrassBendImpulse {
  sourceId: string;
  positionX: number;
  positionZ: number;
  startPositionX: number;
  startPositionZ: number;
  directionX: number;
  directionZ: number;
  radius: number;
  strength: number;
  radial: boolean;
}

const DEFAULT_RADIUS = 0.65;
/** 每个来源每帧最多写一条，队列上界因此按来源数上界的两倍取，留出鼠标与调试。 */
const MAX_QUEUE_SIZE = GRASS_TRAIL_MAX_SOURCES * 2;
const DEFAULT_RADIAL_DIRECTION = { x: 1, z: 0 } as const;

export class GrassInteractionQueue implements GrassInteractionTarget {
  private readonly queued: NormalizedGrassBendImpulse[] = [];

  public applyImpulse(impulse: GrassBendImpulse): void {
    const radial = impulse.mode === 'radial';
    const fallbackDirection = radial
      ? impulse.direction ?? DEFAULT_RADIAL_DIRECTION
      : impulse.direction;
    const directionX = fallbackDirection.x;
    const directionZ = fallbackDirection.z;
    const directionLength = Math.hypot(directionX, directionZ);
    const startPosition = radial
      ? impulse.startPosition ?? impulse.position
      : impulse.position;
    if (
      !Number.isFinite(impulse.position.x)
      || !Number.isFinite(impulse.position.z)
      || !Number.isFinite(startPosition.x)
      || !Number.isFinite(startPosition.z)
      || !Number.isFinite(directionLength)
      || directionLength < 0.0001
    ) return;

    if (this.queued.length >= MAX_QUEUE_SIZE) this.queued.shift();
    this.queued.push({
      sourceId: impulse.sourceId ?? DEFAULT_GRASS_TRAIL_SOURCE,
      positionX: impulse.position.x,
      positionZ: impulse.position.z,
      startPositionX: startPosition.x,
      startPositionZ: startPosition.z,
      directionX: directionX / directionLength,
      directionZ: directionZ / directionLength,
      radius: clampFinite(impulse.radius ?? DEFAULT_RADIUS, 0.05, 4, DEFAULT_RADIUS),
      strength: clampFinite(impulse.strength ?? 1, 0, 1, 1),
      radial,
    });
  }

  public drain(): NormalizedGrassBendImpulse[] {
    return this.queued.splice(0, this.queued.length);
  }

  public clear(): void {
    this.queued.length = 0;
  }
}

function clampFinite(value: number, minimum: number, maximum: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}
