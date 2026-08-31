import * as THREE from 'three';
import { FOG_FAR, FOG_NEAR, PAPER_COLOR } from '../materials/atmosphere';

/**
 * 建立空的线稿场景。
 *
 * 这里只负责氛围：底色与雾。地面、树木、草丛不再一次性铺满，
 * 它们由 ChunkStreamer 按玩家位置流式加载，场景内容随玩家移动进出。
 */
export function createLineArtScene(): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PAPER_COLOR);
  scene.fog = new THREE.Fog(PAPER_COLOR, FOG_NEAR, FOG_FAR);
  return scene;
}
