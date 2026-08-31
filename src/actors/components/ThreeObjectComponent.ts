import * as THREE from 'three';
import { ActorComponent } from '../../../shared/actor/ActorComponent.mjs';
import type { BuoyancyRaftModel } from '../../models/ocean/createBuoyancyRaftModel';

export const THREE_OBJECT_COMPONENT = 'three-object';

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

export class ThreeObjectComponent extends ActorComponent {
  public readonly root: THREE.Group;
  public readonly visualRoot: THREE.Group;
  public readonly length: number;
  public readonly width: number;

  public constructor(model: BuoyancyRaftModel) {
    super(THREE_OBJECT_COMPONENT);
    this.root = model.root;
    this.visualRoot = model.visualRoot;
    this.length = model.length;
    this.width = model.width;
  }

  public override onEndPlay(): void {
    this.root.parent?.remove(this.root);
    disposeObject(this.root);
  }
}
