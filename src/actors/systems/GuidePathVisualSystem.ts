import type { ActorWorld } from '../../../shared/actor/ActorWorld.mjs';
import { GUIDE_PATH_COMPONENT } from '../../../shared/actor/components/GuidePathComponent.mjs';
import {
  GUIDE_PATH_VISUAL_COMPONENT,
  type GuidePathVisualComponent,
} from '../components/GuidePathVisualComponent';

export class GuidePathVisualSystem {
  public update(world: ActorWorld, deltaSeconds: number): void {
    for (const actor of world.query(GUIDE_PATH_COMPONENT, GUIDE_PATH_VISUAL_COMPONENT)) {
      const visual = actor.requireComponent(
        GUIDE_PATH_VISUAL_COMPONENT,
      ) as GuidePathVisualComponent;
      visual.sync();
      visual.update(deltaSeconds);
    }
  }
}
