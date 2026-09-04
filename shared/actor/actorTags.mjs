import { BUILD_PIECE_COMPONENT } from './components/BuildPieceComponent.mjs';
import { GENERATED_PROP_COMPONENT } from './components/GeneratedPropComponent.mjs';
import { HEALTH_COMPONENT } from './components/HealthComponent.mjs';
import { ITEM_STACK_COMPONENT } from './components/ItemStackComponent.mjs';
import { PLAYER_MOVEMENT_COMPONENT } from './components/PlayerMovementComponent.mjs';

/**
 * 一个 Actor 在武器判定里算什么（设计稿：「使用标签Tag对目标进行判定」）。
 *
 * **标签由 Component 推导，不在配置里逐个声明。** 一件东西是不是建筑块、是不是
 * 生物，已经写在它挂了哪些 Component 上；再让每份 JSON 重复声明一遍，两处迟早
 * 会不一致——而不一致的那一天，斧子会对着一堵没标 `Actor.Build` 的墙打出满伤害。
 * 以后真需要「同一类 Actor 里再分几种材质」时，在这里叠一层由配置补充的标签，
 * 而不是把这份推导搬进配置。
 *
 * 用的是 `src/tags/` 那套点分层级：`Actor.Build` 匹配得上 `Actor.Build.Wall`，
 * 所以倍率表可以只写一条父标签。
 */

/** 玩家操控的角色。 */
export const ACTOR_PLAYER_TAG = 'Actor.Player';
/** 会动、有生命值的非玩家实体。 */
export const ACTOR_CREATURE_TAG = 'Actor.Creature';
/** 按网格放出来的建造件。 */
export const ACTOR_BUILD_TAG = 'Actor.Build';
/** 世界生成的可采集物件（树、石头、蘑菇）。 */
export const ACTOR_PROP_TAG = 'Actor.Prop';
/** 掉在地上的一摞物品。 */
export const ACTOR_ITEM_TAG = 'Actor.Item';

/**
 * 这个 Actor 的标签，从它挂的 Component 推出来。
 *
 * 返回的数组顺序稳定（从最具体到最泛），倍率表按第一个命中的算，所以
 * 「建筑块」和「生物」之间不会因为遍历顺序而摇摆。
 */
export function resolveActorTags(actor) {
  if (!actor?.getComponent) return [];
  const tags = [];
  if (actor.getComponent(BUILD_PIECE_COMPONENT)) tags.push(ACTOR_BUILD_TAG);
  if (actor.getComponent(GENERATED_PROP_COMPONENT)) tags.push(ACTOR_PROP_TAG);
  if (actor.getComponent(ITEM_STACK_COMPONENT)) tags.push(ACTOR_ITEM_TAG);
  // 玩家外壳同时带 playerMovement 与 health；生物只有 health。
  if (actor.getComponent(PLAYER_MOVEMENT_COMPONENT)) tags.push(ACTOR_PLAYER_TAG);
  else if (actor.getComponent(HEALTH_COMPONENT)) tags.push(ACTOR_CREATURE_TAG);
  return tags;
}
