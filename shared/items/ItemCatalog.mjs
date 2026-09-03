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
 * 手持时按使用键做什么。
 *
 * 只登记**已经有系统兑现**的效果：`tool` 走 `GeneratedProp.applyDamage`，
 * `throw` 走掉落物的 `DropMotion` 抛体。「吃下回血」这类要等角色身上先有一条
 * 可回复的属性——在那之前写进目录只会得到一个按下去没反应的动词。
 */
export const ITEM_USE_ACTIONS = Object.freeze(['tool', 'throw']);

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
 * 怎么按。
 *
 * - `tap`：按下即结算，强度恒为满值。锤子敲一下就是一下。
 * - `charge`：按住蓄力、松手结算，蓄力比例 ∈ [0,1] 乘进强度。投掷蓄得越久扔得
 *   越远；以后的弓箭是同一条路径——多的只是一个 `shoot` 分支，按键、蓄力、
 *   结算这一套不用再写一遍。
 */
export const ITEM_USE_MODES = Object.freeze(['tap', 'charge']);

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

/** 手持交互配置。整块不写就是「只能拿着，按键没反应」。 */
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
  const charged = definition.mode === 'charge';
  const chargeSeconds = definition.chargeSeconds;
  if (charged !== (chargeSeconds !== undefined)) {
    throw new TypeError(`${path}.chargeSeconds 只属于 charge，且蓄力必须给出蓄满时长`);
  }
  if (charged && (!Number.isFinite(chargeSeconds) || chargeSeconds <= 0 || chargeSeconds > 10)) {
    throw new TypeError(`${path}.chargeSeconds 必须是 (0, 10] 的秒数`);
  }
  return Object.freeze({
    action: definition.action,
    input: definition.input,
    mode: definition.mode,
    /** tap 蓄力时长为 0：结算时强度恒为满值，不需要再分一条支路。 */
    chargeSeconds: charged ? chargeSeconds : 0,
    value: requireInteger(definition.value, `${path}.value`, 1, 1000),
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
  return Object.freeze({
    id,
    displayName: requireString(definition.displayName, `${path}.displayName`, 32),
    category,
    stackLimit,
    slotCost,
    iconId: requireId(definition.iconId, `${path}.iconId`),
    tint: definition.tint,
    summary: requireString(definition.summary, `${path}.summary`, 64),
    coinValue,
    contraband: definition.contraband === true,
    /** 不占货位的物品由独立上限池承载，背包格数对它们没有约束力。 */
    pooled,
    /** 能不能拿在手上。手持物是挂在角色手部挂点上的一个真 Actor。 */
    holdable,
    /** 怎么用它；不可使用时是 undefined。 */
    use,
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
