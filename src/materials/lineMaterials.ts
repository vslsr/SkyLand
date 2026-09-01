import * as THREE from 'three';

export const OUTLINE_MATERIAL = new THREE.LineBasicMaterial({
  color: 0x171614,
});

export const GROUND_GRID_MATERIAL = new THREE.LineBasicMaterial({
  color: 0x9d9a90,
  transparent: true,
  opacity: 0.34,
  fog: false,
});
