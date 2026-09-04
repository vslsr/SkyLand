import * as THREE from 'three';
import type { BallisticPreviewState } from '../RenderScene';

/**
 * 蓄力时那条白色抛物线，住在渲染世界里（设计稿 `@w` 的 `A`）。
 *
 * **它不是判定**：判定只认落点与半径，这条线画的是同一个落点的一段抛物弧。
 * 玩法侧每帧只给两个端点和一个蓄力比例，弧本身在这一侧插出来——那是一条纯粹的
 * 表现曲线，让它过边界只会让同一件事在两边各有一份。
 *
 * 顶点数固定：一条线一段几何，蓄力时每帧改写同一段 `Float32Array`，
 * 不随蓄力时长或射程增长。
 */

/** 弧上取几个点。够画出一条平滑的弧，又不至于每帧写太多字节。 */
const SEGMENTS = 24;
/** 弧顶最高抬到射程的几分之一。拉满时最平，轻放时最吊。 */
const APEX_RATIO = 0.22;

export class ThreeBallisticPreviewVisual {
  public readonly root = new THREE.Group();
  private readonly positions = new Float32Array((SEGMENTS + 1) * 3);
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material = new THREE.LineBasicMaterial({
    color: 0xfdfbf6,
    transparent: true,
    opacity: 0.9,
    fog: false,
  });
  private readonly line: THREE.Line;

  public constructor() {
    this.root.name = 'ballistic-preview';
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.line = new THREE.Line(this.geometry, this.material);
    this.line.name = 'ballistic-preview-line';
    this.line.frustumCulled = false;
    this.line.visible = false;
    this.root.add(this.line);
  }

  public setState(state: BallisticPreviewState | undefined): void {
    if (!state) {
      this.line.visible = false;
      return;
    }
    const dx = state.impactX - state.originX;
    const dz = state.impactZ - state.originZ;
    const distance = Math.hypot(dx, dz);
    // 拉得越满弧越平：抬起的高度按「1 − 比例」收，和射程一起决定这条弧的样子。
    const apex = distance * APEX_RATIO * (1 - state.ratio * 0.55);
    for (let index = 0; index <= SEGMENTS; index += 1) {
      const t = index / SEGMENTS;
      const offset = index * 3;
      this.positions[offset] = state.originX + dx * t;
      this.positions[offset + 1] = state.originY
        + (state.impactY - state.originY) * t
        // 一条标准抛物线：两端为 0、中间最高。
        + apex * 4 * t * (1 - t);
      this.positions[offset + 2] = state.originZ + dz * t;
    }
    this.geometry.getAttribute('position').needsUpdate = true;
    this.geometry.computeBoundingSphere();
    this.line.visible = true;
  }

  public dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.root.parent?.remove(this.root);
  }
}
