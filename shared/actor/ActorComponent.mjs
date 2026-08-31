/** Actor Component 的最小生命周期基类，不依赖浏览器、Three.js 或 Node API。 */
export class ActorComponent {
  constructor(type) {
    if (typeof type !== 'string' || type.length === 0) {
      throw new TypeError('Component type 必须是非空字符串');
    }
    this.type = type;
    this.actor = undefined;
    this.world = undefined;
    this.started = false;
  }

  attach(actor) {
    if (this.actor) throw new Error(`Component ${this.type} 已经挂载`);
    this.actor = actor;
    this.onAttach(actor);
  }

  beginPlay(world) {
    if (this.started) return;
    this.world = world;
    this.started = true;
    this.onBeginPlay(world);
  }

  endPlay() {
    if (!this.started) return;
    this.onEndPlay(this.world);
    this.started = false;
    this.world = undefined;
  }

  detach() {
    if (!this.actor) return;
    this.endPlay();
    const actor = this.actor;
    this.actor = undefined;
    this.onDetach(actor);
  }

  onAttach(_actor) {}

  onBeginPlay(_world) {}

  onEndPlay(_world) {}

  onDetach(_actor) {}
}
