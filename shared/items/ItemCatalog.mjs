import { isValidTag } from '../abilities/index.mjs';

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

/**
 * 物品分类。分类不是标签，它决定物品走哪条携带规则：
 *
 * - `material` / `valuable` 占货位，装满了就拿不动，对应设计稿 §6.5「角色背包容量小」；
 * - `throwable` / `supply` 也占货位，但战斗中由固定战斗栏取用，§9.5.2、§9.5.3 各自限量；
 * - `ammunition` / `tool` 的 slotCost 为 0，按 §9.5.5「不通过背包格数挤压武器选择」走独立上限池。
 */
export const ITEM_CATEGORIES = Object.freeze([
  'material',
  'valuable',
  'throwable',
  'supply',
  'ammunition',
  'tool',
]);

/** 不占货位的分类：它们各自有上限，但不吃背包格数。 */
const POOLED_CATEGORIES = new Set(['ammunition', 'tool']);

/**
 * 使用这件物品时做什么。
 *
 * 只登记**有人兑现得了**的效果：`eat` 扣掉 `value` 个并让角色演一段吃的动作，
 * `tool` 走 `GeneratedProp.applyDamage`，`throw` 走掉落物的 `DropMotion` 抛体，
 * `shoot` 由**武器系统**自己注册执行器（见 `server/actors/ItemUseActions.mjs`）——
 * 物品侧只负责把这一次激活连同蓄力比例交出去，不替它决定飞出去的是什么。
 * 「吃下回血」里的回血还不在其中——角色身上还没有一条可回复的属性，所以 `eat`
 * 现在兑现的是「吃掉一个」这件事本身，回血等那条属性到位再加。
 *
 * 这一段同时是**物品能力的定义源**：使用一件物品的兑现路径是「授予玩家一条
 * Ability → 按下面的 mode 激活 → 完成后收回」，`action` 决定那条 Ability 激活
 * 时执行什么，见 `shared/items/ItemAbility.mjs`。
 */
export const ITEM_USE_ACTIONS = Object.freeze(['eat', 'shoot', 'tool', 'throw']);

/**
 * 逻辑输入槽。
 *
 * 物品说自己走哪个槽，**不说自己绑在哪个键上**：键位属于
 * `config/input/player.input.json`，那里才有重绑定、手柄和触屏三套映射。物品目录
 * 里写死 `Mouse.Button0` 会让这三样在这件物品上同时失效。
 *
 * 目前只有主手一个槽。留着这一层是因为它是「物品」和「键位」之间唯一的接缝：
 * 以后要给弓箭配一个瞄准键，是往这个枚举加一个值，而不是在玩法里插一句判断。
 */
export const ITEM_USE_INPUTS = Object.freeze(['primary']);

/**
 * 怎么激活这条能力。
 *
 * - `tap`：点一下就激活。锤子敲一下就是一下。
 * - `hold`：按住 `holdSeconds` 秒，**倒计时走完的那一刻激活**，中途松手是取消。
 *   长按不是「蓄力越久越强」——强度恒为 `value`，倒计时只决定成不成立。玩家看到
 *   的那圈圆形倒计时因此和判定是同一件事：圈满 = 激活。
 * - `charge`：按住蓄力，**松手那一刻激活**，蓄到几成由激活时的比例说了算。圈满之后
 *   不自己激活，停在满圈上等松手——弓拉满了不会自己射出去。
 *
 * `hold` 和 `charge` 画的是同一个圈、读的是同一个 `holdSeconds`，差别只有一个：
 * 圈满那一刻是**结算**还是**等松手**。分成两个 mode 而不是加一个布尔，是因为这决定
 * 了「松手」有没有含义——`hold` 的松手是取消，`charge` 的松手才是那一下。
 */
export const ITEM_USE_MODES = Object.freeze(['tap', 'hold', 'charge']);

function requireObject(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${path} 必须是对象`);
  }
  return value;
}

function requireId(value, path) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new TypeError(`${path} 必须是小写 kebab-case id`);
  }
  return value;
}

function requireString(value, path, maximumLength) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximumLength) {
    throw new TypeError(`${path} 必须是 1-${maximumLength} 个字符的字符串`);
  }
  return value;
}

function requireInteger(value, path, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${path} 必须是 ${minimum}-${maximum} 的整数`);
  }
  return value;
}

