/**
 * 同步节奏与容差常量。
 *
 * 上行频率、快照频率、插值延迟和防作弊阈值必须在前后端保持一致，
 * 所以统一放在这里，由浏览器与房间进程共同引用。
 */

/** 房间进程的模拟频率（Hz）。 */
export const SERVER_TICK_RATE = 20;

/** 房间进程的快照广播频率（Hz）。 */
export const SNAPSHOT_RATE = 10;

/** 每广播一次快照要经过的 tick 数。 */
export const TICKS_PER_SNAPSHOT = Math.max(1, Math.round(SERVER_TICK_RATE / SNAPSHOT_RATE));

/** 客户端上行输入的最小间隔（秒），与渲染帧率解耦。 */
export const INPUT_SEND_INTERVAL_SECONDS = 0.05;

/**
 * 拖拽形变的上行间隔（秒）。它只被服务端转发，不参与重放，而快照本来就只有
 * SNAPSHOT_RATE 次每秒，报得更密只会白占同一个输入令牌桶。
 */
export const SLIME_DRAG_SEND_INTERVAL_SECONDS = 1 / SNAPSHOT_RATE;

/** 玩家预测与权威模拟唯一允许使用的固定步长。 */
export const SIMULATION_STEP_SECONDS = 1 / 60;

/** 单个渲染帧最多补跑的固定步数，避免切回后台标签时阻塞主线程。 */
export const MAXIMUM_SIMULATION_CATCH_UP_STEPS = 5;

/** 单个输入包最多接受的固定步数（100ms）。 */
export const MAXIMUM_INPUT_STEPS_PER_PACKET = 6;

/** 每名玩家的模拟时间预算上限（秒），用来吸收网络抖动的突发。 */
export const INPUT_TIME_BUDGET_SECONDS = 0.25;

/**
 * 预算补充速率相对真实时间的倍率。
 *
 * 客户端每真实秒稳定产出 1 / SIMULATION_STEP_SECONDS 个固定步。补充速率如果正好
 * 等于产出速率，一次卡顿堆起来的积压就永远排不掉：服务端排一步、客户端又生一步，
 * 权威状态会一直落后那一段，直到客户端的未确认队列到顶开始丢最旧的输入。留出
 * 一点追赶余量，积压才会在几秒内自然收敛；上限仍由 INPUT_TIME_BUDGET_SECONDS 封住，
 * 所以这不会给作弊客户端额外的加速空间。
 */
export const INPUT_STEP_BUDGET_CATCH_UP_RATE = 1.2;

/** 客户端未确认输入队列上限；超过时只保留最新步并等待权威快照兜底。 */
export const MAXIMUM_PENDING_INPUT_STEPS = 120;

/** 单个连接每秒允许的输入消息数，以及可以透支的突发条数。 */
export const MAXIMUM_INPUT_MESSAGES_PER_SECOND = 40;
export const INPUT_MESSAGE_BURST = 20;

/** 超过这个时间没有收到输入就认为玩家停止移动（毫秒）。 */
export const MOVEMENT_IDLE_TIMEOUT_MS = 300;

/** 渲染远端玩家时回退的时间（毫秒），用来在两份快照之间插值。 */
export const INTERPOLATION_DELAY_MS = 120;

/** 客户端保留的快照条数。 */
export const SNAPSHOT_BUFFER_SIZE = 24;

/** 本地预测与服务器权威位置的容差（米），小于它不做可见纠正。 */
export const RECONCILE_TOLERANCE = 0.06;

/**
 * 容差之内每份快照朝权威收敛的比例。
 *
 * 这个值不能是 0。容差分支原来把重放结果整个丢掉、原样保留预测位置，于是误差
 * **永远不收敛**：实测站着不动时两端位置差恒定在 4.9cm 纹丝不动，残差就卡在
 * 6cm 门槛下面攒着，一旦越界就由 corrected 分支一次性拉回 6.5–15.6cm——一秒
 * 一次，正是「走着走着被拉回」的手感。
 *
 * 改成每拍收敛四分之一：8.3Hz 的快照率下误差约 0.4 秒衰减到 1/e，5cm 的误差
 * 每拍只吃掉 1.25cm，而且这一点点还会进渲染偏移被平滑掉，看不出来。原注释担心
 * 的「毫米量化快照反复改写位置」也仍然成立——量化误差是毫米级，按比例吃掉
 * 之后每拍不到 0.3 毫米，且同样是收敛的。
 */
export const RECONCILE_CONVERGENCE = 0.25;

/** 超过这个误差（米）直接瞬移到服务器位置，不再平滑。 */
export const RECONCILE_SNAP_DISTANCE = 2.5;

/** 平滑纠正的收敛速率，值越大拉回越快。 */
export const RECONCILE_RATE = 9;

/** WebSocket 心跳间隔（毫秒），用来清理半开连接。 */
export const SOCKET_HEARTBEAT_MS = 30_000;
