// 設定フォーム。ツールバーのポップアップとプレーヤー内のパネルで共用する
(() => {
  const CHOICES = [
    {
      key: 'screens',
      label: 'スクリーン',
      options: { three: '3面（左右）', four: '4面（左右＋上）', five: '5面（左右＋上下）' },
    },
    {
      key: 'seat',
      label: '席の位置',
      options: Object.fromEntries(
        Object.entries(PERIPHERAL_VIEW_SEATS).map(([value, { label }]) => [value, label])
      ),
    },
    {
      key: 'average',
      label: '平均の方法',
      options: { uniform: '均等', weighted: '端を重視' },
    },
  ];

  const SLIDERS = [
    { key: 'size', label: '中央スクリーンの大きさ（前方席）', min: 0.4, max: 0.9 },
    { key: 'strip', label: '端から平均する幅', min: 0.01, max: 0.3 },
    { key: 'blurRange', label: 'ぼかす範囲', min: 0, max: 0.4 },
    { key: 'brightness', label: '明るさ', min: 0.2, max: 1.5 },
  ];

  const save = (values) => PERIPHERAL_VIEW_API.storage.local.set(values);
  const percent = (value) => `${Math.round(value * 100)}%`;

  const createElement = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
  };

  const createChoice = ({ key, label, options }) => {
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
    };
    return { element: group, render };
  };

  const createSlider = ({ key, label, min, max }) => {
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
    };
    return { element, render };
  };

  globalThis.createPeripheralViewControls = () => {
    const root = createElement('div', 'peripheral-view-controls');
    const fields = [...CHOICES.map(createChoice), ...SLIDERS.map(createSlider)];
    root.append(...fields.map((field) => field.element));

    const reset = createElement('button', 'peripheral-view-reset', '初期設定に戻す');
    reset.type = 'button';
    reset.addEventListener('click', () => save({ ...PERIPHERAL_VIEW_DEFAULTS }));
    root.append(reset);

    const refresh = () =>
      PERIPHERAL_VIEW_API.storage.local.get(PERIPHERAL_VIEW_DEFAULTS).then((values) => {
        for (const field of fields) field.render(values);
      });
    refresh();
    PERIPHERAL_VIEW_API.storage.onChanged.addListener(refresh);
    return { element: root, dispose: () => PERIPHERAL_VIEW_API.storage.onChanged.removeListener(refresh) };
  };
})();
