/* ================= パネル折りたたみ ================= */
export function setupPanels(): void {
  for (const id of ['controlPanel', 'infoPanel', 'spectatorPanel']) {
    const panel = document.getElementById(id)!;
    panel.querySelector('.panel-title')!.addEventListener('click', function (e) {
      if ((e.target as Element).closest('button,input')) return;
      panel.classList.toggle('collapsed');
    });
  }
  // 小さい画面では情報を畳んだ状態から始める(3Dの邪魔をしない)
  if (matchMedia('(max-width:700px), (max-height:520px)').matches) {
    document.getElementById('controlPanel')!.classList.add('collapsed');
    document.getElementById('spectatorPanel')!.classList.add('collapsed');
  }
}
