export interface GrassBendImpulse {
  position: Readonly<{ x: number; z: number }>;
  direction: Readonly<{ x: number; z: number }>;
  radius?: number;
  strength?: number;
}

export interface GrassInteractionTarget {
  applyImpulse(impulse: GrassBendImpulse): void;
}

export interface NormalizedGrassBendImpulse {
  positionX: number;
  positionZ: number;
  directionX: number;
  directionZ: number;
  radius: number;
  strength: number;
}

const DEFAULT_RADIUS = 0.65;
const MAX_QUEUE_SIZE = 12;

export class GrassInteractionQueue implements GrassInteractionTarget {
  private readonly queued: NormalizedGrassBendImpulse[] = [];

  public applyImpulse(impulse: GrassBendImpulse): void {
    const directionLength = Math.hypot(impulse.direction.x, impulse.direction.z);
    if (
      !Number.isFinite(impulse.position.x)
      || !Number.isFinite(impulse.position.z)
      || !Number.isFinite(directionLength)
      || directionLength < 0.0001
    ) return;

    if (this.queued.length >= MAX_QUEUE_SIZE) this.queued.shift();
    this.queued.push({
      positionX: impulse.position.x,
      positionZ: impulse.position.z,
      directionX: impulse.direction.x / directionLength,
      directionZ: impulse.direction.z / directionLength,
      radius: clampFinite(impulse.radius ?? DEFAULT_RADIUS, 0.05, 4, DEFAULT_RADIUS),
      strength: clampFinite(impulse.strength ?? 1, 0, 1, 1),
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
