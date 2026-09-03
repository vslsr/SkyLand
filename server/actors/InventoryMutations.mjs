import {
  CONTAINER_COMPONENT,
  STOWABLE_COMPONENT,
  DROP_MOTION_COMPONENT,
  INTERACTABLE_COMPONENT,
  INVENTORY_COMPONENT,
  ITEM_STACK_COMPONENT,
  PICKUP_DROP_COMPONENT,
  TRANSFORM_COMPONENT,
  chargeRatio,
} from '../../shared/actor/index.mjs';
import { itemCatalog } from '../../shared/items/index.mjs';
import { dropPickedActor, pickupActor } from './PickupDropMutations.mjs';

/**
 * 背包、手持与容器的权威变更。
 *
 * 放在这里而不是 `ServerScene` 里，是因为同一个变更有多个入口：切快捷栏、用光最后
 * 一个、丢下、离开房间、容器被拆掉，都要把「嘴上那件」和「账本」重新对齐。写成
 * 一处，每个入口调同一个函数，就不会出现某条路径忘了收手。
 */

/**
 * `itemType` 掉在地上时用哪个原型。
 *
 * 手持物复用的就是掉落原型：同一套模型、同一条复制链路，只是数量固定为 1 并挂在
 * 角色挂点上。地上能画出来的东西，拿在手上就能画出来，不需要「手持专用原型」这
 * 一层配置。
 */
export function findItemArchetypeId(archetypes, itemType) {
  if (!archetypes || !itemType) return undefined;
  for (const [id, archetype] of archetypes) {
    if (archetype?.components?.itemStack?.itemType === itemType) return id;
  }
  return undefined;
}

/** 嘴上那件如果是手持物，返回它的 itemStack；叼着的蘑菇之类返回 undefined。 */
function heldItemStack(world, player) {
  const heldId = player?.getComponent(PICKUP_DROP_COMPONENT)?.heldActorId;
  const actor = heldId ? world.getActor(heldId) : undefined;
  return actor?.getComponent(ITEM_STACK_COMPONENT) ? actor : undefined;
}

/**
 * 让嘴上那件和快捷栏选中的那件保持一致。
 *
 * 切格、拾取、用光、丢下之后都要调一次。它是幂等的：已经拿着对的东西就什么都不做。
 *
 * 嘴上叼着的不是手持物（比如一株蘑菇）时**整个跳过**：嘴里同时只允许有一件，
 * 蘑菇优先——它是玩家显式叼上去的，不该被一次快捷栏切换悄悄挤掉。
 */
export function syncHeldItemActor(scene, player) {
  const inventory = player?.getComponent(INVENTORY_COMPONENT);
  const pickupDrop = player?.getComponent(PICKUP_DROP_COMPONENT);
  if (!inventory || !pickupDrop) return false;

  const world = scene.actorWorld;
  const current = heldItemStack(world, player);
  if (pickupDrop.heldActorId && !current) return false;

  const wanted = inventory.heldItemType;
  const definition = wanted ? itemCatalog.get(wanted) : undefined;
  const holdable = Boolean(definition?.holdable);
  if (current && holdable && current.getComponent(ITEM_STACK_COMPONENT).itemType === wanted) {
    return false;
  }

  // 换手：先把旧的那件收回账本再拿新的，顺序反过来会在背包正好装满时把旧的弄丢。
  if (current) {
    const stack = current.getComponent(ITEM_STACK_COMPONENT);
    inventory.add(stack.itemType, stack.quantity);
    dropPickedActor(world, player);
    scene.removeItemStackActor(current.id);
  }
  if (!holdable || inventory.quantityOf(wanted) === 0) return true;

  const archetypeId = findItemArchetypeId(world.context.archetypes, wanted);
  if (!archetypeId) return true;
  // 拿在手上的那一个从账本里扣掉：它已经在世界里了，账上再记一份就是复制物品。
  if (inventory.remove(wanted, 1) !== 1) return true;
  const actor = scene.spawnItemStack(archetypeId, {
    position: [player.x, player.y, player.z],
    quantity: 1,
    yaw: player.yaw,
  });
  const interactable = actor.getComponent(INTERACTABLE_COMPONENT);
  // 手上那件不参与就近拾取：否则交互键会在「放下」和「拾取自己」之间摇摆。
  if (interactable) interactable.enabled = false;
  if (!pickupActor(world, actor, player)) {
    scene.removeItemStackActor(actor.id);
    inventory.add(wanted, 1);
  }
  return true;
}

/**
 * 放下嘴上那件东西，不管它是什么。
 *
 * 嘴里同时只有一件，但它有两种：快捷栏拿出来的物品堆，和叼着的世界物件（蘑菇）。
 * 两者的落地方式不同——物品堆只要摆好位置交给掉落物理，蘑菇要建刚体、恢复
 * 可交互、按碰撞半径推开落点——所以这里只做分派，各自的落法留在原处。
 *
 * 分派放在一处，是因为「交互键短按 = 放下」现在对两种手持物都成立：让调用方
 * 自己判断拿的是哪一种，那个判断迟早会有一处忘了写。
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
 * 丢下嘴上那件手持物，落在身前。
 *
 * 落点要推到身体之外：就地松口会把人卡住（嘴只在身前 0.36 米，而玩家半径加物件
 * 半径要 0.7 米才不重叠）。这条和蘑菇放下是同一个理由，也是同一个落点算法。
 *
 * @returns 是否真的丢下了
 */
