/**
 * 生物自然刷新的规则层。
 *
 * 照着 Minecraft 的自然刷新抄，抄的是**规则的形状**不是数值：
 *
 * | Minecraft | SkyLand |
 * | --- | --- |
 * | 史莱姆区块（种子的纯函数） | `isCreatureChunk`，同样是 (worldSeed, chunkX, chunkZ) 的纯函数 |
 * | mobcap × 已加载区块 / 289 | `creatureCap`，按**在场玩家数**缩放 |
 * | 玩家 24 格以内不刷 | `minimumDistance` |
 * | 128 格外立刻消失、32–128 格随机消失 | `despawnVerdict` 的硬消失与随机消失 |
 * | 成群刷新（一次 1–4 只） | `packSize` |
 * | 光照等级 ≤ 7 | 昼夜时钟的夜间窗口 `isNightWindow` |
 * | `SpawnPlacements`（脚下是实心块、头顶有空间） | 地形是平坦陆地、圆形足迹塞得下 |
 *
 * 上限跟着**玩家数**而不是已加载区块数走，这是与 Minecraft 唯一一处刻意的分歧：
 * SkyLand 的世界是 65 公里见方的，任何一个跟面积沾边的量都会立刻失控，而房间容量
 * 是写在场景里的硬上限。两种口径想说的其实是同一句话——「一个人身边最多有这么多
 * 只」——按人头算更直接，也更难写错。
 *
 * 这一层全是纯函数：不认识 Actor，不认识场景，因此每一条规则都能单独测。哪一条
 * 规则在什么时候被问，是 `server/scene/SceneCreatureSpawner.mjs` 的事。
 */

import { normalizeTimeOfDay } from '../dayNight.mjs';
import { toChunkCoordinate } from './chunkKey.mjs';
import { hash32 } from './hash.mjs';
import { TERRAIN_CELL_SIZE, TERRAIN_SHAPE, TERRAIN_SURFACE } from './terrainConfig.mjs';
import { terrainCellShape, terrainCellSurface } from './terrainContent.mjs';

/** 刷新区块判定用的盐。换了它就是换一张「哪儿出怪」的地图。 */
const CREATURE_CHUNK_SALT = 0x51a1_3e07;

/**
 * 这一片地出不出这种生物。
 *
 * Minecraft 的史莱姆区块：只有约十六分之一的区块会出史莱姆，而且这件事**由种子
 * 决定、永不改变**。它把「随机刷怪」变成了一件玩家可以记住、可以规划的事——那一片
 * 沼泽一直出史莱姆，另一片一直不出。这里原样保留，理由也一样：世界是种子的纯函数，
 * 出怪的地图也该是。
 *
 * `oneIn` 为 1 时每个区块都出（不需要这一层的生物照样能用同一条路径）。
 *
 * @param {number} worldSeed
 * @param {number} chunkX
 * @param {number} chunkZ
 * @param {number} oneIn 几分之一的区块出这种生物
 * @param {number} [salt] 同一张图上不同生物用不同的盐，各出各的地方
 */
export function isCreatureChunk(worldSeed, chunkX, chunkZ, oneIn, salt = 0) {
  const divisor = Math.max(1, Math.floor(oneIn));
  if (divisor === 1) return true;
  return hash32(worldSeed ^ CREATURE_CHUNK_SALT ^ (salt | 0), chunkX, chunkZ, divisor) % divisor === 0;
}

/**
 * 这一刻房间里最多能有多少只。
 *
 * 没有人在场时是 0，不是「按最低配额留几只」：没有人看的房间里刷怪是纯粹的浪费，
 * 而且它们会在下一个人进来之前把配额占满，让他进门就被围住。
 *
 * @param {number} playerCount
 * @param {number} capPerPlayer
 * @param {number} maximumPerRoom
 */
export function creatureCap(playerCount, capPerPlayer, maximumPerRoom) {
  if (playerCount <= 0) return 0;
  return Math.min(maximumPerRoom, Math.floor(playerCount * capPerPlayer));
}

/**
 * 现在算不算夜里。
 *
 * 夜间窗口跨午夜（比如 19 点到 5 点），所以不能写成一个简单的区间比较——那会让
 * 「夜里刷怪」在午夜那一刻停掉。
 *
 * @param {number} timeOfDay 0..24
 * @param {number} fromHour
 * @param {number} toHour
 */
export function isNightWindow(timeOfDay, fromHour, toHour) {
  const now = normalizeTimeOfDay(timeOfDay);
  const from = normalizeTimeOfDay(fromHour);
  const to = normalizeTimeOfDay(toHour);
  if (from === to) return true;
  return from < to ? now >= from && now < to : now >= from || now < to;
}

/**
 * 一次刷新出几只。
 *
 * Minecraft 一个刷新点会连着试着放下一小群，而不是一次一只。这不只是省调用：
 * 一只孤零零站在旷野上的怪看起来像是从地里长出来的，三只挨在一起看起来像是
 * 它们本来就在那儿。
 *
 * @param {number} roll 0..1
 */
export function packSize(roll, minimum, maximum) {
  const low = Math.max(1, Math.floor(minimum));
  const high = Math.max(low, Math.floor(maximum));
  return low + Math.floor(Math.max(0, Math.min(0.999999, roll)) * (high - low + 1));
}

