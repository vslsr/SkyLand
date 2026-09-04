import {
  CONTAINER_COMPONENT,
  INVENTORY_COMPONENT,
  ITEM_STACK_COMPONENT,
  PICKUP_DROP_COMPONENT,
} from '../../shared/actor/index.mjs';
import { itemCatalog } from '../../shared/items/index.mjs';
import { dropPickedActor, pickupActor } from './PickupDropMutations.mjs';
import { findItemArchetypeId } from './ItemArchetypes.mjs';
import { revokeItemAbility, syncItemAbility } from './ItemAbilityRuntime.mjs';

/**
 * 背包、物品栏与容器的权威变更。
 *
 * 放在这里而不是 `ServerScene` 里，是因为同一个变更有多个入口：切物品栏格、用光
 * 最后一个、丢下、离开房间、容器被拆掉，都要把「嘴上那件」「账本」「玩家身上挂着
 * 的物品能力」三样重新对齐。写成一处，每个入口调同一个函数，就不会出现某条路径
 * 忘了收手。
 */

export { findItemArchetypeId };

/** 嘴上那件如果是手持表现体，返回它；叼着的蘑菇之类返回 undefined。 */
function heldItemActor(world, player) {
  const heldId = player?.getComponent(PICKUP_DROP_COMPONENT)?.heldActorId;
  const actor = heldId ? world.getActor(heldId) : undefined;
  return actor?.getComponent(ITEM_STACK_COMPONENT) ? actor : undefined;
}

/**
 * 让嘴上那件、玩家身上挂着的能力和物品栏选中格保持一致。
 *
 * 切格、拾取、用光、丢下之后都要调一次。它是幂等的：已经拿着对的东西就什么都不做。
 *
 * 手上那件是一个**纯表现 Actor**：模型来自这件物品的掉落原型，但物理、生命期、
 * 可交互全部摘掉（见 `heldItemArchetype`），坐标只由 Actor 嵌套关系解算。数量不
 * 记在它身上——账在物品栏那一格上，手上那个只是把那一格画出来，所以拿起来不扣账、
 * 放下也不回账。
 *
 * 嘴上叼着的不是手持物（比如一株蘑菇）时**整个跳过**：嘴里同时只允许有一件，
 * 蘑菇优先——它是玩家显式叼上去的，不该被一次物品栏切换悄悄挤掉。
 */
export function syncHeldItemActor(scene, player) {
  const inventory = player?.getComponent(INVENTORY_COMPONENT);
  const pickupDrop = player?.getComponent(PICKUP_DROP_COMPONENT);
  if (!inventory || !pickupDrop) return false;

  const world = scene.actorWorld;
  const current = heldItemActor(world, player);
  if (pickupDrop.heldActorId && !current) return false;

  const wanted = inventory.heldItemType;
  const definition = wanted ? itemCatalog.get(wanted) : undefined;
  const holdable = Boolean(definition?.holdable);
  const currentItemType = current?.getComponent(ITEM_STACK_COMPONENT).itemType;
  if (current && holdable && currentItemType === wanted) {
    syncItemAbility(scene, player);
    return false;
  }

  if (current) {
    // 换手：表现体直接消失。它没有数量，账一直在物品栏那一格上，所以这里不回账。
    dropPickedActor(world, player);
    scene.removeHeldItemActor(current.id);
  }
  if (holdable) spawnHeldItemActor(scene, player, wanted);
  syncItemAbility(scene, player);
  return true;
}

/** 挂一个手持表现体到玩家挂点上。挂不上（没有原型、嘴被占了）就空着手。 */
function spawnHeldItemActor(scene, player, itemType) {
  const world = scene.actorWorld;
  const archetypeId = findItemArchetypeId(world.context.archetypes, itemType);
  if (!archetypeId) return false;
  const actor = scene.spawnHeldItemActor(archetypeId, player);
  if (!actor) return false;
  if (!pickupActor(world, actor, player)) {
    scene.removeHeldItemActor(actor.id);
    return false;
  }
  return true;
}

/**
 * 把手持表现体收掉，不回账。
 *
 * 玩家离开房间时用：表现体只是把物品栏那一格画出来，货一直记在账上跟着玩家走，
 * 所以它该跟着连接一起消失，而不是像蘑菇那样落在地上变成一件可拾取的东西——
 * 那等于凭空复制了一份货。
 *
 * @returns 是否真的收掉了一个
 */
export function discardHeldItemActor(scene, player) {
  const actor = heldItemActor(scene.actorWorld, player);
  if (!actor) return false;
  dropPickedActor(scene.actorWorld, player);
  scene.removeHeldItemActor(actor.id);
  revokeItemAbility(player);
  return true;
}

/**
 * 放下嘴上那件东西，不管它是什么。
 *
 * 嘴里同时只有一件，但它有两种：物品栏拿出来的表现体，和叼着的世界物件（蘑菇）。
 * 两者的落地方式不同——表现体要换成一个真正的掉落 Actor，蘑菇要建刚体、恢复
 * 可交互、按碰撞半径推开落点——所以这里只做分派，各自的落法留在原处。
 *
 * @returns 是否真的放下了
 */
export function dropHeldObject(scene, player) {
  if (dropHeldItem(scene, player)) return true;
  const heldId = player?.getComponent(PICKUP_DROP_COMPONENT)?.heldActorId;
  const actor = heldId ? scene.actorWorld.getActor(heldId) : undefined;
  return actor ? scene.dropCarriedActor(player, actor) : false;
}

