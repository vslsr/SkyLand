import type { ProxyId } from './RenderScene';
import type { RenderTransformBuffer } from './RenderTransformBuffer';
import {
  PARAM_SLIME_BITE_TIPS,
  PARAM_SLIME_BITE_TIP_COUNT,
  PARAM_SLIME_BITE_TIP_STRIDE,
} from './RenderVisualParams';

/**
 * 被咬住时那些突起向量的读写口。玩法侧写、渲染侧读，不 import three。
 *
 * **每有一张嘴咬着，就多一个向量**，求解器把它们各自长成一个锥再把位移相加。
 * 定长 `PARAM_SLIME_BITE_TIP_COUNT` 个槽位，没人咬的槽位写零向量。
 *
 * 这些数**不过网络**：快照里只有「谁咬着谁」这些离散关系，两边的位置又都是权威
 * 复制过来的，所以每个客户端自己算。方向取「被咬者身体中心 → 那张嘴」，长度按
 * 拉扯量算，剩下的形状全在求解器的静止外形里。
 */
export type SlimeBiteParams = Float32Array;

/** 三个尖 × 三个分量。 */
export const SLIME_BITE_TIP_VALUES = PARAM_SLIME_BITE_TIP_COUNT * PARAM_SLIME_BITE_TIP_STRIDE;

export function createSlimeBiteParams(): SlimeBiteParams {
  return new Float32Array(SLIME_BITE_TIP_VALUES);
}

/** 没有人咬着的槽位每帧写它。全零就是「没有尖」。 */
export const SLIME_BITE_AT_REST: SlimeBiteParams = createSlimeBiteParams();

export function writeSlimeBiteParams(
  transforms: RenderTransformBuffer,
  id: ProxyId,
  bite: ArrayLike<number>,
): void {
  for (let value = 0; value < SLIME_BITE_TIP_VALUES; value += 1) {
    transforms.writeParam(
      id,
      PARAM_SLIME_BITE_TIPS + value,
      value < bite.length ? bite[value] : 0,
    );
  }
}

export function readSlimeBiteParams(
  transforms: RenderTransformBuffer,
  id: ProxyId,
  out: SlimeBiteParams,
): SlimeBiteParams {
  for (let value = 0; value < SLIME_BITE_TIP_VALUES; value += 1) {
    out[value] = transforms.readParam(id, PARAM_SLIME_BITE_TIPS + value);
  }
  return out;
}
