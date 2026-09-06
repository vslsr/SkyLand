import * as THREE from 'three';

/**
 * 石子砸在地上炸开的那一小团烟尘。
 *
 * 它是**一次性事件**，不是每帧状态：撞上那一刻发一次，之后半秒钟怎么散全在这一侧
 * 积分——和飘字、和倒下那段动画同一个取向。
 *
 * 画法跟着这张图的线稿走：不是一团半透明的雾，而是**几个描边的小圈**往外飘、
 * 一边变淡一边变大。雾在纸面色的地上什么都看不见，而一圈墨线看得见。
 *
 * **数量有上界**：一池固定 `POOL_SIZE` 团循环复用，池满时顶掉最老的那一团。这条
 * 上界和世界大小无关，同屏打得再密也不会多建一段几何。
 */

/** 池子有多大。同屏同时散着的烟尘超过它就顶掉最老的一团。 */
const POOL_SIZE = 8;
/** 一团烟尘里有几个圈。太少不成团，太多在这个尺寸上糊成一片。 */
const RING_COUNT = 5;
/** 一团活多久，秒。 */
const PUFF_SECONDS = 0.45;
/** 圈从多大长到多大，米。 */
const RING_START_RADIUS = 0.03;
const RING_END_RADIUS = 0.17;
/** 整团往外摊开多远，米。 */
const SPREAD = 0.16;
/** 整团往上飘多高，米。 */
const RISE = 0.12;

const DUST_COLOR = 0x6f665a;

interface DustPuffSlot {
  readonly group: THREE.Group;
  readonly rings: readonly THREE.LineLoop[];
  /** 每个圈往哪个方向摊、摊多远。出生时抽一次，之后不变。 */
  readonly offsets: readonly THREE.Vector3[];
  elapsedSeconds: number;
  active: boolean;
  /** 复用顺序用的序号，越小越老。 */
  sequence: number;
}

/** 一个单位圆的线圈几何。所有圈共用它，大小靠 scale。 */
function createRingGeometry(): THREE.BufferGeometry {
  const segments = 10;
  const points = new Float32Array((segments + 1) * 3);
  for (let index = 0; index <= segments; index += 1) {
    const angle = (index / segments) * Math.PI * 2;
    points[index * 3] = Math.cos(angle);
    points[index * 3 + 1] = 0;
    points[index * 3 + 2] = Math.sin(angle);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(points, 3));
  return geometry;
}

export class ThreeDustPuffVisual {
  public readonly root = new THREE.Group();
  private readonly slots: DustPuffSlot[] = [];
  private readonly geometry = createRingGeometry();
  private nextSequence = 1;

  public constructor() {
    this.root.name = 'dust-puffs';
  }

  /** 在这一点炸开一团。 */
  public spawn(x: number, y: number, z: number): void {
    const slot = this.acquire();
    slot.group.position.set(x, y, z);
    slot.elapsedSeconds = 0;
    slot.active = true;
    slot.sequence = this.nextSequence += 1;
    slot.group.visible = true;
    this.place(slot);
  }

  public update(deltaSeconds: number): void {
    for (const slot of this.slots) {
      if (!slot.active) continue;
      slot.elapsedSeconds += deltaSeconds;
      if (slot.elapsedSeconds >= PUFF_SECONDS) {
        slot.active = false;
        slot.group.visible = false;
        continue;
      }
      this.place(slot);
    }
  }

  /** 这一刻这团散到哪一步：往外摊、往上飘、越来越大、越来越淡。 */
  private place(slot: DustPuffSlot): void {
    const t = Math.min(1, slot.elapsedSeconds / PUFF_SECONDS);
    // 前快后慢：砸出来的尘先窜开，再慢慢停住。
    const eased = 1 - (1 - t) * (1 - t);
    const radius = RING_START_RADIUS + (RING_END_RADIUS - RING_START_RADIUS) * eased;
    for (const [index, ring] of slot.rings.entries()) {
      const offset = slot.offsets[index];
      ring.position.set(offset.x * eased, offset.y * eased, offset.z * eased);
      ring.scale.setScalar(radius);
      const material = ring.material as THREE.LineBasicMaterial;
      // 最后那一段淡出去。一开始就淡的话，砸下去那一下反而看不见。
      material.opacity = 0.75 * (1 - Math.max(0, (t - 0.35) / 0.65));
    }
  }

  /** 拿一团空闲的；一团都没有就顶掉最老的那一团。 */
  private acquire(): DustPuffSlot {
    const idle = this.slots.find((slot) => !slot.active);
    if (idle) return idle;
    if (this.slots.length < POOL_SIZE) {
      const group = new THREE.Group();
      const rings: THREE.LineLoop[] = [];
      const offsets: THREE.Vector3[] = [];
      for (let index = 0; index < RING_COUNT; index += 1) {
        const ring = new THREE.LineLoop(this.geometry, new THREE.LineBasicMaterial({
          color: DUST_COLOR,
          transparent: true,
          opacity: 0.75,
          fog: false,
        }));
        ring.frustumCulled = false;
        rings.push(ring);
        group.add(ring);
        // 方向摊匀一点，再各自错开一点高度：完全对称的一圈看上去像一个图标。
        const angle = (index / RING_COUNT) * Math.PI * 2 + index * 0.37;
        offsets.push(new THREE.Vector3(
          Math.cos(angle) * SPREAD,
          RISE * (0.35 + (index % 3) * 0.32),
          Math.sin(angle) * SPREAD,
        ));
      }
      group.visible = false;
      this.root.add(group);
      const slot: DustPuffSlot = {
        group, rings, offsets, elapsedSeconds: 0, active: false, sequence: 0,
      };
      this.slots.push(slot);
      return slot;
    }
    return this.slots.reduce((oldest, slot) => (slot.sequence < oldest.sequence ? slot : oldest));
  }

  public dispose(): void {
    for (const slot of this.slots) {
      for (const ring of slot.rings) (ring.material as THREE.Material).dispose();
    }
    this.geometry.dispose();
    this.slots.length = 0;
    this.root.parent?.remove(this.root);
  }
}
