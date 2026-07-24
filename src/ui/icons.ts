/* ================= lucide アイコンヘルパー ================= */
// 動的に差し替えるラベル用: プレースホルダ <i data-lucide> を生成し、
// renderIcons() でまとめて SVG に変換する(変換済みの要素は再処理されない)
import {
  createIcons,
  Angry,
  CarFront,
  ChevronDown,
  Circle,
  Clapperboard,
  Crown,
  Frown,
  Gauge,
  Meh,
  Merge,
  Moon,
  Mouse,
  MoveUp,
  PanelTop,
  Repeat,
  RotateCcw,
  Scale,
  Send,
  SlidersHorizontal,
  Smartphone,
  Smile,
  Square,
  Sun,
  Timer,
  TriangleAlert,
  X,
} from 'lucide';

// 使用するアイコンだけを束ねる(バンドルに全アイコンを含めない)
const ICONS = {
  Angry,
  CarFront,
  ChevronDown,
  Circle,
  Clapperboard,
  Crown,
  Frown,
  Gauge,
  Meh,
  Merge,
  Moon,
  Mouse,
  MoveUp,
  PanelTop,
  Repeat,
  RotateCcw,
  Scale,
  Send,
  SlidersHorizontal,
  Smartphone,
  Smile,
  Square,
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
