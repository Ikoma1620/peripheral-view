// サイトごとのプレーヤー構造の違いをここにまとめる
(() => {
  const SITES = {
    youtube: {
      player: () => document.querySelector('#movie_player'),
      video: (player) => player?.querySelector('video.html5-main-video'),
      fullscreenButton: (player) => player?.querySelector('.ytp-fullscreen-button'),
      buttonClass: () => 'ytp-button',
    },
    niconico: {
      player: () => document.querySelector('[data-name="stage"]'),
      video: (player) => player?.querySelector('video[data-name="video-content"]'),
      // 操作バーはプレーヤーの外側にある
      fullscreenButton: () => document.querySelector('button[aria-label^="全画面"]'),
      buttonClass: (fullscreenButton) => fullscreenButton.className,
    },
  };

  globalThis.PERIPHERAL_VIEW_SITE = location.hostname.endsWith('nicovideo.jp')
    ? SITES.niconico
    : SITES.youtube;
})();
