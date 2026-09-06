import * as THREE from 'three';
import { PLAYER_MOVE_SPEED } from '../../../shared/playerMovement.mjs';
import type { ContactShadowMaterial } from '../../materials/createContactShadowMaterial';
import type { SlimeSoftBody } from '../../models/slimeSoftBody';
import { SlimeImpactTrigger, type SlimeImpactParams } from '../RenderSlimeImpact';

const BASE_SQUASH = 0.78;

/**
 * 中箭那一下的**弹性形变**：一个欠阻尼弹簧，凹进去之后会过冲、鼓出来，再晃两下停住。
 *
 * 骨骼腿史莱姆的身体不是逐顶点求解的软体（那是 `HybridSlimeSimulation` 的活儿），
 * 它是一颗按公式形变的球。所以这里给的是一条弹性形变曲线而不是一记冲量：刚度与
 * 阻尼比选在明显欠阻尼那一档，约 0.6 秒晃完——挨一箭该看得出弹性，而不是像块石头
 * 一样凹一下就不动了。
 */
const IMPACT_STIFFNESS = 120;
const IMPACT_DAMPING = 5.2;
/** 冲量满格时弹簧起手的速度。凹陷的深浅整个由它和上面两个常数决定。 */
const IMPACT_IMPULSE_SPEED = 5.5;
/** 坑心最深压进去多少，占半径的比例。 */
const IMPACT_DENT_RATIO = 0.34;
/** 坑口张多大：`max(0, -来袭轴·顶点方向)^k`。比软体那一版钝一点——这颗球的顶点少。 */
const IMPACT_FALLOFF_EXPONENT = 4;
/** 挤进去的那部分材料从侧面鼓出来，占凹陷量的比例。不鼓的话看着像被削掉一块。 */
const IMPACT_BULGE_RATIO = 0.22;
/** 整只被砸得往后仰多少弧度（冲量满格、弹簧最深时）。 */
const IMPACT_LEAN = 0.22;

export type SlimeContactShadow = THREE.Mesh<THREE.CircleGeometry, ContactShadowMaterial>;

export interface SlimeAnimatorOptions {
  /** 走路动画的参考速度，通常取原型的 walkSpeed。 */
  readonly referenceSpeed?: number;
  /**
   * 静止时身体中心停在 `radius` 的几倍高度上。
   *
   * 贴地的史莱姆是 1——底面正好压在 y=0。由腿撑起来的是 0：中心就停在髋点上，
   * 高度由腿决定，身体只在原地挤压。
   */
  readonly restHeightRatio?: number;
  /** 贴地阴影。长腿的史莱姆没有身体阴影，阴影画在落脚点上。 */
  readonly shadow?: SlimeContactShadow;
}

/**
 * 史莱姆软体的挤压/摇摆动画（实现路径文档 §1.5）。
 *
 * 从 `src/player/` 搬进渲染世界：它每帧改的是软体各节点的 scale 与 rotation，
 * 玩法侧只需要给一个速度标量。
 *
 * 它认识的是 `SlimeSoftBody` 而不是某一个模型，因此贴地的 `line-art-player-slime`
 * 和由腿撑起来的 `line-art-legged-slime` 共用同一套形变。
 */
export class ThreeSlimeAnimator {
  private readonly referenceSpeed: number;
  private readonly restHeightRatio: number;
  private readonly shadow?: SlimeContactShadow;
  private squash = BASE_SQUASH;
  private squashVelocity = 0;
  private wobble = 0;
  private wobbleVelocity = 0;
  private tilt = 0;
  private tiltVelocity = 0;
  private pulse = 2;
  private readonly impact = new SlimeImpactTrigger();
  /**
   * 来袭轴，**rig 局部**的单位向量：身体挂在被 yaw 转过的 root 下面。
   *
   * 三维的：拉满的一箭是以二十来度扎下来的，坑因此该偏在迎箭那一侧的**上方**，
   * 而不是齐着赤道压一圈。把它拍平成水平的话，平射和吊射打出来的坑一模一样。
   */
  private impactAxisX = 0;
  private impactAxisY = 0;
  private impactAxisZ = 1;
  /**
   * 同一次命中的**水平**那一份，单独留一个单位向量。
   *
   * 「整只往后仰」是绕水平轴倒过去，只跟来箭的水平方位有关；用三维那个轴的话，
   * 越陡的箭仰得越少——而实际上正好相反，扎得越狠该仰得越明显。
   */
  private impactLeanX = 0;
  private impactLeanZ = 1;
  /** 弹簧的位移：正是朝来袭方向凹进去，负是过冲鼓出来。 */
  private impactDent = 0;
  private impactVelocity = 0;

