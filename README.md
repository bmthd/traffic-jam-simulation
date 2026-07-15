# 6車線比較 渋滞シミュレーション

「追いつかれた車両の義務」の有無で渋滞のできかたがどう変わるかを、
左右2つの3車線道路を並べて比較する Three.js シミュレーション。

## 開発

```bash
npm install
npm run dev      # 開発サーバー (HMR付き)
npm test         # シミュレーションコアのテスト
npm run build    # dist/ へバンドル出力
npm run preview  # ビルド結果の確認サーバー
```

依存 (three / lucide) は npm で管理し、Vite でバンドルする。CDN は使わない。

## 構成と責務

```
index.html                  マークアップのみ(ロジックなし)
src/
  main.js                   エントリポイント(エラー表示の土台 + app起動)
  app.js                    組み立て: World と描画・UI の配線、メインループ
  style.css                 全スタイル
  core/                     ★ シミュレーションコア(DOM / THREE 非依存)
    constants.js            調整パラメータ CONST・車両タイプ
    utils.js                clamp / lerp / 乱数 / 周回路距離
    vehicle.js              Vehicle: ドライバーモデル(追従・車線変更・気質)
    world.js                World: 車両生成・時間発展・渋滞スコア
    index.js                コアの公開API
  render/                   Three.js 描画(ブラウザ専用)
    scene.js                シーン・カメラ・レンダラー・ライト・地面
    materials.js            共有マテリアル(昼夜で色が変わるものはここ)
    track.js                道路・車線・合流ランプ・中央分離帯・標識ゲート
    night.js                夜景アセット(空・星・月・街灯・投光)
    theme.js                昼夜テーマの補間 (nightMix) と適用
    vehicle-mesh.js         車両メッシュ生成と World との同期
    camera.js               カメラ操作(回転・ズーム)
  ui/                       DOM UI
    icons.js                lucide アイコン(使用分のみバンドル)
    notify.js               エラー表示・トースト
    hud.js                  スコア比較パネルの更新
    panels.js               パネル折りたたみ
    params.js               パラメータ調整室モーダル
    night-toggle.js         カラーモード切替ボタン
```

**ルール**: `src/core/` は DOM / THREE に依存させない。
テスト (`traffic-simulation.test.js`) は Node がコアを直接 import して実行する。
シミュレーションの挙動を変えるときは core、見た目は render / ui だけを触ればよい。
