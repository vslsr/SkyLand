import type { SnapshotHealth } from '../network/protocol';
import type { ActorRenderDefinition } from '../scenes/data/SceneDefinition';

/**
 * 血量变了就放一条飘字。
 *
 * **判据是计数而不是数值差**：`eventRevision` 每变一次就是服务端结算过的一次
 * 伤害或治疗，`lastDelta` 是那一次的量。拿两帧血量相减的话，一次 30 点会被 10Hz
 * 快照摊成好几条小数字，掉线重连补上的那一大段还会凭空冒出一条巨额飘字。
 *
 * **第一次看到某个实体不弹**：中途进房间、或者一具已经挨过打的 Replica 刚进
 * AOI，都不该把它过去的伤害补演一遍。只有「先记住它现在的计数、之后计数又变了」
 * 才是发生在眼前的一次。
 *
 * 表里每个实体一条记录，实体消失时由调用方 `forget`——所以它的大小是「视野里
 * 有几个带血的东西」，与世界面积无关。
 */
export interface HealthPopupSink {
  spawnHealthPopup(x: number, y: number, z: number, amount: number): void;
}

/** 飘字从模型的哪个高度起飞。比模型高一点，免得数字压在身体上。 */
export function healthPopupAnchorY(render?: ActorRenderDefinition): number {
  if (!render) return 1;
  const definition = render as { radius?: number; hipHeight?: number; height?: number };
  const radius = Number(definition.radius) || 0;
  const hip = Number(definition.hipHeight) || 0;
  const height = Number(definition.height) || 0;
  return Math.max(0.6, hip + radius * 1.6, height + radius, radius * 2.2);
}

export class HealthPopupEmitter {
  private readonly seen = new Map<string, number>();

  public constructor(private readonly sink: HealthPopupSink) {}

  /**
   * 记下这一帧某个实体的血量，需要的话放一条飘字。
   *
   * 坐标是**这一帧渲染出来的位置**，不是快照里的：飘字该从眼睛看到的那个身影
   * 头顶飞出来，而不是从它上一份快照的位置。
   */
  public observe(
    id: string,
    health: SnapshotHealth | undefined,
    x: number,
    y: number,
    z: number,
    anchorY: number,
  ): void {
    if (!health) return;
    const previous = this.seen.get(id);
    this.seen.set(id, health.eventRevision);
    if (previous === undefined || health.eventRevision === previous) return;
    if (!health.lastDelta) return;
    this.sink.spawnHealthPopup(x, y + anchorY, z, health.lastDelta);
  }

  public forget(id: string): void {
    this.seen.delete(id);
  }

  public clear(): void {
    this.seen.clear();
  }
}
