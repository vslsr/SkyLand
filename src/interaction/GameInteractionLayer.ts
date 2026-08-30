export type GameInteractionHandler = (event: Event) => boolean;

export class GameInteractionLayer {
  private readonly handlers: GameInteractionHandler[] = [];

  public addHandler(handler: GameInteractionHandler): () => void {
    this.handlers.push(handler);
    return () => {
      const index = this.handlers.indexOf(handler);
      if (index >= 0) this.handlers.splice(index, 1);
    };
  }

  public dispatch(event: Event): boolean {
    for (let index = this.handlers.length - 1; index >= 0; index -= 1) {
      if (this.handlers[index](event)) return true;
    }
    return false;
  }
}
