/**
 * 拉开与撒手那一下的形变曲线（设计稿 `@i 木弓` / `@i 弹弓` 的 `A`：蓄力 / 发射）。
 *
 * **弓拉弦、弹弓拉皮筋，走的是同一条曲线**：玩法侧给的是同一个量（物品栏那圈倒计时
 * 的比例），撒手之后回弹的形状也是同一个。差别只有「拉多开」这一个数，所以它是参数
 * 而不是第二份曲线——各写一套的话，改回弹手感要改两处，而漏掉一处不会有人发现。
 * 弓臂那一段是弓自己的（皮筋没有臂），所以它单独留在下面。
 *
 * 和倒下那段动画（`RenderDeathCollapse.ts`）同一个取向：**玩法侧给一个量，表现
 * 自己走完**。蓄力那一段给的是比例（和物品栏那圈倒计时同一个 ratio），撒手那一下
 * 给的是一个自增的 revision——一次性事件靠计数变化触发，不靠一个 bool，因为连着
 * 两箭之间那个 bool 有可能在同一帧里立起来又倒下去。
 *
 * 曲线本身是纯函数，不认识 three、也不认识 proxy：它只把「拉了几成、撒手过了
 * 多久」翻成两个数。
 */

/** 拉满时上下弓梢各向后转多少（弧度，16°）。 */
export const BOW_LIMB_BEND_RADIANS = (16 * Math.PI) / 180;
/** 弓拉满时弦中点后移多少米。 */
export const BOW_STRING_PULL = 0.18;
/** 弹弓拉满时皮筋中点后移多少米。比弓弦短：那是一条橡皮筋，不是一米长的弓弦。 */
export const SLING_BAND_PULL = 0.13;
/** 撒手那一下多长，秒。 */
export const BOW_RELEASE_SECONDS = 0.12;
/** 弦回到 0 之后往前过冲多少米。 */
const RELEASE_OVERSHOOT = 0.03;
/** 过冲的阻尼。越大收得越快。 */
const RELEASE_DAMPING = 12;
/** 撒手那一下抖几个来回。 */
const RELEASE_WOBBLES = 2;
/**
 * 弦在这一下的前几分之几里归零。
 *
 * 归零和抖动是两件事，所以分开写：把它们揉成一条衰减曲线的话，归零那一段会把
 * 过冲吃掉——弦看上去只是慢慢松回去，没有那一记回弹。
 */
const RELEASE_RETURN_RATIO = 0.3;
/** 弓梢在撒手的前几分之几里回正。 */
const LIMB_RECOVER_RATIO = 1 / 3;

/** 拉了几成时弓梢向后转多少。 */
export function bowLimbBend(charge: number): number {
  return clamp01(charge) * BOW_LIMB_BEND_RADIANS;
}

/**
 * 拉了几成时，弦 / 皮筋的中点后移多少米。
 *
 * @param maxPull 拉满时后移多少。弓和弹弓的差别就只有这一个数。
 */
export function weaponDrawPull(charge: number, maxPull: number): number {
  return clamp01(charge) * maxPull;
}

/**
 * 撒手之后第 `elapsedSeconds` 秒，弦 / 皮筋的中点还在哪儿。
 *
 * 从撒手那一刻的后移量连续地接上去（t=0 时正是它），一边归零一边过冲，按阻尼
 * 抖两个来回收住。中间不重新开始，所以连发时后一箭接的是前一箭抖到一半的弦。
 */
export function weaponReleasePull(startPull: number, elapsedSeconds: number): number {
  const u = clamp01(elapsedSeconds / BOW_RELEASE_SECONDS);
  // 先松回去（前 30%），再按阻尼抖两个来回收住。
  const snapBack = startPull * Math.max(0, 1 - u / RELEASE_RETURN_RATIO);
  const wobble = -RELEASE_OVERSHOOT
    * Math.sin(Math.PI * 2 * RELEASE_WOBBLES * u)
    * Math.exp(-RELEASE_DAMPING * elapsedSeconds);
  return snapBack + wobble;
}

/**
 * 撒手之后第 `elapsedSeconds` 秒，弓梢还向后转着多少。
 *
 * 弓梢比弦收得早（前 1/3 就回正了）：木头本来就比一根弦硬，两者同时抖会让整把弓
 * 看上去是软的。
 */
export function bowReleaseLimbBend(startBend: number, elapsedSeconds: number): number {
  const u = elapsedSeconds / BOW_RELEASE_SECONDS;
  return startBend * Math.max(0, 1 - u / LIMB_RECOVER_RATIO);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
