// content script と popup で共有する既定値
globalThis.PERIPHERAL_VIEW_API = globalThis.browser ?? globalThis.chrome;

globalThis.PERIPHERAL_VIEW_DEFAULTS = Object.freeze({
  seat: 'front',
  screens: 'three',
  average: 'uniform',
  size: 0.68, // 前方席での中央スクリーンの大きさ（プレーヤーに対する比率）
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
