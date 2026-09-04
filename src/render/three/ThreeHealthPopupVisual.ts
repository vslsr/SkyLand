import * as THREE from 'three';
import { createDrawingSurface, type DrawingSurface } from '../../platform/index';
import { createSurfaceTexture } from '../../materials/surfaceTexture';

/**
 * 伤害与治疗的飘字，住在渲染世界里。
 *
 * 它是**一次性事件**，不是每帧状态：玩法侧只在血量变了的那一帧发一条
 * `spawnHealthPopup`，之后飘多高、什么时候淡掉全在这一侧积分——和倒下那段动画
 * 同一个取向（`RenderDeathCollapse.ts`）。
 *
 * **数量有上界**：一池固定 `POOL_SIZE` 块牌子循环复用，同屏伤害再密也不会多建
 * 一块几何或一张贴图。池满时顶掉最老的那一块——新的一下比正在淡出的那一下重要。
 * 这条上界和世界大小无关，所以流式世界里它也不会长。
 */

/** 池子有多大。同屏同时飘着的数字超过它就顶掉最老的一条。 */
const POOL_SIZE = 12;
/** 一条飘字活多久，秒。 */
const POPUP_SECONDS = 0.9;
/** 一条飘字往上飘多少米。 */
const POPUP_RISE = 0.85;
/** 最后这一段比例里淡出。 */
const POPUP_FADE_RATIO = 0.45;
/** 牌面尺寸，米。 */
const PLATE_WIDTH = 0.9;
const PLATE_HEIGHT = 0.45;
const TEXTURE_WIDTH = 256;
const TEXTURE_HEIGHT = 128;

const DAMAGE_COLOR = '#a53e2c';
const HEAL_COLOR = '#3f6658';

interface HealthPopupSlot {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  readonly surface?: DrawingSurface;
  readonly texture?: THREE.CanvasTexture;
  /** 出生时的世界坐标；每帧在它上面加飘起来的那一段。 */
  readonly origin: THREE.Vector3;
  /** 横向漂移方向，避免连续几下叠成一条竖线。 */
  driftX: number;
  driftZ: number;
  elapsedSeconds: number;
  active: boolean;
  /** 复用顺序用的序号，越小越老。 */
  sequence: number;
}

