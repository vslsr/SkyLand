/**
 * A* 的开集。
 *
 * 存的是**节点下标**（`NavRegion` 的线性下标），分数另存一份，所以整个堆是
 * 两条定长 TypedArray，一次搜索里一个对象都不分配。
 *
 * 带 decrease-key（`positions` 反查表）而不是「重复压入 + 弹出时跳过陈旧项」：
 * 后者写起来短，但堆的长度会涨到边数而不是点数，而这一层存在的全部理由就是
 * 让内存与窗口大小成正比、与搜索的曲折程度无关。
 */

export class BinaryHeap {
  /** @param {number} capacity 节点总数；堆长度不会超过它 */
  constructor(capacity) {
    this.items = new Int32Array(capacity);
    this.scores = new Float64Array(capacity);
    /** 节点下标 → 它在堆里的位置；-1 表示不在堆里。 */
    this.positions = new Int32Array(capacity).fill(-1);
    this.size = 0;
  }

  get isEmpty() {
    return this.size === 0;
  }

  /** 只清掉还在堆里的那些反查项，成本与堆的长度成正比而不是与容量成正比。 */
  clear() {
    for (let index = 0; index < this.size; index += 1) this.positions[this.items[index]] = -1;
    this.size = 0;
  }

  /** 压入，或者在已有节点上下调分数。分数不降时什么都不做。 */
  push(item, score) {
    const existing = this.positions[item];
    if (existing >= 0) {
      if (score >= this.scores[existing]) return false;
      this.scores[existing] = score;
      this.siftUp(existing);
      return true;
    }
    const index = this.size;
    this.size += 1;
    this.items[index] = item;
    this.scores[index] = score;
    this.positions[item] = index;
    this.siftUp(index);
    return true;
  }

  /** 弹出分数最小的节点下标；空堆返回 -1。 */
  pop() {
    if (this.size === 0) return -1;
    const top = this.items[0];
    this.positions[top] = -1;
    this.size -= 1;
    if (this.size > 0) {
      this.items[0] = this.items[this.size];
      this.scores[0] = this.scores[this.size];
      this.positions[this.items[0]] = 0;
      this.siftDown(0);
    }
    return top;
  }

  siftUp(start) {
    let index = start;
    const item = this.items[index];
    const score = this.scores[index];
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.scores[parent] <= score) break;
      this.items[index] = this.items[parent];
      this.scores[index] = this.scores[parent];
      this.positions[this.items[index]] = index;
      index = parent;
    }
    this.items[index] = item;
    this.scores[index] = score;
    this.positions[item] = index;
  }

  siftDown(start) {
    let index = start;
    const item = this.items[index];
    const score = this.scores[index];
    const half = this.size >> 1;
    while (index < half) {
      let child = index * 2 + 1;
      const right = child + 1;
      if (right < this.size && this.scores[right] < this.scores[child]) child = right;
      if (this.scores[child] >= score) break;
      this.items[index] = this.items[child];
      this.scores[index] = this.scores[child];
      this.positions[this.items[index]] = index;
      index = child;
    }
    this.items[index] = item;
    this.scores[index] = score;
    this.positions[item] = index;
  }
}
