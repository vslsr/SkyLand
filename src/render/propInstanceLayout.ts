import type {
  ActorArchetypeDefinition,
  SceneDefinition,
} from '../scenes/data/SceneDefinition';

/**
 * 掉落堆实例通道的字段布局（`RenderInstanceBuffer` 的一种记录形状）。
 *
 * 渲染侧要的只有下标：哪个原型、哪种驻留态、烧没烧、是单个还是一堆，加上位置、
 * 朝向、数量和刚体半径。这些下标两侧共用，所以定义放在通道这一层，
 * 而不是写入方或读出方任何一边。
 */

/** 每条记录的离散字段个数，见 `PROP_*` 下标。 */
export const PROP_INT_STRIDE = 5;
/** 每条记录的连续字段个数。 */
export const PROP_FLOAT_STRIDE = 7;

/**
 * 原型在场景原型表里的下标。渲染侧据此找到 render 定义、建材质与模板。
 *
 * 「场景原型表」由 `createArchetypeTable` 定义，两侧各自从同一份场景定义建。
 */
export const PROP_ARCHETYPE = 0;
/** 驻留态（`ActorResidencyComponent.state`），按下面那份顺序编号。 */
export const PROP_RESIDENCY = 1;
export const PROP_BURNING = 2;
/** 单个还是一堆：果子与原木在数量为 1 时换一套模板。 */
export const PROP_SINGLE = 3;
/**
 * 稳定的实例编号。
 *
 * 渲染侧的滚动姿态是**从位移累积出来的**，所以必须能把这一帧的实例认成
 * 「上一帧那一个」。Actor id 是字符串，过不了字节边界；玩法侧因此给每个
 * 被合批的 Actor 分一个槽位号，和 `ProxyId` 一个套路——离开视野就还回去复用。
 */
export const PROP_ID = 4;

export const PROP_X = 0;
export const PROP_Y = 1;
export const PROP_Z = 2;
export const PROP_YAW = 3;
export const PROP_QUANTITY = 4;
/** 刚体半径；> 0 才有滚动姿态。 */
export const PROP_ROLL_RADIUS = 5;
/**
 * 表现缩放倍率，1 = 原样。
 *
 * 玩法侧写、渲染侧乘上去。它承载的是**一次性的表现**，不是玩法状态：正被吃掉的
 * 那件食物一口一口地小下去，用的就是它。做成一个倍率而不是「吃到第几口」，是
 * 因为渲染侧不该认识「吃」这件事——它只需要知道这一帧画多大。
 */
export const PROP_SCALE = 6;

/**
 * 驻留态的两侧共用编号。字符串过不了字节边界，所以定一份顺序。
 *
 * 放在通道定义里而不是写入方那边：读的一侧要靠它把编号翻回可读的名字
 * （合批的调试对象名就是这么拼的），两边必须是同一份。
 *
 * 只有这两个态：`ActorResidencyComponent.setState` 只认 `active` 与 `sleeping`。
 * dormant 不在这里——它表示这个 Actor **已经离开 ActorWorld**，也就不会有实例记录。
 */
export const PROP_RESIDENCY_STATES = ['active', 'sleeping'] as const;

export function residencyCode(state: string | undefined): number {
  const index = PROP_RESIDENCY_STATES.indexOf(
    state as typeof PROP_RESIDENCY_STATES[number],
  );
  return index < 0 ? 0 : index;
}

export function residencyName(code: number): string {
  return PROP_RESIDENCY_STATES[code] ?? PROP_RESIDENCY_STATES[0];
}

/**
 * `PROP_ARCHETYPE` 指向的那张表。
 *
 * 玩法侧写下标，渲染侧按下标反查 render 定义——两侧必须是同一份顺序。
 * 与其把这张表每帧塞进通道（它一整局都不变），不如**两侧各自从同一份场景定义建**：
 * 输入是同一段 JSON，`Map` 的插入序是确定的，于是结果必然一致。
 * 和地形「两侧各按同一个种子推」是同一个套路。
 *
 * 定义放在通道这一层而不是任何一侧，就是为了让「同一份顺序」只有一处实现。
 */
export interface ArchetypeTable {
  readonly byId: ReadonlyMap<string, ActorArchetypeDefinition>;
  readonly order: readonly string[];
}

/** 没有合批内容的渲染世界（固定地图、绝大多数用例）用的空表。 */
export const EMPTY_ARCHETYPE_TABLE: ArchetypeTable = { byId: new Map(), order: [] };

export function createArchetypeTable(definition: SceneDefinition): ArchetypeTable {
  const byId = new Map(
    definition.actorArchetypes.map((archetype) => [archetype.id, archetype]),
  );
  return { byId, order: [...byId.keys()] };
}