  public constructor(
    private readonly model: SlimeSoftBody,
    options: SlimeAnimatorOptions = {},
  ) {
    this.referenceSpeed = options.referenceSpeed ?? PLAYER_MOVE_SPEED;
    this.restHeightRatio = options.restHeightRatio ?? 1;
    this.shadow = options.shadow;
  }

  /**
   * `bodyYaw` 是这个 proxy 的 root 这一帧实际被转到的角度。
   *
   * 它只为中箭那一下服务：来袭方向在参数段里是**世界轴向**的，而这颗身体挂在被 yaw
   * 转过的 root 下面，不换算的话，两只面对面的史莱姆挨箭时坑会开在背上——软体那条
   * 路线上这个 180° 的错已经犯过一次了（见 `skyland-soft-body-deformation`）。
   */
  /** 这一帧被形变的那颗身体（能力实验室与测试用）。 */
  public get softBody(): SlimeSoftBody {
    return this.model;
  }

  public update(
    deltaSeconds: number,
    elapsedSeconds: number,
    movementSpeed: number,
    bodyYaw = 0,
    impact?: SlimeImpactParams,
  ): void {
    this.updateImpact(deltaSeconds, bodyYaw, impact);
    const moving = movementSpeed > 0.08;
    if (moving) this.pulse += deltaSeconds * (2.6 + movementSpeed * 1.3);

    const breathe = 1 + Math.sin(elapsedSeconds * 1.7) * 0.03;
    const pulseSquash = moving ? 1 - 0.1 * Math.max(0, Math.sin(this.pulse - 0.9)) : 1;
    const targetSquash = BASE_SQUASH * breathe * pulseSquash;
    this.squashVelocity += (targetSquash - this.squash) * 165 * deltaSeconds;
    this.squashVelocity *= Math.exp(-6.2 * deltaSeconds);
    this.squash += this.squashVelocity * deltaSeconds;

    this.wobbleVelocity += -this.wobble * 55 * deltaSeconds;
    this.wobbleVelocity *= Math.exp(-3.4 * deltaSeconds);
    this.wobble += this.wobbleVelocity * deltaSeconds;

    const scaleY = THREE.MathUtils.clamp(this.squash, 0.45, 1.5);
    const scaleXZ = (1 / Math.sqrt(scaleY)) * (1 + this.wobble * 0.1);
    this.model.body.scale.set(scaleXZ, scaleY, scaleXZ);
    this.model.body.position.y = this.model.radius * scaleY * this.restHeightRatio;

    const targetTilt = Math.min(movementSpeed / Math.max(0.01, this.referenceSpeed), 1) * 0.15;
    this.tiltVelocity += (targetTilt - this.tilt) * 130 * deltaSeconds;
    this.tiltVelocity *= Math.exp(-5 * deltaSeconds);
    this.tilt += this.tiltVelocity * deltaSeconds;
    // 挨了一箭整只往后仰一点：坑是局部的，被砸得晃是整只的。顶点朝 +Y，绕 X 正转
    // 把它推向 +Z，绕 Z 正转把它推向 -X，所以横滚那一项取负号。
    const lean = this.impactDent * IMPACT_LEAN;
    this.model.body.rotation.x = this.tilt + this.wobble * 0.35 + this.impactLeanZ * lean;
    this.model.body.rotation.z =
      Math.sin(elapsedSeconds * 2.1) * 0.02 +
      Math.sin(this.pulse * 0.5) * 0.035
        * Math.min(movementSpeed / Math.max(0.01, this.referenceSpeed), 1) +
      this.wobble * 0.55 - this.impactLeanX * lean;

    this.deformBody(elapsedSeconds, moving ? 0.02 : 0.007, moving ? 7.5 : 1.5);
    this.animateContents(elapsedSeconds, scaleY);
  }

