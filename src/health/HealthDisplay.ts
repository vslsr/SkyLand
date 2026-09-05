/**
 * 生命值显示的契约层：界面认识的**全部**生命值就写在这个文件里。
 *
 * 它不认识 `HealthComponent`。那一份住在 `shared/actor/components/HealthComponent.mjs`，
 * 是服务端 GAS `Health` 属性的复制面，带着死亡计数、来袭方向、冲量、尸体停留秒数——
 * 全是给权威结算和蒙皮形变用的东西，画一条血条一个都不需要。让血条直接读它，等于
 * 把「服务端怎么记血」焊死在「屏幕上画几个像素」上：那边加一个字段、改一次复制形状，
 * 这边跟着改；反过来想换一种血条样式，又得从 Component 一路读起。
 *
 * 中间隔一层之后，两边各自只欠对方几个数：
 *
 * ```text
 *   谁的血 --实现--> HealthSource --> HealthDisplayController --> HealthView × N
 * ```
 *
 * 左边是谁都行：本地玩家实体、一具 Replica、载具、一段回放、测试里的一个假对象——
 * 只要能交出 `HealthReading`。右边有几种样式都行：屏幕底部那条横条、准星旁边的一圈、
 * 头顶的一排格子。**它们收到的是同一份已经算好的显示状态**，所以几种样式永远说同一
 * 句话：不会一条已经变红、另一条还没有，也不会各自定义各自的警戒线。
 *
 * 边界就是这一条：契约层里没有 Component、没有快照、没有网络、没有 DOM。
 */

/**
 * 界面要的全部生命值。
 *
 * `SnapshotHealth` 在结构上正好满足它，所以本地玩家那一侧的实现就是一句
 * `readHealth: () => this.player?.health`——**结构兼容不是绑定**：这个接口没有
 * import 过快照类型，换一个不带快照的来源同样能实现它。
 */
export interface HealthReading {
  readonly current: number;
  readonly maximum: number;
  readonly dead: boolean;
  /**
   * 自增计数：变了就是又结算过一次伤害或治疗。
   *
   * 判「刚刚挨了一下」用它而不是拿两帧血量相减，理由和飘字那边
   * （`HealthPopupEmitter`）是同一条：快照 10Hz，一次 30 点会被摊成好几帧的小数字，
   * 掉线重连补上的那一大段还会凭空多出一次。计数只在服务端真的结算过时才动。
   */
  readonly eventRevision: number;
  /** 最近一次变化量：正是治疗，负是伤害。 */
  readonly lastDelta: number;
}

/**
 * 「现在该显示谁的血」。
 *
 * 每帧问一次，而不是让来源推过来：生命值本来就是每帧都要重画的东西，拉取还顺手
 * 解决了两件麻烦事——角色没了就返回 `undefined`（不必再发一条「我没了」的事件），
 * 换一个被显示的对象也只是换这个函数返回谁，控制器和视图都不用知道换过。
 */
export interface HealthSource {
  /** `undefined` 表示现在没有可显示的对象：没进房间、角色还没生成、已经离开。 */
  readHealth(): HealthReading | undefined;
}

/** 最近一次结算。视图据它决定要不要闪一下，以及闪成什么样。 */
export interface HealthChange {
  /** 正是治疗，负是伤害。 */
  readonly amount: number;
  /**
   * 这次结算过去了多少秒。
   *
   * 给的是年龄而不是「要不要闪」：闪多久、怎么淡出是各家样式自己的事，但**闪的
   * 起点必须是同一刻**。视图自己记事件的话，几种样式会各自从自己第一次看到的
   * 那一帧开始计时，闪的节奏就散了。
   */
  readonly ageSeconds: number;
}

/**
 * 算好的一帧显示状态：视图拿到它只管画，不做任何判断。
 *
 * 凡是「几种样式必须一致」的结论都在这里定好——警戒线、残影退到哪、事件多久算过去，
 * 因此都只有一份。视图只挑自己画得出来的字段用：横条用 `ratio` 和 `trailingRatio`，
 * 一排格子用 `current`/`maximum`，纯数字读数两个都不用管。
 */
export interface HealthDisplayState {
  readonly current: number;
  readonly maximum: number;
  /** [0, 1]。`maximum` 为 0 时是 0，视图不必自己防除零。 */
  readonly ratio: number;
  /**
   * 缓慢退下去的那条残影，恒 >= `ratio`。
   *
   * 掉的那一截先留在原处再退，玩家因此看得见「刚刚少了多少」——不然 10Hz 的快照
   * 打过来只是一格瞬间变短，多少血没了全靠猜。治疗时立刻贴合：残影只讲损失。
   */
  readonly trailingRatio: number;
  readonly dead: boolean;
  /** 低于警戒线（活着时才成立）。阈值在控制器上，几种样式因此同时变红。 */
  readonly critical: boolean;
  /** 最近一次结算；已经过去太久或这条命还没被动过就是 `undefined`。 */
  readonly lastChange?: HealthChange;
}

/**
 * 一种生命值的画法。
 *
 * 实现它就能被挂到控制器上，不需要认识来源、快照或者别的样式；同时挂几种也没关系，
 * 它们收到的是同一个状态对象。
 */
export interface HealthView {
  /**
   * 每帧一次。`undefined` 表示现在没有可显示的生命值，视图自己收起来。
   *
   * 传进来的对象**只在这一帧有效**，别留着：控制器每帧重新造一份，留住的那个
   * 不会跟着更新。要跨帧的东西自己抄一份走。
   */
  render(state: HealthDisplayState | undefined): void;
  /**
   * 视图归创建它的那一方释放，控制器不代劳——它只是被挂上来的，不拥有谁。
   */
  dispose?(): void;
}
