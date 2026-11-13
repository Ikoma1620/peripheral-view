// 見た目「劇場」：部屋を映画館のように描く（前の列の座席、通路の段、床、天井、スクリーンまわりの黒い幕、壁の上のプロジェクター）
// 従来の描画（renderer.js）と「動きに追従」（motion.js）の部屋のシェーダーで共用する
// 座席の並びは、座席表のファイル（theaters/theater-7.json。作成ツールが書き出した形式のまま）から読み、
// 選んだ席の位置と高さから見た景色にする。同じ形式のファイルを、そのページだけで一時的に読み込むこともできる
// 正面スクリーンは座席表どおりの幅で、左右の壁との間は斜めのスクリーンでつなぐ
(() => {
  const BUNDLED = 'theaters/theater-7.json';
  // 正面スクリーンの端と左右の壁の間を、奥行きの向きから22.5度開いた斜めのスクリーンでつなぐ
  const WING_ANGLE = (22.5 * Math.PI) / 180;
  const SIDE_CLEAR = 1.55; // 床から左右のスクリーンの下端まで（背もたれの上端 1.05m + 50cm）
  const SCREEN_BOTTOM = SIDE_CLEAR; // 最前列の床から、正面スクリーンの下端まで。左右のスクリーンのいちばん低い所に合わせる
  const RISER = 0.4; // 1列ごとの段差（m）。座席表にないので想定
  const FLAT_ROWS = 2; // 前から2列は段差なし
  const BACK_HEIGHT = [1.05, 1.15]; // 床から背もたれの上端まで（通常席、幅の広い席）
  const WIDE_SEAT = 70; // これ以上の幅（cm）の席は、幅の広い席として背もたれを高くする
  const EYE_FROM_BACK = 0.25; // 背もたれから目まで
  const MAX_ROWS = 16;
  const MAX_SEGMENTS = 5; // 1列の中の、通路や向きで区切られたブロックの数
  const WALL_SPAN = 14; // 左右のスクリーンに映像を延ばす長さ（m）。席を替えても、壁の同じ所に同じ映像が映る
  const MAX_BOX = 0.92; // 近い席や端の席でも、正面スクリーンが画面のこの範囲に収まるように画角を広げる
  // 「席の位置」に当てる列（最前列を0、最後列を1とする位置）。12列なら E、G、J 列
  const AUTO_ROWS = { front: 0.36, middle: 0.55, back: 0.82 };

  const metres = (cm) => cm / 100;
  const finite = (...values) => values.every((value) => Number.isFinite(value));

  // ---------------------------------------------------------------- 座席表
  // 座席表のファイルの中身（単位はcm、上がスクリーン側）から、描くための寸法を作る
  const build = (data) => {
    if (!data || typeof data !== 'object' || !Array.isArray(data.seats) || !data.screen) {
      throw new Error('座席表のファイルではありません（screen と seats が見つかりません）');
    }
    const screenLeft = Number(data.screen.x);
    const screenWidth = Number(data.screen.width);
    if (!finite(screenLeft, screenWidth) || screenWidth <= 0) throw new Error('スクリーンの位置と幅を読み取れません');
    const screen = {
      left: screenLeft,
      right: screenLeft + screenWidth,
      y: (Number(data.screen.y) || 0) + (Number(data.screen.height) || 0) / 2,
    };
    const center = (screen.left + screen.right) / 2;
    const half = metres(screenWidth) / 2;
    // 図面の上の点（cm）を、スクリーンの中心から右へ x、スクリーンから奥へ z の位置（m）に直す
    const place = ([x, y]) => [metres(x - center), metres(y - screen.y)];
    // 長方形の中心から (dx, dy) の点を、中心のまわりに回した位置（図面と同じく時計回りが正）
    const turned = (cx, cy, degrees, dx, dy) => {
      const angle = (degrees * Math.PI) / 180;
      return [cx + dx * Math.cos(angle) - dy * Math.sin(angle), cy + dx * Math.sin(angle) + dy * Math.cos(angle)];
    };

    const wheelchair = new Set(
      (Array.isArray(data.seatTypes) ? data.seatTypes : [])
        .filter((type) => type?.design === 'wheelchair')
        .map((type) => type.id)
    );
    const ids = new Set();
    const seats = [];
    for (const source of data.seats) {
      const seat = {
        row: String(source?.row ?? ''),
        number: source?.number ?? '',
        x: Number(source?.x),
        y: Number(source?.y),
        width: Number(source?.width),
        depth: Number(source?.height),
        rotation: Number(source?.rotation) || 0,
      };
      if (!finite(seat.x, seat.y, seat.width, seat.depth) || seat.width <= 0 || seat.depth <= 0) continue;
      seat.type = wheelchair.has(source.type) ? 2 : seat.width >= WIDE_SEAT ? 1 : 0;
      // 背もたれの左右の端（図面の上の点）。向きのある席では斜めになる
      const cx = seat.x + seat.width / 2;
      const cy = seat.y + seat.depth / 2;
      seat.backLeft = turned(cx, cy, seat.rotation, -seat.width / 2, seat.depth / 2);
      seat.backRight = turned(cx, cy, seat.rotation, seat.width / 2, seat.depth / 2);
      // 設定に保存する名前。車椅子スペースは列の文字と番号が座席と重なることがある
      let id = `${seat.type === 2 ? 'W' : seat.row}-${seat.number}`;
      while (ids.has(id)) id += '+';
      ids.add(id);
      seat.id = id;
      seat.label = seat.type === 2 ? `車椅子スペース ${seat.number}` : `${seat.row}列 ${seat.number}番`;
      seats.push(seat);
    }
    const regular = seats.filter((seat) => seat.type !== 2);
    if (!regular.length) throw new Error('座席が見つかりません');

    // 左右の壁は、それぞれの側でいちばん長い縦の壁。その内側にある縦の壁は、出入口の通路の仕切りとみなす
    const allWalls = (Array.isArray(data.objects) ? data.objects : [])
      .filter((object) => object?.type === 'wall')
      .map((object) => ({
        x: Number(object.x),
        y: Number(object.y),
        width: Number(object.width),
        height: Number(object.height),
        rotation: (Number(object.rotation) || 0) % 360,
      }))
      .filter((wall) => finite(wall.x, wall.y, wall.width, wall.height));
    const vertical = allWalls.filter((wall) => !wall.rotation && wall.height > wall.width && wall.height >= 300);
    const others = allWalls.filter((wall) => !vertical.includes(wall));
    const walls = {};
    const partitions = [];
    for (const side of [-1, 1]) {
      // 客席側の面
      const face = (wall) => (side < 0 ? wall.x + wall.width : wall.x);
      const candidates = vertical
        .filter((wall) => (wall.x + wall.width / 2 - center) * side > 0)
        .sort((a, b) => b.height - a.height || (b.x - a.x) * side);
      const seatEdge =
        side < 0
          ? Math.min(...seats.map((seat) => seat.x)) - 30
          : Math.max(...seats.map((seat) => seat.x + seat.width)) + 30;
      const outer = candidates.length ? face(candidates[0]) : seatEdge;
      // 正面スクリーンは壁の内側に収まる
      const edge = side < 0 ? Math.min(outer, screen.left) : Math.max(outer, screen.right);
      walls[side < 0 ? 'left' : 'right'] = edge;
      const partition = candidates.slice(1).find((wall) => (edge - face(wall)) * side >= 50);
      if (partition) {
        const position = face(partition);
        const back = partition.y + partition.height;
        // 通路の後ろの端をふさぐ壁。仕切りの後ろの端の近くで、仕切りと部屋の壁の間にある壁を使う。図面で斜めなら斜めに描く
        let closure = [position, back - 10, edge, back - 10];
        const closing = others.find((wall) => {
          const cx = wall.x + wall.width / 2;
          const cy = wall.y + wall.height / 2;
          return (cx - position) * side > -30 && (edge - cx) * side > -30 && cy > back - 150 && cy < back + 100;
        });
        if (closing) {
          const cx = closing.x + closing.width / 2;
          const cy = closing.y + closing.height / 2;
          const [ax, ay] = turned(cx, cy, closing.rotation, -closing.width / 2, 0);
          const [bx, by] = turned(cx, cy, closing.rotation, closing.width / 2, 0);
          // 壁の線を、仕切りの面と部屋の壁の面まで延ばす
          if (Math.abs(bx - ax) > 1) {
            const at = (x) => ay + ((by - ay) * (x - ax)) / (bx - ax);
            closure = [position, at(position), edge, at(edge)];
          }
        }
        partitions.push({ side, face: position, front: partition.y, back, closure });
      }
    }
    walls.front = screen.y - 20;
    walls.back = Math.max(
      ...seats.map((seat) => seat.y + seat.depth + 60),
      ...vertical.map((wall) => wall.y + wall.height)
    );
    // 部屋はスクリーンの中心で左右対称として描く
    const roomHalf = Math.max(metres(walls.right - walls.left) / 2, half);
    const wingDepth = (roomHalf - half) / Math.tan(WING_ANGLE);
    const parts = new Float32Array(8);
    for (const { side, face, front, closure } of partitions) {
      // 中心から仕切りまで、仕切りの前の端、通路の後ろをふさぐ壁の仕切り側の端と壁側の端（端はスクリーンから）
      parts.set(
        [
          metres(Math.abs(face - center)),
          metres(front - screen.y),
          metres(closure[1] - screen.y),
          metres(closure[3] - screen.y),
        ],
        side < 0 ? 0 : 4
      );
    }

    // 列ごとの、背もたれの位置、床の高さ、座席のブロック
    const rows = [];
    for (const letter of new Set(regular.map((seat) => seat.row))) {
      const members = regular.filter((seat) => seat.row === letter).sort((a, b) => a.x - b.x);
      const upright = members.filter((seat) => seat.rotation % 360 === 0);
      const straight = upright.length ? upright : members;
      const back = Math.max(...straight.map((seat) => seat.y + seat.depth));
      const front = Math.min(...straight.map((seat) => seat.y));
      // 隣り合って同じ向きに並ぶ席を1つのブロックにまとめる。背もたれの面は、ブロックごとに向きが違う
      const segments = [];
      for (const seat of members) {
        const last = segments[segments.length - 1];
        if (last && last.pitch === seat.width && last.rotation === seat.rotation && Math.abs(seat.x - last.right) <= 6) {
          last.right = seat.x + seat.width;
          last.end = seat.backRight;
        } else {
          segments.push({
            right: seat.x + seat.width,
            pitch: seat.width,
            rotation: seat.rotation,
            start: seat.backLeft,
            end: seat.backRight,
          });
        }
      }
      rows.push({
        letter,
        back: metres(back - screen.y) - 0.05, // スクリーンから背もたれまで
        front: metres(front - screen.y),
        backHeight: BACK_HEIGHT[members[0].type] ?? BACK_HEIGHT[0],
        // 背もたれの面の両端（x、スクリーンからの距離）と、座席の幅
        segments: segments.slice(0, MAX_SEGMENTS).map(({ start, end, pitch }) => {
          const [x0, z0] = place(start);
          const [x1, z1] = place(end);
          return { line: [x0, z0 - 0.05, x1, z1 - 0.05], info: [metres(pitch), 0, 0, 0] };
        }),
      });
    }
    rows.sort((a, b) => a.back - b.back);
    rows.forEach((row, index) => {
      row.index = index;
      row.floor = Math.max(0, index - FLAT_ROWS + 1) * RISER;
      // 段の先端。前の列の背もたれのすぐ後ろで、横通路の後ろでは足元の分だけ前に出す
      row.edge = row.floor > 0 ? Math.max(rows[index - 1].back + 0.1, row.front - 0.45) : 0;
    });
    for (const seat of seats) {
      // 車椅子スペースは列の文字と場所が合わないので、いちばん近い列に入れる
      const back = metres((seat.backLeft[1] + seat.backRight[1]) / 2 - screen.y);
      seat.back = back - 0.05; // スクリーンから、この席の背もたれまで
      seat.rowIndex =
        seat.type === 2
          ? rows.reduce((best, row) => (Math.abs(row.back - back) < Math.abs(rows[best].back - back) ? row.index : best), 0)
          : rows.findIndex((row) => row.letter === seat.row);
    }

    const model = {
      name: String(data.theater?.name ?? '') || 'シアター',
      plan: { walls, screen, partitions },
      seats,
      rows,
      center,
      half,
      // 部屋の幅の半分、斜めのスクリーンの奥行きと面に沿った長さ、部屋の奥行き
      room: [roomHalf, wingDepth, Math.hypot(roomHalf - half, wingDepth), metres(walls.back - screen.y)],
      // 列ごとの床の高さ。スクリーンに近い列から並べ、余りは最後の列で埋める
      floors: new Float32Array(
        Array.from({ length: MAX_ROWS }, (_, index) => {
          const row = rows[Math.min(index, rows.length - 1)];
          return [row.back, row.floor, 0, 0];
        }).flat()
      ),
      parts,
      eyeHeight: metres(Number(data.settings?.eyeHeight) || 115),
    };
    model.reference = eyeOf(model, autoSeat(model, 'front')).distance;
    return model;
  };

  // 「席の位置」の前方・中央・後方に当てる、その列の中央の席
  const autoSeat = (model, setting) => {
    const position = AUTO_ROWS[setting] ?? AUTO_ROWS.front;
    const rowIndex = Math.round((model.rows.length - 1) * position);
    const offset = (seat) => Math.abs(seat.x + seat.width / 2 - model.center);
    return model.seats
      .filter((seat) => seat.rowIndex === rowIndex && seat.type !== 2)
      .reduce((best, seat) => (offset(seat) < offset(best) ? seat : best));
  };

  // 席から見た目の位置（m）。x はスクリーンの中心から右が正、distance はスクリーンまで、height は最前列の床から
  const eyeOf = (model, seat) => {
    const row = model.rows[seat.rowIndex];
    return {
      x: metres(seat.x + seat.width / 2 - model.center),
      distance: seat.back - EYE_FROM_BACK,
      height: row.floor + model.eyeHeight,
      row,
    };
  };

  // ---------------------------------------------------------------- 使うシアター
  // bundled は拡張機能に入っているシアター、temporary はこのページで読み込んだシアター（保存しない）
  let bundled = null;
  let temporary = null; // { model, seatId }
  const listeners = new Set();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const onChange = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const current = () => temporary?.model ?? bundled;
  const isTemporary = () => Boolean(temporary);

  // 座席表のファイルの中身を、このページだけで使う。読めないときは理由を投げる
  const loadText = (text) => {
    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new Error('JSON として読み取れません');
    }
    temporary = { model: build(data), seatId: '' };
    notify();
  };

  const clearTemporary = () => {
    if (!temporary) return;
    temporary = null;
    notify();
  };

  // このページで読み込んだシアターでは、選んだ席も保存しない
  const chooseSeat = (id) => {
    if (!temporary) return;
    temporary.seatId = id;
    notify();
  };

  // 目線にする席。座席表で選んでいなければ「席の位置」から決める
  const resolve = (settings) => {
    const model = current();
    if (!model) return null;
    const id = temporary ? temporary.seatId : settings.theaterSeat;
    return model.seats.find((seat) => seat.id === id) ?? autoSeat(model, settings.seat);
  };

  // 座席表で選んだ席かどうか
  const isChosen = (settings) => {
    const id = temporary ? temporary.seatId : settings.theaterSeat;
    return Boolean(id) && resolve(settings)?.id === id;
  };

  // ---------------------------------------------------------------- 視線
  // 選んだ席の目の位置から、正面スクリーンの中心を見るカメラ。席が端や前になるほど、スクリーンは斜めに見える
  // frontSize は、前方席の正面から見たときの正面スクリーンの半分のサイズ（NDC）。画角はこれで決まり、席を替えても変わらない
  // 座標は x が右、y が上、z がスクリーンの向きで、スクリーンの中心を原点とする（m）
  const cameraOf = (model, settings, frontSize, width, height) => {
    const eye = eyeOf(model, resolve(settings));
    const halfWidth = model.half;
    // 幅は固定で、高さは正面スクリーンの比率で決まる。下端の高さは変えず、上端と天井が上下する
    const halfHeight = (halfWidth * frontSize[1] * height) / (frontSize[0] * width);
    const offset = [eye.x, eye.height - (SCREEN_BOTTOM + halfHeight)]; // スクリーンの中心から見た目の位置
    const distance = eye.distance;

    const length = Math.hypot(offset[0], offset[1], distance);
    const forward = [-offset[0] / length, -offset[1] / length, distance / length];
    const flat = Math.hypot(forward[0], forward[2]);
    const right = [forward[2] / flat, 0, -forward[0] / flat];
    const up = [
      forward[1] * right[2] - forward[2] * right[1],
      forward[2] * right[0] - forward[0] * right[2],
      forward[0] * right[1] - forward[1] * right[0],
    ];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const aspect = width / height;

    // スクリーンの四隅が画面に収まらない席では、収まるまで画角を広げる
    let focal = (frontSize[0] * model.reference) / halfWidth;
    let extent = 0;
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const v = [sx * halfWidth - offset[0], sy * halfHeight - offset[1], distance];
      const depth = Math.max(dot(v, forward), 1e-3);
      extent = Math.max(extent, Math.abs((focal * dot(v, right)) / depth), Math.abs((focal * aspect * dot(v, up)) / depth));
    }
    if (extent > MAX_BOX) focal *= MAX_BOX / extent;

    return { eye, offset, distance, halfWidth, halfHeight, forward, right, up, focal, aspect, dot };
  };

  // 画面の位置（NDC）から、正面スクリーン面の上の位置（スクリーンの半分を1）への変換。シェーダーへ mat3 として渡す
  const viewMatrix = ({ offset, distance, halfWidth, halfHeight, forward, right, up, focal, aspect }) => {
    const column = (d) => [
      (offset[0] * d[2] + distance * d[0]) / halfWidth,
      (offset[1] * d[2] + distance * d[1]) / halfHeight,
      d[2],
    ];
    return new Float32Array([
      ...column(right.map((value) => value / focal)),
      ...column(up.map((value) => value / (focal * aspect))),
      ...column(forward),
    ]);
  };

  // 実際の<video>などの要素に指定する CSS の transform
  // 要素の中心からの位置（px）を scale 倍すると、正面から見た正面スクリーン（screenWidth × screenHeight px）の上の位置になる
  // それを席から見た画面の位置へ移す
  const videoTransform = ({ settings, frontSize, width, height, scale, screenWidth, screenHeight }) => {
    const camera = cameraOf(current(), settings, frontSize, width, height);
    const { offset, distance, forward, right, up, focal } = camera;
    const a = (scale * camera.halfWidth) / (screenWidth / 2);
    const b = (-scale * camera.halfHeight) / (screenHeight / 2);
    const k = (focal * width) / 2;
    // 要素の (x, y, 1) に掛ける行。カメラの軸 axis の成分を取り出す
    const row = (axis, gain) => [
      gain * axis[0] * a,
      gain * axis[1] * b,
      gain * (-axis[0] * offset[0] - axis[1] * offset[1] + axis[2] * distance),
    ];
    const x = row(right, k);
    const y = row(up, -k);
    const w = row(forward, 1);
    const n = w[2];
    const m = [x, y, w].map((values) => values.map((value) => value / n));
    return `matrix3d(${[m[0][0], m[1][0], 0, m[2][0], m[0][1], m[1][1], 0, m[2][1], 0, 0, 1, 0, m[0][2], m[1][2], 0, m[2][2]].join(',')})`;
  };

  // 拡張機能に入っているシアターを読む。読み終わるまで、見た目「劇場」は「標準」として描く
  const ready = fetch(PERIPHERAL_VIEW_API.runtime.getURL(BUNDLED))
    .then((response) => response.json())
    .then((data) => {
      bundled = build(data);
      notify();
    })
    .catch((error) => console.warn('[peripheral-view]', '座席表を読み込めません', error));

  // ---------------------------------------------------------------- シェーダー
  // 部屋のシェーダーの main より前に差し込む
  // q は視点から正面スクリーン面への視線（スクリーンの半分を1とする）、t は視点から正面スクリーン面までを1とする奥行き
  // 視点はスクリーンの中心から uTheaterEye.xy だけずれているので、スクリーンの中心から見た位置は eye + q * t
  const GLSL = `
uniform float uTheater;      // 1 で劇場の見た目
uniform mat3 uTheaterView;   // 画面の位置（NDC）から、正面スクリーン面の上の位置（スクリーンの半分を1）への変換
uniform vec4 uTheaterScale;  // スクリーンの幅の半分（m）、高さの半分（m）、スクリーンまでの距離（m）、列の数
uniform vec4 uTheaterEye;    // スクリーンの中心から見た視点（スクリーンの半分を1）、視点の横の位置（m）、視点から見た最前列の床の高さ（m）
uniform vec4 uTheaterRoom;   // 部屋の幅の半分、斜めのスクリーンの奥行き、斜めのスクリーンの面に沿った長さ、部屋の奥行き（m）
uniform vec4 uTheaterFloor[${MAX_ROWS}];  // すべての列の、スクリーンからの距離と床の高さ（m、最前列の床から）。スクリーンに近い列から
uniform vec4 uTheaterPart[2]; // 出入口の通路の仕切り（左、右）。中心からの距離、前の端、通路の後ろをふさぐ壁の仕切り側の端と壁側の端（m、端はスクリーンから）。なければ 0
uniform vec4 uTheaterRows[${MAX_ROWS}];   // 近い列から。背もたれまでの距離、背もたれの上端、段の先端までの距離、床の高さ（m、高さは視点から）
uniform vec4 uTheaterSegs[${MAX_ROWS * MAX_SEGMENTS}];  // 列ごとの座席のブロック。背もたれの面の両端（x、スクリーンからの距離、m）
uniform vec4 uTheaterSegInfo[${MAX_ROWS * MAX_SEGMENTS}];  // 座席の幅（m）。0 ならブロックなし

const int S_SCREEN = 0;   // 正面スクリーン
const int S_WALL = 1;     // 左右の壁
const int S_CEILING = 2;
const int S_FLOOR = 3;
const int S_FRONT = 4;    // 正面スクリーンの上下の黒い幕（劇場だけ）

const int T_MAX_ROWS = ${MAX_ROWS};
const int T_MAX_SEGMENTS = ${MAX_SEGMENTS};
const float T_CORNER = 0.075;  // 背もたれの角の丸み
const float T_WALL_SPAN = ${WALL_SPAN.toFixed(1)};  // 左右のスクリーンに映像を延ばす長さ
const float T_ABOVE = 0.87;    // スクリーンの上端から天井まで（3面のとき）
const float T_PROJECTORS = 4.0; // 片側のプロジェクターの台数
const float T_SIDE_GAP = 0.05; // 正面スクリーンの端と、左右のスクリーンの間のすき間
const float T_SIDE_CLEAR = ${SIDE_CLEAR.toFixed(3)}; // 床から左右のスクリーンの下端まで
const float T_PART_RISE = 1.15; // 床から仕切りの上端まで（隣の背もたれの上端 + 10cm）

// 視線が最初に当たる面と、その奥行きを求める
// 天井はスクリーンの上端に合わせて上下し、3面のときだけ上端より高くする。床は最前列の床の高さ
// along は、壁に当たったときの、正面スクリーンの端から面に沿って測った距離（m）
// facing が負のときは、スクリーンと逆の向き（真横より後ろ）を見ている視線。q の向きが実際の視線と逆になるので、
// t は負になり、0 に近いほど手前。近い席や端の席で画角が広がると、画面の端がこの向きになる
void theaterSurface(vec2 q, float facing, int screens, out int surface, out float t, out float along) {
  if (facing < 0.0) {
    vec2 behind = uTheaterEye.xy;
    float side = q.x > 0.0 ? -1.0 : 1.0;
    surface = S_WALL;
    t = abs(q.x) > 1e-6 ? (side * uTheaterRoom.x / uTheaterScale.x - behind.x) / q.x : -1e6;
    if (q.y < 0.0) {
      float tc = ((screens >= 4 ? 1.0 : 1.0 + T_ABOVE / uTheaterScale.y) - behind.y) / q.y;
      if (tc > t) {
        surface = S_CEILING;
        t = tc;
      }
    } else if (q.y > 0.0) {
      // 後ろは、自分の列の床が続いているものとして描く
      float tf = uTheaterRows[0].w / uTheaterScale.y / q.y;
      if (tf > t) {
        surface = S_FLOOR;
        t = tf;
      }
    }
    along = uTheaterRoom.z + (1.0 - t) * uTheaterScale.z - uTheaterRoom.y;
    return;
  }
  vec2 eye = uTheaterEye.xy;
  vec2 at = abs(eye + q);
  surface = S_FRONT;
  t = 1.0;
  along = 0.0;
  if (at.x <= 1.0 && at.y <= 1.0) {
    surface = S_SCREEN;
    return;
  }
  if (at.x > 1.0) {
    surface = S_WALL;
    float side = sign(q.x);
    float room = uTheaterRoom.x / uTheaterScale.x;
    float wing = uTheaterRoom.y / uTheaterScale.z;
    t = (side * room - eye.x) / q.x;
    // 正面スクリーンが壁いっぱいのシアターには、斜めのスクリーンがない
    if (wing > 1e-4 && t > 1.0 - wing) {
      // 正面スクリーンの端から壁へ開く、斜めのスクリーン
      float k = (room - 1.0) / wing;
      t = clamp((1.0 + k - side * eye.x) / (side * q.x + k), 1.0 - wing, 1.0);
      along = (1.0 - t) / wing * uTheaterRoom.z;
    } else {
      along = uTheaterRoom.z + (1.0 - min(t, 1.0)) * uTheaterScale.z - uTheaterRoom.y;
    }
  }
  float hy = uTheaterScale.y;
  if (q.y > 0.0) {
    float tc = ((screens >= 4 ? 1.0 : 1.0 + T_ABOVE / hy) - eye.y) / q.y;
    if (tc < t) {
      surface = S_CEILING;
      t = tc;
    }
  } else if (q.y < 0.0) {
    float tf = uTheaterEye.w / hy / q.y;
    if (tf < t) {
      surface = S_FLOOR;
      t = tf;
    }
  }
}

// 壁の面に沿った距離 along（m）から、映像を延ばす向きの位置を求める。visible は 1 - 正面スクリーンの大きさ
// 従来の描画の「視点から正面スクリーン面までを1とする奥行き」の代わりに使い、席を替えても壁の同じ所に同じ映像を映す
float theaterWallT(float along, float visible) {
  return 1.0 - min(along / T_WALL_SPAN, 1.0) * visible;
}

// 間隔 pitch ごとの細い線。fw は1ピクセルの長さで、線が細かくなりすぎる所では消す
float tLine(float position, float pitch, float width, float fw) {
  float d = (0.5 - abs(fract(position / pitch) - 0.5)) * pitch;
  return (1.0 - smoothstep(width, width + max(fw, 1e-4), d)) * (1.0 - smoothstep(0.25, 0.8, fw / pitch));
}

float tHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

// 視点から奥へ d（m）進んだ所の、床の高さ（m、視点から）。列の間は斜めにつなぐ
float tFloorAt(float d) {
  // 自分より後ろの列も含めて、客席全体の段から求める
  float z = uTheaterScale.z - d;
  float h = uTheaterFloor[0].y;
  for (int i = 0; i < T_MAX_ROWS - 1; i++) {
    vec4 front = uTheaterFloor[i];
    vec4 back = uTheaterFloor[i + 1];
    if (z > front.x) h = mix(front.y, back.y, clamp((z - front.x) / max(back.x - front.x, 1e-3), 0.0, 1.0));
  }
  return h + uTheaterEye.w;
}

// 壁：吸音パネルの壁の上に、左右のスクリーンをわずかに浮かせて付ける。v はスクリーンの中心からの高さ
// 左右のスクリーンは、正面スクリーンの端から斜めに開いて壁に沿う。下端は座席の背もたれの50cm上までで、
// 客席の段に沿って、後ろほど下が削られる
vec3 theaterWall(vec3 projected, float v, float t, float along, vec3 light, float aa) {
  float hy = uTheaterScale.y;
  float height = v * hy;
  aa = clamp(aa, 1e-4, 0.3);

  float bottom = max(-hy, tFloorAt(t * uTheaterScale.z) + T_SIDE_CLEAR + uTheaterEye.y * hy);
  // スクリーンの内側で正、外側で負になる、縁からの距離（m）
  float inside = min(min(hy - height, height - bottom), along - T_SIDE_GAP);

  // 吸音パネル：布張りのパネルを目地で区切り、1枚ごとにわずかに色を変える
  vec2 panel = vec2(along, height + 60.0) / 1.2;
  float joint = max(tLine(along, 1.2, 0.01, aa), tLine(height + 60.0, 1.2, 0.01, aa));
  float tone = mix(1.0, 0.82 + 0.36 * tHash(floor(panel)), 1.0 - smoothstep(0.25, 0.8, aa / 1.2));
  vec3 acoustic = (vec3(0.014, 0.014, 0.016) + light * 0.05) * tone * (1.0 - 0.6 * joint);
  // 浮いたスクリーンが壁に落とす影
  acoustic *= 1.0 - 0.7 * exp(-max(-inside, 0.0) / 0.12);

  // スクリーンの縁は厚みの分だけ暗くし、斜めの面と壁沿いの面の折り目に細い継ぎ目を入れる
  float fold = (1.0 - smoothstep(0.012, 0.012 + aa, abs(along - uTheaterRoom.z))) * step(1e-3, uTheaterRoom.z);
  vec3 screen = projected * (0.78 + 0.22 * smoothstep(0.0, 0.04, inside)) * (1.0 - 0.55 * fold);
  return mix(acoustic, screen, smoothstep(-aa, aa, inside));
}

// 壁の上のプロジェクターは片側に4台で、部屋の奥行きを等分した区画の中央に1台ずつ置く
// 壁のこの奥行きがある区画の、プロジェクターのスクリーンからの距離（m）を返す
float theaterProjectorDepth(float t) {
  float spacing = max(uTheaterRoom.w, 4.0) / T_PROJECTORS;
  float index = clamp(floor((1.0 - t) * uTheaterScale.z / spacing), 0.0, T_PROJECTORS - 1.0);
  return (index + 0.5) * spacing;
}

// プロジェクターを壁に重ねる。lens は向かいの壁へ映している映像の色、aa は壁の上での1ピクセルの長さ（m）
vec3 theaterProjector(vec3 base, float v, float t, float depth, int screens, vec3 lens, vec3 light, float aa) {
  // 3面では投影の帯の上の壁に付け、4面と5面では天井（上のスクリーン）から帯の上端に下げる
  vec2 p = vec2((1.0 - t) * uTheaterScale.z - depth, (v - 1.0) * uTheaterScale.y - (screens >= 4 ? -0.26 : 0.5));
  float r = length(p);
  if (r > 3.0) return base;
  aa = clamp(aa, 1e-4, 0.2);
  vec2 d = abs(p) - vec2(0.32, 0.18) + 0.05;
  float box = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - 0.05;
  vec3 result = mix(base, vec3(0.03) + light * (0.03 + 0.05 * smoothstep(0.0, 0.18, p.y)), 1.0 - smoothstep(-aa, aa, box));
  // レンズと、そのまわりの光
  result = mix(result, lens * 1.25 + 0.02, 1.0 - smoothstep(0.075 - aa, 0.075 + aa, r));
  return result + lens * (0.4 * exp(-r * r / 0.05) + 0.07 * exp(-r / 0.7));
}

// 天井：スクリーンの光が回り込んだ色に、天井板の目地を重ねる
vec3 theaterCeiling(vec3 glow, float s, float t, float fw, float fx) {
  float depth = (1.0 - t) * uTheaterScale.z;
  float joint = max(tLine(depth, 0.2, 0.003, fw), tLine(s * uTheaterScale.x, 0.2, 0.003, fx * t * uTheaterScale.x));
  return glow * 1.3 * (1.0 - 0.3 * joint) + vec3(0.002);
}

// 劇場のカーペット：グレーに、濃いグレーの菱形の格子と明るいグレーの点の柄。at は床の上の位置（m）、fw は1ピクセルの長さ（m）
vec3 theaterCarpet(vec2 at, float fw) {
  // 柄と毛足は、細かくなりすぎる所ではならす
  float pattern = 1.0 - smoothstep(0.06, 0.25, fw);
  float pile = 1.0 - smoothstep(0.002, 0.012, fw);
  vec2 g = abs(fract(at / 0.42) - 0.5);
  float lattice = smoothstep(0.015, 0.05, abs(g.x + g.y - 0.5));
  float spot = 1.0 - smoothstep(0.045, 0.08, length(g));
  vec3 carpet = vec3(0.21, 0.21, 0.23) * mix(0.9, 0.62 + 0.38 * lattice, pattern);
  carpet = mix(carpet, vec3(0.42, 0.42, 0.44), spot * 0.6 * pattern);
  return carpet * mix(1.0, 0.8 + 0.4 * tHash(floor(at * 220.0)), pile);
}

// 床：スクリーンの光が当たったカーペット。s はスクリーンの中心からの横の位置
vec3 theaterFloor(vec3 glow, float s, float t, float fw, float fx) {
  vec2 at = vec2(s * uTheaterScale.x, (1.0 - t) * uTheaterScale.z);
  return glow * theaterCarpet(at, max(fw, fx * t * uTheaterScale.x)) * 2.6 + vec3(0.002);
}

// 正面スクリーンの上下の黒い幕。at はスクリーンの中心から見た位置
vec3 theaterFront(vec2 at, vec3 light) {
  float folds = 0.75 + 0.25 * sin(at.x * uTheaterScale.x * 20.9);
  return (vec3(0.004) + light * 0.012) * folds;
}

// 視線と、床の上の線分 p0 → p0 + d（x、スクリーンからの距離、m）が交わる所。tz は奥行き、s は線分の上の位置（0〜1）
bool tCross(vec2 q, vec2 p0, vec2 d, out float tz, out float s) {
  float a = q.x * uTheaterScale.x;
  float eyeZ = uTheaterScale.z;
  float den = a * d.y + eyeZ * d.x;
  tz = 0.0;
  s = 0.0;
  if (abs(den) < 1e-6) return false;
  tz = ((p0.x - uTheaterEye.z) * d.y + (eyeZ - p0.y) * d.x) / den;
  if (tz <= 0.0) return false;
  s = dot(vec2(uTheaterEye.z + a * tz, eyeZ * (1.0 - tz)) - p0, d) / dot(d, d);
  return s > 0.0 && s < 1.0;
}

// 列 row の座席のうち、視線が背もたれの面に当たるもの。面はブロックごとに向きが違う
// tz は奥行き、lx は座席の中心からの距離、halfWidth は背もたれの幅の半分
bool tSeatHit(int row, vec2 q, out float tz, out float lx, out float halfWidth) {
  for (int j = 0; j < T_MAX_SEGMENTS; j++) {
    vec4 g = uTheaterSegs[row * T_MAX_SEGMENTS + j];
    float pitch = uTheaterSegInfo[row * T_MAX_SEGMENTS + j].x;
    if (pitch <= 0.0) continue;
    float s;
    if (tCross(q, g.xy, g.zw - g.xy, tz, s)) {
      lx = mod(s * length(g.zw - g.xy), pitch) - 0.5 * pitch;
      halfWidth = 0.5 * pitch - 0.03;
      return true;
    }
  }
  tz = 0.0;
  lx = 0.0;
  halfWidth = 0.0;
  return false;
}

// 列 row の、横の位置 x（m）が座席のブロックの中かどうか
bool tInSeats(int row, float x) {
  for (int j = 0; j < T_MAX_SEGMENTS; j++) {
    vec4 g = uTheaterSegs[row * T_MAX_SEGMENTS + j];
    if (uTheaterSegInfo[row * T_MAX_SEGMENTS + j].x > 0.0 && x > min(g.x, g.z) && x < max(g.x, g.z)) return true;
  }
  return false;
}

// 出入口の通路を仕切る低い壁の色。below は上端からの距離（m）
vec3 tLowWall(float below, vec3 light) {
  return light * (0.05 + 0.3 * exp(-max(below, 0.0) / 0.03)) + vec3(0.006);
}

// 奥行き tz より手前にある低い壁を、まだ重ねていなければ重ねる
void tLowWalls(float tz, inout float lowT[2], vec4 lowC[2], inout vec3 over, inout float covered) {
  for (int j = 0; j < 2; j++) {
    if (lowT[j] < tz) {
      over += (1.0 - covered) * lowC[j].a * lowC[j].rgb;
      covered += (1.0 - covered) * lowC[j].a;
      lowT[j] = 1e9;
    }
  }
}

// 前の列の座席と床の段を、近い列から順に重ねる
// 背もたれと段は列ごとの板として扱う。上端より下に見えるのは必ずその列か手前の列なので、見え方は変わらない
vec3 theaterSeats(vec3 result, vec2 q, float facing, vec2 pixel, vec3 light) {
  // 後ろを向いた視線には、前の列は見えない
  if (facing < 0.0) return result;
  float rows = uTheaterScale.w;
  vec2 metres = uTheaterScale.xy;
  vec3 over = vec3(0.0);
  float covered = 0.0;

  // 出入口の通路を客席と仕切る低い壁。隣の座席の背もたれより10cm高く、客席の段に沿って上がる
  // 0 は通路に沿った仕切り、1 は通路の後ろの端（出入口の側）をふさぐ壁
  float lowT[2];
  vec4 lowC[2];
  lowT[0] = 1e9;
  lowT[1] = 1e9;
  lowC[0] = vec4(0.0);
  lowC[1] = vec4(0.0);
  float eyeZ = uTheaterScale.z;
  vec4 part = uTheaterPart[q.x < 0.0 ? 0 : 1];
  if (part.x > 0.0 && q.x != 0.0) {
    float side = sign(q.x);
    float partNear = eyeZ - part.z;
    float partFar = eyeZ - part.y;
    float tz = (side * part.x - uTheaterEye.z) / (q.x * metres.x);
    float d = tz * eyeZ;
    if (tz > 0.0 && d > max(partNear, 0.0) && d < partFar) {
      float below = tFloorAt(d) + T_PART_RISE - q.y * tz * metres.y;
      float cover = clamp(below / max(pixel.y * tz * metres.y, 1e-5) + 0.5, 0.0, 1.0);
      if (cover > 0.0) {
        lowT[0] = tz;
        lowC[0] = vec4(tLowWall(below, light), cover);
      }
    }
    // 通路の後ろの端をふさぐ壁。図面で斜めなら斜めになる
    vec2 from = vec2(side * part.x, part.z);
    float s;
    if (tCross(q, from, vec2(side * uTheaterRoom.x, part.w) - from, tz, s)) {
      float below = tFloorAt(tz * eyeZ) + T_PART_RISE - q.y * tz * metres.y;
      float cover = clamp(below / max(pixel.y * tz * metres.y, 1e-5) + 0.5, 0.0, 1.0);
      if (cover > 0.0) {
        lowT[1] = tz;
        lowC[1] = vec4(tLowWall(below, light), cover);
      }
    }
  }

  for (int i = 0; i < T_MAX_ROWS; i++) {
    if (float(i) >= rows || covered > 0.995) break;
    vec4 line = uTheaterRows[i];
    // スクリーンに近い列ほど明るい
    float lit = mix(0.6, 1.0, float(i) / max(rows - 1.0, 1.0));
    float lx;
    float halfWidth;

    // 背もたれと、その間の肘掛け
    if (line.x > 0.0) {
      tLowWalls(line.x / uTheaterScale.z, lowT, lowC, over, covered);
      float tz;
      if (tSeatHit(i, q, tz, lx, halfWidth)) {
        vec2 p = q * tz * metres + vec2(uTheaterEye.z, 0.0);
        vec2 px = max(pixel * tz * metres, vec2(1e-5));
        float d = abs(lx);
        float inBack = 1.0 - smoothstep(halfWidth - 0.5 * px.x, halfWidth + 0.5 * px.x, d);
        float e = max(d - (halfWidth - T_CORNER), 0.0);
        float backTop = line.y - (T_CORNER - sqrt(max(T_CORNER * T_CORNER - e * e, 0.0)));
        float coverBack = clamp((backTop - p.y) / px.y + 0.5, 0.0, 1.0) * inBack;
        float coverArm = clamp((line.y - 0.43 - p.y) / px.y + 0.5, 0.0, 1.0) * (1.0 - inBack);
        float cover = coverBack + coverArm;
        if (cover > 0.0) {
          // 背もたれの上端だけスクリーンの光を受ける
          float rim = exp(-max(backTop - p.y, 0.0) / 0.025);
          float rounded = 1.0 - 0.35 * (d / halfWidth) * (d / halfWidth);
          vec3 back = light * (0.035 * rounded + 0.38 * rim) * lit + vec3(0.004);
          vec3 arm = light * 0.012 * lit + vec3(0.002);
          over += (1.0 - covered) * (back * coverBack + arm * coverArm);
          covered += (1.0 - covered) * cover;
        }
      }
    }

    // 床の段。通路では先端に足元灯を並べる
    if (line.z > 0.0) {
      float tz = line.z / uTheaterScale.z;
      tLowWalls(tz, lowT, lowC, over, covered);
      vec2 p = q * tz * metres + vec2(uTheaterEye.z, 0.0);
      vec2 px = max(pixel * tz * metres, vec2(1e-5));
      float cover = abs(p.x) < uTheaterRoom.x ? clamp((line.w - p.y) / px.y + 0.5, 0.0, 1.0) : 0.0;
      if (cover > 0.0) {
        // 視線が段の上面に当たる所で、カーペットの柄を決める
        float th = line.w / min(q.y * metres.y, -1e-4);
        vec2 at = vec2(uTheaterEye.z + q.x * th * metres.x, (1.0 - th) * uTheaterScale.z);
        float footprint = max(px.x, uTheaterScale.z * th * pixel.y / max(-q.y, 1e-4));
        vec3 stair = light * theaterCarpet(at, footprint) * 0.34 * lit + vec3(0.003);
        if (!tInSeats(i, p.x)) {
          float edge = exp(-max(line.w - p.y, 0.0) / 0.02);
          float lamp = 0.35 + 0.65 * smoothstep(0.3, 0.45, abs(fract(p.x / 0.3) - 0.5));
          stair += vec3(1.0, 0.62, 0.28) * 0.09 * edge * lamp;
        }
        over += (1.0 - covered) * cover * stair;
        covered += (1.0 - covered) * cover;
      }
    }
  }
  tLowWalls(1e8, lowT, lowC, over, covered);
  return result * (1.0 - covered) + over;
}
`;

  // ---------------------------------------------------------------- シェーダーへ渡す値
  const rowData = new Float32Array(MAX_ROWS * 4);
  const segmentData = new Float32Array(MAX_ROWS * MAX_SEGMENTS * 4);
  const segmentInfo = new Float32Array(MAX_ROWS * MAX_SEGMENTS * 4);
  const IDLE = Object.freeze({
    enabled: false,
    scale: [1, 1, 1, 0],
    eye: [0, 0, 0, 0],
    view: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
    room: [1, 0, 0, 0],
    floors: new Float32Array(MAX_ROWS * 4),
    parts: new Float32Array(8),
    rows: rowData,
    segments: segmentData,
    segmentInfo,
  });

  const enabled = (settings) => settings.look === 'theater' && Boolean(current());

  // frontSize は正面スクリーンの半分のサイズ（NDC）、width と height は描く先のピクセル数
  const frame = ({ settings, frontSize, width, height }) => {
    if (!enabled(settings)) return IDLE;
    const model = current();
    const camera = cameraOf(model, settings, frontSize, width, height);
    const { eye, halfHeight } = camera;

    // 自分の列（段だけ）と、それより前の列を近い順に並べる
    rowData.fill(0);
    segmentData.fill(0);
    segmentInfo.fill(0);
    let count = 0;
    for (let index = eye.row.index; index >= 0 && count < MAX_ROWS; index--, count++) {
      const row = model.rows[index];
      rowData.set(
        [
          // 自分の列の背もたれは描かない
          index === eye.row.index ? -1 : eye.distance - row.back,
          row.floor + row.backHeight - eye.height,
          row.edge ? eye.distance - row.edge : -1,
          row.floor - eye.height,
        ],
        count * 4
      );
      row.segments.forEach(({ line, info }, j) => {
        segmentData.set(line, (count * MAX_SEGMENTS + j) * 4);
        segmentInfo.set(info, (count * MAX_SEGMENTS + j) * 4);
      });
    }
    return {
      enabled: true,
      scale: [model.half, halfHeight, eye.distance, count],
      eye: [camera.offset[0] / model.half, camera.offset[1] / halfHeight, eye.x, -eye.height],
      view: viewMatrix(camera),
      room: model.room,
      floors: model.floors,
      parts: model.parts,
      rows: rowData,
      segments: segmentData,
      segmentInfo,
    };
  };

  globalThis.PeripheralViewTheater = {
    GLSL,
    ready,
    enabled,
    frame,
    videoTransform,
    resolve,
    isChosen,
    current,
    isTemporary,
    loadText,
    clearTemporary,
    chooseSeat,
    onChange,
  };
})();
