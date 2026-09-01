import { ActorComponent } from '../../../shared/actor/ActorComponent.mjs';

export const LOCAL_DERIVED_ACTOR_COMPONENT = 'localDerivedActor';

/** 标记由世界种子/Chunk 在本地构造、不能因缺席于网络快照而回收的 Actor。 */
export class LocalDerivedActorComponent extends ActorComponent {
  public constructor() {
    super(LOCAL_DERIVED_ACTOR_COMPONENT);
  }
}
