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

/**
 * 史莱姆软体表现的运动输入（第 1.5 步）。
 *
 * **权威 yaw 不在这里。** 渲染侧要抵消的是「root 这一级实际被转了多少」，
 * 而那个角度正是 `submitTransforms` 刚写进 `proxy.root.rotation.y` 的值——
 * 在渲染世界内部读它是 Render→Render，不需要再过一次边界。
 */
export const PARAM_SLIME_SPEED = 2;
export const PARAM_SLIME_VELOCITY_X = 3;
export const PARAM_SLIME_VELOCITY_Z = 4;
export const PARAM_SLIME_VERTICAL_VELOCITY = 5;

/**
 * 离地标记：**0 表示贴地**。
 *
 * 取反不是随手写的：「没有这项表现的槽位每帧写 0」是参数段的通用规则，
 * 而软体求解器的默认态是 grounded=true。存 `grounded` 的话，0 就成了「浮空」，
 * 所有不驱动这项参数的史莱姆都会被当成在空中。
 */
export const PARAM_SLIME_AIRBORNE = 6;

/** 被环境圆柱挡住的位移，只在新接触那一帧非零；渲染侧自己做接触去抖。 */
export const PARAM_SLIME_COLLISION_DISPLACEMENT_X = 7;
export const PARAM_SLIME_COLLISION_DISPLACEMENT_Z = 8;

/**
 * 船体波动的静态偏置（第 1.75 步）。波面高度由渲染侧自己采样——浪的公式是渲染
 * 配置，不是玩法状态；过边界的只有吃水深度和装载造成的静态倾斜。
 */
export const PARAM_BUOYANCY_DRAFT = 9;
export const PARAM_BUOYANCY_STATIC_PITCH = 10;
export const PARAM_BUOYANCY_STATIC_ROLL = 11;

/**
 * 弹性拉伸（第 1.75 步）。弹簧积分、拉伸比例与摆动全在渲染侧，
 * 玩法侧只给「被谁拉到哪儿」和两个状态位。
 */
export const PARAM_ELASTIC_DETACHED = 12;
/** 有人叼着（`holderPlayerId !== null`）。渲染侧只需要知道刚度取哪一档。 */
export const PARAM_ELASTIC_HELD = 13;
export const PARAM_ELASTIC_TARGET_X = 14;
export const PARAM_ELASTIC_TARGET_Y = 15;
export const PARAM_ELASTIC_TARGET_Z = 16;
export const PARAM_ELASTIC_DETACH_LENGTH = 17;
/**
 * 松手计数。渲染侧只比较「和上一帧一样吗」，不做算术，所以 f32 够用——
 * 一次会话里它到不了 f32 整数精度的边界（2^24）。
 */
export const PARAM_ELASTIC_RELEASE_REVISION = 18;

/**
 * 脱落物件的刚体姿态（第 1.75 步）。四元数按 0 写入不是单位四元数，
 * 但渲染侧只在 `detached` 且 `radius > 0` 时才应用它，所以静止槽位的零值到不了。
 */
export const PARAM_DROP_RADIUS = 19;
export const PARAM_DROP_ROTATION_X = 20;
export const PARAM_DROP_ROTATION_Y = 21;
export const PARAM_DROP_ROTATION_Z = 22;
export const PARAM_DROP_ROTATION_W = 23;

/**
 * 从快照复制过来的拖拽形变（见 `RenderSlimeDrag.ts`）。本地玩家的拖拽不走这里：
 * 指针、相机和外壳都在渲染侧，那条路径整个在渲染世界内部。
 *
 * **revision 为 0 表示没有拖拽。** 和 AIRBORNE 同一个道理：「不驱动这项表现的
 * 槽位每帧写 0」是参数段的通用规则，所以静止值必须是 0，而服务端的抓取计数从 1 起。
 */
export const PARAM_SLIME_DRAG_REVISION = 24;
export const PARAM_SLIME_DRAG_CONTACT_X = 25;
export const PARAM_SLIME_DRAG_CONTACT_Y = 26;
export const PARAM_SLIME_DRAG_CONTACT_Z = 27;
export const PARAM_SLIME_DRAG_PULL_X = 28;
export const PARAM_SLIME_DRAG_PULL_Y = 29;
export const PARAM_SLIME_DRAG_PULL_Z = 30;

/** 每个 proxy 槽位的参数个数。新增参数就在上面加常量并把这里加一。 */
export const RENDER_VISUAL_PARAM_COUNT = 31;
