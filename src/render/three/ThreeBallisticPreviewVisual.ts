import * as THREE from 'three';
import { ballisticArcPoint } from '../ballisticArc';
import type { BallisticPreviewState } from '../RenderScene';

/**
 * 蓄力时那条白色抛物线，住在渲染世界里（设计稿 `@w` 的 `A`）。
 *
 * **它不是判定**：判定只认落点与半径，这条线画的是同一个落点的一段抛物弧。
 * 玩法侧每帧只给两个端点和一个蓄力比例，弧本身在这一侧插出来（`ballisticArcPoint`，
 * 射出去那支箭走的是同一条）——那是一条纯粹的表现曲线，让它过边界只会让同一件事
 * 在两边各有一份。
 *
 * 顶点数固定：一条线一段几何，蓄力时每帧改写同一段 `Float32Array`，
 * 不随蓄力时长或射程增长。
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
      return;
    }
    for (let index = 0; index <= SEGMENTS; index += 1) {
      const offset = index * 3;
      ballisticArcPoint(state, index / SEGMENTS, this.point);
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
