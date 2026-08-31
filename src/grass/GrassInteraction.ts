interface GrassBendImpulseBase {
  position: Readonly<{ x: number; z: number }>;
  radius?: number;
  strength?: number;
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
const MAX_QUEUE_SIZE = 12;
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
