import { ActorComponent } from '../ActorComponent.mjs';
import { itemCatalog } from '../../items/index.mjs';
import { DEFAULT_SLOT_CAPACITY, ItemLedger, sameAmmo, sanitizeAmmo } from '../ItemLedger.mjs';

export const INVENTORY_COMPONENT = 'inventory';

export { DEFAULT_SLOT_CAPACITY };

/** 物品栏格数。原型没写时的默认值；数字键 1-9 一格一个，所以上限是 9。 */
export const DEFAULT_HOTBAR_CAPACITY = 9;

/** 数字键能寻址的最大格数。再多的格子没有键可以切过去，配置也就没有意义。 */
export const MAXIMUM_HOTBAR_CAPACITY = 9;

/** 空手。`activeHotbarIndex` 取这个值时嘴上不挂任何手持物。 */
export const NO_HOTBAR_SLOT = -1;

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function requestedQuantity(value) {
  return Math.max(0, Math.floor(Number(value) || 0));
}

/**
 * 角色随身携带的两样东西：**背包**和**物品栏**。
 *
 * 两者装的是同一种东西、守的是同一套堆叠规则，区别只有「谁拿得出来用」：
 *
 * - 背包（`ledger`）按货位记账，是收纳；
 * - 物品栏（`hotbar`）是一条**特殊的背包**：固定格数、一格一摞、数字键直接寻址，
 *   拿在手上的永远是其中一格。
 *
 * 配置物品栏因此是一次**转移**，不是一个引用：`assignHotbarSlot` 把那一摞从背包
 * 里搬进物品栏那一格，背包里就不再有它了。做成引用（物品栏只记 itemType、数量
 * 仍算在背包账上）省一次搬运，代价是两个地方画同一摞货、数量同步变化，玩家没法
 * 理解那是一件东西；把「装进物品栏」和「放回背包」写成两次真实的转移之后，界面
 * 上看到几个就是几个。
 *
 * 权威数据只在房间服务端变化，客户端靠 `applySnapshot` 跟随。
 */
export class InventoryComponent extends ActorComponent {
  constructor(definition = {}, catalog = itemCatalog) {
    super(INVENTORY_COMPONENT);
    this.catalog = catalog;
    this.ledger = new ItemLedger(
      positiveInteger(definition.slotCapacity, DEFAULT_SLOT_CAPACITY),
      catalog,
    );
    this.hotbarCapacity = Math.min(
      MAXIMUM_HOTBAR_CAPACITY,
      positiveInteger(definition.hotbarCapacity, DEFAULT_HOTBAR_CAPACITY),
    );
    /**
     * @type {({ itemType: string, quantity: number } | null)[]}
     * 物品栏每格实际持有的那一摞；null 是空格。
     */
    this.hotbar = new Array(this.hotbarCapacity).fill(null);
    this.activeHotbarIndex = NO_HOTBAR_SLOT;
    this.revision = 0;
  }

  get slotCapacity() { return this.ledger.slotCapacity; }

  get slots() { return this.ledger.slots; }

  get pooled() { return this.ledger.pooled; }

  get usedSlots() { return this.ledger.usedSlots; }

  get freeSlots() { return this.ledger.freeSlots; }

  get isFull() { return this.ledger.isFull; }

  /**
   * 当前握在手上的物品种类；空手时是 undefined。
   *
   * 手持就是「物品栏选中格里那一摞」——不再需要「配置还在但货用光了」这种中间
   * 态：一摞用光，那一格就空了，物品栏是账本而不是一张配置表。
   */
  get heldItemType() {
    return this.hotbar[this.activeHotbarIndex]?.itemType;
  }

  /** 手上那一摞还剩几个；空手时是 0。 */
  get heldQuantity() {
    return this.hotbar[this.activeHotbarIndex]?.quantity ?? 0;
  }

  /** 背包里有多少。物品栏里的那些不算在内，它们已经不在背包里了。 */
  quantityOf(itemType) { return this.ledger.quantityOf(itemType); }

