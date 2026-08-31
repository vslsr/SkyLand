import { ActorComponent } from '../ActorComponent.mjs';

export const VESSEL_MOTOR_COMPONENT = 'vessel-motor';

/** 船舶动力配置与运行态。坐标推进只由服务端 VesselMotorSystem 执行。 */
export class VesselMotorComponent extends ActorComponent {
  constructor(definition) {
    super(VESSEL_MOTOR_COMPONENT);
    this.maximumForwardSpeed = definition.maximumForwardSpeed;
    this.maximumReverseSpeed = definition.maximumReverseSpeed;
    this.acceleration = definition.acceleration;
    this.deceleration = definition.deceleration;
    this.drag = definition.drag;
    this.turnSpeed = definition.turnSpeed;
    this.inputTimeoutMs = definition.inputTimeoutMs;
    this.speed = 0;
    this.throttle = 0;
    this.steering = 0;
  }

  stopInput() {
    this.throttle = 0;
    this.steering = 0;
  }
}
