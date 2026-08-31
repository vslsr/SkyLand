import { ActorComponent } from '../ActorComponent.mjs';

export const REPLICATION_POLICY_COMPONENT = 'replicationPolicy';

/** 决定 Actor 是全房间复制还是只进入附近玩家的快照。 */
export class ReplicationPolicyComponent extends ActorComponent {
  constructor(definition = {}) {
    super(REPLICATION_POLICY_COMPONENT);
    this.mode = definition.mode === 'aoi' ? 'aoi' : 'always';
    this.radiusChunks = Math.max(0, Math.floor(Number(definition.radiusChunks) || 2));
  }
}