  /** 物品栏里有多少（所有格子合计）。 */
  hotbarQuantityOf(itemType) {
    let total = 0;
    for (const slot of this.hotbar) if (slot?.itemType === itemType) total += slot.quantity;
    return total;
  }

  /** 身上一共有多少：背包 + 物品栏。界面上「我还有几个」问的是这个数。 */
  totalQuantityOf(itemType) {
    return this.quantityOf(itemType) + this.hotbarQuantityOf(itemType);
  }

  /** 收进背包。拾取、容器取出、物品栏放回都走这条。 */
  add(itemType, quantity) {
    const accepted = this.ledger.add(itemType, quantity);
    if (accepted > 0) this.revision += 1;
    return accepted;
  }

  /** 从背包里取出。物品栏那几格不受影响，见 `consumeHotbarSlot`。 */
  remove(itemType, quantity) {
    const removed = this.ledger.remove(itemType, quantity);
    if (removed > 0) this.revision += 1;
    return removed;
  }

  clear() {
    const hadHotbar = this.hotbar.some((slot) => slot !== null);
    const cleared = this.ledger.clear();
    if (!cleared && !hadHotbar) return false;
    this.hotbar.fill(null);
    this.activeHotbarIndex = NO_HOTBAR_SLOT;
    this.revision += 1;
    return true;
  }

  /** 序号落在物品栏里才算数；越界的数字键什么都不做，而不是绕回第一格。 */
  isHotbarSlot(slotIndex) {
    return Number.isInteger(slotIndex) && slotIndex >= 0 && slotIndex < this.hotbarCapacity;
  }

  /**
   * 把背包里的一种物品装配到物品栏某格；`itemType` 为 null 时把那一格收回背包。
   *
   * 这是一次真实的转移，所以顺序很重要：**先把目标格原有的那一摞放回背包**，
   * 放不下就整件事不做——放不下还硬装，那一摞就凭空消失了。
   *
   * 同一种物品只占一格：它已经在别的格子上时，直接把那一格整摞挪过来，而不是
   * 再从背包里抽一摞出来（背包里可能根本没有了）。
   *
   * @returns 物品栏是否真的变了。
   */
  assignHotbarSlot(slotIndex, itemType) {
    if (!this.isHotbarSlot(slotIndex)) return false;
    const next = typeof itemType === 'string' && this.catalog.has(itemType) ? itemType : null;
    if (next === null) return this.clearHotbarSlot(slotIndex);

    const sourceIndex = this.hotbar.findIndex((slot) => slot?.itemType === next);
    if (sourceIndex === slotIndex) return false;
    if (sourceIndex >= 0) return this.swapHotbarSlots(sourceIndex, slotIndex);

    const definition = this.catalog.get(next);
    const available = Math.min(this.ledger.quantityOf(next), definition.stackLimit);
    if (available === 0) return false;
    // 腾格子：原有那一摞先回背包，回不去就放弃这次装配。
    if (!this.clearHotbarSlot(slotIndex, { allowEmpty: true })) return false;
    // 整条搬：装着弹药的那一条连弹药一起过来，装配一次弓不该把箭留在包里。
    const moved = this.ledger.takeEntry(next, available);
    if (!moved) return false;
    this.hotbar[slotIndex] = {
      itemType: next,
      quantity: moved.quantity,
      ...(moved.ammo ? { ammo: moved.ammo } : {}),
    };
    this.revision += 1;
    return true;
  }

  /**
   * 把物品栏某格整摞放回背包。
   *
   * 背包收不下就原样留在物品栏：这时把它删掉等于凭空销毁，留着让玩家自己腾地方
   * 才是能理解的结果。
   *
   * @param {{ allowEmpty?: boolean }} [options] `allowEmpty` 时空格也算成功，
   *   供 `assignHotbarSlot` 用「腾出这一格」这一个语义调用。
   * @returns 那一格现在是不是空的（或者说这次收回成没成）。
   */
  clearHotbarSlot(slotIndex, { allowEmpty = false } = {}) {
    if (!this.isHotbarSlot(slotIndex)) return false;
    const slot = this.hotbar[slotIndex];
    if (!slot) return allowEmpty;
    // 整摞放不回去就一个都不放（`putEntry` 自己保证），那一摞原样留在物品栏；
    // 装着的弹药跟着一起回包。
    if (!this.ledger.putEntry(slot)) return false;
    this.hotbar[slotIndex] = null;
    this.revision += 1;
    return true;
  }

