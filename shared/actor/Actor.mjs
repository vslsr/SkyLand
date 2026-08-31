const ACTOR_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/;

/** 可在服务端和客户端 Replica 之间复用的轻量 Actor 容器。 */
export class Actor {
  constructor(id, archetypeId) {
    if (typeof id !== 'string' || !ACTOR_ID_PATTERN.test(id)) {
      throw new TypeError('Actor id 格式无效');
    }
    if (typeof archetypeId !== 'string' || archetypeId.length === 0) {
      throw new TypeError('Actor archetypeId 必须是非空字符串');
    }
    this.id = id;
    this.archetypeId = archetypeId;
    this.components = new Map();
    this.world = undefined;
    this.started = false;
    this.parentActor = undefined;
    this.childActors = new Set();
  }

  get parent() {
    return this.parentActor;
  }

  get children() {
    return Array.from(this.childActors);
  }

  setParent(parent, options = {}) {
    if (parent === this.parentActor) return false;
    if (parent === this) throw new Error(`Actor ${this.id} 不能成为自己的父节点`);
    for (let ancestor = parent; ancestor; ancestor = ancestor.parent) {
      if (ancestor === this) throw new Error(`Actor ${this.id} 的父子关系形成了循环`);
    }
    if (this.started && parent && (!parent.started || parent.world !== this.world)) {
      throw new Error('父子 Actor 必须属于同一个 ActorWorld');
    }

    const transform = this.getComponent('transform');
    this.parentActor?.childActors.delete(this);
    this.parentActor = parent;
    parent?.childActors.add(this);
    const parentTransform = parent?.getComponent('transform');
    if (transform) {
      if (options.worldPositionStays === false) transform.updateWorldFromParent(parentTransform);
      else transform.updateLocalFromParent(parentTransform);
    }
    return true;
  }

  addComponent(component) {
    if (!component || typeof component.type !== 'string') {
      throw new TypeError('Actor 只能添加有效 Component');
    }
    if (this.components.has(component.type)) {
      throw new Error(`Actor ${this.id} 已有 Component：${component.type}`);
    }
    this.components.set(component.type, component);
    component.attach(this);
    if (this.started) component.beginPlay(this.world);
    return component;
  }

  removeComponent(type) {
    const component = this.components.get(type);
    if (!component) return false;
    this.components.delete(type);
    component.detach();
    return true;
  }

  getComponent(type) {
    return this.components.get(type);
  }

  requireComponent(type) {
    const component = this.getComponent(type);
    if (!component) throw new Error(`Actor ${this.id} 缺少 Component：${type}`);
    return component;
  }

  hasComponents(...types) {
    return types.every((type) => this.components.has(type));
  }

  beginPlay(world) {
    if (this.started) return;
    this.world = world;
    this.started = true;
    for (const component of this.components.values()) component.beginPlay(world);
  }

  endPlay() {
    if (!this.started) return;
    const components = Array.from(this.components.values()).reverse();
    for (const component of components) component.endPlay();
    this.started = false;
    this.world = undefined;
  }

  dispose() {
    for (const child of this.children) child.setParent(undefined, { worldPositionStays: true });
    this.setParent(undefined, { worldPositionStays: true });
    this.endPlay();
    const components = Array.from(this.components.values()).reverse();
    this.components.clear();
    for (const component of components) component.detach();
  }
}
