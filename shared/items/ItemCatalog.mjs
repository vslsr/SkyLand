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
