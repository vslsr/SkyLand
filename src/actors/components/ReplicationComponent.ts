import { ActorComponent } from '../../../shared/actor/ActorComponent.mjs';

export const REPLICATION_COMPONENT = 'replication';

export class ReplicationComponent extends ActorComponent {
  public revision = 0;

  public constructor() {
    super(REPLICATION_COMPONENT);
  }
}
