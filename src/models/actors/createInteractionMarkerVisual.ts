import * as THREE from 'three';

export interface InteractionMarkerVisual {
  readonly root: THREE.Group;
  dispose(): void;
}

function setOverlayMaterial(material: THREE.Material): void {
  material.depthTest = false;
  material.depthWrite = false;
}

/** 无 DOM/Canvas 依赖的线稿风 E 键世界标记，可在 Node 客户端测试中安全创建。 */
export function createInteractionMarkerVisual(): InteractionMarkerVisual {
  const root = new THREE.Group();
  root.name = 'actor-interaction-marker';
  root.visible = false;
  root.frustumCulled = false;

  const plateGeometry = new THREE.PlaneGeometry(0.46, 0.46);
  const plateMaterial = new THREE.MeshBasicMaterial({
    color: 0xf5ecd7,
    transparent: true,
    opacity: 0.96,
    fog: false,
  });
  setOverlayMaterial(plateMaterial);
  const plate = new THREE.Mesh(plateGeometry, plateMaterial);
  plate.renderOrder = 1000;
  root.add(plate);

  const borderGeometry = new THREE.EdgesGeometry(plateGeometry);
  const inkMaterial = new THREE.LineBasicMaterial({ color: 0x29231f, fog: false });
  setOverlayMaterial(inkMaterial);
  const border = new THREE.LineSegments(borderGeometry, inkMaterial);
  border.position.z = 0.006;
  border.renderOrder = 1001;
  root.add(border);

  const glyphGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0.1, 0.14, 0.012),
    new THREE.Vector3(-0.09, 0.14, 0.012),
    new THREE.Vector3(-0.09, 0.14, 0.012),
    new THREE.Vector3(-0.09, -0.14, 0.012),
    new THREE.Vector3(-0.09, 0, 0.012),
    new THREE.Vector3(0.07, 0, 0.012),
    new THREE.Vector3(-0.09, -0.14, 0.012),
    new THREE.Vector3(0.1, -0.14, 0.012),
  ]);
  const glyph = new THREE.LineSegments(glyphGeometry, inkMaterial);
  glyph.renderOrder = 1002;
  root.add(glyph);

  return {
    root,
    dispose(): void {
      root.parent?.remove(root);
      glyphGeometry.dispose();
      borderGeometry.dispose();
      plateGeometry.dispose();
      inkMaterial.dispose();
      plateMaterial.dispose();
    },
  };
}
