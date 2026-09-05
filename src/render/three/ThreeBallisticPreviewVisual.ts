import * as THREE from 'three';
import { ballisticArcPoint, ballisticArcTravel } from '../ballisticArc';
import type { BallisticPreviewState } from '../RenderScene';

/**
 * 蓄力时那条白色抛物线，住在渲染世界里（设计稿 `@w` 的 `A`）。
 *
 * **它不是判定**：判定跟着射出去那支箭走，这条线画的是它会走的那条弧。玩法侧每帧
 * 只给两个端点、一个蓄力比例和一个截断处，弧本身在这一侧插出来（`ballisticArcPoint`，
 * 射出去那支箭走的是同一条）——那是一条纯粹的表现曲线，让它过边界只会让同一件事
 * 在两边各有一份。
 *
 * 截断处（`travel`）由玩法侧沿弧扫掠算出来：线因此画到墙上、山坡上、挡在路上的
 * 那只史莱姆身上为止，而不是穿过去落在它们后面。
 *
 * 顶点数固定：一条线一段几何，蓄力时每帧改写同一段 `Float32Array`，
 * 不随蓄力时长或射程增长。
 *
 * **画多长会追一下**（`advance`）。射程是从 `range.minimum` 起跳的，而低于
 * `charge.minimumRatio` 那一段算空放、根本没有弧——于是圈刚过空放阈值那一帧，
 * 线是「从没有」直接变成 8.4 米的，占满射程的三分之一多。屏幕上那就是先抖一下、
 * 之后才开始逐渐变长。这里让画出来的长度以固定速度追上去，起手因此是从枪口
 * 长出来的。
 *
 * 只追**变长**：被墙截短要立刻生效，不然线会在障碍物后面多留几帧——那是在
 * 说谎，而这条线的全部意义就是「箭会停在哪」。
 */

/** 弧上取几个点。够画出一条平滑的弧，又不至于每帧写太多字节。 */
const SEGMENTS = 24;
/**
 * 白线下面那条墨色影线压低多少米。
 *
 * 没有它这条线在纸面色的地上是**看不见的**——设计稿要的是白线，而这张图的背景
 * 就是纸白。WebGL 忽略线宽，所以「描一圈边」在这里只能靠第二条线：俯视机位下
 * 压低几厘米正好投影成白线下方的一道暗边，和线稿里「填充 + 描边」是同一套办法。
 */
const INK_SHADOW_OFFSET = 0.06;
/**
 * 线变长追得多快，米每秒。
 *
 * 比 8.4 米那一跳快得多（跑完只要八分之一秒），所以它读起来是「长出来」而不是
 * 「慢慢爬」；又比一帧慢得多，所以那一跳被摊开了。
 */
const GROW_METERS_PER_SECOND = 70;

export class ThreeBallisticPreviewVisual {
  public readonly root = new THREE.Group();
  private readonly positions = new Float32Array((SEGMENTS + 1) * 3);
  private readonly shadowPositions = new Float32Array((SEGMENTS + 1) * 3);
  private readonly geometry = new THREE.BufferGeometry();
  private readonly shadowGeometry = new THREE.BufferGeometry();
  private readonly material = new THREE.LineBasicMaterial({
    color: 0xfdfbf6,
    transparent: true,
    opacity: 0.95,
    fog: false,
  });
  private readonly shadowMaterial = new THREE.LineBasicMaterial({
    color: 0x2f2419,
    transparent: true,
    opacity: 0.55,
    fog: false,
  });
  /** 每帧沿弧取点用的暂存，避免一帧新建二十几个对象。 */
  private readonly point = { x: 0, y: 0, z: 0 };
  /** 这一帧画到弧的百分之几。目标由 `setState` 给，变长时由 `advance` 追。 */
  private drawnTravel = 0;
  /** 最近一次的弧与它的目标截断处；`advance` 要拿它重画。 */
  private state?: BallisticPreviewState;
  private targetTravel = 0;
  private readonly line: THREE.Line;
  private readonly shadow: THREE.Line;

  public constructor() {
    this.root.name = 'ballistic-preview';
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.shadowGeometry.setAttribute('position', new THREE.BufferAttribute(this.shadowPositions, 3));
    this.shadow = new THREE.Line(this.shadowGeometry, this.shadowMaterial);
    this.shadow.name = 'ballistic-preview-shadow';
    this.shadow.frustumCulled = false;
    this.shadow.visible = false;
    this.line = new THREE.Line(this.geometry, this.material);
    this.line.name = 'ballistic-preview-line';
    this.line.frustumCulled = false;
    this.line.visible = false;
    // 影线先画：白线压在它上面，读起来就是「一条带暗边的白线」。
    this.root.add(this.shadow, this.line);
  }

  public setState(state: BallisticPreviewState | undefined): void {
    if (!state) {
      this.line.visible = false;
      this.shadow.visible = false;
      this.state = undefined;
      // 收起来就归零：下一次拉弓仍然从枪口长出来，而不是接着上一次的长度。
      this.drawnTravel = 0;
      this.targetTravel = 0;
      return;
    }
    this.state = state;
    this.targetTravel = ballisticArcTravel(state);
    // 变短立刻生效：线不能比它该停的地方长。
    if (this.targetTravel < this.drawnTravel) this.drawnTravel = this.targetTravel;
    this.redraw();
  }

  /**
   * 让画出来的长度追上目标，每帧一次。
   *
   * 速度按**米每秒**给，而不是按比例每秒：远弧和近弧的起手因此看起来一样快。
   */
  public advance(deltaSeconds: number): void {
    const state = this.state;
    if (!state || this.drawnTravel >= this.targetTravel) return;
    const distance = Math.hypot(state.impactX - state.originX, state.impactZ - state.originZ);
    const step = distance > 1e-6
      ? (GROW_METERS_PER_SECOND * Math.max(0, deltaSeconds)) / distance
      : this.targetTravel;
    this.drawnTravel = Math.min(this.targetTravel, this.drawnTravel + step);
    this.redraw();
  }

  private redraw(): void {
    const state = this.state;
    if (!state) return;
    // 被挡住的那一条只画到障碍物为止：顶点数不变，最后一段挤在截断处，
    // 于是同一段 `Float32Array` 每帧原地改写，不随射程或障碍物远近增长。
    const travel = this.drawnTravel;
    for (let index = 0; index <= SEGMENTS; index += 1) {
      const offset = index * 3;
      ballisticArcPoint(state, (index / SEGMENTS) * travel, this.point);
      this.positions[offset] = this.point.x;
      this.positions[offset + 1] = this.point.y;
      this.positions[offset + 2] = this.point.z;
      this.shadowPositions[offset] = this.point.x;
      this.shadowPositions[offset + 1] = this.point.y - INK_SHADOW_OFFSET;
      this.shadowPositions[offset + 2] = this.point.z;
    }
    this.geometry.getAttribute('position').needsUpdate = true;
    this.geometry.computeBoundingSphere();
    this.shadowGeometry.getAttribute('position').needsUpdate = true;
    this.shadowGeometry.computeBoundingSphere();
    this.line.visible = true;
    this.shadow.visible = true;
  }

  public dispose(): void {
    this.geometry.dispose();
    this.shadowGeometry.dispose();
    this.material.dispose();
    this.shadowMaterial.dispose();
    this.root.parent?.remove(this.root);
  }
}
