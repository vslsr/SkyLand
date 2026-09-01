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

/** 玩家预测与权威模拟唯一允许使用的固定步长。 */
export const SIMULATION_STEP_SECONDS = 1 / 60;

/** 单个渲染帧最多补跑的固定步数，避免切回后台标签时阻塞主线程。 */
export const MAXIMUM_SIMULATION_CATCH_UP_STEPS = 5;

/** 单个输入包最多接受的固定步数（100ms）。 */
export const MAXIMUM_INPUT_STEPS_PER_PACKET = 6;

/** 每名玩家的模拟时间预算上限（秒），用来吸收网络抖动的突发。 */
export const INPUT_TIME_BUDGET_SECONDS = 0.25;

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

/** 本地预测与服务器权威位置的容差（米），小于它就不纠正。 */
export const RECONCILE_TOLERANCE = 0.06;

/** 超过这个误差（米）直接瞬移到服务器位置，不再平滑。 */
export const RECONCILE_SNAP_DISTANCE = 2.5;

/** 平滑纠正的收敛速率，值越大拉回越快。 */
export const RECONCILE_RATE = 9;

/** WebSocket 心跳间隔（毫秒），用来清理半开连接。 */
export const SOCKET_HEARTBEAT_MS = 30_000;
