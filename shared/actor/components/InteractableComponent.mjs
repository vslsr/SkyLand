import { ActorComponent } from '../ActorComponent.mjs';

export const INTERACTABLE_COMPONENT = 'interactable';

/** 客户端展示交互提示，服务端仍以权威载具位置重新校验距离。 */
export class InteractableComponent extends ActorComponent {
  constructor(definition) {
    super(INTERACTABLE_COMPONENT);
    this.action = definition.action;
    this.label = definition.label;
    this.maximumDistance = definition.maximumDistance;
    this.enabled = true;
    this.revision = 0;
  }
}
