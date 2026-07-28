/* ================= モーダル共通処理 =================
   開閉・フォーカスの退避と復帰・Esc・背景クリックでの閉じ・フォーカストラップは
   どのモーダルでも同じなので、ここにまとめてパラメータ調整室とサイト説明で共有する */

export interface Modal {
  // `this` を持たない関数として公開する(そのままイベントハンドラに渡せる)
  open: () => void;
  close: () => void;
}

export function setupModal(overlayId: string, modalId: string): Modal {
  const overlay = document.getElementById(overlayId)!;
  const modal = document.getElementById(modalId)!;
  let previouslyFocused: HTMLElement | null = null;

  function open(): void {
    previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    overlay.classList.add('open');
    modal.focus();
  }
  function close(): void {
    overlay.classList.remove('open');
    if (previouslyFocused?.isConnected) previouslyFocused.focus();
    previouslyFocused = null;
  }

  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) close();
  });
  window.addEventListener('keydown', function (e) {
    if (!overlay.classList.contains('open')) return;
    if (e.key === 'Escape') close();
  });
  modal.addEventListener('keydown', function (e) {
    if (e.key !== 'Tab' || !overlay.classList.contains('open')) return;
    const focusable = Array.from(
      modal.querySelectorAll<HTMLElement>(
        'button, input, [href], select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ).filter(
      (element) =>
        !element.hasAttribute('disabled') && !element.hidden && element.offsetParent !== null,
    );
    if (focusable.length === 0) {
      e.preventDefault();
      modal.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (document.activeElement === modal) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    } else if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });

  return { open, close };
}
