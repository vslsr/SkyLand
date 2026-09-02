/**
 * 跨边界的定长表现参数（引擎迁移路线图 第 1.5 步）。
 *
 * transform 之外，渲染世界还需要一些**玩法决定、渲染兑现**的标量：火焰强度、
 * 温度、权威 yaw……它们和 transform 一样是「每个 proxy 一个定长结构」，所以
 * 走同一段字节、同一次 publish。
 *
 * **为什么不另开一个 buffer**：参数必须与 transform 帧一致。两个缓冲各自
 * publish 会撕裂——火焰强度来自第 N 帧、位置来自第 N+1 帧。同一段字节、
 * 一次翻面，这个问题就不存在。
 *
 * **为什么是具名下标而不是通用属性包**：§4.5 的取向——新增一种参数要在这里
 * 加一个具名常量并把 COUNT 加一，而不是往一张可变长表里塞 key。
 *
 * **为什么不量化**：火焰强度那对阈值（吸附 0.002、可见 0.01）是一对，
 * 塞进 u8 或 f16 会让 intensity 永远吸不到 0，火焰关不掉。f32 就留着。
 */

/** 火焰的目标强度。0 或 1，由快照 thermal.burning 或静态热源配置决定。 */
export const PARAM_FIRE_TARGET_INTENSITY = 0;

/** 权威温度。只有带温度牌的 proxy 会用到，其余槽位每帧写 0。 */
export const PARAM_TEMPERATURE = 1;

/** 每个 proxy 槽位的参数个数。新增参数就在上面加常量并把这里加一。 */
export const RENDER_VISUAL_PARAM_COUNT = 2;
