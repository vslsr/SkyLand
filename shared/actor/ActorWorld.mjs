/**
 * Actor 的生命周期所有者。更新期间发生的增删会排队到本轮 System 完成后，
 * 避免迭代中的集合突变造成漏更新或重复更新。
 */
export class ActorWorld {
  constructor(context = {}) {
    this.context = context;
    this.actorMap = new Map();
    this.systems = [];
    this.pendingMutations = [];
    this.updating = false;
  }

  get size() {
    return this.actorMap.size;
  }

  addSystem(system) {
    if (!system || typeof system.update !== 'function') {
      throw new TypeError('Actor System 必须提供 update(world, deltaSeconds, elapsedSeconds)');
    }
    this.systems.push(system);
    return system;
  }

  addActor(actor) {
    if (this.updating) {
      this.pendingMutations.push(() => this.addActorNow(actor));
    } else {
      this.addActorNow(actor);
    }
    return actor;
  }

  removeActor(actorId) {
    if (this.updating) {
      const exists = this.actorMap.has(actorId);
      this.pendingMutations.push(() => this.removeActorNow(actorId));
      return exists;
    }
    return this.removeActorNow(actorId);
  }

  getActor(actorId) {
    return this.actorMap.get(actorId);
  }

  actors() {
    return Array.from(this.actorMap.values());
  }

  query(...componentTypes) {
    return this.actors().filter((actor) => actor.hasComponents(...componentTypes));
  }

  update(deltaSeconds, elapsedSeconds) {
    this.updating = true;
    try {
      for (const system of this.systems) system.update(this, deltaSeconds, elapsedSeconds);
    } finally {
      this.updating = false;
      this.flushMutations();
    }
  }

  clear() {
    this.pendingMutations.length = 0;
    const actors = Array.from(this.actorMap.values()).reverse();
    this.actorMap.clear();
    for (const actor of actors) actor.dispose();
  }

  dispose() {
    this.clear();
    this.systems.length = 0;
  }

  addActorNow(actor) {
    if (this.actorMap.has(actor.id)) throw new Error(`Actor id 重复：${actor.id}`);
    this.actorMap.set(actor.id, actor);
    actor.beginPlay(this);
  }

  removeActorNow(actorId) {
    const actor = this.actorMap.get(actorId);
    if (!actor) return false;
    this.actorMap.delete(actorId);
    actor.dispose();
    return true;
  }

  flushMutations() {
    const mutations = this.pendingMutations.splice(0);
    for (const mutation of mutations) mutation();
  }
}