/** 使用配置。整块不写就是「这件东西没有用法」。 */
function validateUse(raw, path, holdable) {
  if (raw === undefined) return undefined;
  const definition = requireObject(raw, path);
  if (!holdable) throw new TypeError(`${path}：拿不到手上的东西没有使用方式`);
  if (!ITEM_USE_ACTIONS.includes(definition.action)) {
    throw new TypeError(`${path}.action 必须是 ${ITEM_USE_ACTIONS.join(' / ')} 之一`);
  }
  if (!ITEM_USE_INPUTS.includes(definition.input)) {
    throw new TypeError(`${path}.input 必须是 ${ITEM_USE_INPUTS.join(' / ')} 之一`);
  }
  if (!ITEM_USE_MODES.includes(definition.mode)) {
    throw new TypeError(`${path}.mode 必须是 ${ITEM_USE_MODES.join(' / ')} 之一`);
  }
  // 按住的两种（长按、蓄力）都要给出圈的长度；点按没有圈可画。
  const held = definition.mode === 'hold' || definition.mode === 'charge';
  const holdSeconds = definition.holdSeconds;
  if (held !== (holdSeconds !== undefined)) {
    throw new TypeError(`${path}.holdSeconds 只属于 hold / charge，且按住必须给出圈的长度`);
  }
  if (held && (!Number.isFinite(holdSeconds) || holdSeconds <= 0 || holdSeconds > 10)) {
    throw new TypeError(`${path}.holdSeconds 必须是 (0, 10] 的秒数`);
  }
  const cooldownSeconds = definition.cooldownSeconds;
  if (cooldownSeconds !== undefined
    && (!Number.isFinite(cooldownSeconds) || cooldownSeconds <= 0 || cooldownSeconds > 60)) {
    throw new TypeError(`${path}.cooldownSeconds 必须是 (0, 60] 的秒数`);
  }
  return Object.freeze({
    action: definition.action,
    input: definition.input,
    mode: definition.mode,
    /** tap 的倒计时长度是 0：点一下就激活，不需要再分一条支路。 */
    holdSeconds: held ? holdSeconds : 0,
    /**
     * 用完之后多久才能再用一次，秒；0 = 没有冷却。
     *
     * 它落成能力自己的 `cooldown`，由 GAS 判定——冷却中的那次激活在能力那一层就被
     * 挡下，物品侧不用再写一遍「还能不能用」。
     */
    cooldownSeconds: cooldownSeconds ?? 0,
    value: requireInteger(definition.value, `${path}.value`, 1, 1000),
  });
}

/**
 * 弹药位：这件东西吃哪几种弹药、装几发。整块不写 = 它不吃弹药。
 *
 * **只有走独立池、且一格只放一件的物品能装弹药**（`slotCost: 0` + `stackLimit: 1`，
 * 也就是分类里的工具）。弹药记在**那一格**上而不是物品目录里——同一把弹弓，装着
 * 三颗石头和空着是两种状态，那是「这一把」的状态。一格里能堆两件时，装进去的石头
 * 归哪一件答不上来；独立池每种只有一条，「背包里的那一把」因此永远只有一把，
 * 用 itemType 就寻址得到它。
 *
 * `accepts` 写的是**物品 id**，不是分类：弹弓吃的是普通石头，而石头是材料。
 * 「什么算弹药」由吃它的那件东西说了算，不由弹药自己的分类说了算。
 */
function validateAmmo(raw, path, { pooled, stackLimit }) {
  if (raw === undefined) return undefined;
  const definition = requireObject(raw, path);
  if (!pooled || stackLimit !== 1) {
    throw new TypeError(`${path}：只有 slotCost 为 0 且 stackLimit 为 1 的物品能装弹药`);
  }
  if (!Array.isArray(definition.accepts) || definition.accepts.length === 0) {
    throw new TypeError(`${path}.accepts 至少要写一种弹药`);
  }
  const accepts = definition.accepts.map(
    (itemType, index) => requireId(itemType, `${path}.accepts[${index}]`),
  );
  if (new Set(accepts).size !== accepts.length) {
    throw new TypeError(`${path}.accepts 里有重复的弹药`);
  }
  return Object.freeze({
    accepts: Object.freeze(accepts),
    capacity: requireInteger(definition.capacity, `${path}.capacity`, 1, 999),
  });
}

function requireNumber(value, path, minimum, maximum) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError(`${path} 必须是 ${minimum}-${maximum} 的数字`);
  }
  return value;
}

