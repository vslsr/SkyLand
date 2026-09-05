import type { WorldRay } from '../camera/cameraRay';
import type { BallisticPreviewState } from '../render/RenderScene';
import {
  resolveWeaponStrike,
  weaponImpactPoint,
} from '../../shared/items/index.mjs';

/**
 * 手持武器时的瞄准与蓄力预览（设计稿「工具、武器使用流程」）。
 *
 * 两件事，一个来源：
 *
 * - **朝向**：拿着武器时，角色面朝指针在地面上的投影点（PC）或摇杆方向（移动端）。
 *   转身仍然归 `TopDownController.setFacingRequest`——这里只说「对准哪儿」。
 * - **抛物线**：蓄力那一段画一条白线，落点用的是**和服务端同一份共享换算**
 *   （`shared/items/weaponStrike.mjs`）。两边各写一套的话，玩家瞄的地方和真正
 *   打中的地方会差一截，而那种偏差只有在有人抱怨「明明瞄准了」时才会被发现。
 *
 * 落点由**朝向**反解，不是指针位置：服务端判定用的是权威 yaw，所以预览也必须用
 * 同一个量。指针只决定角色转到哪个方向，转不到位时线自然跟着还没转到位的朝向走。
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
  /** 射出去一支箭。走的弧和刚才那条预览线是同一条。 */
  spawnArrow(state: BallisticPreviewState): void;
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

/** 出手点比脚底高多少：弓握在身前偏上，线从那里出去才不像贴着地面爬。 */
const MUZZLE_HEIGHT = 0.62;
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
   * 松手：把刚才瞄的那条弧交给一支箭。
   *
   * **弹道在这一刻就算完了**，箭飞出去之后不再决定任何事——服务端也是在这一刻
   * 结算的（落点半径内全中）。所以这里不需要一套飞行物理，只需要和预览同一条弧：
   * 玩家看到的那条线末端，就是这一箭落下去的地方。
   *
   * 没过空放阈值的那一下不射：那一箭本来就没出去，画一支箭出来是在撒谎。
   */
  public fire(ratio: number): void {
    const player = this.port.isActive() ? this.port.getPlayer() : undefined;
    const arc = player ? this.resolveArc(player, ratio) : undefined;
    if (arc) this.port.spawnArrow(arc);
  }

  /** 这一份蓄力比例下，从出手点到落点的那条弧。空放时没有。 */
  private resolveArc(
    player: { x: number; y: number; z: number; yaw: number },
    ratio: number,
  ): BallisticPreviewState | undefined {
    const weapon = this.port.getHeldWeapon()?.weapon;
    const strike = weapon ? resolveWeaponStrike(weapon, ratio) : undefined;
    if (!strike) return undefined;
    const impact = weaponImpactPoint(player.x, player.z, player.yaw, strike.distance);
    return {
      originX: player.x,
      originY: player.y + MUZZLE_HEIGHT,
      originZ: player.z,
      impactX: impact.x,
      impactY: this.port.sampleGroundHeight(impact.x, impact.z),
      impactZ: impact.z,
      ratio: strike.ratio,
    };
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