  /**
   * 那一记冲量进弹簧，弹簧每帧往前走一步。
   *
   * 弹簧是**欠阻尼**的：凹到底之后会过冲成外鼓，再晃回来——这就是「弹性形变」。
   * 换成过阻尼的话，坑会慢慢平复，看着像捏了一下橡皮泥。
   */
  private updateImpact(
    deltaSeconds: number,
    bodyYaw: number,
    impact?: SlimeImpactParams,
  ): void {
    const hit = this.impact.consume(impact);
    if (hit && Number.isFinite(bodyYaw)) {
      const sinYaw = Math.sin(bodyYaw);
      const cosYaw = Math.cos(bodyYaw);
      // 世界轴向 → rig 局部：和 `ThreeSlimeLegVisual.applyPose` 换算落脚点用的是
      // 同一对系数，两边必须一致，否则腿和身体各朝一个方向。
      const localX = cosYaw * hit.directionX - sinYaw * hit.directionZ;
      const localZ = sinYaw * hit.directionX + cosYaw * hit.directionZ;
      // 竖直那一份不过 yaw：绕 Y 转不动它。
      const localY = hit.directionY;
      const length = Math.hypot(localX, localY, localZ);
      if (length > 1e-6) {
        // 连着挨两箭就换成新那一支的轴：坑跟着最后一下走，晃动累加。两个轴各留一半
        // 的话，得到的是一个谁也没被射中的方向。
        this.impactAxisX = localX / length;
        this.impactAxisY = localY / length;
        this.impactAxisZ = localZ / length;
        // 正上方直直插下来的那一箭没有水平方位，仰的方向保持上一次的——总比
        // 让它突然倒向 +Z 好。
        const planar = Math.hypot(localX, localZ);
        if (planar > 1e-6) {
          this.impactLeanX = localX / planar;
          this.impactLeanZ = localZ / planar;
        }
        this.impactVelocity += hit.impulse * IMPACT_IMPULSE_SPEED;
      }
    }
    const frameSeconds = Math.max(0, Math.min(deltaSeconds, 0.1));
    if (frameSeconds <= 0) return;
    this.impactVelocity += -this.impactDent * IMPACT_STIFFNESS * frameSeconds;
    this.impactVelocity *= Math.exp(-IMPACT_DAMPING * frameSeconds);
    this.impactDent += this.impactVelocity * frameSeconds;
  }

  private deformBody(time: number, amplitude: number, speed: number): void {
    const positions = this.model.geometry.getAttribute('position') as THREE.BufferAttribute;
    const target = positions.array as Float32Array;
    const source = this.model.originalPositions;

    // 坑是加在原始球面上的一项，和呼吸波相加——不是先算完波再去挪一块皮：
    // 挪一块皮要有命中顶点、要有影响圈，而影响圈的边界就是画面上那道折痕。
    const dent = this.impactDent * this.model.radius * IMPACT_DENT_RATIO;
    const bulge = this.impactDent * IMPACT_BULGE_RATIO;
    const inverseRadius = 1 / Math.max(1e-6, this.model.radius);

    for (let index = 0; index < positions.count; index += 1) {
      const offset = index * 3;
      const x = source[offset];
      const y = source[offset + 1];
      const z = source[offset + 2];
      const height = y / this.model.radius;
      const spread = 1 + 0.2 * Math.max(0, -height);
      const phase = height * 3.4 - time * speed;
      const wave = Math.sin(phase) * amplitude;
      const crossWave = Math.sin(phase + 1.7) * amplitude * 0.4;
      // 迎着箭的那一侧才凹，背面几乎不动；权重是顶点方向的连续函数，所以侧壁不裂。
      // 三个分量都算进去：斜着扎下来的一箭，坑就偏在迎箭那一侧的上方。
      const facing = -(
        x * this.impactAxisX + y * this.impactAxisY + z * this.impactAxisZ
      ) * inverseRadius;
      const impactWeight = facing > 0 ? facing ** IMPACT_FALLOFF_EXPONENT : 0;
      // 挤进去的材料从坑口外面鼓出来：坑最深的地方不鼓，赤道一圈鼓得最多。
      const impactBulge = 1 + bulge * (1 - impactWeight);
      target[offset] = (x * spread - crossWave) * impactBulge
        + this.impactAxisX * dent * impactWeight;
      target[offset + 1] = y + Math.sin(phase * 0.8 + 0.6) * amplitude * 0.25
        + this.impactAxisY * dent * impactWeight;
      target[offset + 2] = (z * spread + wave) * impactBulge
        + this.impactAxisZ * dent * impactWeight;
    }
    positions.needsUpdate = true;
  }

  private animateContents(time: number, scaleY: number): void {
    this.model.core.scale.setScalar(1 + 0.06 * Math.sin(time * 2.4 + this.pulse));
    this.model.core.position.set(
      Math.sin(time * 1.3) * 0.016,
      Math.sin(time * 1.9) * 0.02,
      Math.sin(time * 1.1) * 0.014,
    );

    for (const bubble of this.model.bubbles) {
      const progress = (time * 0.22 + bubble.phase) % 1;
      const orbitRadius = bubble.radius * (1 - progress * 0.45);
      bubble.mesh.position.set(
        Math.cos(bubble.angle) * orbitRadius,
        -this.model.radius * 0.4 + progress * this.model.radius * 0.8,
        Math.sin(bubble.angle) * orbitRadius,
      );
      bubble.mesh.scale.setScalar(0.5 + 0.5 * Math.sin(progress * Math.PI));
    }

    const shadow = this.shadow;
    if (!shadow) return;
    const shadowScale = 1 / Math.sqrt(scaleY);
    shadow.scale.set(shadowScale, shadowScale, 1);
    shadow.material.setOpacity(0.1 + 0.1 / scaleY);
  }
}
