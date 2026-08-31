import { ActorComponent } from '../ActorComponent.mjs';
import { createSimpleCollisionDefinition } from '../simpleCollision.mjs';

export const SIMPLE_COLLISION_COMPONENT = 'simpleCollision';

/** 由 Actor 可视模型尺寸自动派生、由客户端预测和房间 DS 共用的简易碰撞。 */
export class SimpleCollisionComponent extends ActorComponent {
  constructor(definition) {
    super(SIMPLE_COLLISION_COMPONENT);
    const collision = createSimpleCollisionDefinition(definition);
    this.centerX = collision.centerX;
    this.centerZ = collision.centerZ;
    this.halfWidth = collision.halfWidth;
    this.halfLength = collision.halfLength;
    this.minimumY = collision.minimumY;
    this.maximumY = collision.maximumY;
  }
}

