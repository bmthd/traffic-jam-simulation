import { defineConfig } from 'vite';

export default defineConfig({
  // 相対パスで出力する: dist/ をどのパス(サブディレクトリ配信・file://)に
  // 置いても動くようにする
  base: './',
  build: {
    // バンドルの大半は three.js 本体(CDN配信時の three.min.js と同等)
    chunkSizeWarningLimit: 600
  }
});
