import * as THREE from 'three';
import type { DropRollVisualRig } from '../../models/actors/ActorVisualModel';
import type { ProxyId } from '../RenderScene';
import type { RenderTransformBuffer } from '../RenderTransformBuffer';
import {
  PARAM_DROP_RADIUS,
  PARAM_DROP_ROTATION_W,
  PARAM_DROP_ROTATION_X,
  PARAM_DROP_ROTATION_Y,
  PARAM_DROP_ROTATION_Z,
  PARAM_ELASTIC_DETACHED,
} from '../RenderVisualParams';

/**
 * 把脱落物件摆成刚体解算出的姿态（实现路径文档 §1.75）。
 *
 * 拔断之前，物件是长在地上的：姿态由 Transform 的 yaw 加上弹性拉伸表现决定。
 * 拔断之后它是一颗自由刚体，躺着还是立着由服务端的四元数说了算——这一位没有
 * 复制过来的时候，蘑菇不管怎么弹、怎么滚，落地永远是笔直站着的。
 *
 * 旋转必须发生在刚体球心上：刚体球心在 Actor 原点上方 radius 处，而模型是以
 * 菌柄根部为原点建的。枢轴抬上去、本体压回来，蘑菇才是原地翻倒，而不是绕着
 * 脚跟甩出去半米。
 *
 * 这里以前是 `ActorDropRollSystem`。它读的五个数（半径与四元数）都是服务端复制
 * 过来的定长标量，所以直接走参数段。
 */
export class ThreeDropRollVisual {
  private readonly quaternion = new THREE.Quaternion();

  public constructor(
    private readonly id: ProxyId,
    private readonly rig: DropRollVisualRig,
  ) {}

  public update(transforms: RenderTransformBuffer): void {
    const detached = transforms.readParam(this.id, PARAM_ELASTIC_DETACHED) !== 0;
    const radius = transforms.readParam(this.id, PARAM_DROP_RADIUS);
    if (!detached || radius <= 0) {
      // 还长在地上：枢轴保持单位变换，姿态完全交回给弹性拉伸表现。
      if (this.rig.pivotRoot.position.y !== 0) {
        this.rig.pivotRoot.position.y = 0;
        this.rig.bodyRoot.position.y = 0;
        this.rig.pivotRoot.quaternion.identity();
      }
      return;
    }
    this.rig.pivotRoot.position.y = radius;
    this.rig.bodyRoot.position.y = -radius;
    this.quaternion.set(
      transforms.readParam(this.id, PARAM_DROP_ROTATION_X),
      transforms.readParam(this.id, PARAM_DROP_ROTATION_Y),
      transforms.readParam(this.id, PARAM_DROP_ROTATION_Z),
      transforms.readParam(this.id, PARAM_DROP_ROTATION_W),
    );
    this.rig.pivotRoot.quaternion.copy(this.quaternion);
  }
}
