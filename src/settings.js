// content script と popup で共有する既定値
globalThis.PERIPHERAL_VIEW_API = globalThis.browser ?? globalThis.chrome;

// 拡張機能を更新すると、開いていたタブに残った古いスクリプトは拡張機能のAPIを使えなくなる
globalThis.PERIPHERAL_VIEW_CONNECTED = () => Boolean(PERIPHERAL_VIEW_API.runtime?.id);

globalThis.PERIPHERAL_VIEW_DEFAULTS = Object.freeze({
  seat: 'front',
  screens: 'three',
  average: 'uniform',
  videoRatio: 'original',
  screenRatio: 'original',
  fit: 'contain',
  size: 0.68, // 前方席での正面スクリーンの大きさ（プレーヤーに対する比率）
  strip: 0.08, // 映像の端から平均する幅（映像の幅に対する比率）
  blurRange: 0.1, // ぼかす範囲（映像の高さに対する比率）
  brightness: 1, // 壁の明るさ
});

// distance は前方席を1とした、スクリーンまでの距離
globalThis.PERIPHERAL_VIEW_SEATS = Object.freeze({
  front: { label: '前方', distance: 1 },
  middle: { label: '中央', distance: 1.2 },
  back: { label: '後方', distance: 1.5 },
});

// 映像と正面スクリーンで共通の縦横比。映像が元の比率と異なる場合は、上下か左右を切り取る
// ratio が null のときは、映像は切り取らず、正面スクリーンは映像に合わせる
globalThis.PERIPHERAL_VIEW_RATIOS = Object.freeze({
  original: { label: 'そのまま（映像に合わせる）', ratio: null },
  standard: { label: 'スタンダード（4:3）', ratio: 4 / 3 },
  largeFormat: { label: '大型フィルム（1.43:1）', ratio: 1.43 },
  hd: { label: 'テレビ・配信（16:9）', ratio: 16 / 9 },
  flat: { label: '映画の標準ワイド（1.85:1）', ratio: 1.85 },
  digitalCinema: { label: 'デジタルシネマ（1.90:1）', ratio: 1.9 },
  twoToOne: { label: '配信ドラマのワイド（2:1）', ratio: 2 },
  scope: { label: '映画の横長ワイド（2.39:1）', ratio: 2.39 },
});