  /**
   * 把一件**世界里的东西**直接交到物品栏上（空手从地里拔出来的蘑菇走这条）。
   *
   * 和 `assignHotbarSlot` 的区别是它**不经过背包**：那件东西刚从世界里出来，
   * 账上本来就没有它，要求它先落进背包再搬一次，只会让「空手拔一朵、拔完就在
   * 手上」在背包满的时候莫名其妙地失败。
   *
   * 落点顺序是「已经装着同种且装得下的那一格 → 空着的选中格 → 第一个空格」：
   * 玩家说的「空手对应的那一格」就是选中的那一格，它空着时优先用它。
   *
   * 和拾取用的 `receive` 是两条政策，区别在**收不下的时候**：拾取收不下就把剩下的
   * 留在世界里那一堆上，而从世界里拔出来的这一株没有「那一堆」可留——所以它要么
   * 整份进物品栏，要么整件事不做，由调用方退回「叼在嘴上」。
   *
   * @returns {number} 收进了哪一格；一格都腾不出来时是 `NO_HOTBAR_SLOT`。
   */
  equipToHotbar(itemType, quantity = 1) {
    const definition = this.catalog.get(itemType);
    const wanted = requestedQuantity(quantity);
    if (!definition || wanted === 0) return NO_HOTBAR_SLOT;
    const stackable = this.hotbar.findIndex((slot) => (
      slot?.itemType === definition.id && slot.quantity + wanted <= definition.stackLimit
    ));
    const index = stackable >= 0 ? stackable : this.firstEmptyHotbarSlot();
    if (index === NO_HOTBAR_SLOT) return NO_HOTBAR_SLOT;
    const slot = this.hotbar[index];
    if (slot) slot.quantity += wanted;
    else this.hotbar[index] = { itemType: definition.id, quantity: wanted };
    this.revision += 1;
    return index;
  }

  /**
   * 收下一批刚捡起来的东西：**先手上，再物品栏空位，最后背包**。
   *
   * 拾取的第一去处是手上那一格，而不是背包：捡起来的东西十有八九是马上要用的，
   * 落进背包等于要求玩家每捡一次就开一次背包、装配一次、再切一次格。
   *
   * 落点顺序：
   *
   * 1. **已经装着同种、还装得下的物品栏格**——手上正拿着同一种东西时，这一步就是
   *    「堆在手上那一摞上」；
   * 2. **空着的选中格**（空手），没选中格时是第一个空格，并顺手切过去：空手捡起
   *    一块石头，石头就该出现在手上；
   * 3. 其余物品栏空格；
   * 4. **背包**：物品栏也满了才轮到它。
   *
   * 每一步都按堆叠上限**部分收下**，收不完的继续往下走；一个都收不下时返回 0，
   * 剩下的留在世界里（`ItemLedger.add` 的老规矩：满额时不吞货）。
   *
   * @returns 实际收下的数量
   */
  receive(itemType, quantity) {
    const definition = this.catalog.get(itemType);
    let remaining = requestedQuantity(quantity);
    if (!definition || remaining === 0) return 0;
    const wasEmptyHanded = !this.hotbar[this.activeHotbarIndex];
    let accepted = 0;

    const fill = (slotIndex) => {
      if (remaining === 0 || !this.isHotbarSlot(slotIndex)) return;
      const slot = this.hotbar[slotIndex];
      if (slot && slot.itemType !== definition.id) return;
      const room = definition.stackLimit - (slot?.quantity ?? 0);
      const taken = Math.min(remaining, room);
      if (taken <= 0) return;
      if (slot) slot.quantity += taken;
      else this.hotbar[slotIndex] = { itemType: definition.id, quantity: taken };
      remaining -= taken;
      accepted += taken;
      // 空手捡起来的那一格顺手切过去，东西直接到手上。已经握着别的东西时不换手：
      // 玩家没有要求换，一次拾取不该把手上那件顶掉。
      if (wasEmptyHanded && this.activeHotbarIndex !== slotIndex && !this.heldItemType) {
        this.activeHotbarIndex = slotIndex;
      }
    };

    for (let index = 0; index < this.hotbarCapacity; index += 1) {
      if (this.hotbar[index]?.itemType === definition.id) fill(index);
    }
    if (this.isHotbarSlot(this.activeHotbarIndex)) fill(this.activeHotbarIndex);
    for (let index = 0; index < this.hotbarCapacity; index += 1) {
      if (!this.hotbar[index]) fill(index);
    }
    if (remaining > 0) {
      const stored = this.ledger.add(definition.id, remaining);
      remaining -= stored;
      accepted += stored;
    }
    if (accepted > 0) this.revision += 1;
    return accepted;
  }