/**
 * 武器数据（设计稿 `@w` 的 `D`）。
 *
 * 它落在**物品**上而不是另开一份武器表：`@w` 的 `I:` 指的就是一件 `@i`，一件东西
 * 只有一条账。字段与设计稿一一对上：
 *
 * - `attack` = `D.Attack`；
 * - `tagMultipliers` = `D.Attack.Tag`，按目标标签改判倍率（`Actor.Build` 匹配
 *   `Actor.Build.Wall`，见 `shared/actor/actorTags.mjs`）；
 * - `radius` + `range` = `D.EQS`：朝向 + 蓄力比例反解出落点，落点周围这个半径内的
 *   目标全部命中。**抛物线不在这里**——它是 `A` 里的表现，判定只认落点与半径；
 * - `charge` = 蓄力缩放：低于 `minimumRatio` 视为空放，不发射也不进冷却。
 *
 * `D.CD` 不在这里：冷却是**所有物品**都可能有的东西，写在 `use.cooldownSeconds` 上，
 * 由能力自己的 cooldown 兑现。
 *
 * **只属于 `shoot` 的物品，但 `shoot` 不强制要有它**：一件登记了 `shoot` 却还没有
 * `@w` 条目的东西（比如今天的弹弓）是「打不响的武器」，那是设计还没到，不是配置错。
 */
function validateWeapon(raw, path, use) {
  if (raw === undefined) return undefined;
  const definition = requireObject(raw, path);
  if (use?.action !== 'shoot') throw new TypeError(`${path} 只属于 shoot 动作的物品`);
  const range = requireObject(definition.range, `${path}.range`);
  const minimumRange = requireNumber(range.minimum, `${path}.range.minimum`, 0.5, 64);
  const maximumRange = requireNumber(range.maximum, `${path}.range.maximum`, 0.5, 64);
  if (maximumRange < minimumRange) {
    throw new TypeError(`${path}.range.maximum 不能小于 minimum`);
  }
  const charge = requireObject(definition.charge, `${path}.charge`);
  const damageScale = requireObject(charge.damageScale, `${path}.charge.damageScale`);
  const minimumScale = requireNumber(damageScale.minimum, `${path}.charge.damageScale.minimum`, 0, 10);
  const maximumScale = requireNumber(damageScale.maximum, `${path}.charge.damageScale.maximum`, 0, 10);
  if (maximumScale < minimumScale) {
    throw new TypeError(`${path}.charge.damageScale.maximum 不能小于 minimum`);
  }
  const multipliers = definition.tagMultipliers === undefined ? [] : definition.tagMultipliers;
  if (!Array.isArray(multipliers)) throw new TypeError(`${path}.tagMultipliers 必须是数组`);
  const tagMultipliers = multipliers.map((entry, index) => {
    const entryPath = `${path}.tagMultipliers[${index}]`;
    const value = requireObject(entry, entryPath);
    if (!isValidTag(value.tag)) throw new TypeError(`${entryPath}.tag 必须是点分层级标签`);
    return Object.freeze({
      tag: value.tag,
      multiplier: requireNumber(value.multiplier, `${entryPath}.multiplier`, 0, 100),
    });
  });
  return Object.freeze({
    attack: requireNumber(definition.attack, `${path}.attack`, 0, 100_000),
    radius: requireNumber(definition.radius, `${path}.radius`, 0.2, 16),
    range: Object.freeze({ minimum: minimumRange, maximum: maximumRange }),
    charge: Object.freeze({
      minimumRatio: requireNumber(charge.minimumRatio, `${path}.charge.minimumRatio`, 0, 0.9),
      damageScale: Object.freeze({ minimum: minimumScale, maximum: maximumScale }),
    }),
    tagMultipliers: Object.freeze(tagMultipliers),
  });
}