function formatAmount(amount: number): string {
  const rounded = Math.round(Math.abs(amount) * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return amount < 0 ? `-${text}` : `+${text}`;
}

export class ThreeHealthPopupVisual {
  public readonly root = new THREE.Group();
  private readonly slots: HealthPopupSlot[] = [];
  private readonly geometry = new THREE.PlaneGeometry(PLATE_WIDTH, PLATE_HEIGHT);
  private nextSequence = 1;
  private readonly cameraQuaternion = new THREE.Quaternion();

  public constructor() {
    this.root.name = 'health-popups';
    this.root.frustumCulled = false;
    for (let index = 0; index < POOL_SIZE; index += 1) {
      const surface = createDrawingSurface(TEXTURE_WIDTH, TEXTURE_HEIGHT);
      const texture = surface ? createSurfaceTexture(surface) : undefined;
      const material = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        fog: false,
        alphaTest: 0.01,
        side: THREE.DoubleSide,
      });
      if (texture) material.map = texture;
      const mesh = new THREE.Mesh(this.geometry, material);
      mesh.name = `health-popup-${index}`;
      mesh.renderOrder = 1020;
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.root.add(mesh);
      this.slots.push({
        mesh,
        surface,
        texture,
        origin: new THREE.Vector3(),
        driftX: 0,
        driftZ: 0,
        elapsedSeconds: 0,
        active: false,
        sequence: 0,
      });
    }
  }

  /**
   * 放一条飘字。`amount` 为负是伤害、为正是治疗，和快照里的 `lastDelta` 同号。
   *
   * 画不出文字的环境（拿不到离屏画布的测试机）也照常走：牌子还是会飘起来，
   * 只是没有字——和标记牌一样，一块贴图画不出来不该让整段表现消失。
   */
  public spawn(x: number, y: number, z: number, amount: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    if (!Number.isFinite(amount) || amount === 0) return;
    const slot = this.acquire();
    slot.origin.set(x, y, z);
    slot.elapsedSeconds = 0;
    slot.active = true;
    slot.sequence = this.nextSequence;
    this.nextSequence += 1;
    // 每一条按序号错开一点横向漂移：连着挨打时数字不会叠成一根柱子。
    const angle = slot.sequence * 2.399963229728653;
    slot.driftX = Math.cos(angle) * 0.18;
    slot.driftZ = Math.sin(angle) * 0.18;
    slot.mesh.visible = true;
    slot.mesh.material.opacity = 1;
    slot.mesh.position.copy(slot.origin);
    this.draw(slot, amount);
  }

  public update(deltaSeconds: number): void {
    const frameSeconds = Math.max(0, Math.min(Number(deltaSeconds) || 0, 0.1));
    for (const slot of this.slots) {
      if (!slot.active) continue;
      slot.elapsedSeconds += frameSeconds;
      const ratio = slot.elapsedSeconds / POPUP_SECONDS;
      if (ratio >= 1) {
        slot.active = false;
        slot.mesh.visible = false;
        continue;
      }
      // 起手快、收尾慢：数字弹出来之后自己浮住，而不是匀速上升。
      const rise = 1 - (1 - ratio) * (1 - ratio);
      slot.mesh.position.set(
        slot.origin.x + slot.driftX * ratio,
        slot.origin.y + POPUP_RISE * rise,
        slot.origin.z + slot.driftZ * ratio,
      );
      const fade = ratio < 1 - POPUP_FADE_RATIO
        ? 1
        : 1 - (ratio - (1 - POPUP_FADE_RATIO)) / POPUP_FADE_RATIO;
      slot.mesh.material.opacity = Math.max(0, fade);
    }
  }

  /** 和标记牌一样正对相机；由渲染循环在 `beforeRender` 里驱动。 */
  public faceCamera(camera: THREE.Camera): void {
    camera.getWorldQuaternion(this.cameraQuaternion);
    for (const slot of this.slots) {
      if (!slot.active) continue;
      slot.mesh.quaternion.copy(this.cameraQuaternion);
    }
  }

  public dispose(): void {
    for (const slot of this.slots) {
      slot.texture?.dispose();
      slot.mesh.material.dispose();
    }
    this.geometry.dispose();
    this.root.parent?.remove(this.root);
    this.slots.length = 0;
  }

  /** 先拿空闲的；池子满了就顶掉最老的那一条。 */
  private acquire(): HealthPopupSlot {
    let oldest = this.slots[0];
    for (const slot of this.slots) {
      if (!slot.active) return slot;
      if (slot.sequence < oldest.sequence) oldest = slot;
    }
    return oldest;
  }

  private draw(slot: HealthPopupSlot, amount: number): void {
    const context = slot.surface?.context;
    if (!context || !slot.texture) return;
    context.clearRect(0, 0, TEXTURE_WIDTH, TEXTURE_HEIGHT);
    context.font = '700 72px Arial, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    // 先描一圈纸白的边：草地和树冠上都要读得出来。
    context.lineWidth = 10;
    context.strokeStyle = '#fdfbf6';
    context.strokeText(formatAmount(amount), TEXTURE_WIDTH / 2, TEXTURE_HEIGHT / 2, TEXTURE_WIDTH - 16);
    context.fillStyle = amount < 0 ? DAMAGE_COLOR : HEAL_COLOR;
    context.fillText(formatAmount(amount), TEXTURE_WIDTH / 2, TEXTURE_HEIGHT / 2, TEXTURE_WIDTH - 16);
    slot.texture.needsUpdate = true;
  }
}
