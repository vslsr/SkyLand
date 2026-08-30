import * as THREE from 'three';

const PAPER_COLOR = 0xfdfbf6;

/**
 * 只负责场景的底色与雾。地面、树木和草丛全部由 ChunkStreamer 按玩家位置
 * 动态挂载，所以这里不再放任何固定内容。
 */
export function createLineArtScene(): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PAPER_COLOR);
  scene.fog = new THREE.Fog(PAPER_COLOR, 22, 52);
  return scene;
}
