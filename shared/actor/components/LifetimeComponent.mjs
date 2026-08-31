import { ActorComponent } from '../ActorComponent.mjs';

export const LIFETIME_COMPONENT = 'lifetime';

/** 使用绝对服务端时间，Actor 休眠成记录后也能按时过期。 */
export class LifetimeComponent extends ActorComponent {
  constructor(definition = {}) {
    super(LIFETIME_COMPONENT);
    const spawnedAt = Number(definition.spawnedAt) || 0;
    const lifetimeSeconds = Math.max(0, Number(definition.lifetimeSeconds) || 0);
    this.spawnedAt = spawnedAt;
    this.expiresAt = lifetimeSeconds > 0 ? spawnedAt + lifetimeSeconds : Number.POSITIVE_INFINITY;
  }
}
