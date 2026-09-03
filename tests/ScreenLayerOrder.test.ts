import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * 屏幕层级的棘轮。
 *
 * 虚拟摇杆的热区是一整块透明的矩形，覆盖屏幕左下角将近半屏。它一旦排到 UI
 * 上面，命中测试就先给它——左侧的地形编辑栏按不动，而且没有任何报错，只是
 * 「点了没反应」。这条规则要挡的就是这种回归：
 *
 *   点在 UI 上 → UI 消耗事件 → 不产生摇杆事件
 *   点在空处   → 没有 UI 接手 → 落到游戏层输入（摇杆）
 *
 * 层级顺序即命中顺序的倒序，所以这里直接盯 `src/style.css` 里的那份变量表，
 * 以及各张样式表里的每条 `z-index` 是否还走这份表。
 */

const STYLESHEET = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
const MARKUP = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

/** 层级变量定义在 src/style.css 的 :root 里，全站样式表共用同一份顺序。 */
const STYLESHEET_PATHS = [
  'src/style.css',
  'src/ui/scrollbars.css',
  'src/abilities/lab/abilityLab.css',
];

/** 从下往上的完整层级顺序。数值可以整体挪，顺序不能乱。 */
const LAYER_ORDER = [
  '--layer-hud',
  '--layer-game-input',
  '--layer-game-ui',
  '--layer-common-ui',
  '--layer-fatal-error',
] as const;

/**
 * 允许写裸数字 `z-index` 的选择器：它们都只在自己的层叠上下文内部排序，
 * 和全屏层级无关。这份清单只能变短。
 */
const LOCAL_STACKING_CONTEXT_SELECTORS = [
  '.modal-window.is-common-ui-covered',
  '.modal-window.is-common-ui-top',
  '.virtual-buttons',
  '.virtual-joystick-zone',
];

interface Declaration {
  readonly selector: string;
  readonly value: string;
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 逐字符扫一遍，把每条 `z-index` 归到最内层的选择器上。 */
function collectZIndexDeclarations(css: string): Declaration[] {
  const source = stripComments(css);
  const declarations: Declaration[] = [];
  const selectors: string[] = [];
  let pending = '';

  for (const character of source) {
    if (character === '{') {
      selectors.push(pending.trim().replace(/\s+/g, ' '));
      pending = '';
      continue;
    }
    if (character === '}') {
      selectors.pop();
      pending = '';
      continue;
    }
    if (character === ';') {
      const [property, ...rest] = pending.split(':');
      if (property.trim() === 'z-index') {
        declarations.push({
          selector: selectors.at(-1) ?? '',
          value: rest.join(':').trim(),
        });
      }
      pending = '';
      continue;
    }
    pending += character;
  }

  return declarations;
}

function readLayerVariables(css: string): Map<string, number> {
  const rootBlock = stripComments(css).match(/:root\s*\{([\s\S]*?)\}/);
  assert.ok(rootBlock, 'src/style.css 缺少 :root 层级变量表');
  const variables = new Map<string, number>();
  for (const [, name, value] of rootBlock[1].matchAll(/(--layer-[\w-]+)\s*:\s*(-?\d+)\s*;/g)) {
    variables.set(name, Number(value));
  }
  return variables;
}

function collectAllZIndexDeclarations(): Declaration[] {
  return STYLESHEET_PATHS.flatMap((relativePath) => collectZIndexDeclarations(
    readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8'),
  ));
}

function findLayerVariable(selector: string): string | undefined {
  const declaration = collectAllZIndexDeclarations()
    .find((entry) => entry.selector === selector);
  const match = declaration?.value.match(/var\((--layer-[\w-]+)\)/);
  return match?.[1];
}

test('层级变量按「画布 < HUD < 游戏层输入 < 游戏内 UI < CommonUI」严格递增', () => {
  const variables = readLayerVariables(STYLESHEET);
  const missing = LAYER_ORDER.filter((name) => !variables.has(name));
  assert.deepEqual(missing, [], '层级变量表少了条目');

  const values = LAYER_ORDER.map((name) => variables.get(name)!);
  for (let index = 1; index < values.length; index += 1) {
    assert.ok(
      values[index] > values[index - 1],
      `${LAYER_ORDER[index]} 必须高于 ${LAYER_ORDER[index - 1]}，现在是 ${values[index]} vs ${values[index - 1]}`,
    );
  }
});

test('虚拟摇杆热区排在可交互 UI 之下：UI 先吃掉指针', () => {
  const variables = readLayerVariables(STYLESHEET);
  assert.equal(
    findLayerVariable('.virtual-controls'),
    '--layer-game-input',
    '触摸控制属于游戏层输入，不能自己挑一个层级',
  );

  // 左侧地形编辑栏、菜单入口和能力实验室面板都压在热区覆盖的那半屏上。
  for (const selector of ['.terrain-editor', '.game-menu-launcher', '.ability-lab-panel']) {
    const layer = findLayerVariable(selector);
    assert.ok(layer, `${selector} 应当使用层级变量`);
    assert.ok(
      variables.get(layer!)! > variables.get('--layer-game-input')!,
      `${selector} 必须压在摇杆热区上面，否则点它会变成一次摇杆输入`,
    );
  }
});

test('全屏层级只走变量表，裸数字仅限已知的局部层叠上下文', () => {
  const offenders = collectAllZIndexDeclarations()
    .filter((entry) => !entry.value.startsWith('var(--layer-'))
    .map((entry) => entry.selector)
    .sort();

  assert.deepEqual(
    offenders,
    LOCAL_STACKING_CONTEXT_SELECTORS,
    '这份清单只能变短：新的全屏层级请用 --layer-* 变量，别写裸数字',
  );
});

test('标记顺序与层级一致：触摸控制紧贴画布，排在所有 UI 之前', () => {
  const joystickHost = MARKUP.indexOf('id="virtual-controls"');
  const canvas = MARKUP.indexOf('id="scene"');
  assert.ok(joystickHost > canvas, '触摸控制应当在画布之后');

  for (const marker of ['id="game-menu-button"', 'id="terrain-editor"']) {
    const uiIndex = MARKUP.indexOf(marker);
    assert.ok(uiIndex > 0, `index.html 缺少 ${marker}`);
    assert.ok(
      uiIndex > joystickHost,
      `${marker} 应当写在触摸控制之后：同层级时后写的那个会盖住前面的`,
    );
  }
});
