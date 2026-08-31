import type { Actor } from '../../shared/actor/Actor.mjs';
import type { ActorWorld } from '../../shared/actor/ActorWorld.mjs';
import {
  GAME_ABILITY_COMPONENT,
  GameAbilityComponent,
} from './GameAbilityComponent';

/**
 * ActorWorld 的固定 tick 适配器。
 *
 * 服务端或离线模拟把它注册进 ActorWorld 后，所有带 GameAbilityComponent 的 Actor
 * 都使用同一个权威 delta 推进冷却与周期效果；Component 本身不读取浏览器时间。
 */
export class GameAbilitySystem {
  public update(world: ActorWorld, deltaSeconds: number): void {
    for (const actor of world.query(GAME_ABILITY_COMPONENT) as Actor[]) {
      const component = actor.requireComponent(GAME_ABILITY_COMPONENT) as GameAbilityComponent;
      component.update(deltaSeconds);
    }
  }
}
