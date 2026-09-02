import { ActorComponent } from '../ActorComponent.mjs';
import { createSimpleCollisionDefinition } from '../simpleCollision.mjs';

export const SIMPLE_COLLISION_COMPONENT = 'simpleCollision';

/** 由 Actor 可视模型尺寸自动派生、由客户端预测和房间 DS 共用的简易碰撞。 */
export class SimpleCollisionComponent extends ActorComponent {
  constructor(definition) {
    super(SIMPLE_COLLISION_COMPONENT);
    // 显式声明稳定字段形状，供 TypeScript 的 checkJs/d.ts 推断；运行时随后覆盖。
    this.shape = 'box';
    this.centerX = 0;
    this.centerZ = 0;
    this.halfWidth = 0.01;
    this.halfLength = 0.01;
    this.minimumY = 0;
    this.maximumY = 0.01;
    this.supportShape = 'box';
    this.supportHalfWidth = 0.01;
    this.supportHalfLength = 0.01;
    this.setDefinition(definition);
  }

  setDefinition(definition) {
    const collision = createSimpleCollisionDefinition(definition);
    this.shape = collision.shape;
    this.centerX = collision.centerX;
    this.centerZ = collision.centerZ;
    this.halfWidth = collision.halfWidth;
    this.halfLength = collision.halfLength;
    this.minimumY = collision.minimumY;
    this.maximumY = collision.maximumY;
    this.supportShape = collision.supportShape;
    this.supportHalfWidth = collision.supportHalfWidth;
    this.supportHalfLength = collision.supportHalfLength;
    return this;
  }
}
