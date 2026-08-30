export type CommonUICloseReason = 'pop' | 'clear' | 'scene-switch';

export interface CommonUIPage {
  readonly id: string;
  readonly element: HTMLElement;
  readonly closeOnEscape?: boolean;
  readonly passUnhandledEvents?: boolean;
  handleInputEvent?(event: Event): boolean;
  onOpen?(): void;
  onClose?(reason: CommonUICloseReason): void;
}