  /** 空着的选中格优先，没有再找第一个空格；全满时是 `NO_HOTBAR_SLOT`。 */
  firstEmptyHotbarSlot(preferredIndex = this.activeHotbarIndex) {
    if (this.isHotbarSlot(preferredIndex) && !this.hotbar[preferredIndex]) return preferredIndex;
    const index = this.hotbar.findIndex((slot) => slot === null);
    return index >= 0 ? index : NO_HOTBAR_SLOT;
  }

  /** 两格对调（拖拽时把一格拖到另一格上）。 */
  swapHotbarSlots(fromIndex, toIndex) {
    if (!this.isHotbarSlot(fromIndex) || !this.isHotbarSlot(toIndex)) return false;
    if (fromIndex === toIndex) return false;
    const from = this.hotbar[fromIndex];
    const to = this.hotbar[toIndex];
    if (!from && !to) return false;
    this.hotbar[fromIndex] = to;
    this.hotbar[toIndex] = from;
    this.revision += 1;
    return true;
  }

  /**
   * 从物品栏某格扣掉几个；扣空的格子直接空出来。
   *
   * 使用一次投掷物、把手上那件丢到地上，走的都是这条：物品栏是账本，手上那件
   * 不额外记一份，所以「用掉一个」就是这一格减一。
   *
   * @returns 实际扣掉的数量。
   */
  consumeHotbarSlot(slotIndex, quantity = 1) {
    if (!this.isHotbarSlot(slotIndex)) return 0;
    const slot = this.hotbar[slotIndex];
    const wanted = requestedQuantity(quantity);
    if (!slot || wanted === 0) return 0;
    const taken = Math.min(wanted, slot.quantity);
    slot.quantity -= taken;
    if (slot.quantity === 0) this.hotbar[slotIndex] = null;
    this.revision += 1;
    return taken;
  }

  /** 手上那一摞扣掉几个。空手时什么都不做。 */
  consumeHeldItem(quantity = 1) {
    return this.consumeHotbarSlot(this.activeHotbarIndex, quantity);
  }

  /**
   * 一格的地址：`{ kind: 'hotbar', slotIndex }` 或 `{ kind: 'backpack', itemType }`。
   *
   * 两本账用两种寻址方式，是因为它们本来就是两种东西：物品栏有固定的第几格，
   * 背包里是一摞摞按种类排的货。界面上那一格（`InventorySlotRef`）说的是同一件事，
   * 所以两边共用同一个形状，命令过网时不用再翻译一次。
   *
   * 背包侧按种类寻址对**弹药位**足够精确：装得下弹药的东西 `stackLimit` 恒为 1、
   * 又在独立池里（每种只有一条），所以「包里哪一把弹弓」不会有第二个答案。
   *
   * @returns 那一格里的那一摞（账本里的原对象，改它就是改账）；空格时是 undefined。
   */
  entryAt(ref) {
    if (ref?.kind === 'hotbar') {
      return this.isHotbarSlot(ref.slotIndex) ? this.hotbar[ref.slotIndex] ?? undefined : undefined;
    }
    if (ref?.kind !== 'backpack') return undefined;
    return [...this.ledger.pooled, ...this.ledger.slots]
      .find((entry) => entry.itemType === ref.itemType);
  }

