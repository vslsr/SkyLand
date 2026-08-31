import * as THREE from 'three';
import { ActorComponent } from '../../../shared/actor/ActorComponent.mjs';
import type { GrassInteractionTarget } from '../../grass';

export const GRASS_DISPLACEMENT_COMPONENT = 'grass-displacement';

export interface GrassDisplacementComponentOptions {
  radius?: number;
  pressurePerSecond?: number;
}

const DEFAULT_RADIUS = 0.68;
const DEFAULT_PRESSURE_PER_SECOND = 3;
const MAX_DELTA_SECONDS = 0.1;
const MAX_SWEEP_DISTANCE_RADIUS_RATIO = 5;
const MOTION_PRESSURE_PER_RADIUS = 0.9;
const MAX_MOTION_PRESSURE = 0.24;

/** 持续把 Actor 脚下的草向外压开；停止更新后弯曲纹理会自然回弹。 */
export class GrassDisplacementComponent extends ActorComponent {
  public enabled = true;
  public readonly radius: number;
  public readonly pressurePerSecond: number;
  private readonly worldPosition = new THREE.Vector3();
  private readonly previousWorldPosition = new THREE.Vector3();
  private readonly fallbackDirection = new THREE.Vector2(1, 0);
  private hasPreviousWorldPosition = false;

  public constructor(
    private readonly positionSource: THREE.Object3D,
    private readonly target: GrassInteractionTarget,
    options: GrassDisplacementComponentOptions = {},
  ) {
    super(GRASS_DISPLACEMENT_COMPONENT);
    this.radius = positiveFiniteOr(options.radius, DEFAULT_RADIUS);
    this.pressurePerSecond = positiveFiniteOr(
      options.pressurePerSecond,
      DEFAULT_PRESSURE_PER_SECOND,
    );
  }

  public update(deltaSeconds: number): void {
    this.positionSource.getWorldPosition(this.worldPosition);
    if (!this.enabled || !Number.isFinite(deltaSeconds) || deltaSeconds <= 0) {
      this.rememberCurrentPosition();
      return;
    }
    const clampedDelta = Math.min(deltaSeconds, MAX_DELTA_SECONDS);
    const sustainedStrength = 1 - Math.exp(-this.pressurePerSecond * clampedDelta);
    const travelDistance = this.hasPreviousWorldPosition
      ? this.worldPosition.distanceTo(this.previousWorldPosition)
      : 0;
    const canSweep = this.hasPreviousWorldPosition
      && travelDistance <= this.radius * MAX_SWEEP_DISTANCE_RADIUS_RATIO;
    if (canSweep && travelDistance > 0.0001) {
      this.fallbackDirection.set(
        this.worldPosition.x - this.previousWorldPosition.x,
        this.worldPosition.z - this.previousWorldPosition.z,
      ).normalize();
    }
    const motionStrength = canSweep
      ? Math.min(
        MAX_MOTION_PRESSURE,
        (travelDistance / this.radius) * MOTION_PRESSURE_PER_RADIUS,
      )
      : 0;
    const strength = Math.min(1, sustainedStrength + motionStrength);
    this.applyPressure(
      canSweep ? this.previousWorldPosition.x : this.worldPosition.x,
      canSweep ? this.previousWorldPosition.z : this.worldPosition.z,
      this.worldPosition.x,
      this.worldPosition.z,
      strength,
      this.fallbackDirection.x,
      this.fallbackDirection.y,
    );
    this.rememberCurrentPosition();
  }

  private applyPressure(
    startPositionX: number,
    startPositionZ: number,
    positionX: number,
    positionZ: number,
    strength: number,
    directionX: number,
    directionZ: number,
  ): void {
    this.target.applyImpulse({
      mode: 'radial',
      startPosition: { x: startPositionX, z: startPositionZ },
      position: { x: positionX, z: positionZ },
      direction: { x: directionX, z: directionZ },
      radius: this.radius,
      strength,
    });
  }

  private rememberCurrentPosition(): void {
    this.previousWorldPosition.copy(this.worldPosition);
    this.hasPreviousWorldPosition = true;
  }
}

function positiveFiniteOr(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? value as number : fallback;
}
