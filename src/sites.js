// サイトごとのプレーヤー構造の違いをここにまとめる
(() => {
  const SITES = {
    youtube: {
      player: () => document.querySelector('#movie_player'),
      video: (player) => player?.querySelector('video.html5-main-video'),
      fullscreenButton: (player) => player?.querySelector('.ytp-fullscreen-button'),
      buttonClass: () => 'ytp-button',
      iconReference: (fullscreenButton) => fullscreenButton.querySelector('svg'),
      controls: '.ytp-chrome-bottom',
    },
    niconico: {
      player: () => document.querySelector('[data-name="stage"]'),
      video: (player) => player?.querySelector('video[data-name="video-content"]'),
      // 操作バーはプレーヤーの外側にある
      fullscreenButton: () => document.querySelector('button[aria-label^="全画面"]'),
      buttonClass: (fullscreenButton) => fullscreenButton.className,
      iconReference: (fullscreenButton) => fullscreenButton.querySelector('svg'),
      controls: null,
    },
    bilibili: {
      // 弾幕送信欄を含まない、映像と操作バーの領域
      player: () => document.querySelector('.bpx-player-video-area'),
      video: (player) => player?.querySelector('.bpx-player-video-wrap video'),
      fullscreenButton: (player) => player?.querySelector('.bpx-player-ctrl-full'),
      // 全画面ボタンのクラスを付けると、サイト側の全画面の処理まで反応する
      buttonClass: () => 'bpx-player-ctrl-btn',
      // アイコンは88px指定のSVGをstyleで縮めているので、属性は参照しない
      iconReference: () => null,
      controls: '.bpx-player-control-wrap',
    },
  };

  const { hostname } = location;
  globalThis.PERIPHERAL_VIEW_SITE = hostname.endsWith('nicovideo.jp')
    ? SITES.niconico
    : hostname.endsWith('bilibili.com')
      ? SITES.bilibili
      : SITES.youtube;
})();
