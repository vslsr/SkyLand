/**
 * Actor 的生命周期所有者。更新期间发生的增删会排队到本轮 System 完成后，
 * 避免迭代中的集合突变造成漏更新或重复更新。
 */
export class ActorWorld {
  constructor(context = {}) {
    this.context = context;
    this.actorMap = new Map();
    this.componentIndex = new Map();
    this.queryCache = new Map();
    this.actorListCache = undefined;
    this.hierarchyRoots = new Set();
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

  removeActor(actorId, options = {}) {
    const removalOptions = this.validateRemovalOptions(options);
    if (this.updating) {
      const exists = this.actorMap.has(actorId);
      this.pendingMutations.push(() => this.removeActorNow(actorId, removalOptions));
      return exists;
    }
    return this.removeActorNow(actorId, removalOptions);
  }

  removeActorTree(actorId) {
    return this.removeActor(actorId, { childPolicy: 'cascade' });
  }

  getActor(actorId) {
    return this.actorMap.get(actorId);
  }

  setActorParent(actorId, parentActorId, options = {}) {
    const actor = this.getActor(actorId);
    if (!actor) throw new Error(`不存在 Actor：${actorId}`);
    const parent = parentActorId ? this.getActor(parentActorId) : undefined;
    if (parentActorId && !parent) throw new Error(`不存在父 Actor：${parentActorId}`);
    const changed = actor.setParent(parent, options);
    if (changed) this.rebuildHierarchyRoots();
    this.resolveTransforms();
    return changed;
  }

  actors() {
    if (!this.actorListCache) this.actorListCache = Array.from(this.actorMap.values());
    return this.actorListCache;
  }

  query(...componentTypes) {
    if (componentTypes.length === 0) return this.actors();
    const normalizedTypes = Array.from(new Set(componentTypes)).sort();
    const cacheKey = normalizedTypes.join('\u0000');
    const cached = this.queryCache.get(cacheKey);
    if (cached) return cached;

    let candidates;
    for (const type of normalizedTypes) {
      const indexed = this.componentIndex.get(type);
      if (!indexed) {
        const empty = [];
        this.queryCache.set(cacheKey, empty);
        return empty;
      }
      if (!candidates || indexed.size < candidates.size) candidates = indexed;
    }
    const result = Array.from(candidates).filter((actor) => actor.hasComponents(...normalizedTypes));
    this.queryCache.set(cacheKey, result);
    return result;
  }

  /** Actor 启动后动态增删 Component 时同步查询索引。 */
  onActorComponentChanged(actor, componentType, added) {
    if (this.actorMap.get(actor.id) !== actor) return;
    if (added) this.indexComponent(actor, componentType);
    else this.componentIndex.get(componentType)?.delete(actor);
    this.queryCache.clear();
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

  resolveTransforms(options = {}) {
    const visit = (actor, parentTransform) => {
      const transform = actor.getComponent('transform');
      if (transform) {
        if (parentTransform) transform.updateWorldFromParent(parentTransform);
        else transform.updateLocalFromParent(undefined);
      }
      for (const child of actor.children) visit(child, transform ?? parentTransform);
    };
    const roots = options.attachedOnly ? this.hierarchyRoots : this.actorMap.values();
    for (const actor of roots) {
      if (!actor.parent && (!options.attachedOnly || actor.childActors.size > 0)) {
        visit(actor, undefined);
      }
    }
  }

  clear() {
    this.pendingMutations.length = 0;
    const actors = Array.from(this.actorMap.values()).reverse();
    this.actorMap.clear();
    this.componentIndex.clear();
    this.queryCache.clear();
    this.actorListCache = undefined;
    this.hierarchyRoots.clear();
    for (const actor of actors) actor.dispose();
  }

  dispose() {
    this.clear();
    this.systems.length = 0;
  }

  addActorNow(actor) {
    if (this.actorMap.has(actor.id)) throw new Error(`Actor id 重复：${actor.id}`);
    this.actorMap.set(actor.id, actor);
    for (const componentType of actor.components.keys()) this.indexComponent(actor, componentType);
    this.invalidateActorCollections();
    actor.beginPlay(this);
    if (!actor.parent && actor.childActors.size > 0) this.hierarchyRoots.add(actor);
  }

  removeActorNow(actorId, options) {
    const actor = this.actorMap.get(actorId);
    if (!actor) return false;
    if (options.childPolicy === 'detach') {
      for (const child of actor.children) {
        child.setParent(undefined, { worldPositionStays: true });
      }
      this.deindexActor(actor);
      this.actorMap.delete(actor.id);
      this.invalidateActorCollections();
      actor.dispose();
      this.rebuildHierarchyRoots();
      return true;
    }
    const subtree = [];
    const collect = (current) => {
      for (const child of current.children) collect(child);
      subtree.push(current);
    };
    collect(actor);
    for (const current of subtree) {
      this.deindexActor(current);
      this.actorMap.delete(current.id);
    }
    this.invalidateActorCollections();
    for (const current of subtree) current.dispose();
    this.rebuildHierarchyRoots();
    return true;
  }

  validateRemovalOptions(options) {
    const childPolicy = options.childPolicy ?? 'detach';
    if (childPolicy !== 'detach' && childPolicy !== 'cascade') {
      throw new TypeError('Actor 删除策略 childPolicy 只能是 detach 或 cascade');
    }
    return { childPolicy };
  }

  flushMutations() {
    const mutations = this.pendingMutations.splice(0);
    for (const mutation of mutations) mutation();
  }

  indexComponent(actor, componentType) {
    let actors = this.componentIndex.get(componentType);
    if (!actors) {
      actors = new Set();
      this.componentIndex.set(componentType, actors);
    }
    actors.add(actor);
  }

  deindexActor(actor) {
    for (const componentType of actor.components.keys()) {
      const actors = this.componentIndex.get(componentType);
      actors?.delete(actor);
      if (actors?.size === 0) this.componentIndex.delete(componentType);
    }
  }

  invalidateActorCollections() {
    this.actorListCache = undefined;
    this.queryCache.clear();
  }

  rebuildHierarchyRoots() {
    this.hierarchyRoots.clear();
    for (const actor of this.actorMap.values()) {
      if (!actor.parent && actor.childActors.size > 0) this.hierarchyRoots.add(actor);
    }
  }
}