  /** 这一格装着什么弹药、还剩几发；没装时是 undefined。 */
  ammoAt(ref) {
    return this.entryAt(ref)?.ammo;
  }

  /**
   * 往一格里装弹药。
   *
   * 弹药记在**那一格**上，不记在物品目录里：同一把弹弓，装着 5 颗石头和空着是
   * 两种状态，而这两种状态属于那一把弹弓。所以装填是一次转移——从来源那一格扣掉，
   * 记到目标那一格的弹药位上。
   *
   * 装什么由目标物品的 `ammo.accepts` 说了算，装多少到 `capacity` 为止；一次尽量
   * 装满，来源见底或装满就停，剩下的原样留在来源那一格。**已经装着别的弹药时不
   * 混装**：先卸下再换。
   *
   * @param {{kind: string}} target 装到哪一格
   * @param {{kind: string}} source 弹药从哪一格来
   * @returns {number} 实际装进去几发
   */
  loadAmmo(target, source, quantity = Number.POSITIVE_INFINITY) {
    const entry = this.entryAt(target);
    const slot = entry ? this.catalog.get(entry.itemType)?.ammo : undefined;
    const from = this.entryAt(source);
    if (!entry || !slot || !from) return 0;
    const ammoType = from.itemType;
    if (!slot.accepts.includes(ammoType)) return 0;
    const loaded = entry.ammo;
    if (loaded && loaded.itemType !== ammoType) return 0;
    const wanted = Number.isFinite(quantity)
      ? requestedQuantity(quantity)
      : Number.MAX_SAFE_INTEGER;
    const taken = Math.min(wanted, from.quantity, slot.capacity - (loaded?.quantity ?? 0));
    if (taken <= 0) return 0;
    const moved = source.kind === 'hotbar'
      ? this.consumeHotbarSlot(source.slotIndex, taken)
      : this.remove(ammoType, taken);
    if (moved === 0) return 0;
    if (loaded) loaded.quantity += moved;
    else entry.ammo = { itemType: ammoType, quantity: moved };
    this.revision += 1;
    return moved;
  }

  /**
   * 把一格里装着的弹药卸回身上，落点和拾取一样：先手上、再物品栏、最后背包。
   *
   * 收不下的**留在武器上**，不落地也不消失：卸下是一次收纳动作，玩家没有要求把
   * 东西丢出去。一发都收不下时整件事不做。
   *
   * @returns {number} 实际收回几发
   */
  unloadAmmo(target) {
    const entry = this.entryAt(target);
    const ammo = entry?.ammo;
    if (!ammo) return 0;
    const accepted = this.receive(ammo.itemType, ammo.quantity);
    if (accepted === 0) return 0;
    ammo.quantity -= accepted;
    if (ammo.quantity === 0) delete entry.ammo;
    this.revision += 1;
    return accepted;
  }

  /**
   * 打掉几发。发射的那一下扣的是这里，不是背包里那摞石头。
   *
   * @returns {number} 实际扣掉几发；不够就扣多少算多少。
   */
  consumeAmmo(target, quantity = 1) {
    const entry = this.entryAt(target);
    const ammo = entry?.ammo;
    const wanted = requestedQuantity(quantity);
    if (!ammo || wanted === 0) return 0;
    const taken = Math.min(wanted, ammo.quantity);
    ammo.quantity -= taken;
    if (ammo.quantity === 0) delete entry.ammo;
    this.revision += 1;
    return taken;
  }

