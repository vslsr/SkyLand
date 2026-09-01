/**
 * 在玩法 System 更新父 Actor 后，按父子拓扑用 localTransform 重建世界坐标。
 * 该 System 只应运行在权威模拟端；客户端直接消费已插值的权威世界坐标。
 */
export class AttachmentSystem {
  update(world) {
    // 大量无父子关系的派生 Actor（树、掉落物）不需要每 tick 重算根 Transform。
    world.resolveTransforms({ attachedOnly: true });
  }
}
