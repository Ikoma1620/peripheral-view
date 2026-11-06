(() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const BUTTON_TITLE = 'peripheral-view';
  const REDRAW_EVENTS = ['loadeddata', 'canplay', 'seeked'];

  let settings = { ...PERIPHERAL_VIEW_DEFAULTS };
  let session = null;
  let panel = null;

  const updateLayout = () => {
    if (!session) return;
    const { player, video, renderer } = session;
    const { clientWidth: width, clientHeight: height } = player;
    if (!width || !height) return;
    const { distance } = PERIPHERAL_VIEW_SEATS[settings.seat] ?? PERIPHERAL_VIEW_SEATS.front;
    const box = settings.size / distance;
    renderer.settings = settings;

    // ニコニコ動画の<video>は枠いっぱいに広がるので、映像が実際に映る範囲を求める
    const fit = video.videoWidth
      ? Math.min(video.offsetWidth / video.videoWidth, video.offsetHeight / video.videoHeight)
      : 1;
    const pictureWidth = video.videoWidth * fit || video.offsetWidth;
    const pictureHeight = video.videoHeight * fit || video.offsetHeight;

    // 映像の比率を変える場合は、上下か左右を切り取った範囲を映像とみなす
    const contentRatio =
      PERIPHERAL_VIEW_RATIOS[settings.videoRatio]?.ratio ?? pictureWidth / pictureHeight;
    const contentWidth = Math.min(pictureWidth, pictureHeight * contentRatio);
    const contentHeight = contentWidth / contentRatio;

    // 正面スクリーンは、席に応じた大きさの枠に収まる、指定の比率の長方形
    const ratio = PERIPHERAL_VIEW_RATIOS[settings.screenRatio]?.ratio ?? contentRatio;
    const screenWidth = Math.min(width * box, height * box * ratio);
    const screenHeight = screenWidth / ratio;

    // 実際の<video>をCSSで縮め、映さない部分を隠す
    const scale = (settings.fit === 'cover' ? Math.max : Math.min)(
      screenWidth / contentWidth,
      screenHeight / contentHeight
    );
    const visibleWidth = Math.min(screenWidth / scale, contentWidth);
    const visibleHeight = Math.min(screenHeight / scale, contentHeight);
    const cropped = visibleWidth < pictureWidth - 0.5 || visibleHeight < pictureHeight - 0.5;
    const insetX = (video.offsetWidth - visibleWidth) / 2;
    const insetY = (video.offsetHeight - visibleHeight) / 2;
    player.style.setProperty('--peripheral-view-scale', scale);
    player.style.setProperty('--peripheral-view-clip', cropped ? `inset(${insetY}px ${insetX}px)` : 'none');

    // WebGL側の部屋をスクリーンの大きさに、壁の色を映っている範囲の端に合わせる
    renderer.frontSize = [screenWidth / width, screenHeight / height];
    renderer.pictureSize = [(visibleWidth * scale) / width, (visibleHeight * scale) / height];
    renderer.crop = [visibleWidth / pictureWidth, visibleHeight / pictureHeight];
    renderer.draw();
  };

  const syncButton = () => {
    document.querySelector('.peripheral-view-button')?.setAttribute('aria-pressed', String(Boolean(session)));
  };

  const activate = () => {
    const player = PERIPHERAL_VIEW_SITE.player();
    const video = PERIPHERAL_VIEW_SITE.video(player);
    if (!video) return false;

    const canvas = document.createElement('canvas');
    canvas.className = 'peripheral-view-canvas';
    player.prepend(canvas);

    let renderer;
    try {
      renderer = new PeripheralViewRenderer(canvas, video);
    } catch (error) {
      console.warn('[peripheral-view]', error);
      canvas.remove();
      return false;
    }

    const redraw = () => session?.renderer.draw();
    const observer = new ResizeObserver(updateLayout);
    observer.observe(player);
    observer.observe(video);
    for (const type of REDRAW_EVENTS) video.addEventListener(type, redraw);
    video.addEventListener('resize', updateLayout);

    session = { player, video, canvas, renderer, observer, redraw, enteredFullscreen: false };
    player.classList.add('peripheral-view-on');
    updateLayout();
    renderer.start();
    syncButton();
    return true;
  };

  const deactivate = () => {
    if (!session) return;
    closePanel();
    const { player, video, canvas, renderer, observer, redraw } = session;
    session = null;
    renderer.stop();
    renderer.gl.getExtension('WEBGL_lose_context')?.loseContext();
    observer.disconnect();
    for (const type of REDRAW_EVENTS) video.removeEventListener(type, redraw);
    video.removeEventListener('resize', updateLayout);
    player.classList.remove('peripheral-view-on');
    player.style.removeProperty('--peripheral-view-scale');
    player.style.removeProperty('--peripheral-view-clip');
    canvas.remove();
    syncButton();
  };

  const toggle = () => {
    if (!PERIPHERAL_VIEW_CONNECTED()) {
      retire();
      return;
    }
    if (session) {
      const { enteredFullscreen } = session;
      deactivate();
      if (enteredFullscreen && document.fullscreenElement) document.exitFullscreen();
      return;
    }
    if (!activate()) return;
    if (!document.fullscreenElement) {
      // サイト自身の全画面を使うと、字幕や操作バーの配置がそのまま機能する
      session.enteredFullscreen = true;
      PERIPHERAL_VIEW_SITE.fullscreenButton(session.player)?.click();
    }
  };

  const closePanel = () => {
    if (!panel) return;
    panel.controls.dispose();
    panel.element.remove();
    panel = null;
  };

  const openPanel = () => {
    const element = document.createElement('div');
    element.className = 'peripheral-view-panel';
    // パネル内の操作がサイト側の再生操作やキー操作として扱われないようにする
    for (const type of ['click', 'dblclick', 'keydown']) {
      element.addEventListener(type, (event) => event.stopPropagation());
    }

    const header = document.createElement('div');
    header.className = 'peripheral-view-panel-header';
    const title = document.createElement('span');
    title.textContent = BUTTON_TITLE;
    const exit = document.createElement('button');
    exit.type = 'button';
    exit.textContent = '終了';
    exit.addEventListener('click', toggle);
    header.append(title, exit);

    const controls = createPeripheralViewControls();
    element.append(header, controls.element);
    session.player.append(element);
    panel = { element, controls };
  };

  // 開始前のクリックは開始、動作中のクリックは設定パネルの開閉にする
  const onButtonClick = () => {
    if (!PERIPHERAL_VIEW_CONNECTED()) {
      retire();
    } else if (!session) {
      toggle();
    } else if (panel) {
      closePanel();
    } else {
      openPanel();
    }
  };

  const createIcon = (reference) => {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 36 36');
    // 操作バーのデザインごとに指定が異なるので、隣のボタンに揃える
    svg.setAttribute('width', reference?.getAttribute('width') ?? '100%');
    svg.setAttribute('height', reference?.getAttribute('height') ?? '100%');
    const iconClass = reference?.getAttribute('class');
    if (iconClass) svg.setAttribute('class', iconClass);
    const paths = ['M12 12h12v12H12z', 'M4 7l6 4v14l-6 4z', 'M32 7l-6 4v14l6 4z'];
    for (const d of paths) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      if (!iconClass) path.setAttribute('fill', '#fff');
      svg.append(path);
    }
    return svg;
  };

  const ensureButton = () => {
    if (document.querySelector('.peripheral-view-button')) return;
    const fullscreenButton = PERIPHERAL_VIEW_SITE.fullscreenButton(PERIPHERAL_VIEW_SITE.player());
    if (!fullscreenButton) return;
    const button = document.createElement('button');
    button.className = `${PERIPHERAL_VIEW_SITE.buttonClass(fullscreenButton)} peripheral-view-button`;
    button.title = BUTTON_TITLE;
    button.setAttribute('aria-label', BUTTON_TITLE);
    button.append(createIcon(PERIPHERAL_VIEW_SITE.iconReference(fullscreenButton)));
    button.addEventListener('click', onButtonClick);
    fullscreenButton.parentElement.insertBefore(button, fullscreenButton);
    syncButton();
  };

  const isTyping = (target) =>
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

  document.addEventListener(
    'keydown',
    (event) => {
      if (event.altKey && !event.ctrlKey && !event.metaKey && event.code === 'KeyX' && !isTyping(event.target)) {
        event.preventDefault();
        event.stopPropagation();
        toggle();
      }
    },
    true
  );

  document.addEventListener(
    'pointerdown',
    (event) => {
      if (!panel || event.target.closest?.('.peripheral-view-panel, .peripheral-view-button')) return;
      closePanel();
      // サイトのメニューと同じく、閉じるだけのクリックでは再生状態を変えない
      const { controls } = PERIPHERAL_VIEW_SITE;
      if (!session?.player.contains(event.target) || (controls && event.target.closest(controls))) return;
      const swallow = (click) => click.stopPropagation();
      document.addEventListener('click', swallow, true);
      document.addEventListener(
        'pointerup',
        () => setTimeout(() => document.removeEventListener('click', swallow, true)),
        { capture: true, once: true }
      );
    },
    true
  );

  document.addEventListener('fullscreenchange', () => {
    if (session && !document.fullscreenElement) deactivate();
  });

  // 操作バーや<video>はページ遷移などで作り直されるので、定期的に確認する
  const checkPage = () => {
    if (!PERIPHERAL_VIEW_CONNECTED()) {
      retire();
      return;
    }
    if (session && !session.video.isConnected) deactivate();
    ensureButton();
  };
  const timer = setInterval(checkPage, 2000);

  // 拡張機能が更新されたら、古いスクリプトのボタンと表示を片付けて止める
  // 再読み込みしたタブでは、新しいスクリプトが改めて動く
  const retire = () => {
    clearInterval(timer);
    deactivate();
    document.querySelector('.peripheral-view-button')?.remove();
  };

  checkPage();

  PERIPHERAL_VIEW_API.storage.local.get(PERIPHERAL_VIEW_DEFAULTS).then((stored) => {
    settings = stored;
    updateLayout();
  });

  PERIPHERAL_VIEW_API.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [key, { newValue }] of Object.entries(changes)) {
      settings[key] = newValue ?? PERIPHERAL_VIEW_DEFAULTS[key];
    }
    updateLayout();
  });
})();
