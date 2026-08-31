export type CommonUICloseReason = 'pop' | 'clear' | 'scene-switch';

export interface CommonUIPage {
  readonly id: string;
  readonly element: HTMLElement;
  readonly closeOnEscape?: boolean;
  readonly passUnhandledEvents?: boolean;
  /** 页面级快捷键；在聚焦按钮/输入框时也先于 DOM receiver 处理。 */
  handleGlobalInputEvent?(event: KeyboardEvent): boolean;
  handleInputEvent?(event: Event): boolean;
  onOpen?(): void;
  onClose?(reason: CommonUICloseReason): void;
}
