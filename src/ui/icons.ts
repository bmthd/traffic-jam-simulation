/* ================= lucide アイコンヘルパー ================= */
// 動的に差し替えるラベル用: プレースホルダ <i data-lucide> を生成し、
// renderIcons() でまとめて SVG に変換する(変換済みの要素は再処理されない)
import {
  createIcons,
  Angry,
  ChevronDown,
  Circle,
  Crown,
  Frown,
  Gauge,
  Meh,
  Moon,
  Mouse,
  RotateCcw,
  Scale,
  SlidersHorizontal,
  Smartphone,
  Smile,
  Sun,
  Timer,
  TriangleAlert,
  X,
} from 'lucide';

// 使用するアイコンだけを束ねる(バンドルに全アイコンを含めない)
const ICONS = {
  Angry,
  ChevronDown,
  Circle,
  Crown,
  Frown,
  Gauge,
  Meh,
  Moon,
  Mouse,
  RotateCcw,
  Scale,
  SlidersHorizontal,
  Smartphone,
  Smile,
  Sun,
  Timer,
  TriangleAlert,
  X,
};

export function icon(name: string, className?: string): string {
  return (
    '<i data-lucide="' + name + '"' + (className ? ' class="' + className + '"' : '') + '></i>'
  );
}
export function renderIcons(): void {
  createIcons({ icons: ICONS });
}
