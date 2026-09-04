import * as THREE from 'three';
import type { FillMaterialEnvironment } from '../../materials/createFillMaterial';
import { createActorVisualModel } from '../../models/actors/createActorVisualModel';
import type { BuildPreviewState } from '../RenderScene';
import { renderAssets } from '../renderAssets';

interface Ghost {
  readonly pieceId: string;
  readonly root: THREE.Group;
  readonly meshes: THREE.Mesh[];
  readonly lines: THREE.Line[];
}

function disposeMaterial(material: THREE.Material | THREE.Material[]): void {
  for (const entry of Array.isArray(material) ? material : [material]) {
    if (!renderAssets.owns(entry)) entry.dispose();
  }
}

/**
 * 建造幽灵：玩家正要放的那一件，半透明地摆在吸附到的格子上，绿的能放、红的不能。
 *
 * 它不是 proxy——没有 Actor、没有槽位，是纯粹的选择辅助（和悬停高亮盒一类）。
 * 模型用和真件同一个工厂建，所以幽灵长得和放下去之后一模一样；只把材质换成两套
 * 共享的透明材质，换件时才重建一次，位姿每帧改。
 */
export class ThreeBuildPreviewVisual {
  private ghost?: Ghost;
  private valid?: boolean;
  private readonly validFill = new THREE.MeshBasicMaterial({
    color: 0x9fd9b3, transparent: true, opacity: 0.42, depthWrite: false,
  });
  private readonly invalidFill = new THREE.MeshBasicMaterial({
    color: 0xe19a8b, transparent: true, opacity: 0.42, depthWrite: false,
  });
  private readonly validLine = new THREE.LineBasicMaterial({
    color: 0x2f7d52, transparent: true, opacity: 0.95, depthTest: false,
  });
  private readonly invalidLine = new THREE.LineBasicMaterial({
    color: 0xa4402f, transparent: true, opacity: 0.95, depthTest: false,
  });

  public apply(
    state: BuildPreviewState | undefined,
    environment: FillMaterialEnvironment,
    parent: THREE.Object3D,
  ): void {
    if (!state) {
      if (this.ghost) this.ghost.root.visible = false;
      return;
    }
    if (this.ghost?.pieceId !== state.pieceId) {
      this.disposeGhost();
      this.ghost = this.build(state, environment);
      this.valid = undefined;
      parent.add(this.ghost.root);
    }
    const ghost = this.ghost;
    if (this.valid !== state.valid) {
      this.valid = state.valid;
      for (const mesh of ghost.meshes) mesh.material = state.valid ? this.validFill : this.invalidFill;
      for (const line of ghost.lines) line.material = state.valid ? this.validLine : this.invalidLine;
    }
    ghost.root.position.set(state.x, state.y, state.z);
    ghost.root.rotation.y = state.yaw;
    ghost.root.visible = true;
  }

  public get visible(): boolean {
    return this.ghost?.root.visible === true;
  }

  public dispose(): void {
    this.disposeGhost();
    this.validFill.dispose();
    this.invalidFill.dispose();
    this.validLine.dispose();
    this.invalidLine.dispose();
  }

  private build(state: BuildPreviewState, environment: FillMaterialEnvironment): Ghost {
    const model = createActorVisualModel(environment, state.render);
    model.root.name = `build-preview-${state.pieceId}`;
    const meshes: THREE.Mesh[] = [];
    const lines: THREE.Line[] = [];
    model.root.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        // 工厂给的填充材质是这个模型独占的；幽灵不用它，当场释放。
        disposeMaterial(object.material);
        object.material = this.invalidFill;
        object.renderOrder = 900;
        meshes.push(object);
      } else if (object instanceof THREE.Line) {
        disposeMaterial(object.material);
        object.material = this.invalidLine;
        object.renderOrder = 901;
        lines.push(object);
      }
    });
    return { pieceId: state.pieceId, root: model.root, meshes, lines };
  }

  private disposeGhost(): void {
    const ghost = this.ghost;
    if (!ghost) return;
    ghost.root.parent?.remove(ghost.root);
    // 材质是这里共享的四支，这一步只放几何。
    ghost.root.traverse((object) => {
      const geometry = (object as { geometry?: THREE.BufferGeometry }).geometry;
      if (geometry && !renderAssets.owns(geometry)) geometry.dispose();
    });
    this.ghost = undefined;
    this.valid = undefined;
  }
}
