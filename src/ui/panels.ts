/* ================= パネル折りたたみ・重なり順 ================= */

// 画面が狭いとパネル同士が重なる。開いた(触れた)パネルを最前面に持ってきて、
// 後から開いた方が必ず上に見えるようにする。
// z-index を無制限に増やすとボタンやモーダルを追い越すため、
// 表示順の配列を持ち直して 10 から順に振り直す(値が上限を超えない)
const PANEL_BASE_Z_INDEX = 10;
const stackOrder: HTMLElement[] = [];
function bringToFront(panel: HTMLElement): void {
  const index = stackOrder.indexOf(panel);
  if (index >= 0) stackOrder.splice(index, 1);
  stackOrder.push(panel);
  stackOrder.forEach(function (element, order) {
    element.style.zIndex = String(PANEL_BASE_Z_INDEX + order);
  });
}

const automaticallyCollapsed = new WeakSet<HTMLElement>();

function setCollapsed(panel: HTMLElement, collapsed: boolean): void {
  panel.classList.toggle('collapsed', collapsed);
  panel
    .querySelector<HTMLElement>('.panel-title')!
    .setAttribute('aria-expanded', String(!collapsed));
}

function syncAutomaticCollapse(panel: HTMLElement, matches: boolean): void {
  if (matches) {
    if (!panel.classList.contains('collapsed')) {
      setCollapsed(panel, true);
      automaticallyCollapsed.add(panel);
    }
    return;
  }
  if (automaticallyCollapsed.has(panel)) {
    setCollapsed(panel, false);
    automaticallyCollapsed.delete(panel);
  }
}

export function setupPanels(): void {
  for (const id of ['controlPanel', 'infoPanel']) {
    const panel = document.getElementById(id)!;
    const title = panel.querySelector<HTMLElement>('.panel-title')!;
    stackOrder.push(panel);
    // 中身の操作(スライダー等)でも最前面へ。展開のクリックより先に反応させる
    panel.addEventListener('pointerdown', function () {
      bringToFront(panel);
    });
    panel.addEventListener('focusin', function () {
      bringToFront(panel);
    });
    title.addEventListener('click', function () {
      automaticallyCollapsed.delete(panel);
      setCollapsed(panel, !panel.classList.contains('collapsed'));
    });
  }

  const controlPanel = document.getElementById('controlPanel')!;
  const infoPanel = document.getElementById('infoPanel')!;
  const compactControl = matchMedia('(max-width:700px), (max-height:520px)');
  const compactInfo = matchMedia('(max-height:420px)');

  const syncControlPanel = (): void => syncAutomaticCollapse(controlPanel, compactControl.matches);
  const syncInfoPanel = (): void => syncAutomaticCollapse(infoPanel, compactInfo.matches);

  // 展開時約230pxの情報パネルに上下12pxずつと、畳んだ操作パネル約52pxを
  // 足すと約306px必要になる。フォントサイズやDPI差の余裕を見て420pxを境界にする。
  syncControlPanel();
  syncInfoPanel();
  compactControl.addEventListener('change', syncControlPanel);
  compactInfo.addEventListener('change', syncInfoPanel);
}
