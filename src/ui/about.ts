/* ================= サイト説明(このサイトについて) =================
   説明の本文は index.html に静的な HTML として置いてある(検索エンジンの
   クローラに読ませるため)。ここで行うのは開閉の配線だけ */
import { setupModal } from './modal';

export function setupAbout(): void {
  const about = setupModal('aboutOverlay', 'aboutModal');
  document.getElementById('aboutBtn')!.addEventListener('click', about.open);
  document.getElementById('aboutClose')!.addEventListener('click', about.close);
}
