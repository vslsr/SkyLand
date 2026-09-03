/**
 * Render 字段规格。
 *
 * 「一个模型有哪些 authoring 字段、各自什么范围」原来同时写在两处：
 * `server/actors/ActorCatalog.mjs` 的 `validateRender`（运行时真正执行的那一份）
 * 和 `config/actors/actor.schema.json`（编辑器读的那一份，**没有任何运行时消费者，
 * 也没有任何测试比对过**）。两份已经漂了——木筏的 `width`、货箱的三个尺寸、礁石的
 * `radius` 与 `height` 在 schema 里没有上限，运行时却有。编辑器放行、服务端启动时报错。
 *
 * 现在只声明一次：描述符上的 `fields`。运行时校验按它遍历，JSON Schema 由
 * `scripts/generate-actor-schema.mjs` 从它生成，`npm run schema:check` 挡住漂移。
 *
 * 这里只有**声明**，没有校验实现——校验要用 `ActorCatalog` 自己那套 `require*`
 * 助手才能给出和其它 Component 一致的报错文案，所以遍历器留在服务端。
 *
 * @typedef {{ kind: 'color' }} ColorFieldSpec
 * @typedef {{ kind: 'number', minimum: number, maximum: number, exclusiveMinimum?: boolean, integer?: boolean }} NumberFieldSpec
 * @typedef {ColorFieldSpec | NumberFieldSpec} FieldSpec
 */

/** `#RRGGBB`。 */
export function color() {
  return { kind: 'color' };
}

/**
 * 闭区间 `[minimum, maximum]` 的实数。
 * @param {number} minimum @param {number} maximum
 */
export function number(minimum, maximum) {
  return { kind: 'number', minimum, maximum };
}

/**
 * 正实数，上限闭。
 *
 * 运行时下界是 `Number.EPSILON`（`requireNumber` 只会做闭区间比较），JSON Schema
 * 那侧写成 `exclusiveMinimum: 0`——两者对任何实际 authoring 值等价，差别只在
 * `(0, Number.EPSILON)` 这段没人会写的区间里。
 *
 * @param {number} maximum
 */
export function positive(maximum) {
  return { kind: 'number', minimum: Number.EPSILON, maximum, exclusiveMinimum: true };
}

/**
 * 闭区间整数。
 * @param {number} minimum @param {number} maximum
 */
export function integer(minimum, maximum) {
  return { kind: 'number', minimum, maximum, integer: true };
}

/**
 * 一个字段规格对应的 JSON Schema 片段。
 * @param {FieldSpec} spec
 */
export function fieldSpecToJsonSchema(spec) {
  if (spec.kind === 'color') return { $ref: '#/$defs/color' };
  const schema = { type: spec.integer ? 'integer' : 'number' };
  if (spec.exclusiveMinimum) schema.exclusiveMinimum = 0;
  else schema.minimum = spec.minimum;
  schema.maximum = spec.maximum;
  return schema;
}
