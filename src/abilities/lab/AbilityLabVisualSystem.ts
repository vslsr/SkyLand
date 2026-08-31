import * as THREE from 'three';
import { createAbilityLabModel } from '../../models/abilityLab';
import type { AbilityLabAction, AbilityLabViewState } from './AbilityLabSimulation';

interface AbilityProjectile {
  readonly object: THREE.Group;
  readonly start: THREE.Vector3;
  readonly end: THREE.Vector3;
  readonly duration: number;
  elapsed: number;
}

function disposeObject(root: THREE.Object3D): void {
  root.traverse((object) => {
    const renderable = object as THREE.Mesh & { material?: THREE.Material | THREE.Material[] };
    renderable.geometry?.dispose();
    if (Array.isArray(renderable.material)) {
      for (const material of renderable.material) material.dispose();
    } else {
      renderable.material?.dispose();
    }
  });
}

export class AbilityLabVisualSystem {
  private readonly model = createAbilityLabModel();
  private readonly projectiles: AbilityProjectile[] = [];
  private hitPulse = 0;
  private ragePulse = 0;

  public get root(): THREE.Group {
    return this.model.root;
  }

  public play(
    action: Exclude<AbilityLabAction, 'reset'>,
    source: THREE.Vector3,
    succeeded: boolean,
  ): void {
    if (!succeeded) return;
    if (action === 'arcane' || action === 'burn') {
      this.spawnProjectile(action, source);
      this.hitPulse = action === 'arcane' ? 1 : 0.55;
    } else if (action === 'rage') {
      this.ragePulse = 1;
    }
  }

  public update(
    deltaSeconds: number,
    elapsedSeconds: number,
    state: AbilityLabViewState,
    source: THREE.Vector3,
  ): void {
    this.model.casterRune.position.set(source.x, 0, source.z);
    this.model.casterRune.rotation.y = elapsedSeconds * 0.18;

    const healthRatio = Math.max(0, state.target.health / state.target.maximumHealth);
    const targetPulse = 1 + this.hitPulse * 0.12;
    this.model.targetCore.scale.setScalar(Math.max(0.72, targetPulse * (0.86 + healthRatio * 0.14)));
    this.model.targetCore.rotation.y = elapsedSeconds * (0.35 + healthRatio * 0.25);
    this.model.targetCore.position.y = 1.72 + Math.sin(elapsedSeconds * 2.1) * 0.035;
    this.model.target.rotation.z = healthRatio <= 0 ? -0.5 : Math.sin(elapsedSeconds * 0.7) * 0.008;

    const burning = state.target.tags.some((tag) => tag === 'State.Burning');
    this.model.burningAura.visible = burning;
    if (burning) {
      for (const child of this.model.burningAura.children) {
        const phase = Number(child.userData.phase ?? 0);
        child.scale.y = 0.72 + Math.sin(elapsedSeconds * 7 + phase * Math.PI * 2) * 0.24;
        child.position.y = Number(child.userData.baseY ?? child.position.y)
          + Math.sin(elapsedSeconds * 5 + phase * 10) * 0.035;
      }
    }

    const raging = state.caster.tags.some((tag) => tag === 'State.Buffed.Rage');
    this.model.rageRings.visible = raging;
    if (raging) {
      const scale = 1 + Math.sin(elapsedSeconds * 4) * 0.035 + this.ragePulse * 0.08;
      this.model.rageRings.scale.setScalar(scale);
      this.model.rageRings.rotation.y = -elapsedSeconds * 0.7;
    }
    this.model.silenceCage.visible = state.caster.tags.some((tag) => tag === 'State.Silenced');
    this.model.silenceCage.rotation.y = elapsedSeconds * 0.32;

    this.hitPulse = Math.max(0, this.hitPulse - deltaSeconds * 4.5);
    this.ragePulse = Math.max(0, this.ragePulse - deltaSeconds * 3.5);
    this.updateProjectiles(deltaSeconds);
  }

  public reset(): void {
    for (const projectile of this.projectiles.splice(0)) {
      projectile.object.parent?.remove(projectile.object);
      disposeObject(projectile.object);
    }
    this.hitPulse = 0;
    this.ragePulse = 0;
  }

  public dispose(): void {
    this.reset();
    this.root.parent?.remove(this.root);
    disposeObject(this.root);
  }

  private spawnProjectile(action: 'arcane' | 'burn', source: THREE.Vector3): void {
    const color = action === 'arcane' ? 0x9678c3 : 0xdb7541;
    const object = new THREE.Group();
    const geometry = action === 'arcane'
      ? new THREE.OctahedronGeometry(0.16)
      : new THREE.IcosahedronGeometry(0.18, 1);
    const fill = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 });
    const line = new THREE.LineBasicMaterial({ color: 0x2b2522, transparent: true, opacity: 0.84 });
    object.add(
      new THREE.Mesh(geometry, fill),
      new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 1), line),
    );
    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(0.28, 10, 8),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
      }),
    );
    object.add(glow);
    this.model.projectileLayer.add(object);
    this.projectiles.push({
      object,
      start: new THREE.Vector3(source.x, 0.68, source.z),
      end: this.model.targetPoint.clone(),
      duration: action === 'arcane' ? 0.34 : 0.52,
      elapsed: 0,
    });
  }

  private updateProjectiles(deltaSeconds: number): void {
    for (let index = this.projectiles.length - 1; index >= 0; index -= 1) {
      const projectile = this.projectiles[index];
      projectile.elapsed += deltaSeconds;
      const progress = Math.min(1, projectile.elapsed / projectile.duration);
      const eased = 1 - (1 - progress) * (1 - progress);
      projectile.object.position.lerpVectors(projectile.start, projectile.end, eased);
      projectile.object.position.y += Math.sin(progress * Math.PI) * 0.75;
      projectile.object.rotation.x += deltaSeconds * 7;
      projectile.object.rotation.y += deltaSeconds * 9;
      if (progress < 1) continue;
      this.projectiles.splice(index, 1);
      projectile.object.parent?.remove(projectile.object);
      disposeObject(projectile.object);
    }
  }
}
