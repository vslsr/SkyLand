/**
 * chunk 静态碰撞体。
 *
 * 流式世界的树和石头一个字节都不走网络：它们是 (worldSeed, chunkX, chunkZ)
 * 的确定性输出。碰撞体同样如此——这里只是把已有的放置记录翻译成简易碰撞盒，
 * 不引入任何新的随机性，所以浏览器预测与房间 DS 得到的是同一批盒子，
 * 客户端预测不会因为「服务端不知道这里有棵树」而被反复拉回。
 *
 * 形状取自 src/models/ 里的线稿模型，一处改了这里要跟着改：
 * - 树：`createTreeModel` 的树干是 r≈0.17、高 1.3 的圆柱，四层锥形树冠堆到 y≈3.98，
 *   最宽一层半径 1.35。
 * - 岩石：`createRockModel` 是半径 0.42 的二十面体缩放 (1.15, 0.62, 0.94) 后上移 0.2。
 *
 * 树干挡走路，树冠只挡镜头。理由和弹性蘑菇一样：宽大的顶部如果参与推出，
 * 每棵树周围都会多出一圈两米多的隐形墙，4 米放置格的世界会变得寸步难行；
 * 但镜头必须被树冠挡住，否则第三人称相机会从枝叶中间穿过去。
 */

import { COLLISION_LAYER, COLLISION_LAYER_SOLID } from '../collision/collisionLayers.mjs';
import {
  PROP_BUFFER_LENGTH,
  PROP_FIELD,
  PROP_STRIDE,
  generateChunkProps,
} from './chunkContent.mjs';
import { PROP_KIND } from './worldConfig.mjs';
import { formatGeneratedPropId, isPropSkipped } from './generatedProp.mjs';

/**
 * 每种物件的碰撞模板，单位缩放下的尺寸。放置记录里的 scale 会等比乘上去。
 * 草没有模板：一片能推开玩家的草地既不合理，也会让碰撞体数量翻好几倍。
 * @type {Record<number, ReadonlyArray<{ halfWidth: number, halfLength: number, minimumY: number, maximumY: number, layers: number }>>}
 */
export const PROP_COLLIDER_TEMPLATES = {
  [PROP_KIND.TREE]: [
    // 树干：走路和镜头都挡。比模型底部半径 0.17 略放大，避免贴着树皮抖动。
    { halfWidth: 0.22, halfLength: 0.22, minimumY: 0, maximumY: 1.3, layers: COLLISION_LAYER_SOLID },
    // 树冠下半：最宽的两层锥体，只挡镜头。
    { halfWidth: 1.2, halfLength: 1.2, minimumY: 0.6, maximumY: 2.4, layers: COLLISION_LAYER.CAMERA },
    // 树冠上半：越往上越细，单独一个盒子比一个大盒子贴合得多。
    { halfWidth: 0.8, halfLength: 0.8, minimumY: 2.4, maximumY: 4, layers: COLLISION_LAYER.CAMERA },
  ],
  [PROP_KIND.ROCK]: [
    { halfWidth: 0.48, halfLength: 0.4, minimumY: 0, maximumY: 0.46, layers: COLLISION_LAYER_SOLID },
  ],
  [PROP_KIND.GRASS]: [],
  // 蘑菇由完整复制的 Actor 提供动态碰撞，不能再派生一份静态盒子。
  [PROP_KIND.MUSHROOM]: [],
};

/** 单个 chunk 最多能派生出多少个碰撞体。调用方据此判断内存上界。 */
export const MAXIMUM_COLLIDERS_PER_PROP = Object.values(PROP_COLLIDER_TEMPLATES)
  .reduce((maximum, templates) => Math.max(maximum, templates.length), 0);

/**
 * 把一批整数放置记录翻译成碰撞体实例。
 *
 * 结果的形状与 Actor 的简易碰撞完全一致（{ collision, transform }），
 * 因此推出与扫掠都走同一套窄相，不需要为静态物件另写一份。
 *
 * @param {Int32Array} props 放置记录缓冲区
 * @param {number} count 记录条数
 * @param {object[]} [target] 复用的输出数组
 * @param {{ skipMask?: import('./generatedProp.mjs').PropSkipMask, chunkX?: number, chunkZ?: number }} [options]
 * @returns {object[]}
 */
export function readChunkColliders(props, count, target = [], options = {}) {
  target.length = 0;
  for (let index = 0; index < count; index += 1) {
    if (isPropSkipped(index, options.skipMask)) continue;
    const offset = index * PROP_STRIDE;
    const kind = props[offset + PROP_FIELD.KIND];
    const templates = PROP_COLLIDER_TEMPLATES[kind];
    if (!templates || templates.length === 0) continue;
    const x = props[offset + PROP_FIELD.X_MM] / 1000;
    const y = props[offset + PROP_FIELD.Y_MM] / 1000;
    const z = props[offset + PROP_FIELD.Z_MM] / 1000;
    const yaw = props[offset + PROP_FIELD.ROTATION_MRAD] / 1000;
    const scale = props[offset + PROP_FIELD.SCALE_THOUSANDTHS] / 1000;
    // 同一个物件的几个盒子共用一份 transform：它们绑在同一个物件上，
    // 位置永远一致，也省下几个对象。
    const transform = { x, y, z, yaw };
    // 每个有碰撞体的物件都带上自描述 id：交互查询靠它从碰撞世界反查 Actor，
    // 成本随身边的密度走，而不是随世界里的物件总数走。哪些种类真的有 Actor
    // 由原型注册表决定，这里不需要知道。
    const actorId = Number.isInteger(options.chunkX) && Number.isInteger(options.chunkZ)
      ? formatGeneratedPropId(kind, options.chunkX, options.chunkZ, index)
      : undefined;
    for (const template of templates) {
      target.push({
        collision: {
          centerX: 0,
          centerZ: 0,
          halfWidth: template.halfWidth * scale,
          halfLength: template.halfLength * scale,
          minimumY: template.minimumY * scale,
          maximumY: template.maximumY * scale,
        },
        transform,
        layers: template.layers,
        ...(actorId ? { actorId } : {}),
      });
    }
  }
  return target;
}

/**
 * 直接由种子生成一个 chunk 的碰撞体。
 *
 * 客户端走 ChunkStreamer，那里已经有放置记录，用 readChunkColliders 就行；
 * 这个入口给房间 DS 用——它不建几何体，只需要碰撞。
 *
 * @param {number} worldSeed
 * @param {number} chunkX
 * @param {number} chunkZ
 * @param {Int32Array} [buffer] 复用的放置缓冲区
 * @param {import('./generatedProp.mjs').PropSkipMask} [skipMask]
 * @returns {object[]}
 */
export function buildChunkColliders(worldSeed, chunkX, chunkZ, buffer, skipMask) {
  const props = buffer ?? new Int32Array(PROP_BUFFER_LENGTH);
  const count = generateChunkProps(worldSeed, chunkX, chunkZ, props);
  return readChunkColliders(props, count, [], { skipMask, chunkX, chunkZ });
}
