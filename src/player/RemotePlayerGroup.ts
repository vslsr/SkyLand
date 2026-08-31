import * as THREE from 'three';
import type { GrassInteractionTarget } from '../grass';
import type { InterpolatedPlayerState } from '../network/protocol';
import type { ActorArchetypeDefinition } from '../scenes/data/SceneDefinition';
import { RemotePlayer } from './RemotePlayer';

/** 远端玩家集合：按快照增删改，本地玩家由 PlayerEntity 单独负责。 */
export class RemotePlayerGroup {
  public readonly root = new THREE.Group();
  private readonly players = new Map<string, RemotePlayer>();
  private archetype?: ActorArchetypeDefinition;

  public constructor(private readonly grassInteraction: GrassInteractionTarget) {
    this.root.name = 'remote-players';
  }

  public get size(): number {
    return this.players.size;
  }

  public configure(archetype: ActorArchetypeDefinition): void {
    if (this.archetype?.id !== archetype.id) this.clear();
    this.archetype = archetype;
  }

  public sync(states: InterpolatedPlayerState[], localPlayerId?: string): void {
    const archetype = this.archetype;
    if (!archetype) return;
    const seen = new Set<string>();

    for (const state of states) {
      if (state.id === localPlayerId) continue;
      seen.add(state.id);
      const existing = this.players.get(state.id);
      if (existing) {
        existing.applyState(state);
        continue;
      }
      const created = new RemotePlayer(state, this.grassInteraction, archetype);
      this.players.set(state.id, created);
      this.root.add(created.object3D);
    }

    for (const [id, player] of this.players) {
      if (seen.has(id)) continue;
      player.dispose();
      this.players.delete(id);
    }
  }

  public update(deltaSeconds: number, elapsedSeconds: number): void {
    for (const player of this.players.values()) player.update(deltaSeconds, elapsedSeconds);
  }

  public clear(): void {
    for (const player of this.players.values()) player.dispose();
    this.players.clear();
  }
}
