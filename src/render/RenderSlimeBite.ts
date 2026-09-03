import type { ProxyId } from './RenderScene';
import type { RenderTransformBuffer } from './RenderTransformBuffer';
import {
  PARAM_SLIME_BITE_X,
  PARAM_SLIME_BITE_Y,
  PARAM_SLIME_BITE_Z,
} from './RenderVisualParams';

/**
 * 被咬住时那个突起向量的读写口。玩法侧写、渲染侧读，不 import three。
 *
 * 只有三个数，而且**不过网络**：快照里只有「谁咬着谁」这一个离散状态，两边的
 * 位置又都是权威复制过来的，所以每个客户端自己算。方向取「被咬者身体中心 →
 * 咬人者的嘴」，长度按拉扯量算，剩下的形状全在求解器的静止外形里。
 */
export interface SlimeBiteParams {
  x: number;
  y: number;
  z: number;
}

/** 没有人咬着的槽位每帧写它。零向量就是「没有尖」。 */
export const SLIME_BITE_AT_REST: SlimeBiteParams = { x: 0, y: 0, z: 0 };

export function writeSlimeBiteParams(
  transforms: RenderTransformBuffer,
  id: ProxyId,
  bite: SlimeBiteParams,
): void {
  transforms.writeParam(id, PARAM_SLIME_BITE_X, bite.x);
  transforms.writeParam(id, PARAM_SLIME_BITE_Y, bite.y);
  transforms.writeParam(id, PARAM_SLIME_BITE_Z, bite.z);
}

export function readSlimeBiteParams(
  transforms: RenderTransformBuffer,
  id: ProxyId,
  out: SlimeBiteParams,
): SlimeBiteParams {
  out.x = transforms.readParam(id, PARAM_SLIME_BITE_X);
  out.y = transforms.readParam(id, PARAM_SLIME_BITE_Y);
  out.z = transforms.readParam(id, PARAM_SLIME_BITE_Z);
  return out;
}
