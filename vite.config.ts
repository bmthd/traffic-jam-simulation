import { defineConfig } from 'vite-plus';
import { configDefaults } from 'vitest/config';

export default defineConfig({
  // 相対パスで出力する: dist/ をどのパス(サブディレクトリ配信・file://)に
  // 置いても動くようにする
  base: './',
  build: {
    // バンドルの大半は three.js 本体(CDN配信時の three.min.js と同等)
    chunkSizeWarningLimit: 600,
  },
  lint: {
    ignorePatterns: ['dist/**'],
    options: {
      // tsgolint による型情報を使った lint + 型チェック(vp check で実行)
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {
    singleQuote: true,
    printWidth: 100,
  },
  test: {
    // シミュレーションを実時間で数百秒ぶん回すシナリオテストがあるため長め
    testTimeout: 300_000,
    // `.claude/worktrees/` には並行作業用の git worktree が置かれており、
    // 各 worktree にもテストファイル (traffic-simulation.test.ts) が存在する。
    // 除外しないとリポジトリルートでの実行時に他 worktree の古いコードのテストまで
    // glob されてしまい、テスト件数が worktree の増減で変動して再現しなくなる。
    // exclude を指定すると Vitest の既定値は置き換わるため、configDefaults.exclude
    // (node_modules / .git) を展開して打ち消さないようにする。
    exclude: [...configDefaults.exclude, '**/.claude/**'],
  },
  // コミット時 (pre-commit hook → `vp staged`) にステージ済みファイルをフォーマットする。
  // hooks 本体は `vp config` (pnpm install の prepare で自動実行) が .vite-hooks に導入する
  staged: {
    '*.{ts,tsx,js,jsx,css,html,json,md,yml,yaml}': 'vp fmt',
  },
});