/**
 * 在以某个玩家为中心的圆环里取一个候选点。
 *
 * 环而不是圆：内圈是「别在人脸上刷」（Minecraft 的 24 格），外圈是「刷了也得有人
 * 能遇上」。半径按面积均匀采样（开方），否则候选点会全部堆在内圈边上。
 *
 * @param {{ x: number, z: number }} center
 * @param {number} minimumDistance
 * @param {number} maximumDistance
 * @param {number} angleRoll 0..1
 * @param {number} radiusRoll 0..1
 * @param {{ x: number, z: number }} [out]
 */
export function sampleSpawnPoint(center, minimumDistance, maximumDistance, angleRoll, radiusRoll, out = { x: 0, z: 0 }) {
  const inner = Math.max(0, minimumDistance);
  const outer = Math.max(inner, maximumDistance);
  const angle = angleRoll * Math.PI * 2;
  const radius = Math.sqrt(inner * inner + radiusRoll * (outer * outer - inner * inner));
  out.x = center.x + Math.cos(angle) * radius;
  out.z = center.z + Math.sin(angle) * radius;
  return out;
}

/**
 * 一个格子够不够格当刷新点——只看**世界**，不看还剩多少配额。
 *
 * 三条，缺一不可：
 *
 * 1. **平坦的陆地**。水面上不刷（会游的生物是另一套判据，这一版没有），斜坡上
 *    也不刷——一只刷在坡上的生物第一帧就在往下滑，那看起来是掉出来的不是走出来的。
 * 2. **不在建筑块上**。玩家铺的地基不出怪。这是 Minecraft 用光照做到的事情——
 *    把屋子点亮，屋里就不出怪——这里换成一条更直接的规则：**你铺过的地不刷**。
 *    它给了建造一个防守上的理由，而不只是一个装饰。
 * 3. **塞得下**。圆形足迹用的是玩家移动那份推出：如果控制器会把它从这里推出去，
 *    就不该把它放进来。判据只有一份，所以不会出现「刷在树里」。
 *
 * @param {{
 *   cellCodeAt: (cellX: number, cellZ: number) => number,
 *   hasBuildPieceAt: (cellX: number, cellZ: number) => boolean,
 *   fits: (x: number, z: number, y: number) => boolean,
 *   groundHeightAt: (x: number, z: number) => number,
 *   withinBounds: (x: number, z: number) => boolean,
 * }} world
 * @param {number} x
 * @param {number} z
 * @param {{ cellX: number, cellZ: number, y: number }} [out]
 * @returns {boolean}
 */
export function canSpawnCreatureAt(world, x, z, out = { cellX: 0, cellZ: 0, y: 0 }) {
  if (!world.withinBounds(x, z)) return false;
  // 刷新点按地形格对齐：一格就是这个世界地面起伏的最小单位，判「平不平」只有
  // 在格上问才有意义。
  const cellX = Math.floor(x / TERRAIN_CELL_SIZE);
  const cellZ = Math.floor(z / TERRAIN_CELL_SIZE);
  out.cellX = cellX;
  out.cellZ = cellZ;
  const code = world.cellCodeAt(cellX, cellZ);
  if (terrainCellSurface(code) !== TERRAIN_SURFACE.GROUND) return false;
  if (terrainCellShape(code) !== TERRAIN_SHAPE.FLAT) return false;
  if (world.hasBuildPieceAt(cellX, cellZ)) return false;
  const y = world.groundHeightAt(x, z);
  if (!Number.isFinite(y)) return false;
  out.y = y;
  return world.fits(x, z, y);
}

export const DESPAWN_VERDICT = Object.freeze({
  KEEP: 0,
  /** 太远了，立刻收走。 */
  IMMEDIATE: 1,
  /** 有点远，掷一次骰子。 */
  RANDOM: 2,
});

/**
 * 这一只该不该消失。
 *
 * Minecraft 分两档：128 格外立刻消失，32–128 格每 tick 有极小概率消失。分两档
 * 的理由是**手感**：只有硬距离的话，玩家往回走一步怪就整批回来了；只有随机的话，
 * 走远之后世界里还留着一批永远遇不上的东西占着配额。
 *
 * 这里的两档是「刷新范围之外」（随机）和「刷新范围的一倍半之外」（立刻），
 * 所以场景只要写一个 `maximumDistance` 就够了，不必再调一对独立的消失距离——
 * 一个和刷新范围脱钩的消失距离几乎总是配错的那一个。
 *
 * 没有人在场时一律立刻消失：房间空了，世界里不该留着一群等在那儿的怪。
 *
 * @param {number} distanceToNearestPlayer 没有玩家时传 Infinity
 * @param {number} spawnRange 场景写的 maximumDistance
 * @param {number} roll 0..1
 * @param {number} randomChance 随机档每次判定的消失概率
 */
export function despawnVerdict(distanceToNearestPlayer, spawnRange, roll, randomChance) {
  if (!Number.isFinite(distanceToNearestPlayer)) return DESPAWN_VERDICT.IMMEDIATE;
  if (distanceToNearestPlayer > spawnRange * 1.5) return DESPAWN_VERDICT.IMMEDIATE;
  if (distanceToNearestPlayer > spawnRange) {
    return roll < randomChance ? DESPAWN_VERDICT.RANDOM : DESPAWN_VERDICT.KEEP;
  }
  return DESPAWN_VERDICT.KEEP;
}

/** 世界坐标落在哪个 chunk 上。刷新区块判定要用。 */
export function spawnChunkOf(x, z) {
  return { chunkX: toChunkCoordinate(x), chunkZ: toChunkCoordinate(z) };
}
