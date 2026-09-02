import assert from 'node:assert/strict';
import test from 'node:test';
import {
  InventoryController,
  type InventoryPort,
} from '../src/controllers/InventoryController.ts';
import type { InventoryView } from '../src/inventory/index.ts';
import type { InventoryPage } from '../src/ui/pages/InventoryPage.ts';
import { InventoryComponent } from '../shared/actor/index.mjs';
import { InputSubsystem } from '../src/input/core/InputSubsystem.ts';
import { PlayerInputTags, createPlayerInputScheme } from '../src/input/index.ts';
import { VirtualInputDevice } from '../src/input/devices/VirtualInputDevice.ts';

/** Controller 只认识 View 的接口，不需要 DOM——这正是拆开三层换来的。 */
class FakeInventoryPage {
  public readonly renders: (InventoryView | undefined)[] = [];
  public closeHint: string | undefined;

  public setInventory(view: InventoryView | undefined): void {
    this.renders.push(view);
  }

  public setCloseHint(label: string | undefined): void {
    this.closeHint = label;
  }
}

interface Harness {
  readonly controller: InventoryController;
  readonly view: FakeInventoryPage;
  readonly inventory: InventoryComponent;
  readonly input: InputSubsystem;
  readonly device: VirtualInputDevice;
  open: boolean;
  available: boolean;
  blocked: boolean;
}

function createHarness(): Harness {
  const view = new FakeInventoryPage();
  const inventory = new InventoryComponent({ slotCapacity: 6 });
  const device = new VirtualInputDevice();
  const scheme = createPlayerInputScheme({ includeDevelopmentMappings: false });
  const input = new InputSubsystem({
    actions: scheme.actions,
    config: scheme.config,
    contexts: scheme.contexts,
    devices: [device],
  });
  const harness = {
    view,
    inventory,
    input,
    device,
    open: false,
    available: true,
    blocked: false,
  } as Harness;
  const port: InventoryPort = {
    getInventory: () => (harness.available ? inventory : undefined),
    isOpen: () => harness.open,
    setOpen: (open) => { harness.open = open; },
    canOpen: () => harness.available && !harness.blocked,
  };
  Object.defineProperty(harness, 'controller', {
    value: new InventoryController(view as unknown as InventoryPage, input, port),
  });
  return harness;
}

test('开合背包：开之前先画好数据，关的时候不重画', () => {
  const harness = createHarness();
  harness.inventory.add('wood', 4);

  harness.controller.toggle();
  assert.equal(harness.open, true);
  assert.equal(harness.view.renders.length, 1, '推入栈之前就该把内容画好');
  assert.deepEqual(harness.view.renders[0]?.slots.map((slot) => slot.itemType), ['wood']);

  harness.controller.toggle();
  assert.equal(harness.open, false);
  assert.equal(harness.view.renders.length, 1);
});

test('关着的时候快照不触发重画，开着才跟随 revision', () => {
  const harness = createHarness();
  harness.inventory.add('stone', 2);

  harness.controller.sync();
  assert.equal(harness.view.renders.length, 0, '没开就不该画');

  harness.controller.open();
  assert.equal(harness.view.renders.length, 1);

  // revision 没动：同一份内容不重复铺 DOM。
  harness.controller.sync();
  assert.equal(harness.view.renders.length, 1);

  harness.inventory.add('stone', 3);
  harness.controller.sync();
  assert.equal(harness.view.renders.length, 2);
  assert.equal(harness.view.renders[1]?.slots[0]?.quantity, 5);
});

test('没有角色时开不出来；开着的过程中角色没了会切成空态', () => {
  const harness = createHarness();
  harness.available = false;
  harness.controller.open();
  assert.equal(harness.open, false);
  assert.equal(harness.view.renders.length, 0);

  harness.available = true;
  harness.blocked = true;
  harness.controller.open();
  assert.equal(harness.open, false, '别的页面盖着时不开背包');

  harness.blocked = false;
  harness.controller.open();
  assert.equal(harness.open, true);

  harness.available = false;
  harness.controller.sync();
  assert.equal(harness.view.renders.at(-1), undefined, '权威来源没了就画空态');
});

test('重新打开一定重画，即使 revision 撞上了', () => {
  const harness = createHarness();
  harness.controller.open();
  harness.controller.close();
  assert.equal(harness.view.renders.length, 1);
  harness.controller.open();
  assert.equal(harness.view.renders.length, 2);
});

test('Input.Player.Inventory 标签能打开背包，dispose 之后不再响应', () => {
  const harness = createHarness();
  const control = harness.input.getMappedControls(PlayerInputTags.Inventory, 'touch')[0];
  assert.equal(control, 'Virtual.InventoryButton', '触屏应该有一个能开背包的虚拟按钮');

  harness.device.setDigital(control, true);
  harness.input.update();
  assert.equal(harness.open, true, '手柄/触屏按下应当打开背包');

  harness.controller.close();
  harness.device.setDigital(control, false);
  harness.input.update();
  harness.controller.dispose();
  harness.device.setDigital(control, true);
  harness.input.update();
  assert.equal(harness.open, false, 'dispose 之后不该再收到输入');
});
