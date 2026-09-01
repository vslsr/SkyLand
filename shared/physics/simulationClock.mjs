import {
  MAXIMUM_SIMULATION_CATCH_UP_STEPS,
  SIMULATION_STEP_SECONDS,
} from '../networkTuning.mjs';

/** 渲染帧率无关的固定步长累加器。 */
export class SimulationClock {
  constructor(options = {}) {
    this.stepSeconds = Math.max(1e-6, Number(options.stepSeconds) || SIMULATION_STEP_SECONDS);
    this.maximumCatchUpSteps = Math.max(
      1,
      Math.floor(Number(options.maximumCatchUpSteps) || MAXIMUM_SIMULATION_CATCH_UP_STEPS),
    );
    this.accumulator = 0;
  }

  get alpha() {
    return Math.max(0, Math.min(1, this.accumulator / this.stepSeconds));
  }

  advance(deltaSeconds, simulateStep) {
    const delta = Number(deltaSeconds);
    if (!(delta > 0) || !Number.isFinite(delta)) return 0;
    this.accumulator += delta;
    const available = Math.floor((this.accumulator + 1e-12) / this.stepSeconds);
    const count = Math.min(available, this.maximumCatchUpSteps);
    for (let index = 0; index < count; index += 1) simulateStep(this.stepSeconds);
    this.accumulator -= count * this.stepSeconds;
    // 后台恢复时丢弃超过封顶值的完整步，但保留亚步余量。
    if (available > this.maximumCatchUpSteps) this.accumulator %= this.stepSeconds;
    return count;
  }

  reset() {
    this.accumulator = 0;
  }
}
