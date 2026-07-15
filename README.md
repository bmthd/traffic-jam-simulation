# 6車線比較 渋滞シミュレーション

「追いつかれた車両の義務」の有無で渋滞のできかたがどう変わるかを、
左右2つの3車線道路を並べて比較する Three.js シミュレーション。

## 開発

ツールチェーンは [Vite+](https://viteplus.dev/) (`vp`) に統一している。
ビルド (Vite) / テスト (Vitest) / lint (Oxlint) / フォーマット (Oxfmt) / 型チェックがすべて `vp` 経由で動く。

```bash
npm install
npm run dev      # 開発サーバー (HMR付き)
npm test         # シミュレーションコアのテスト (Vitest)
npm run check    # フォーマット + lint + 型チェックを一括実行
npm run lint     # lint のみ (Oxlint, 型情報を使ったルール込み)
npm run fmt      # フォーマット適用 (Oxfmt)
npm run build    # dist/ へバンドル出力
npm run preview  # ビルド結果の確認サーバー
```

依存 (three / lucide) は npm で管理し、Vite+ でバンドルする。CDN は使わない。
lint / フォーマット / 型チェックの設定は `vite.config.ts` に集約している。

## 構成と責務

```
index.html                  マークアップのみ(ロジックなし)
src/
  main.ts                   エントリポイント(エラー表示の土台 + app起動)
  app.ts                    組み立て: World と描画・UI の配線、メインループ
  style.css                 全スタイル
  core/                     ★ シミュレーションコア(DOM / THREE 非依存)
    constants.ts            調整パラメータ CONST・車両タイプ・共有型
    utils.ts                clamp / lerp / 乱数 / 周回路距離
    vehicle.ts              Vehicle: ドライバーモデル(追従・車線変更・気質)
    world.ts                World: 車両生成・時間発展・渋滞スコア
    index.ts                コアの公開API
  render/                   Three.js 描画(ブラウザ専用)
    scene.ts                シーン・カメラ・レンダラー・ライト・地面
    materials.ts            共有マテリアル(昼夜で色が変わるものはここ)
    track.ts                道路・車線・合流ランプ・中央分離帯・標識ゲート
    night.ts                夜景アセット(空・星・月・街灯・投光)
    theme.ts                昼夜テーマの補間 (nightMix) と適用
    vehicle-mesh.ts         車両メッシュ生成と World との同期
    camera.ts               カメラ操作(回転・ズーム)
  ui/                       DOM UI
    icons.ts                lucide アイコン(使用分のみバンドル)
    notify.ts               エラー表示・トースト
    hud.ts                  スコア比較パネルの更新
    panels.ts               パネル折りたたみ
    params.ts               パラメータ調整室モーダル
    night-toggle.ts         カラーモード切替ボタン
```

**ルール**: `src/core/` は DOM / THREE に依存させない。
テスト (`traffic-simulation.test.ts`) は Vitest がコアを直接 import して実行する。
シミュレーションの挙動を変えるときは core、見た目は render / ui だけを触ればよい。
