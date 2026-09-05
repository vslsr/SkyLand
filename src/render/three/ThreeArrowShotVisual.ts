import * as THREE from 'three';
import type { FillMaterialEnvironment } from '../../materials/createFillMaterial';
import { createArrowModel } from '../../models/arrow';
import { ballisticArcPoint, type BallisticArc } from '../ballisticArc';

/**
 * 射出去的那些箭，住在渲染世界里（设计稿 `@w 木弓` 的 `A`）。
 *
 * **弹道在松手那一刻就算完了**：判定也是那一刻结算的（落点半径内全中，见
 * `WeaponRuntime`），所以这支箭没有任何需要每帧再决定的事——它只是把那条已经定
 * 下来的弧在半秒里走完。因此它不是 Actor、不过网、不参与碰撞：给它一套飞行物理，
 * 等于让表现有机会飞到和判定不一样的地方去。
 *
 * 走的弧和蓄力时那条白线是同一条（`ballisticArcPoint`）：玩家瞄的就是这一条。
 *
 * **数量有上界**：一池固定 `POOL_SIZE` 支箭循环复用，池满时顶掉最老的那一支——
 * 和飘字同一个取向（`ThreeHealthPopupVisual`）。这条上界和世界大小无关。
 */

/** 池子有多大。同屏同时飞着的箭超过它就顶掉最老的一支。 */
const POOL_SIZE = 8;
/** 箭的飞行速度，米每秒。射程越远飞得越久，速度是同一个。 */
const ARROW_SPEED = 34;
/** 再快的一箭也要看得见：飞行时间的下限，秒。 */
const MINIMUM_FLIGHT_SECONDS = 0.12;
/** 落地之后再留多久才收走，秒。让眼睛跟得上「插在那儿了」。 */
const LINGER_SECONDS = 0.45;

const SHAFT_COLOR = '#c8a06a';
const HEAD_COLOR = '#7a6a58';
const INK_COLOR = '#2f2419';

interface ArrowSlot {
  readonly object: THREE.Group;
  /** 这一支走的弧。射出去那一刻就定下来，飞行途中不再变。 */
  arc: BallisticArc;
  flightSeconds: number;
  elapsedSeconds: number;
  active: boolean;
  /** 复用顺序用的序号，越小越老。 */
  sequence: number;
}

export class ThreeArrowShotVisual {
  public readonly root = new THREE.Group();
  private readonly slots: ArrowSlot[] = [];
  private nextSequence = 1;
  private readonly point = { x: 0, y: 0, z: 0 };
  private readonly lookAhead = { x: 0, y: 0, z: 0 };
  private readonly target = new THREE.Vector3();

  public constructor(private readonly environment: FillMaterialEnvironment) {
    this.root.name = 'arrow-shots';
  }

  /** 射一支箭。弧已经算好了，这里只是把它交给一支箭去走完。 */
  public spawn(arc: BallisticArc): void {
    const slot = this.acquire();
    slot.arc = arc;
    const distance = Math.hypot(arc.impactX - arc.originX, arc.impactZ - arc.originZ);
    slot.flightSeconds = Math.max(MINIMUM_FLIGHT_SECONDS, distance / ARROW_SPEED);
    slot.elapsedSeconds = 0;
    slot.active = true;
    slot.sequence = this.nextSequence += 1;
    slot.object.visible = true;
    this.place(slot);
  }

  public update(deltaSeconds: number): void {
    for (const slot of this.slots) {
      if (!slot.active) continue;
      slot.elapsedSeconds += deltaSeconds;
      if (slot.elapsedSeconds >= slot.flightSeconds + LINGER_SECONDS) {
        slot.active = false;
        slot.object.visible = false;
        continue;
      }
      this.place(slot);
    }
  }

  /**
   * 把一支箭摆到它这一刻该在的地方。
   *
   * 朝向用「弧上再往前一点」那个点：箭尖跟着切线走，起手时仰着、落地时扎下去，
   * 不需要另外解一次速度。落地之后停在最后一帧的姿态上插着。
   */
  private place(slot: ArrowSlot): void {
    const t = Math.min(1, slot.elapsedSeconds / slot.flightSeconds);
    ballisticArcPoint(slot.arc, t, this.point);
    slot.object.position.set(this.point.x, this.point.y, this.point.z);
    // 已经到落点的那一帧没有「再往前」，就回头看上一小段，姿态才不会跳。
    const ahead = t >= 1 ? -0.02 : Math.min(0.02, 1 - t);
    ballisticArcPoint(slot.arc, t + ahead, this.lookAhead);
    this.target.set(
      this.point.x + (this.lookAhead.x - this.point.x) * Math.sign(ahead),
      this.point.y + (this.lookAhead.y - this.point.y) * Math.sign(ahead),
      this.point.z + (this.lookAhead.z - this.point.z) * Math.sign(ahead),
    );
    slot.object.lookAt(this.target);
  }

  /** 拿一支空闲的箭；一支都没有就顶掉最老的那一支。 */
  private acquire(): ArrowSlot {
    const idle = this.slots.find((slot) => !slot.active);
    if (idle) return idle;
    if (this.slots.length < POOL_SIZE) {
      const object = createArrowModel(this.environment, {
        shaft: SHAFT_COLOR,
        head: HEAD_COLOR,
        ink: INK_COLOR,
      });
      object.visible = false;
      this.root.add(object);
      const slot: ArrowSlot = {
        object,
        arc: { originX: 0, originY: 0, originZ: 0, impactX: 0, impactY: 0, impactZ: 0, ratio: 0 },
        flightSeconds: MINIMUM_FLIGHT_SECONDS,
        elapsedSeconds: 0,
        active: false,
        sequence: 0,
      };
      this.slots.push(slot);
      return slot;
    }
    return this.slots.reduce((oldest, slot) => (slot.sequence < oldest.sequence ? slot : oldest));
  }

  public dispose(): void {
    for (const slot of this.slots) {
      slot.object.traverse((child) => {
        const mesh = child as Partial<THREE.Mesh>;
        mesh.geometry?.dispose();
      });
    }
    this.slots.length = 0;
    this.root.parent?.remove(this.root);
  }
}
