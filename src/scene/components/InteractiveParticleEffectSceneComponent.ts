import * as THREE from 'three';
import { ActorWorld } from '../../../shared/actor/ActorWorld.mjs';
import { InteractiveParticleEffectActor } from '../../actors/InteractiveParticleEffectActor';
import { InteractiveParticleEffectSystem } from '../../actors/systems/InteractiveParticleEffectSystem';
import { LineArtLeafParticleEffect } from '../../particles/LineArtLeafParticleEffect';
import type {
  InteractiveParticleSceneComponentDefinition,
} from '../../scenes/data/SceneDefinition';
import type { SceneComponentContext, SceneRuntimeComponent } from './SceneComponent';

const MIN_INTERACTION_TRAVEL = 0.000_1;
const TELEPORT_DISTANCE_RADIUS_RATIO = 5;
const REFERENCE_MOVE_SPEED = 6;

/**
 * 从场景配置创建一个客户端本地粒子 Actor。当前不读写 Actor Snapshot；未来联网时
 * 应同步交互事件而不是每片叶子的 Transform。
 */
export class InteractiveParticleEffectSceneComponent implements SceneRuntimeComponent {
  public readonly type = 'interactive-particle-effect' as const;
  private readonly world = new ActorWorld();
  private readonly actor: InteractiveParticleEffectActor;
  private readonly playerPosition = new THREE.Vector3();
  private readonly previousPlayerPosition = new THREE.Vector3();
  private hasPreviousPlayerPosition = false;
  private active = false;

  public constructor(
    private readonly definition: InteractiveParticleSceneComponentDefinition,
    private readonly context: SceneComponentContext,
  ) {
    const effect = createEffect(definition, context);
    effect.root.position.set(...definition.position);
    effect.root.name = `particle-actor-${definition.id}`;
    this.actor = new InteractiveParticleEffectActor(definition.id, effect);
    this.world.addSystem(new InteractiveParticleEffectSystem());
    this.world.addActor(this.actor);
  }

  public activate(): void {
    if (this.active) return;
    this.active = true;
    this.context.renderer.addWorldObject(this.actor.object3D);
    this.resetPlayerSweep();
  }

  public deactivate(): void {
    if (!this.active) return;
    this.active = false;
    this.context.renderer.removeWorldObject(this.actor.object3D);
    this.hasPreviousPlayerPosition = false;
  }

  public update(deltaSeconds: number, elapsedSeconds: number): void {
    this.applyPlayerInteraction(deltaSeconds);
    this.world.update(deltaSeconds, elapsedSeconds);
  }

  public dispose(): void {
    this.deactivate();
    this.world.dispose();
  }

  private applyPlayerInteraction(deltaSeconds: number): void {
    const player = this.context.player;
    if (!player) return;
    player.object3D.getWorldPosition(this.playerPosition);
    if (!this.hasPreviousPlayerPosition) {
      this.previousPlayerPosition.copy(this.playerPosition);
      this.hasPreviousPlayerPosition = true;
      return;
    }

    const travelDistance = this.playerPosition.distanceTo(this.previousPlayerPosition);
    const teleported = travelDistance > (
      this.definition.interactionRadius * TELEPORT_DISTANCE_RADIUS_RATIO
    );
    if (
      !teleported
      && travelDistance > MIN_INTERACTION_TRAVEL
      && Number.isFinite(deltaSeconds)
      && deltaSeconds > 0
    ) {
      const speed = travelDistance / deltaSeconds;
      const speedScale = THREE.MathUtils.clamp(speed / REFERENCE_MOVE_SPEED, 0.25, 1.4);
      this.actor.applyWorldImpulse({
        startPosition: this.previousPlayerPosition,
        position: this.playerPosition,
        radius: this.definition.interactionRadius,
        strength: this.definition.impulseStrength * speedScale,
      });
    }
    this.previousPlayerPosition.copy(this.playerPosition);
  }

  private resetPlayerSweep(): void {
    const player = this.context.player;
    if (!player) {
      this.hasPreviousPlayerPosition = false;
      return;
    }
    player.object3D.getWorldPosition(this.previousPlayerPosition);
    this.hasPreviousPlayerPosition = true;
  }
}

function createEffect(
  definition: InteractiveParticleSceneComponentDefinition,
  context: SceneComponentContext,
): LineArtLeafParticleEffect {
  switch (definition.preset) {
    case 'line-art-leaves':
      return new LineArtLeafParticleEffect({
        particleCount: definition.particleCount,
        radius: definition.radius,
        seed: definition.seed,
        fillColor: definition.fillColor,
        accentColor: definition.accentColor,
        lineColor: definition.lineColor,
        environment: {
          fogColor: context.definition.renderer.fog.color,
          fogNear: context.definition.renderer.fog.near,
          fogFar: context.definition.renderer.fog.far,
        },
      });
    default: {
      const unsupported: never = definition.preset;
      throw new Error(`未实现的交互粒子 preset：${String(unsupported)}`);
    }
  }
}
