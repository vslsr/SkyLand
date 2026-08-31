/**
 * 在玩法 System 更新父 Actor 后，按父子拓扑用 localTransform 重建世界坐标。
 * 该 System 只应运行在权威模拟端；客户端直接消费已插值的权威世界坐标。
 */
export class AttachmentSystem {
  update(world) {
    world.resolveTransforms();
  }
}