  /**
   * 切到物品栏某一格；再按一次当前格，或传 `NO_HOTBAR_SLOT`，都是收手。
   *
   * @returns 手持是否真的变了。
   */
  setActiveHotbarSlot(slotIndex) {
    const next = this.isHotbarSlot(slotIndex) && slotIndex !== this.activeHotbarIndex
      ? slotIndex
      : NO_HOTBAR_SLOT;
    if (next === this.activeHotbarIndex) return false;
    this.activeHotbarIndex = next;
    this.revision += 1;
    return true;
  }

  /** 物品栏往前/往后挪一格（手柄 LB/RB）。空栏时什么都不做。 */
  cycleActiveHotbarSlot(direction) {
    const step = direction < 0 ? -1 : 1;
    if (this.hotbarCapacity === 0) return false;
    const from = this.activeHotbarIndex === NO_HOTBAR_SLOT ? -step : this.activeHotbarIndex;
    const next = ((from + step) % this.hotbarCapacity + this.hotbarCapacity) % this.hotbarCapacity;
    if (next === this.activeHotbarIndex) return false;
    this.activeHotbarIndex = next;
    this.revision += 1;
    return true;
  }

  snapshot() { return this.ledger.snapshot(); }

  /**
   * 物品栏内容与选中格；和背包一起下发，只发给物主。
   *
   * 每格带上数量，因为物品栏现在自己持有那一摞——只发 itemType 的话，客户端要
   * 去背包账上找数量，而那里已经没有它了。
   */
  hotbarSnapshot() {
    return {
      // 弹药那一段也复制一份：快照发出去之后不该还指着账本里那个对象。
      slots: this.hotbar.map((slot) => (
        slot ? { ...slot, ...(slot.ammo ? { ammo: { ...slot.ammo } } : {}) } : null
      )),
      activeIndex: this.activeHotbarIndex,
    };
  }

  /**
   * 客户端镜像：按快照重建背包与物品栏。
   *
   * @param {Array<{itemType: string, quantity: number}>} entries 背包内容
   * @param {number} [revision]
   * @param {{slots: Array<{itemType: string, quantity: number}|null>, activeIndex: number}} [hotbar]
   *   没有这一段时保持本地物品栏不动，只更新背包。
   * @returns {boolean} 内容或 revision 是否真的变了，供界面决定要不要重画。
   */
  applySnapshot(entries, revision = this.revision, hotbar = undefined) {
    const nextRevision = Math.max(0, Math.trunc(Number(revision) || 0));
    let changed = this.ledger.applySnapshot(entries) || nextRevision !== this.revision;
    if (hotbar) {
      const slots = Array.isArray(hotbar.slots) ? hotbar.slots : [];
      const next = new Array(this.hotbarCapacity).fill(null);
      for (let index = 0; index < this.hotbarCapacity; index += 1) {
        next[index] = this.sanitizeHotbarSlot(slots[index]);
      }
      const activeIndex = this.isHotbarSlot(hotbar.activeIndex)
        ? hotbar.activeIndex
        : NO_HOTBAR_SLOT;
      changed = changed
        || activeIndex !== this.activeHotbarIndex
        || next.some((slot, index) => !sameHotbarSlot(slot, this.hotbar[index]));
      this.hotbar = next;
      this.activeHotbarIndex = activeIndex;
    }
    this.revision = nextRevision;
    return changed;
  }

  /** 快照里没登记的物品、数量为 0 的格子一律当成空格，不写坏本地物品栏。 */
  sanitizeHotbarSlot(raw) {
    const definition = raw ? this.catalog.get(raw.itemType) : undefined;
    const quantity = requestedQuantity(raw?.quantity);
    if (!definition || quantity === 0) return null;
    const ammo = sanitizeAmmo(raw?.ammo, definition, this.catalog);
    return {
      itemType: definition.id,
      quantity: Math.min(quantity, definition.stackLimit),
      ...(ammo ? { ammo } : {}),
    };
  }

  matches(slots, pooled) { return this.ledger.matches(slots, pooled); }
}

function sameHotbarSlot(left, right) {
  if (!left || !right) return left === right;
  return left.itemType === right.itemType
    && left.quantity === right.quantity
    && sameAmmo(left.ammo, right.ammo);
}
