import type { WorldRay } from '../camera/cameraRay';
import type { BallisticPreviewState } from '../render/RenderScene';
import {
  resolveWeaponStrike,
  weaponImpactPoint,
} from '../../shared/items/index.mjs';
import { MUZZLE_HEIGHT } from '../../shared/ballistics/index.mjs';

/**
 * 手持武器时的瞄准与蓄力预览（设计稿「工具、武器使用流程」）。
 *
 * 两件事，一个来源：
 *
 * - **朝向**：拿着武器时，角色面朝指针在地面上的投影点（PC）或摇杆方向（移动端）。
 *   转身仍然归 `TopDownController.setFacingRequest`——这里只说「对准哪儿」。
 * - **抛物线**：蓄力那一段画一条白线，落点用的是**和服务端同一份共享换算**
 *   （`shared/items/weaponStrike.mjs`），再由**同一份沿弧扫掠**在墙、地形、实体
 *   处截断（`shared/ballistics/projectileSweep.mjs`）。两边各写一套的话，玩家瞄
 *   的地方和真正打中的地方会差一截，而那种偏差只有在有人抱怨「明明瞄准了」时
 *   才会被发现。
 *
 * 落点由**朝向**反解，不是指针位置：服务端判定用的是权威 yaw，所以预览也必须用
 * 同一个量。指针只决定角色转到哪个方向，转不到位时线自然跟着还没转到位的朝向走。
 *
 * **松手这里不做任何事**。射出去的是服务端生成的一个真 Actor（`ProjectileComponent`），
 * 它自己飞、自己撞、撞上了才结算伤害，然后顺着快照回到这一侧。这里画的那条线因此
 * 只是「这一箭会往哪儿去」的预告，不是它本身。
 */

export interface WeaponAimPort {
  /** 这一帧该不该瞄准：没进房间、界面盖着、在建造模式里都不算。 */
  isActive(): boolean;
  /** 手上那件东西的武器数据；不是武器就是 undefined。 */
  getHeldWeapon(): WeaponAimTarget | undefined;
  /** 本地玩家的渲染位置与当前朝向。 */
  getPlayer(): { x: number; y: number; z: number; yaw: number } | undefined;
  /** 指针射线；触屏/手柄没有指针时是 undefined，这时朝向交回移动方向。 */
  pointerRay(): WorldRay | undefined;
  /** 落点那一格的地面高度，画线的末端要落在地上。 */
  sampleGroundHeight(x: number, z: number): number;
  /** 让角色对准这一点；传 undefined 把朝向交回移动方向。 */
  setFacingTarget(target: { x: number; z: number } | undefined): void;
  setPreview(state: BallisticPreviewState | undefined): void;
  /**
   * 这条弧被挡在哪儿：返回 [0, 1] 的截断比例，一路无阻就是 1。
   *
   * 走的是和服务端同一份扫掠（`sweepProjectileArc`），只是两边各自问自己那个
   * 物理世界与 Actor 世界要碰撞数据。没有实现时返回 1——那样线会画到名义落点，
   * 也就是这套碰撞接上之前的老样子。
   */
  sweepProjectile?(arc: BallisticPreviewState): number;
}

export interface WeaponAimTarget {
  /** 物品目录里那份武器数据。 */
  readonly weapon: {
    readonly range: { readonly minimum: number; readonly maximum: number };
    readonly charge: {
      readonly minimumRatio: number;
      readonly damageScale: { readonly minimum: number; readonly maximum: number };
    };
    readonly radius: number;
  };
}

/** 朝向跟随指针的收敛速度。比默认快一些：瞄准要跟手。 */
const AIM_SHARPNESS = 14;

export class WeaponAimController {
  private charging = false;
  private chargeRatio = 0;

  public constructor(private readonly port: WeaponAimPort) {}

  /**
   * 这一帧的蓄力比例。由物品栏那圈倒计时喂进来——圈和线读同一个比例，
   * 所以线的长度和圈的进度永远是同一件事。
   */
  public setChargeRatio(ratio: number | undefined): void {
    this.charging = ratio !== undefined;
    this.chargeRatio = ratio ?? 0;
  }

  public update(): void {
    const held = this.port.isActive() ? this.port.getHeldWeapon() : undefined;
    const player = this.port.getPlayer();
    if (!held || !player) {
      this.clear();
      return;
    }
    this.port.setFacingTarget(this.resolveAimPoint(player.y));
    if (!this.charging) {
      this.port.setPreview(undefined);
      return;
    }
    // 还没攒过空放阈值时 `resolveArc` 给不出弧：这一箭现在松手也射不出去，
    // 所以线也不该出现。
    this.port.setPreview(this.resolveArc(player, this.chargeRatio));
  }

  /**
   * 这一份蓄力比例下，从出手点到落点的那条弧。空放时没有。
   *
   * `travel` 是这条弧被挡在哪儿：墙、地形、站在半路上的实体都会把它截短，
   * 于是白线画到障碍物那里为止，而不是穿过去落在墙后面。截断读的是和服务端
   * 飞行判定同一份扫掠，所以「线停在哪」和「箭停在哪」是同一个答案。
   */
  private resolveArc(
    player: { x: number; y: number; z: number; yaw: number },
    ratio: number,
  ): BallisticPreviewState | undefined {
    const weapon = this.port.getHeldWeapon()?.weapon;
    const strike = weapon ? resolveWeaponStrike(weapon, ratio) : undefined;
    if (!strike) return undefined;
    const impact = weaponImpactPoint(player.x, player.z, player.yaw, strike.distance);
    const arc: BallisticPreviewState = {
      originX: player.x,
      originY: player.y + MUZZLE_HEIGHT,
      originZ: player.z,
      impactX: impact.x,
      impactY: this.port.sampleGroundHeight(impact.x, impact.z),
      impactZ: impact.z,
      ratio: strike.ratio,
    };
    const travel = this.port.sweepProjectile?.(arc) ?? 1;
    // 一路无阻的那条弧不带 `travel`：省下的不是一个字段，是「这条线到底完不完整」
    // 这个问题——不写就是完整的。
    return travel < 1 ? { ...arc, travel } : arc;
  }

  /** 收起瞄准与预览。换成别的东西、进建造模式、界面盖上来都走这里。 */
  public reset(): void {
    this.charging = false;
    this.chargeRatio = 0;
    this.clear();
  }

  private clear(): void {
    this.port.setFacingTarget(undefined);
    this.port.setPreview(undefined);
  }

  /**
   * 指针射线与「角色脚下那个水平面」的交点。
   *
   * 用玩家的高度而不是 y=0：站在地基或山坡上时，射线打在 0 平面上的那一点会
   * 偏出去一大截，角色因此永远转不到指针指着的地方。
   */
  private resolveAimPoint(planeY: number): { x: number; z: number } | undefined {
    const ray = this.port.pointerRay();
    if (!ray) return undefined;
    const directionY = ray.direction[1];
    // 射线几乎与平面平行：这一帧没有可信的交点，保持上一帧的朝向。
    if (!Number.isFinite(directionY) || Math.abs(directionY) < 1e-4) return undefined;
    const distance = (planeY - ray.origin[1]) / directionY;
    if (!(distance > 0)) return undefined;
    return {
      x: ray.origin[0] + ray.direction[0] * distance,
      z: ray.origin[2] + ray.direction[2] * distance,
    };
  }
}

/** 朝向请求的收敛速度，导出给场景层复用。 */
export const WEAPON_AIM_SHARPNESS = AIM_SHARPNESS;
