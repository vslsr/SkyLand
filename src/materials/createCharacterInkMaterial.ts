import * as THREE from 'three';

/**
 * 角色墨记层的基准色：纯黑。
 *
 * 腿、眼睛、嘴不是身体的一部分颜色，而是「这是谁、它朝哪儿、它在走路」的读图
 * 线索。线索只有一种颜色时最好读，所以这一层不跟着配色走，永远是同一道黑。
 */
export const CHARACTER_INK_COLOR = '#000000';

export interface CharacterInkMaterialOptions {
  /**
   * 是否参与深度测试。默认参与；只有贴在可变形蒙皮外侧的眼睛需要关掉它，
   * 否则蒙皮鼓起来的一帧会把眼睛吞掉。
   */
  depthTest?: boolean;
  /**
   * 是否写深度。默认写；叠在半透明软体上的墨记要关掉它，写深度会在身体上
   * 割出一圈硬边。
   */
  depthWrite?: boolean;
}

/**
 * 角色墨记层的材质：不受光照、不受雾、不受色调映射，画出来永远是给定的那个色。
 *
 * **为什么要单独一支材质**。墨记本来就用不参与光照的 `MeshBasicMaterial`，可
 * 真正在夜里把腿吃掉的是**距离雾**——`scene.fog` 对 basic 材质一样生效，而雾天
 * 会把雾压进十几米内（见 `WeatherSystem.updateEnvironment`），镜头前这只史莱姆
 * 的腿于是被大比例混向雾色。入夜后纸面本来就沉成一片中灰，被雾提亮的黑腿落在
 * 上面，剩下的就是几道分不出形状的浅痕。关掉 `fog` 之后这一层与天色彻底无关：
 * 什么时刻、什么天气，都是同一道纯黑的剪影。
 *
 * `toneMapped: false` 是同一个道理的另一半：曝光调整会把纯黑抬成深灰。
 *
 * **和 `lineMaterials` 里那两支共享墨线正好相反**。那两支画的是**环境**的墨
 * （物件轮廓、地面网格），纸面沉下去时它们必须跟着浮上来，否则线稿整张糊掉；
 * 这一支画的是**角色**的墨，它不参与那套换墨，因为角色始终是画面的主体，
 * 不该跟着背景一起变淡。
 *
 * 每个模型各建一份实例（而不是像共享墨线那样登记进所有权表）：这些材质随模型
 * 生灭，`disposeObject` 的遍历式释放正好能把它们收掉。
 */
export function createCharacterInkMaterial(
  color: THREE.ColorRepresentation = CHARACTER_INK_COLOR,
  options: CharacterInkMaterialOptions = {},
): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    depthTest: options.depthTest ?? true,
    depthWrite: options.depthWrite ?? true,
    fog: false,
    toneMapped: false,
  });
}

/** 墨记层里用线段画的那部分（比如嘴），约束与上面完全一致。 */
export function createCharacterInkLineMaterial(
  color: THREE.ColorRepresentation = CHARACTER_INK_COLOR,
): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({
    color,
    fog: false,
    toneMapped: false,
  });
}