export function dropHeldItem(scene, player) {
  const world = scene.actorWorld;
  const actor = heldItemStack(world, player);
  if (!actor) return false;
  const inventory = player.getComponent(INVENTORY_COMPONENT);
  if (!dropPickedActor(world, player)) return false;
  const transform = actor.getComponent(TRANSFORM_COMPONENT);
  const interactable = actor.getComponent(INTERACTABLE_COMPONENT);
  if (interactable) interactable.enabled = true;
  if (transform) {
    const distance = 0.85;
    transform.setWorldTransform([
      player.x + Math.sin(player.yaw) * distance,
      player.y + 0.35,
      player.z + Math.cos(player.yaw) * distance,
    ], player.yaw);
  }
  // 丢下之后快捷栏那一格保持配置：包里还有同类就立刻再拿一个出来，
  // 拿不出来就空着手，配置留着等补货。
  if (inventory) syncHeldItemActor(scene, player);
  return true;
}

/**
 * 从背包里直接丢一个到身前。
 *
 * 它**不经过手**。走「先拿到手上再丢」那条路也能把东西丢出去，代价是顺手改写了
 * 快捷栏的一格、把原本握着的东西换下去，丢完还会自动再抽一个同类的到手上——玩家
 * 只想扔掉一个石头，回头发现锤子进了包、手里攥着另一块石头。所以这里自己扣账、
 * 自己生成掉落物。
 *
 * 落点与 `dropHeldItem` 用同一套：身前 0.85 米、抬高 0.35 米。就地生成会和角色的
 * 碰撞体重叠，把人卡住。
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
  const distance = 0.85;
  scene.spawnItemStack(archetypeId, {
    position: [
      player.x + Math.sin(player.yaw) * distance,
      player.y + 0.35,
      player.z + Math.cos(player.yaw) * distance,
    ],
    quantity: removed,
    yaw: player.yaw,
  });
  return true;
}

/**
 * 把手上那件收回背包。
 *
 * 两种手持物都能收：物品堆按自己的 itemType 与数量回账；叼着的世界物件（蘑菇）
 * 按它 `stowable` 上声明的物品回账——「这个世界物件装进包里算哪种物品」是那个
 * 物件自己的属性，不是背包该知道的事。没声明就收不了，交给调用方回退成放下。
 *
 * 收回之后**必须清掉选中格**，否则 `syncHeldItemActor` 会立刻再拿一个出来，长按
 * 等于没发生。「收回背包」的语义就是空手，那一格的配置留着，再按一次数字键还在。
 *
 * @returns 是否真的收回了
 */
export function stowHeldItem(scene, player) {
  const world = scene.actorWorld;
  const inventory = player?.getComponent(INVENTORY_COMPONENT);
  const heldId = player?.getComponent(PICKUP_DROP_COMPONENT)?.heldActorId;
  const actor = heldId ? world.getActor(heldId) : undefined;
  if (!actor || !inventory) return false;
  const stack = actor.getComponent(ITEM_STACK_COMPONENT);
  const stowable = actor.getComponent(STOWABLE_COMPONENT);
  const itemType = stack?.itemType ?? stowable?.itemType;
  const quantity = stack?.quantity ?? stowable?.quantity ?? 0;
  if (!itemType || quantity <= 0) return false;
  // 背包正好满了就收不回来：这时不该把东西删掉，让它留在手上比凭空消失好。
  if (inventory.add(itemType, quantity) !== quantity) return false;
  dropPickedActor(world, player);
  // 物品堆是临时生成的，收回去就该消失；世界物件（蘑菇）走 ActorWorld 的删除，
  // 它本来就登记在场景里。
  if (stack) scene.removeItemStackActor(actor.id);
  else world.removeActor(actor.id);
  inventory.setActiveHotbarSlot(-1);
  return true;
}

/**
 * 结算一次手持物使用。
 *
 * `heldSeconds` 是**服务端自己记的**按下时长，不采信客户端上报的值；两端跑同一个
 * `chargeRatio`，所以客户端蓄力条画满那一刻就是这里判定蓄满那一刻。
 *
 * @returns 是否产生了效果
 */
export function useHeldItem(scene, player, heldSeconds) {
  const world = scene.actorWorld;
  const actor = heldItemStack(world, player);
  const stack = actor?.getComponent(ITEM_STACK_COMPONENT);
  const definition = stack ? itemCatalog.get(stack.itemType) : undefined;
  const use = definition?.use;
  if (!use) return false;
  const ratio = chargeRatio(heldSeconds, use.chargeSeconds);

  if (use.action === 'throw') {
    // 投出去的就是手上那一个 Actor 本身：不销毁再生成，掉落物理直接从当前位姿接管。
    if (!dropPickedActor(world, player)) return false;
    const transform = actor.getComponent(TRANSFORM_COMPONENT);
    const motion = actor.getComponent(DROP_MOTION_COMPONENT);
    const interactable = actor.getComponent(INTERACTABLE_COMPONENT);
    if (interactable) interactable.enabled = true;
    const speed = (use.value / 10) * ratio;
    if (transform) {
      transform.setWorldTransform([
        player.x + Math.sin(player.yaw) * 0.6,
        player.y + 0.6,
        player.z + Math.cos(player.yaw) * 0.6,
      ], player.yaw);
    }
    if (motion) {
      motion.velocityX = Math.sin(player.yaw) * speed;
      motion.velocityY = 1.6 + speed * 0.35;
      motion.velocityZ = Math.cos(player.yaw) * speed;
    }
    syncHeldItemActor(scene, player);
    return true;
  }

  if (use.action === 'tool') {
    // 工具敲的是面前那个可采集物件，力度来自物品目录，不是写死在采集代码里。
    const target = scene.findHarvestablePropNear?.(player, use);
    if (!target) return false;
    return scene.applyToolHarvest(player, target, use.value);
  }

  return false;
}

/**
 * 背包与容器之间搬东西。
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
