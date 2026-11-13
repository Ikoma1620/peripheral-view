// 設定フォーム。ツールバーのポップアップとプレーヤー内のパネルで共用する
(() => {
  const labels = (entries) =>
    Object.fromEntries(Object.entries(entries).map(([value, { label }]) => [value, label]));

  const CHOICES = [
    {
      key: 'screens',
      label: 'スクリーン',
      options: { three: '3面（左右）', four: '4面（左右＋上）', five: '5面（左右＋上下）' },
    },
    {
      key: 'look',
      label: '見た目',
      options: { classic: '標準', theater: '劇場（座席・床・天井）' },
    },
    {
      key: 'renderMode',
      label: '描画方式',
      options: { classic: '端の色を延ばす', motion: '動きに追従' },
    },
    {
      key: 'videoRatio',
      label: '映像の比率（上下か左右を切り取る）',
      options: labels(PERIPHERAL_VIEW_RATIOS),
      menu: true,
    },
    {
      key: 'screenRatio',
      label: '正面スクリーンの比率',
      options: labels(PERIPHERAL_VIEW_RATIOS),
      menu: true,
    },
    {
      key: 'fit',
      label: '映像の合わせ方',
      options: { contain: '全体を表示', cover: '切り取って埋める' },
    },
    {
      key: 'seat',
      label: '席の位置',
      options: labels(PERIPHERAL_VIEW_SEATS),
    },
    {
      key: 'average',
      label: '平均の方法',
      options: { uniform: '均等', weighted: '端を重視' },
    },
  ];

  const SLIDERS = [
    { key: 'size', label: '正面スクリーンの大きさ（前方席）', min: 0.4, max: 0.9 },
    { key: 'strip', label: '端から平均する幅', min: 0.01, max: 0.3 },
    { key: 'blurRange', label: 'ぼかす範囲', min: 0, max: 0.4 },
    { key: 'brightness', label: '明るさ', min: 0.2, max: 1.5 },
    // only の設定をすべて選んでいるときだけ表示する
    { key: 'motion', label: '動きの追従', min: 0, max: 1.5, only: { renderMode: 'motion' } },
    { key: 'persistence', label: '残像の長さ', min: 0, max: 1, only: { renderMode: 'motion' } },
    { key: 'continuity', label: '連続部分を端まで描く', min: 0, max: 1, only: { renderMode: 'motion' } },
  ];

  const save = (values) => {
    if (PERIPHERAL_VIEW_CONNECTED()) PERIPHERAL_VIEW_API.storage.local.set(values);
  };
  const percent = (value) => `${Math.round(value * 100)}%`;

  const createElement = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
  };

  const matches = (only, values) => Object.entries(only).every(([key, value]) => values[key] === value);

  const createChoice = ({ key, label, options, only }) => {
    const group = createElement('fieldset', 'peripheral-view-choice');
    group.append(createElement('legend', '', label));
    const row = createElement('div', 'peripheral-view-options');
    const radios = Object.entries(options).map(([value, text]) => {
      const option = createElement('label', 'peripheral-view-option');
      const radio = createElement('input');
      radio.type = 'radio';
      radio.name = `peripheral-view-${key}`;
      radio.value = value;
      radio.addEventListener('change', () => save({ [key]: value }));
      option.append(radio, createElement('span', '', text));
      row.append(option);
      return radio;
    });
    group.append(row);
    const render = (values) => {
      for (const radio of radios) radio.checked = radio.value === values[key];
      if (only) group.hidden = !matches(only, values);
    };
    return { element: group, render };
  };

  // 選択肢が多い項目はプルダウンにする
  const createMenu = ({ key, label, options, only }) => {
    const element = createElement('label', 'peripheral-view-menu');
    const select = createElement('select');
    select.name = `peripheral-view-${key}`;
    for (const [value, text] of Object.entries(options)) {
      const option = createElement('option', '', text);
      option.value = value;
      select.append(option);
    }
    select.addEventListener('change', () => save({ [key]: select.value }));
    element.append(createElement('span', '', label), select);
    const render = (values) => {
      select.value = values[key];
      // 以前の版で保存した、今はない選択肢は先頭として表示する
      if (select.selectedIndex < 0) select.selectedIndex = 0;
      if (only) element.hidden = !matches(only, values);
    };
    return { element, render };
  };

  const createSlider = ({ key, label, min, max, only }) => {
    const element = createElement('label', 'peripheral-view-slider');
    const heading = createElement('span', 'peripheral-view-slider-label', label);
    const output = createElement('output');
    heading.append(output);
    const input = createElement('input');
    input.type = 'range';
    input.min = min;
    input.max = max;
    input.step = 0.01;
    input.addEventListener('input', () => {
      output.textContent = percent(input.value);
      save({ [key]: Number(input.value) });
    });
    element.append(heading, input);
    const render = (values) => {
      input.value = values[key];
      output.textContent = percent(values[key]);
      if (only) element.hidden = !matches(only, values);
    };
    return { element, render };
  };

  // 見た目「劇場」の座席表。席を押すと、その席からの目線になる
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const createSvg = (tag, attributes = {}) => {
    const element = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    return element;
  };

  const MAX_FILE_BYTES = 5 * 1024 * 1024;

  // filePicker があるときは、座席表のファイルをこのページだけで読み込めるようにする（ツールバーのポップアップでは出さない）
  // filePicker.onOpen と onClose は、ファイルを選ぶ窓を開く前と閉じた後に呼ぶ
  const createSeatMap = ({ filePicker } = {}) => {
    const theater = PeripheralViewTheater;
    const element = createElement('div', 'peripheral-view-seatmap');
    const heading = createElement('div', 'peripheral-view-seatmap-heading');
    const holder = createElement('div');
    const status = createElement('div', 'peripheral-view-seatmap-status');
    status.setAttribute('role', 'status');

    const choose = (id) => {
      // このページで読み込んだシアターでは、選んだ席も保存しない
      if (theater.isTemporary()) theater.chooseSeat(id);
      else save({ theaterSeat: id });
    };

    // 座席表は、使うシアターが替わったときだけ描き直す
    let drawn = null;
    let buttons = [];
    const draw = () => {
      const model = theater.current();
      if (model === drawn) return;
      drawn = model;
      buttons = [];
      holder.replaceChildren();
      if (!model) return;
      const { walls, screen, partitions } = model.plan;
      const margin = 30;
      const svg = createSvg('svg', {
        viewBox: `${walls.left - margin} ${walls.front - margin} ${walls.right - walls.left + margin * 2} ${walls.back - walls.front + margin * 2}`,
        role: 'group',
        'aria-label': '座席表。席を選ぶと、その席からの目線になります',
      });
      svg.append(
        createSvg('rect', {
          class: 'peripheral-view-seatmap-room',
          x: walls.left,
          y: walls.front,
          width: walls.right - walls.left,
          height: walls.back - walls.front,
          rx: 12,
        }),
        createSvg('rect', {
          class: 'peripheral-view-seatmap-screen',
          x: screen.left,
          y: screen.y + 20,
          width: screen.right - screen.left,
          height: 26,
          rx: 6,
        })
      );
      // 出入口の通路を仕切る壁と、通路の後ろの端をふさぐ壁
      for (const { side, face, front, back, closure } of partitions) {
        svg.append(
          createSvg('rect', {
            class: 'peripheral-view-seatmap-wall',
            x: side < 0 ? face - 20 : face,
            y: front,
            width: 20,
            height: back - front,
          }),
          createSvg('line', {
            class: 'peripheral-view-seatmap-wall-line',
            x1: closure[0],
            y1: closure[1],
            x2: closure[2],
            y2: closure[3],
          })
        );
      }
      const screenLabel = createSvg('text', {
        class: 'peripheral-view-seatmap-label',
        x: (screen.left + screen.right) / 2,
        y: screen.y + 130,
        'text-anchor': 'middle',
      });
      screenLabel.textContent = 'スクリーン';
      svg.append(screenLabel);

      // 列の文字は、その列のまっすぐ並んだ席のいちばん左の、通路側に置く
      const upright = model.seats.filter((seat) => seat.type !== 2 && seat.rotation % 360 === 0);
      const straight = upright.length ? upright : model.seats;
      for (const letter of new Set(straight.map((seat) => seat.row))) {
        const members = straight.filter((seat) => seat.row === letter);
        const first = members.reduce((best, seat) => (seat.x < best.x ? seat : best));
        const label = createSvg('text', {
          class: 'peripheral-view-seatmap-label',
          x: Math.max(first.x - 35, walls.left + 25),
          y: first.y + first.depth / 2 + 16,
          'text-anchor': 'middle',
        });
        label.textContent = letter;
        svg.append(label);
      }

      buttons = model.seats.map((seat) => {
        const rect = createSvg('rect', {
          class: `peripheral-view-seat peripheral-view-seat-${seat.type}`,
          x: seat.x + 4,
          y: seat.y + 4,
          width: Math.max(seat.width - 8, 4),
          height: Math.max(seat.depth - 8, 4),
          rx: 12,
          tabindex: 0,
          role: 'button',
          'aria-label': seat.label,
        });
        if (seat.rotation) {
          rect.setAttribute(
            'transform',
            `rotate(${seat.rotation} ${seat.x + seat.width / 2} ${seat.y + seat.depth / 2})`
          );
        }
        const title = createSvg('title');
        title.textContent = seat.label;
        rect.append(title);
        rect.addEventListener('click', () => choose(seat.id));
        rect.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            choose(seat.id);
          }
        });
        svg.append(rect);
        return { seat, rect };
      });
      holder.append(svg);
    };

    const clear = createElement('button', 'peripheral-view-seatmap-clear', '「席の位置」の設定に戻す');
    clear.type = 'button';
    clear.addEventListener('click', () => choose(''));
    element.append(heading, holder, status, clear);

    // 座席表のファイルを、このページだけで読み込む
    let restore = null;
    if (filePicker) {
      const input = createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.hidden = true;
      const open = createElement('button', '', '座席表のファイルを読み込む（このページだけ）');
      open.type = 'button';
      const note = createElement('div', 'peripheral-view-seatmap-status');
      note.setAttribute('role', 'status');
      open.addEventListener('click', () => {
        note.textContent = '';
        filePicker.onOpen?.();
        input.click();
      });
      input.addEventListener('cancel', () => filePicker.onClose?.());
      input.addEventListener('change', () => {
        filePicker.onClose?.();
        const [file] = input.files;
        input.value = '';
        if (!file) return;
        if (file.size > MAX_FILE_BYTES) {
          note.textContent = '読み込めませんでした：ファイルが大きすぎます';
          return;
        }
        file
          .text()
          .then((text) => {
            theater.loadText(text);
            note.textContent = 'このページを閉じるか再読み込みするまで使います。設定には保存しません';
          })
          .catch((error) => {
            note.textContent = `読み込めませんでした：${error.message}`;
          });
      });
      restore = createElement('button', '', '元のシアターに戻す');
      restore.type = 'button';
      restore.addEventListener('click', () => {
        note.textContent = '';
        theater.clearTemporary();
      });
      element.append(input, open, restore, note);
    }

    const render = (values) => {
      element.hidden = !matches({ look: 'theater' }, values);
      draw();
      if (restore) restore.hidden = !theater.isTemporary();
      const model = theater.current();
      if (!model) {
        heading.textContent = '座席表';
        status.textContent = '座席表を読み込んでいます';
        clear.hidden = true;
        return;
      }
      heading.textContent = `座席表（${model.name}${theater.isTemporary() ? '・このページだけ' : ''}）`;
      const current = theater.resolve(values);
      const chosen = theater.isChosen(values);
      for (const { seat, rect } of buttons) {
        rect.classList.toggle('peripheral-view-seat-current', seat === current);
        rect.setAttribute('aria-pressed', String(seat === current));
      }
      const seatLabel = PERIPHERAL_VIEW_SEATS[values.seat]?.label ?? PERIPHERAL_VIEW_SEATS.front.label;
      status.textContent = chosen
        ? `目線：${current.label}（座席表で選択）`
        : `目線：${current.label}（席の位置：${seatLabel}）。席を押すと、その席からの目線になります`;
      clear.hidden = !chosen;
    };
    return { element, render };
  };

  globalThis.createPeripheralViewControls = ({ theaterFile } = {}) => {
    const root = createElement('div', 'peripheral-view-controls');
    const fields = [
      ...CHOICES.map((choice) => (choice.menu ? createMenu : createChoice)(choice)),
      ...SLIDERS.map(createSlider),
    ];
    // 座席表は「見た目」のすぐ下に置く
    const lookIndex = CHOICES.findIndex(({ key }) => key === 'look');
    fields.splice(lookIndex + 1, 0, createSeatMap({ filePicker: theaterFile }));
    root.append(...fields.map((field) => field.element));

    const reset = createElement('button', 'peripheral-view-reset', '初期設定に戻す');
    reset.type = 'button';
    reset.addEventListener('click', () => save({ ...PERIPHERAL_VIEW_DEFAULTS }));
    root.append(reset);

    const refresh = () => {
      if (!PERIPHERAL_VIEW_CONNECTED()) return;
      PERIPHERAL_VIEW_API.storage.local.get(PERIPHERAL_VIEW_DEFAULTS).then((values) => {
        for (const field of fields) field.render(values);
      });
    };
    refresh();
    PERIPHERAL_VIEW_API.storage.onChanged.addListener(refresh);
    // 座席表を読み終えたときと、このページで別のシアターを読み込んだときも描き直す
    const unsubscribe = PeripheralViewTheater.onChange(refresh);
    const dispose = () => {
      unsubscribe();
      if (PERIPHERAL_VIEW_CONNECTED()) PERIPHERAL_VIEW_API.storage.onChanged.removeListener(refresh);
    };
    return { element: root, dispose };
  };
})();
