import { GAME_ABILITY_COMPONENT } from './GameAbilityComponent.mjs';

/** 只遍历带 GAS Component 的活跃 Actor，成本随房间内相关 Actor 数增长。 */
export class GameAbilitySystem {
  update(world, deltaSeconds) {
    for (const actor of world.query(GAME_ABILITY_COMPONENT)) {
      actor.requireComponent(GAME_ABILITY_COMPONENT).update(deltaSeconds);
    }
  }
}