function validateItem(raw, index) {
  const path = `items[${index}]`;
  const definition = requireObject(raw, path);
  const id = requireId(definition.id, `${path}.id`);
  if (!ITEM_CATEGORIES.includes(definition.category)) {
    throw new TypeError(`${path}.category 必须是 ${ITEM_CATEGORIES.join(' / ')} 之一`);
  }
  const category = definition.category;
  const slotCost = requireInteger(definition.slotCost, `${path}.slotCost`, 0, 3);
  const pooled = POOLED_CATEGORIES.has(category);
  if (pooled !== (slotCost === 0)) {
    throw new TypeError(
      `${path}.slotCost 与分类不符：${category} ${pooled ? '不占货位' : '必须占至少一个货位'}`,
    );
  }
  const stackLimit = requireInteger(definition.stackLimit, `${path}.stackLimit`, 1, 100_000);
  if (category === 'valuable' && stackLimit !== 1) {
    throw new TypeError(`${path}.stackLimit：价值货物是可抢夺实体，不能堆叠`);
  }
  if (typeof definition.tint !== 'string' || !COLOR_PATTERN.test(definition.tint)) {
    throw new TypeError(`${path}.tint 必须是 #RRGGBB 颜色`);
  }
  const durability = definition.durability === undefined
    ? 0
    : requireInteger(definition.durability, `${path}.durability`, 0, 1000);
  const coinValue = definition.coinValue === undefined
    ? undefined
    : requireInteger(definition.coinValue, `${path}.coinValue`, 1, 1000);
  if ((category === 'valuable') !== (coinValue !== undefined)) {
    throw new TypeError(`${path}.coinValue 只属于价值货物，且价值货物必须标价`);
  }
  if (definition.contraband !== undefined && typeof definition.contraband !== 'boolean') {
    throw new TypeError(`${path}.contraband 必须是布尔值`);
  }
  if (definition.holdable !== undefined && typeof definition.holdable !== 'boolean') {
    throw new TypeError(`${path}.holdable 必须是布尔值`);
  }
  // 弹药是按发数记的独立池，没有「一发子弹拿在手上」这种东西；其余默认可手持。
  const holdable = definition.holdable ?? category !== 'ammunition';
  const use = validateUse(definition.use, `${path}.use`, holdable);
  const ammo = validateAmmo(definition.ammo, `${path}.ammo`, { pooled, stackLimit });
  const weapon = validateWeapon(definition.weapon, `${path}.weapon`, use);
  return Object.freeze({
    id,
    displayName: requireString(definition.displayName, `${path}.displayName`, 32),
    category,
    stackLimit,
    slotCost,
    iconId: requireId(definition.iconId, `${path}.iconId`),
    tint: definition.tint,
    summary: requireString(definition.summary, `${path}.summary`, 64),
    /**
     * 耐久度。0 = 没有耐久，用不坏。
     *
     * 目前四件物品全是 0：耐久要有「用一次掉一点、掉光了坏掉」的系统才有意义，
     * 那套还没有。字段先立在这里，是因为物品表本来就按「有没有耐久」描述一件
     * 东西，缺了它，一件有耐久的道具进目录时得先改一遍校验。
     */
    durability,
    coinValue,
    contraband: definition.contraband === true,
    /** 不占货位的物品由独立上限池承载，背包格数对它们没有约束力。 */
    pooled,
    /**
     * 能不能拿在手上。手持物是挂在角色手部挂点上的一个纯表现 Actor：
     * 没有碰撞、没有掉落物理，坐标完全由 Actor 嵌套关系解算。
     */
    holdable,
    /** 怎么用它；不可使用时是 undefined。 */
    use,
    /**
     * 弹药位：吃哪几种弹药、装几发。不吃弹药时是 undefined。
     *
     * 装了多少记在账本那一格上（`ItemLedger` 的条目、物品栏那一格），不记在这里——
     * 这里说的是「这类东西能装什么」，那里说的是「这一件现在装着什么」。
     */
    ammo,
    /**
     * 武器数据（`@w` 的 `D`）；不是武器、或者还没有 `@w` 条目时是 undefined。
     * 见 `validateWeapon`。
     */
    weapon,
  });
}

/**
 * 通用物品定义表。
 *
 * 物品只是数据：新增一种物品是往 `config/items/item-catalog.json` 加一条，
 * 加上 `src/ui/icons/ItemIconSprite.ts` 里的一枚图标，不需要改背包、拾取或界面代码。
 */
export class ItemCatalog {
  /** @param {unknown} raw `config/items/item-catalog.json` 的内容 */
  constructor(raw) {
    const source = requireObject(raw, 'itemCatalog');
    if (source.schemaVersion !== 1) {
      throw new TypeError(`itemCatalog.schemaVersion 不受支持：${source.schemaVersion}`);
    }
    if (!Array.isArray(source.items) || source.items.length === 0) {
      throw new TypeError('itemCatalog.items 至少要有一条物品定义');
    }
    this.id = requireString(source.id, 'itemCatalog.id', 64);
    /** @type {Map<string, ReturnType<typeof validateItem>>} */
    this.definitions = new Map();
    source.items.forEach((item, index) => {
      const definition = validateItem(item, index);
      if (this.definitions.has(definition.id)) {
        throw new TypeError(`itemCatalog 物品 id 重复：${definition.id}`);
      }
      this.definitions.set(definition.id, definition);
    });
  }

  has(itemId) {
    return this.definitions.has(itemId);
  }

  get(itemId) {
    return this.definitions.get(itemId);
  }

  /** 取不到就抛：配置里没登记的物品不应该悄悄以默认值进入存档与快照。 */
  require(itemId) {
    const definition = this.definitions.get(itemId);
    if (!definition) throw new Error(`物品目录里没有登记：${itemId}`);
    return definition;
  }

  list() {
    return Array.from(this.definitions.values());
  }

  listByCategory(category) {
    return this.list().filter((definition) => definition.category === category);
  }
}
