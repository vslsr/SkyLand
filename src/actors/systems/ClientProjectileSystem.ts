import type { ActorWorld } from '../../../shared/actor/ActorWorld.mjs';
import type { Actor } from '../../../shared/actor/Actor.mjs';
import {
  PROJECTILE_COMPONENT,
  TRANSFORM_COMPONENT,
  type ProjectileComponent,
  type TransformComponent,
} from '../../../shared/actor/index.mjs';
import { ballisticArcPoint, ballisticArcTangent } from '../../../shared/ballistics/index.mjs';
import { PARAM_PROJECTILE_PITCH } from '../../render/RenderVisualParams';
import type { RenderTransformBuffer } from '../../render/RenderTransformBuffer';
import {
  RENDER_PROXY_COMPONENT,
  type RenderProxyComponent,
} from '../components/RenderProxyComponent';

/**
 * 飞在空中那支箭的位置与俯仰，**这一侧自己按弧求**。
 *
 * 它不走快照插值那条路，而那正是它存在的理由：34 米每秒的小东西是插值最坏的情况。
 * 20 Hz 下两份快照隔着 1.7 米，缓冲一空 `ActorSnapshotBuffer` 就退回最新那一帧、
 * 箭在空中原地冻住，下一份到了再跳过去——画面上就是一路抖。那阵抖不是参数没调好，
 * 是信息本来就不够：折线连不出一条抛物线。
 *
 * 而这条弧是**写得出来的**：出手点、名义落点、蓄力比例、出发时刻、飞多久，五样在
 * 射出那一刻就定死了，随快照复制过来（`SnapshotProjectile`）。于是位置每一渲染帧
 * 解析地求一次，光滑；切线也解析地求，不必拿两帧位移去猜——猜出来的那一个在停住
 * 之后会跟着载体乱转（插在走动的史莱姆身上时尤其明显）。
 *
 * **权威的那一半仍然在服务端**：撞在哪儿、什么时候停，只有它知道，所以这里推进到
 * `travel` 为止就不再往前。渲染时刻取的是快照缓冲那一个（落后一个插值延迟），
 * 所以「停住」这条消息总是先到、箭不会先飞过头再被拽回来。
 *
 * **停住之后这一位就撒手**：扎中的那一箭在服务端被挂到了目标身上
 * （`ProjectileSystem` 的 `setActorParent`），从那一刻起它是目标下面的一个静态
 * 子 Actor，位置与朝向都由那份挂载解算出来、随快照过来。这里要是还照弧写世界
 * 坐标，箭就会钉死在命中时那个世界点上——史莱姆走开，箭留在半空。所以
 * `stopped` 之后不再碰 Transform，只把那一刻的俯仰继续摆着（它是绕 yaw 之后的
 * 局部 X 转的，父节点只有 yaw，所以跟着目标转身也仍然是扎进去的那个姿态）。
 *
 * 排在 `ActorTransformSystem` 之前：它写的是权威 Transform，那一位再把它送过边界。
 */
export class ClientProjectileSystem {
  private readonly point = { x: 0, y: 0, z: 0 };
  private readonly tangent = { x: 0, y: 0, z: 0 };

  /**
   * @param renderTime 快照缓冲这一帧的渲染时刻（服务端时钟，毫秒）。**和别的 Actor
   *   读同一个**，箭才和世界落在同一帧上；各用各的时钟会让它比周围快或慢半拍。
   */
  public constructor(
    private readonly transforms: RenderTransformBuffer,
    private readonly renderTime: () => number | undefined,
  ) {}

  public update(world: ActorWorld): void {
    const renderTime = this.renderTime();
    for (const actor of world.query(PROJECTILE_COMPONENT, TRANSFORM_COMPONENT) as Actor[]) {
      const projectile = actor.requireComponent(PROJECTILE_COMPONENT) as ProjectileComponent;
      const travel = this.resolveTravel(projectile, renderTime);
      // 还在飞的才由这一位摆位置；扎住的那一支交回给挂载与复制。
      if (!projectile.stopped) {
        const transform = actor.requireComponent(TRANSFORM_COMPONENT) as TransformComponent;
        ballisticArcPoint(projectile, travel, this.point);
        transform.setWorldTransform(
          [this.point.x, this.point.y, this.point.z],
          Math.atan2(
            projectile.impactX - projectile.originX,
            projectile.impactZ - projectile.originZ,
          ),
        );
      }
      const proxy = actor.getComponent(RENDER_PROXY_COMPONENT) as RenderProxyComponent | undefined;
      if (!proxy) continue;
      ballisticArcTangent(projectile, travel, this.tangent);
      // 模型沿 +Z 躺着；绕 X 的**正**旋转把 +Z 压向下方，所以抬头是负角。
      this.transforms.writeParam(
        proxy.proxyId,
        PARAM_PROJECTILE_PITCH,
        -Math.atan2(this.tangent.y, Math.hypot(this.tangent.x, this.tangent.z)),
      );
    }
  }

  /**
   * 这一刻它飞到弧的百分之几。
   *
   * 没有时钟基准（刚进房间、还没对上表）时退回权威那个值：宁可让第一帧停在服务端
   * 说的地方，也不要按一个错的时刻把它甩出去。
   */
  private resolveTravel(projectile: ProjectileComponent, renderTime: number | undefined): number {
    if (projectile.stopped || renderTime === undefined) return projectile.travel;
    const elapsed = renderTime / 1000 - projectile.startedAt;
    const predicted = elapsed / Math.max(1e-3, projectile.flightSeconds);
    // 权威还没说停，所以不往它前面跑：撞墙那一下是它说了算的。
    return Math.min(1, Math.max(0, predicted));
  }
}
