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

export function setupPanels(): void {
  for (const id of ['controlPanel', 'infoPanel']) {
    const panel = document.getElementById(id)!;
    stackOrder.push(panel);
    // 中身の操作(スライダー等)でも最前面へ。展開のクリックより先に反応させる
    panel.addEventListener('pointerdown', function () {
      bringToFront(panel);
    });
    panel.querySelector('.panel-title')!.addEventListener('click', function (e) {
      if ((e.target as Element).closest('button,input')) return;
      panel.classList.toggle('collapsed');
    });
  }
  // 小さい画面では情報を畳んだ状態から始める(3Dの邪魔をしない)
  if (matchMedia('(max-width:700px), (max-height:520px)').matches) {
    document.getElementById('controlPanel')!.classList.add('collapsed');
  }
}
