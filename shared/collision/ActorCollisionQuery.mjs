import { circleOverlapsSimpleCollisionFootprint } from '../actor/simpleCollision.mjs';
import { COLLISION_LAYER } from './collisionLayers.mjs';

const QUERY_EPSILON = 1e-6;

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/** Actor/静态物件 provider：宽相完全复用 CollisionWorld 的局部均匀网格。 */
export class ActorCollisionQuery {
  constructor(world, options = {}) {
    this.world = world;
    this.accept = options.accept;
  }

  sweepHorizontal(start, end, volume, feetY, options = {}) {
    return this.world?.sweepCircle(
      start,
      end,
      volume.radius,
      {
        minimumY: feetY,
        maximumY: feetY + volume.height,
        maximumStepHeight: options.maximumStepHeight,
      },
      { accept: options.accept ?? this.accept, layers: COLLISION_LAYER.MOVEMENT },
    );
  }

  groundAt(point, _feetY, volume, options = {}) {
    const supportY = this.world?.findSupportHeight(
      point,
      volume.radius,
      options.minimumY,
      options.maximumY,
      { accept: options.accept ?? this.accept, layers: COLLISION_LAYER.MOVEMENT },
    );
    return supportY === undefined
      ? undefined
      : {
          y: supportY,
          normalX: 0,
          normalY: 1,
          normalZ: 0,
          walkable: true,
          kind: 'actor',
        };
  }

  sweepVertical(point, fromY, toY, volume, options = {}) {
    if (!this.world) return undefined;
    if (toY < fromY) {
      const ground = this.groundAt(point, fromY, volume, {
        ...options,
        minimumY: toY,
        maximumY: fromY,
      });
      if (!ground) return undefined;
      const distance = fromY - toY;
      return {
        ...ground,
        t: distance > QUERY_EPSILON ? Math.max(0, Math.min(1, (fromY - ground.y) / distance)) : 0,
        kind: 'floor',
      };
    }
    if (toY <= fromY + QUERY_EPSILON) return undefined;

    const bodyTopFrom = fromY + volume.height;
    const bodyTopTo = toY + volume.height;
    let earliest;
    this.world.forEachNear(
      point.x,
      point.z,
      volume.radius,
      COLLISION_LAYER.MOVEMENT,
      (instance) => {
        if ((options.accept ?? this.accept)?.(instance) === false) return;
        if (!circleOverlapsSimpleCollisionFootprint(point, volume.radius, instance)) return;
        const ceilingY = finiteNumber(instance.transform.y)
          + finiteNumber(instance.collision.minimumY);
        if (ceilingY < bodyTopFrom - QUERY_EPSILON || ceilingY > bodyTopTo + QUERY_EPSILON) return;
        const t = Math.max(0, Math.min(1, (ceilingY - bodyTopFrom) / (bodyTopTo - bodyTopFrom)));
        if (earliest && t >= earliest.t) return;
        earliest = {
          t,
          y: ceilingY - volume.height,
          normalX: 0,
          normalY: -1,
          normalZ: 0,
          walkable: false,
          kind: 'ceiling',
        };
      },
    );
    return earliest;
  }
}