/**
 * 从手上那一摞里丢一个到身前。
 *
 * 手上挂的是表现体，不能直接丢出去——它没有碰撞也没有掉落物理。所以这里做的是
 * 「物品栏那一格扣一个，身前生成一个真正的掉落物」，和背包里的「丢弃」是同一条
 * 路径，只是扣的账不同。
 *
 * 落点要推到身体之外：就地松口会把人卡住（嘴只在身前 0.36 米，而玩家半径加物件
 * 半径要 0.7 米才不重叠）。
 *
 * @returns 是否真的丢下了
 */
export function dropHeldItem(scene, player) {
  const actor = heldItemActor(scene.actorWorld, player);
  const inventory = player?.getComponent(INVENTORY_COMPONENT);
  if (!actor || !inventory) return false;
  return dropHotbarItem(scene, player, inventory.activeHotbarIndex);
}

/**
 * 从物品栏某一格丢一个到身前。
 *
 * 手上那件走的也是这条（`dropHeldItem` 就是「丢选中的那一格」）：手上挂的只是
 * 一个表现体，账从头到尾在格子上，所以丢哪一格是同一件事，不该有两套扣账。
 *
 * @returns 是否真的丢下了
 */
export function dropHotbarItem(scene, player, slotIndex) {
  const inventory = player?.getComponent(INVENTORY_COMPONENT);
  if (!inventory?.isHotbarSlot(slotIndex)) return false;
  const slot = inventory.hotbar[slotIndex];
  if (!slot) return false;
  // 先确认这件东西掉在地上长什么样：没有掉落原型就丢不出去，这时账不能先扣。
  const archetypeId = findItemArchetypeId(scene.actorWorld.context.archetypes, slot.itemType);
  if (!archetypeId) return false;
  if (inventory.consumeHotbarSlot(slotIndex, 1) !== 1) return false;
  spawnDropInFront(scene, player, archetypeId, 1);
  // 那一格可能还剩几个，也可能刚好空了：重新对齐一次，手上跟着变。
  syncHeldItemActor(scene, player);
  return true;
}

/**
 * 从背包里直接丢一个到身前。
 *
 * 它**不经过手**。走「先拿到手上再丢」那条路也能把东西丢出去，代价是顺手改写了
 * 物品栏的一格、把原本握着的东西换下去，丢完还会自动再抽一个同类的到手上——玩家
 * 只想扔掉一个石头，回头发现锤子进了包、手里攥着另一块石头。所以这里自己扣账、
 * 自己生成掉落物。
 *
 * @returns 是否真的丢出去了
 */
export function dropInventoryItem(scene, player, itemType, quantity = 1) {
  const inventory = player?.getComponent(INVENTORY_COMPONENT);
  const wanted = Math.trunc(Number(quantity));
  if (!inventory || !itemType || !(wanted > 0)) return false;
  // 先确认这件东西掉在地上长什么样：没有掉落原型就丢不出去，这时账不能先扣。
  const archetypeId = findItemArchetypeId(scene.actorWorld.context.archetypes, itemType);
  if (!archetypeId) return false;
  const removed = inventory.remove(itemType, wanted);
  if (removed <= 0) return false;
  spawnDropInFront(scene, player, archetypeId, removed);
  return true;
}

/** 身前 0.85 米、抬高 0.35 米。就地生成会和角色的碰撞体重叠，把人卡住。 */
function spawnDropInFront(scene, player, archetypeId, quantity) {
  const distance = 0.85;
  return scene.spawnItemStack(archetypeId, {
    position: [
      player.x + Math.sin(player.yaw) * distance,
      player.y + 0.35,
      player.z + Math.cos(player.yaw) * distance,
    ],
    quantity,
    yaw: player.yaw,
  });
}

/**
 * 背包与容器之间搬东西。
 *
 * 搬的是**背包**那一本账，物品栏不参与：箱子前面按「存」，玩家指的是包里那些，
 * 而不是把手上正拿着的那一摞也一并塞进去。要存物品栏里的东西，先把它收回背包。
 *
 * 不加锁：两个人同时掏同一个箱子时，两次请求在同一条 tick 线上依次执行，
 * `ItemLedger.remove` 按账上实际有的数量截断，所以先到的拿走、后到的拿到 0，
 * 各自在下一帧快照里看到真实结果。
 *
 * @returns 实际搬动的数量
 */
export function transferItems(player, containerActor, { itemType, quantity, direction }) {
  const inventory = player?.getComponent(INVENTORY_COMPONENT);
  const container = containerActor?.getComponent(CONTAINER_COMPONENT);
  if (!inventory || !container || !itemCatalog.has(itemType)) return 0;
  if (!container.isOpenFor(player.id)) return 0;
  const requested = Math.max(0, Math.floor(Number(quantity) || 0));
  if (requested === 0) return 0;

  const [from, to] = direction === 'withdraw' ? [container, inventory] : [inventory, container];
  // 先按来源实际有多少截断，再按目标能收多少截断，最后才真的从来源扣：
  // 顺序反了会在目标装满时把差额凭空销毁。
  const available = Math.min(requested, from.quantityOf(itemType));
  if (available === 0) return 0;
  const accepted = to.add(itemType, available);
  if (accepted === 0) return 0;
  from.remove(itemType, accepted);
  return accepted;
}
