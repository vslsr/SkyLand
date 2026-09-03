import * as THREE from 'three';
import type { ThreeMeshProxy } from './ThreeMeshProxy';
import { releaseOwnResources } from '../../render/renderAssets';
import { createAbilityLabModel } from '../../models/abilityLab';
import type { AbilityLabAction, AbilityLabViewState } from '../../abilities/lab/AbilityLabSimulation';

interface AbilityProjectile {
  readonly object: THREE.Group;
  readonly start: THREE.Vector3;
  readonly end: THREE.Vector3;
  readonly duration: number;
  elapsed: number;
}

function disposeObject(root: THREE.Object3D): void {
  root.traverse(releaseOwnResources);
}

export class ThreeAbilityLabVisual {
  private readonly model = createAbilityLabModel();
  private readonly projectiles: AbilityProjectile[] = [];
  private readonly targetPosition = new THREE.Vector3();
  private targetRender?: ThreeMeshProxy;
  private hitPulse = 0;
  private ragePulse = 0;

  public get root(): THREE.Group {
    return this.model.root;
  }

  public bindTarget(targetRender: ThreeMeshProxy): void {
    if (!targetRender.abilityTargetRig) {
      throw new Error('能力实验室目标 Actor 缺少 abilityTargetRig');
    }
    this.unbindTarget();
    this.targetRender = targetRender;
    this.resetTargetVisual();
  }

  public unbindTarget(): void {
    this.resetTargetVisual();
    this.targetRender = undefined;
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
    const targetRig = this.targetRender?.abilityTargetRig;
    if (!targetRig) return;
    this.model.casterRune.position.set(source.x, 0, source.z);
    this.model.casterRune.rotation.y = elapsedSeconds * 0.18;

    const healthRatio = Math.max(0, state.target.health / state.target.maximumHealth);
    const targetPulse = 1 + this.hitPulse * 0.12;
    targetRig.core.scale.setScalar(Math.max(0.72, targetPulse * (0.86 + healthRatio * 0.14)));
    targetRig.core.rotation.y = elapsedSeconds * (0.35 + healthRatio * 0.25);
    const coreBaseY = Number(targetRig.core.userData.baseY ?? targetRig.core.position.y);
    targetRig.core.position.y = coreBaseY + Math.sin(elapsedSeconds * 2.1) * 0.035;
    targetRig.targetRoot.rotation.z = healthRatio <= 0
      ? -0.5
      : Math.sin(elapsedSeconds * 0.7) * 0.008;

    const burning = state.target.tags.some((tag) => tag === 'State.Burning');
    targetRig.burningAura.visible = burning;
    if (burning) {
      for (const child of targetRig.burningAura.children) {
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
    this.resetTargetVisual();
  }

  public dispose(): void {
    this.reset();
    this.unbindTarget();
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
    const targetPoint = this.targetRender?.abilityTargetRig?.targetPoint;
    if (!targetPoint) {
      object.parent?.remove(object);
      disposeObject(object);
      return;
    }
    targetPoint.getWorldPosition(this.targetPosition);
    this.projectiles.push({
      object,
      start: new THREE.Vector3(source.x, 0.68, source.z),
      end: this.targetPosition.clone(),
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

  private resetTargetVisual(): void {
    const rig = this.targetRender?.abilityTargetRig;
    if (!rig) return;
    rig.targetRoot.rotation.z = 0;
    rig.core.scale.setScalar(1);
    rig.core.rotation.y = 0;
    if (rig.core.userData.baseY !== undefined) {
      rig.core.position.y = Number(rig.core.userData.baseY);
    }
    rig.burningAura.visible = false;
  }
}
