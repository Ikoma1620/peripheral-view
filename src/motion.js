// 描画方式「動きに追従」
// Periphery 環繞延伸（https://github.com/Tro999999/periphery、MIT License、Copyright (c) 2026 Tro999999）の
// 解析（黒帯・場面転換・カメラの動き）と延伸（光の広がり・映像の流し込み・段階的なぼかし）を、
// 正面スクリーンを囲む部屋の壁へ投影するように組み直したもの。
// 従来の描画が使うテクスチャユニット0〜2には触れず、映像は0番から読むだけにする
(() => {
  const TH_W = 256; // 解析用の縮小画像
  const TH_H = 144;
  const PROFILE_H = 256; // 端の色を並べる数
  const FIRST_UNIT = 3;
  const RESPONSIVENESS = 0.45; // 端の色が新しいフレームに追いつく速さ
  const INNER_BLUR = 1.3; // 映像に近い側のぼかしの段
  const SHARP_BLUR = 0.35; // 連続している部分のぼかしの段
  const VIDEO = Symbol('video'); // テクスチャユニット0の映像

  // 向きごとの設定。axis が x は左右（行ごと）、y は上下（列ごと）。side は映像の座標で負が左か上
  const DIRECTIONS = [
    { axis: 'x', side: -1, width: 256, height: 144 },
    { axis: 'x', side: 1, width: 256, height: 144 },
    { axis: 'y', side: -1, width: 256, height: 256 },
    { axis: 'y', side: 1, width: 256, height: 256 },
  ];

  const VERTEX_SHADER = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

  const HEAD = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
`;

  const THUMB = `${HEAD}
uniform sampler2D uVideo;
void main() { fragColor = vec4(texture(uVideo, vUv).rgb, 1.0); }`;

  // 端の帯の色を、端に沿った位置ごとに平均し、前のフレームとなめらかにつなぐ
  // a には連続性（端へ向かって色がほとんど変わらないほど1）を入れる
  // 書き出す座標は y が端に沿った位置（0が映像の上か左）
  const PROFILE = `${HEAD}
uniform sampler2D uVideo;
uniform sampler2D uPrev;
uniform vec4 uRect;      // 映像として扱う範囲（x0, y0, x1, y1）
uniform float uSide;
uniform bool uAcross;
uniform bool uWeighted;
uniform float uBand;
uniform float uProbe;    // 連続性を調べる幅
uniform float uLod;
uniform float uAlpha;
vec3 at(float from, float along) {
  float across = uSide < 0.0 ? from : 1.0 - from;
  vec2 c = uAcross ? vec2(along, across) : vec2(across, along);
  return textureLod(uVideo, mix(uRect.xy, uRect.zw, c), uLod).rgb;
}
void main() {
  float along = vUv.y;
  vec3 sum = vec3(0.0);
  float total = 0.0;
  for (int i = 0; i < 16; i++) {
    float t = (float(i) + 0.5) / 16.0;
    float w = uWeighted ? exp(-3.0 * t) : 1.0;
    sum += at(t * uBand, along) * w;
    total += w;
  }
  // 端から内側へ向かう色のばらつき。空、地平線、壁、なだらかな階調は小さくなる
  vec3 mean = vec3(0.0);
  vec3 square = vec3(0.0);
  for (int i = 0; i < 12; i++) {
    vec3 c = at((float(i) + 0.5) / 12.0 * uProbe, along);
    mean += c;
    square += c * c;
  }
  mean /= 12.0;
  vec3 variance = max(square / 12.0 - mean * mean, 0.0);
  float spread = sqrt(dot(variance, vec3(0.2126, 0.7152, 0.0722)));
  float continuity = 1.0 - smoothstep(0.02, 0.09, spread);
  vec4 prev = texture(uPrev, vec2(0.5, along));
  fragColor = mix(prev, vec4(sum / total, continuity), uAlpha);
}`;

  // 映像の外へ出た内容を、カメラの動きに合わせて外へ流し、時間とともに薄める
  // x は映像の端からの距離（0〜uDmax、映像の幅か高さが単位）、a は信頼度
  const ADVECT = `${HEAD}
uniform sampler2D uVideo;
uniform sampler2D uPrev;
uniform vec4 uRect;
uniform float uSide;
uniform bool uAcross;
uniform float uDmax;
uniform vec2 uVel;       // 端に垂直な向き、端に沿った向きの、1フレームの移動量
uniform float uDecay;
uniform float uLod;
uniform bool uReset;
void main() {
  if (uReset) { fragColor = vec4(0.0); return; }
  float d = vUv.x * uDmax;
  float sd = d - uSide * uVel.x;
  float sa = vUv.y - uVel.y;
  vec4 e = vec4(0.0);
  if (sa >= 0.0 && sa <= 1.0) {
    if (sd < 0.0) {
      float across = 0.5 + uSide * (0.5 + sd);
      vec2 c = uAcross ? vec2(sa, across) : vec2(across, sa);
      e = vec4(textureLod(uVideo, mix(uRect.xy, uRect.zw, c), uLod).rgb, 1.0);
    } else if (sd <= uDmax) {
      e = texture(uPrev, vec2(sd / uDmax, sa));
    }
  }
  fragColor = vec4(e.rgb, max(e.a * (1.0 - uDecay) - 0.002, 0.0));
}`;

  // 端の色を、遠いほど端に沿って広げた光にし、流れてきた映像を重ねる
  const COMPOSE = `${HEAD}
uniform sampler2D uE;
uniform sampler2D uP0;
uniform sampler2D uP1;
uniform sampler2D uP2;
uniform sampler2D uP3;
uniform float uDmax;
uniform float uGap;
uniform float uDetail;
uniform float uSpread;
uniform float uContinuity; // 連続している部分を端まで描く強さ
vec3 at(sampler2D p) { return texture(p, vec2(0.5, vUv.y)).rgb; }
void main() {
  float d = vUv.x * uDmax;
  // 少しぼかした段の連続性を使い、行ごとの切り替わりを目立たせない
  float continuity = texture(uP1, vec2(0.5, vUv.y)).a * uContinuity;
  float k = clamp((d - uGap * 0.5) / max(uDmax - uGap * 0.5, 1e-3), 0.0, 1.0);
  // 連続している行は上下に広げず、そのまま端まで延ばす
  float level = clamp(pow(k, 0.6) * 3.0 * uSpread * (1.0 - continuity), 0.0, 3.0);
  vec3 s;
  if (level < 1.0) s = mix(at(uP0), at(uP1), level);
  else if (level < 2.0) s = mix(at(uP1), at(uP2), level - 1.0);
  else s = mix(at(uP2), at(uP3), level - 2.0);
  vec4 e = texture(uE, vUv);
  float flowed = clamp(e.a, 0.0, 1.0) * uDetail;
  // 流れてきた映像は実際の映像なので、それも連続しているものとして扱う
  fragColor = vec4(mix(s, e.rgb, flowed), max(continuity, flowed * uContinuity));
}`;

  const COPY = `${HEAD}
uniform sampler2D uSrc;
void main() { fragColor = texture(uSrc, vUv); }`;

  const BLUR = `${HEAD}
uniform sampler2D uSrc;
uniform vec2 uDir;
uniform float uSigma;
void main() {
  vec4 sum = vec4(0.0);
  float total = 0.0;
  float r = ceil(uSigma * 3.0);
  for (int i = -12; i <= 12; i++) {
    float fi = float(i);
    if (abs(fi) > r) continue;
    float w = exp(-fi * fi / (2.0 * uSigma * uSigma));
    sum += texture(uSrc, vUv + uDir * fi) * w;
    total += w;
  }
  fragColor = sum / total;
}`;

  // 映像から遠いほど強くぼかした段を選び、壁に貼る1枚にまとめる
  const RESOLVE = `${HEAD}
uniform sampler2D uL0;
uniform sampler2D uL1;
uniform sampler2D uL2;
uniform sampler2D uL3;
uniform sampler2D uL4;
uniform float uDmax;
uniform float uGap;
uniform float uInner;
uniform float uSharp;    // 連続している部分のぼかしの段
vec4 cubicWeights(float v) {
  vec4 n = vec4(1.0, 2.0, 3.0, 4.0) - v;
  vec4 s = n * n * n;
  float x = s.x;
  float y = s.y - 4.0 * s.x;
  float z = s.z - 4.0 * s.y + 6.0 * s.x;
  return vec4(x, y, z, 6.0 - x - y - z) / 6.0;
}
vec3 bicubic(sampler2D tex, vec2 uv) {
  vec2 size = vec2(textureSize(tex, 0));
  vec2 inv = 1.0 / size;
  uv = uv * size - 0.5;
  vec2 f = fract(uv);
  uv -= f;
  vec4 xc = cubicWeights(f.x);
  vec4 yc = cubicWeights(f.y);
  vec4 c = uv.xxyy + vec2(-0.5, 1.5).xyxy;
  vec4 s = vec4(xc.xz + xc.yw, yc.xz + yc.yw);
  vec4 off = (c + vec4(xc.yw, yc.yw) / s) * inv.xxyy;
  vec3 s0 = texture(tex, off.xz).rgb;
  vec3 s1 = texture(tex, off.yz).rgb;
  vec3 s2 = texture(tex, off.xw).rgb;
  vec3 s3 = texture(tex, off.yw).rgb;
  float sx = s.x / (s.x + s.y);
  float sy = s.z / (s.z + s.w);
  return mix(mix(s3, s2, sx), mix(s1, s0, sx), sy);
}
void main() {
  float d = vUv.x * uDmax;
  float o = clamp((d - uGap) / max(uDmax - uGap, 1e-3), 0.0, 1.0);
  // 連続性はぼかした段から読み、境目をなだらかにする
  float continuity = clamp(texture(uL2, vUv).a, 0.0, 1.0);
  float t = clamp(mix(mix(uInner, 3.95, pow(o, 0.65)), uSharp, continuity), 0.0, 4.0);
  vec3 c;
  if (t < 1.0) c = mix(texture(uL0, vUv).rgb, bicubic(uL1, vUv), t);
  else if (t < 2.0) c = mix(bicubic(uL1, vUv), bicubic(uL2, vUv), t - 1.0);
  else if (t < 3.0) c = mix(bicubic(uL2, vUv), bicubic(uL3, vUv), t - 2.0);
  else c = mix(bicubic(uL3, vUv), bicubic(uL4, vUv), t - 3.0);
  fragColor = vec4(c, continuity);
}`;

  // 部屋の描き方は従来の描画（renderer.js）と同じ。壁などの色だけを、まとめた1枚から読む
  // 壁は正面スクリーンを継ぎ目で折り返して広げた平面とみなし、映像の端からの距離で引く
  const ROOM = `${HEAD}
uniform sampler2D uVideo;
uniform sampler2D uExt0;   // 左
uniform sampler2D uExt1;   // 右
uniform sampler2D uExt2;   // 上
uniform sampler2D uExt3;   // 下
uniform vec2 uFront;
uniform vec2 uPicture;
uniform vec2 uCrop;
uniform vec4 uEdges;       // 左、右、上、下の映像の端の位置（正面スクリーンの半分を1とする）
uniform vec2 uExtent;      // 映像の幅と高さ（同じ単位）
uniform vec4 uDmax;
uniform vec2 uColumnMap;   // 横の位置から映像の列（0〜1）への変換
uniform vec2 uRowMap;      // 縦の位置から映像の行（0〜1）への変換
uniform float uBrightness;
uniform int uScreenCount;

// 連続している部分は奥へ行っても暗くしすぎない
float wallShade(float u, float across, float continuity) {
  return mix(1.0, mix(0.3, 0.85, continuity), pow(u, 1.4)) * (1.0 - 0.45 * pow(min(abs(across), 1.0), 3.0));
}

vec4 lookup(int dir, float position, float along) {
  float d = (position - uEdges[dir]) / (dir < 2 ? uExtent.x : uExtent.y);
  vec2 at = vec2(clamp(d / uDmax[dir], 0.0, 1.0), clamp(along, 0.0, 1.0));
  if (dir == 0) return texture(uExt0, at);
  if (dir == 1) return texture(uExt1, at);
  if (dir == 2) return texture(uExt2, at);
  return texture(uExt3, at);
}

vec3 extension(int dir, float position, float along, float u, float across) {
  vec4 c = lookup(dir, position, along);
  return c.rgb * wallShade(u, across, clamp(c.a, 0.0, 1.0));
}

float row(float y) { return uRowMap.x + uRowMap.y * y; }
float column(float x) { return uColumnMap.x + uColumnMap.y * x; }
${PeripheralViewTheater.GLSL}
void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  // 正面スクリーンの中心から見た位置と、視点のずれ。見た目「劇場」は theater.js を参照
  bool theater = uTheater > 0.5;
  vec2 rel = ndc;
  // facing が負の画素は、スクリーンと逆の向き（真横より後ろ）を見ている
  float facing = 1.0;
  if (theater) {
    vec3 h = uTheaterView * vec3(ndc, 1.0);
    facing = h.z < 0.0 ? -1.0 : 1.0;
    rel = h.xy / (facing * max(abs(h.z), 1e-4)) * uFront;
  }
  vec2 eye = theater ? uTheaterEye.xy : vec2(0.0);
  vec2 q = rel / uFront - eye;
  vec2 a = abs(q);
  vec2 toPicture = uFront / uPicture;

  // 視線が当たる面と、その奥行き t（正面スクリーン面が1、視点が0）
  int surface;
  float t;
  float along = 0.0;
  if (theater) {
    theaterSurface(q, facing, uScreenCount, surface, t, along);
  } else if (a.x <= 1.0 && a.y <= 1.0) {
    surface = S_SCREEN;
    t = 1.0;
  } else if (a.x >= a.y) {
    surface = S_WALL;
    t = 1.0 / a.x;
  } else {
    surface = q.y > 0.0 ? S_CEILING : S_FLOOR;
    t = 1.0 / a.y;
  }
  vec2 pixel = fwidth(q);
  float fw = fwidth(t) * uTheaterScale.z;
  vec3 light = theater ? textureLod(uVideo, vec2(0.5), 9.0).rgb : vec3(0.0);

  vec3 result;
  if (surface == S_SCREEN) {
    vec2 b = abs(rel / uPicture);
    // 映像の部分は、前面にある本物の<video>が表示される
    if (b.x <= 1.0 && b.y <= 1.0) {
      fragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }
    vec2 on = rel / uFront;
    vec2 margin = (abs(rel) - uPicture) / max(uFront - uPicture, vec2(1e-4));
    if (margin.x >= margin.y) {
      result = extension(on.x < 0.0 ? 0 : 1, abs(on.x), row(on.y), 0.0, on.y);
    } else {
      result = extension(on.y > 0.0 ? 2 : 3, abs(on.y), column(on.x), 0.0, on.x);
    }
  } else if (surface == S_WALL) {
    // 劇場では壁が斜めのスクリーンから始まるので、面に沿った距離で測る。席を替えても壁の同じ所に同じ映像を映す
    float tw = theater ? theaterWallT(along, 1.0 - uFront.x) : t;
    float u = (1.0 - tw) / (1.0 - uFront.x);
    if (theater) u = min(u, 1.0);
    float v = eye.y + q.y * t;
    bool left = q.x * facing < 0.0;
    result = extension(left ? 0 : 1, 2.0 - tw, row(v), u, v);
    if (theater) {
      float aa = max(fw, pixel.y * t * uTheaterScale.y);
      result = theaterWall(result, v, t, along, light, aa);
      // プロジェクターのレンズは、向かいの壁のその奥行きへ映している映像の色で光る
      float depth = theaterProjectorDepth(t);
      int opposite = left ? 1 : 0;
      float position = 2.0 - theaterWallT(uTheaterRoom.z + depth - uTheaterRoom.y, 1.0 - uFront.x);
      vec3 lens = (lookup(opposite, position, 0.25).rgb + lookup(opposite, position, 0.5).rgb + lookup(opposite, position, 0.75).rgb) / 3.0;
      result = theaterProjector(result, v, t, depth, uScreenCount, lens, light, aa);
    }
  } else if (surface == S_FRONT) {
    result = theaterFront(eye + q, light);
  } else {
    float u = (1.0 - t) / (1.0 - uFront.y);
    if (theater) u = min(u, 1.0);
    float s = eye.x + q.x * t;
    bool above = surface == S_CEILING;
    if (uScreenCount >= (above ? 4 : 5)) {
      result = extension(above ? 2 : 3, 2.0 - t, column(s), u, s);
    } else {
      // 床と天井は従来の描画と同じ
      float c = clamp(s * toPicture.x, -1.0, 1.0);
      vec2 uv = vec2(0.5 + 0.5 * c, above ? u * 0.2 : 1.0 - u * 0.2);
      float strength = above ? 0.14 : 0.3;
      result = textureLod(uVideo, 0.5 + (uv - 0.5) * uCrop, 6.0).rgb * strength * pow(1.0 - u, 1.3);
      if (theater) result = above ? theaterCeiling(result, s, t, fw, pixel.x) : theaterFloor(result, s, t, fw, pixel.x);
    }
  }
  if (theater) result = theaterSeats(result, q, facing, pixel, light);

  float noise = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  fragColor = vec4(result * uBrightness + (noise - 0.5) / 255.0, 1.0);
}`;

  // ---------------------------------------------------------------- 解析（CPU）
  // 縮小画像から、黒帯を除いた映像の範囲、場面転換、画面全体の動きを求める
  class Analyzer {
    constructor() {
      this.luma = new Uint8Array(TH_W * TH_H);
      this.reset();
    }

    reset() {
      this.rect = { x0: 0, y0: 0, x1: 1, y1: 1 };
      this.shrink = [0, 0, 0, 0];
      this.brightFrames = 0;
      this.prevCoarse = null;
      this.prevHist = null;
      this.prevProfile = null;
      this.vel = { x: 0, y: 0 };
      this.avgScore = 0.08;
    }

    // 縮小画像の1行目は映像の上端。速度は映像の範囲に対する1フレームの移動量で、右と下が正
    analyze(pixels) {
      const W = TH_W;
      const H = TH_H;
      const L = this.luma;
      let sum = 0;
      for (let i = 0, j = 0; i < W * H; i++, j += 4) {
        const l = (pixels[j] * 54 + pixels[j + 1] * 183 + pixels[j + 2] * 19) >> 8;
        L[i] = l;
        sum += l;
      }
      const mean = sum / (W * H);

      // 黒帯：暗くない画素が一定以上ある行と列を映像とみなし、狭める変化はしばらく続いたときだけ採る
      const threshold = 26;
      let top = -1;
      let bottom = -1;
      let left = -1;
      let right = -1;
      const columnCount = new Uint16Array(W);
      for (let y = 0; y < H; y++) {
        let count = 0;
        const rowStart = y * W;
        for (let x = 0; x < W; x++) {
          if (L[rowStart + x] > threshold) {
            count++;
            columnCount[x]++;
          }
        }
        if (count > W * 0.22) {
          if (top < 0) top = y;
          bottom = y;
        }
      }
      for (let x = 0; x < W; x++) {
        if (columnCount[x] > H * 0.22) {
          if (left < 0) left = x;
          right = x;
        }
      }
      const r = this.rect;
      let rectChanged = false;
      if (top >= 0 && left >= 0 && mean > 12) {
        this.brightFrames++;
        const detected = [left / W, top / H, (right + 1) / W, (bottom + 1) / H];
        const current = [r.x0, r.y0, r.x1, r.y1];
        const need = this.brightFrames < 40 ? 6 : 70;
        for (let e = 0; e < 4; e++) {
          const isMin = e < 2;
          const outside = isMin ? detected[e] < current[e] - 0.004 : detected[e] > current[e] + 0.004;
          const inside = isMin ? detected[e] > current[e] + 0.008 : detected[e] < current[e] - 0.008;
          if (outside) {
            current[e] = detected[e];
            this.shrink[e] = 0;
            rectChanged = true;
          } else if (inside) {
            if (++this.shrink[e] > need) {
              current[e] = detected[e];
              this.shrink[e] = 0;
              rectChanged = true;
            }
          } else {
            this.shrink[e] = 0;
          }
        }
        if (current[2] - current[0] > 0.35 && current[3] - current[1] > 0.35) {
          [r.x0, r.y0, r.x1, r.y1] = current;
        }
      }

      // 場面転換：粗い格子と輝度ヒストグラムの差を、最近の平均と比べる
      const CW = 32;
      const CH = 18;
      const rx0 = Math.floor(r.x0 * W);
      const rx1 = Math.max(rx0 + 1, Math.ceil(r.x1 * W));
      const ry0 = Math.floor(r.y0 * H);
      const ry1 = Math.max(ry0 + 1, Math.ceil(r.y1 * H));
      const rw = rx1 - rx0;
      const rh = ry1 - ry0;
      const coarse = new Float32Array(CW * CH);
      const counts = new Float32Array(CW * CH);
      const hist = new Float32Array(32);
      for (let y = ry0; y < ry1; y++) {
        const cy = Math.min(CH - 1, Math.floor(((y - ry0) * CH) / rh));
        const rowStart = y * W;
        for (let x = rx0; x < rx1; x++) {
          const cx = Math.min(CW - 1, Math.floor(((x - rx0) * CW) / rw));
          const l = L[rowStart + x];
          coarse[cy * CW + cx] += l;
          counts[cy * CW + cx]++;
          hist[l >> 3]++;
        }
      }
      for (let i = 0; i < coarse.length; i++) coarse[i] /= Math.max(1, counts[i]);
      for (let i = 0; i < 32; i++) hist[i] /= rw * rh;
      let cut = false;
      if (!this.prevCoarse) {
        cut = true;
      } else if (!rectChanged) {
        let mad = 0;
        for (let i = 0; i < coarse.length; i++) mad += Math.abs(coarse[i] - this.prevCoarse[i]);
        mad /= coarse.length * 255;
        let hd = 0;
        for (let i = 0; i < 32; i++) hd += Math.abs(hist[i] - this.prevHist[i]);
        const score = mad * 4 + hd;
        cut = score > Math.max(0.6, this.avgScore * 5);
        if (!cut) this.avgScore = this.avgScore * 0.9 + score * 0.1;
      }
      this.prevCoarse = coarse;
      this.prevHist = hist;

      // 画面全体の動き：上下半分の列の和と、左右半分の行の和を、前のフレームとずらして比べる
      let mx = 0;
      let my = 0;
      let confident = false;
      const ix0 = Math.round((r.x0 + (r.x1 - r.x0) * 0.06) * W);
      const ix1 = Math.round((r.x1 - (r.x1 - r.x0) * 0.06) * W);
      const iy0 = Math.round((r.y0 + (r.y1 - r.y0) * 0.08) * H);
      const iy1 = Math.round((r.y1 - (r.y1 - r.y0) * 0.08) * H);
      const ymid = (iy0 + iy1) >> 1;
      const xmid = (ix0 + ix1) >> 1;
      const nx = ix1 - ix0;
      const ny = iy1 - iy0;
      const profile = {
        key: `${ix0},${ix1},${iy0},${iy1}`,
        top: new Float32Array(nx),
        bottom: new Float32Array(nx),
        left: new Float32Array(ny),
        right: new Float32Array(ny),
      };
      for (let y = iy0; y < iy1; y++) {
        const rowStart = y * W;
        const isTop = y < ymid;
        for (let x = ix0; x < ix1; x++) {
          const l = L[rowStart + x];
          (isTop ? profile.top : profile.bottom)[x - ix0] += l;
          (x < xmid ? profile.left : profile.right)[y - iy0] += l;
        }
      }
      const prev = this.prevProfile;
      if (!cut && !rectChanged && prev && prev.key === profile.key && nx > 40 && ny > 20) {
        const a = bestShift(profile.top, prev.top, 12);
        const b = bestShift(profile.bottom, prev.bottom, 12);
        const c = bestShift(profile.left, prev.left, 8);
        const d = bestShift(profile.right, prev.right, 8);
        const okX = a.ok && b.ok && a.score > 0.9 && b.score > 0.9 && Math.abs(a.d - b.d) < 1.5;
        const okY = c.ok && d.ok && c.score > 0.9 && d.score > 0.9 && Math.abs(c.d - d.d) < 1.5;
        if (okX) mx = (a.d + b.d) / 2 / ((r.x1 - r.x0) * W);
        if (okY) my = (c.d + d.d) / 2 / ((r.y1 - r.y0) * H);
        confident = okX || okY;
      }
      this.prevProfile = profile;

      const v = this.vel;
      if (cut) {
        v.x = 0;
        v.y = 0;
      } else if (confident) {
        v.x += (mx - v.x) * 0.6;
        v.y += (my - v.y) * 0.6;
      } else {
        v.x *= 0.4;
        v.y *= 0.4;
      }
      const deadZone = 0.0008;
      const limit = (value) => (Math.abs(value) < deadZone ? 0 : Math.max(-0.06, Math.min(0.06, value)));
      return { rect: r, vel: { x: limit(v.x), y: limit(v.y) }, cut };
    }
  }

  // 1次元の並びの正規化相互相関。cur[x] ≈ prev[x - d] となる d を小数まで求める
  const bestShift = (cur, prev, maxShift) => {
    const n = cur.length;
    let meanCur = 0;
    let meanPrev = 0;
    for (let i = 0; i < n; i++) {
      meanCur += cur[i];
      meanPrev += prev[i];
    }
    meanCur /= n;
    meanPrev /= n;
    let variance = 0;
    for (let i = 0; i < n; i++) variance += (cur[i] - meanCur) ** 2;
    // 模様のない並びでは求めない
    if (Math.sqrt(variance / n) < meanCur * 0.012 + 2) return { ok: false, d: 0, score: 0 };
    const scores = new Float32Array(2 * maxShift + 1);
    let best = -2;
    let bestIndex = maxShift;
    for (let d = -maxShift; d <= maxShift; d++) {
      const x0 = Math.max(0, d);
      const x1 = Math.min(n, n + d);
      let num = 0;
      let sc = 0;
      let sp = 0;
      for (let x = x0; x < x1; x++) {
        const a = cur[x] - meanCur;
        const b = prev[x - d] - meanPrev;
        num += a * b;
        sc += a * a;
        sp += b * b;
      }
      const s = num / Math.sqrt(sc * sp + 1e-6);
      scores[d + maxShift] = s;
      if (s > best) {
        best = s;
        bestIndex = d + maxShift;
      }
    }
    let shift = bestIndex - maxShift;
    if (bestIndex > 0 && bestIndex < 2 * maxShift) {
      const s0 = scores[bestIndex - 1];
      const s1 = scores[bestIndex];
      const s2 = scores[bestIndex + 1];
      const den = s0 - 2 * s1 + s2;
      if (Math.abs(den) > 1e-6) shift += Math.max(-0.5, Math.min(0.5, (0.5 * (s0 - s2)) / den));
    }
    // 探す範囲の端で最大になったものは信用しない
    return { ok: bestIndex > 0 && bestIndex < 2 * maxShift, d: shift, score: best };
  };

  // ---------------------------------------------------------------- GPU
  const compile = (gl, type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  };

  const link = (gl, fragmentSource) => {
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragmentSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    const uniforms = {};
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const { name, type } = gl.getActiveUniform(program, i);
      uniforms[name] = { location: gl.getUniformLocation(program, name), type };
    }
    return { program, uniforms };
  };

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  class PeripheralViewMotion {
    constructor(gl) {
      this.gl = gl;
      this.float = Boolean(gl.getExtension('EXT_color_buffer_float'));
      this.programs = {
        thumb: link(gl, THUMB),
        profile: link(gl, PROFILE),
        advect: link(gl, ADVECT),
        compose: link(gl, COMPOSE),
        copy: link(gl, COPY),
        blur: link(gl, BLUR),
        resolve: link(gl, RESOLVE),
        room: link(gl, ROOM),
      };
      try {
        this.thumb = this.target(TH_W, TH_H, false);
        this.directions = DIRECTIONS.map((direction) => this.createDirection(direction));
      } finally {
        gl.activeTexture(gl.TEXTURE0);
      }
      this.thumbPixels = new Uint8Array(TH_W * TH_H * 4);
      this.analyzer = new Analyzer();
      this.geometryKey = '';
    }

    // 描画方式を切り替えたときや映像が替わったときは、黒帯の判定から始め直す
    resetAll() {
      this.analyzer.reset();
      this.resetHistory();
    }

    // シークや場面転換では、流れていた映像と色の履歴だけを捨てる
    resetHistory() {
      for (const direction of this.directions) direction.ready = false;
    }

    target(width, height, float = this.float) {
      const { gl } = this;
      gl.activeTexture(gl.TEXTURE0 + FIRST_UNIT);
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      if (float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { texture, framebuffer, width, height };
    }

    createDirection({ axis, side, width: w, height: h }) {
      const t = (width, height) => this.target(width, height);
      return {
        axis,
        side,
        profiles: [t(1, PROFILE_H), t(1, PROFILE_H)],
        p1: t(1, PROFILE_H),
        p2: t(1, PROFILE_H / 4),
        q2: t(1, PROFILE_H / 4),
        p3: t(1, PROFILE_H / 16),
        q3: t(1, PROFILE_H / 16),
        pans: [t(w, h), t(w, h)],
        composed: t(w, h),
        l1: t(w, h),
        t1: t(w, h),
        l2: t(w / 2, h / 2),
        t2: t(w / 2, h / 2),
        l3: t(w / 4, h / 4),
        t3: t(w / 4, h / 4),
        l4: t(w / 8, h / 8),
        t4: t(w / 8, h / 8),
        resolved: t(w, h),
        profileIndex: 0,
        panIndex: 0,
        ready: false,
      };
    }

    pass(name, target, values, width, height) {
      const { gl } = this;
      const { program, uniforms } = this.programs[name];
      gl.useProgram(program);
      let unit = FIRST_UNIT;
      for (const [key, value] of Object.entries(values)) {
        const uniform = uniforms[key];
        if (!uniform) continue;
        const { location, type } = uniform;
        if (type === gl.SAMPLER_2D) {
          if (value === VIDEO) {
            gl.uniform1i(location, 0);
          } else {
            gl.activeTexture(gl.TEXTURE0 + unit);
            gl.bindTexture(gl.TEXTURE_2D, value);
            gl.uniform1i(location, unit++);
          }
        } else if (type === gl.FLOAT) gl.uniform1f(location, value);
        else if (type === gl.FLOAT_VEC2) gl.uniform2fv(location, value);
        else if (type === gl.FLOAT_VEC4) gl.uniform4fv(location, value);
        else if (type === gl.FLOAT_MAT3) gl.uniformMatrix3fv(location, false, value);
        else gl.uniform1i(location, Number(value));
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.framebuffer : null);
      gl.viewport(0, 0, target ? target.width : width, target ? target.height : height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    blur(source, temp, destination, sigma) {
      this.pass('blur', temp, { uSrc: source.texture, uDir: [1 / source.width, 0], uSigma: sigma });
      this.pass('blur', destination, { uSrc: temp.texture, uDir: [0, 1 / source.height], uSigma: sigma });
    }

    // 正面スクリーンを半分で1とする座標で、映像として扱う範囲の端と大きさを求める
    geometry({ crop, frontSize, pictureSize }) {
      const halfX = crop[0] / 2;
      const halfY = crop[1] / 2;
      const r = this.analyzer.rect;
      const inset = 0.004;
      let rect = [
        Math.max(0.5 - halfX, r.x0) + inset,
        Math.max(0.5 - halfY, r.y0) + inset,
        Math.min(0.5 + halfX, r.x1) - inset,
        Math.min(0.5 + halfY, r.y1) - inset,
      ];
      if (rect[2] - rect[0] < 0.05 || rect[3] - rect[1] < 0.05) {
        rect = [0.5 - halfX, 0.5 - halfY, 0.5 + halfX, 0.5 + halfY];
      }
      const pictureX = pictureSize[0] / frontSize[0];
      const pictureY = pictureSize[1] / frontSize[1];
      const edges = [
        ((0.5 - rect[0]) / halfX) * pictureX,
        ((rect[2] - 0.5) / halfX) * pictureX,
        ((0.5 - rect[1]) / halfY) * pictureY,
        ((rect[3] - 0.5) / halfY) * pictureY,
      ];
      const extent = [edges[0] + edges[1], edges[2] + edges[3]];
      // 折り返した壁の外端は 2 - 正面スクリーンの大きさ
      const outerX = 2 - frontSize[0];
      const outerY = 2 - frontSize[1];
      const outer = [outerX, outerX, outerY, outerY];
      const dmax = edges.map((edge, i) => Math.max(0.05, (outer[i] - edge) / extent[i < 2 ? 0 : 1]));
      const gap = edges.map((edge, i) => clamp((1 - edge) / extent[i < 2 ? 0 : 1], 0, dmax[i]));
      const width = rect[2] - rect[0];
      const height = rect[3] - rect[1];
      return {
        rect,
        edges,
        extent,
        dmax,
        gap,
        columnMap: [(0.5 - rect[0]) / width, halfX / pictureX / width],
        rowMap: [(0.5 - rect[1]) / height, -halfY / pictureY / height],
      };
    }

    // 1フレームに1回、解析して壁に貼る絵を作る
    process({ video, crop, frontSize, pictureSize, settings, screenCount, advance, reset }) {
      const { gl } = this;
      try {
        if (reset) this.resetHistory();
        // 上下は、上下のスクリーンか正面スクリーンの上下の余白があるときだけ作る
        const needAcross = screenCount > 3 || pictureSize[1] < frontSize[1];
        const used = this.directions.filter((direction) => needAcross || direction.axis === 'x');

        // 新しいフレームのときだけ解析し、映像を流す
        let velocity = { x: 0, y: 0 };
        if (advance || used.some((direction) => !direction.ready)) {
          this.pass('thumb', this.thumb, { uVideo: VIDEO });
          gl.bindFramebuffer(gl.FRAMEBUFFER, this.thumb.framebuffer);
          gl.readPixels(0, 0, TH_W, TH_H, gl.RGBA, gl.UNSIGNED_BYTE, this.thumbPixels);
          const analysis = this.analyzer.analyze(this.thumbPixels);
          if (analysis.cut) this.resetHistory();
          if (advance) velocity = analysis.vel;
        }

        const geo = this.geometry({ crop, frontSize, pictureSize });
        this.frameGeometry = geo;
        const key = [...geo.rect, ...geo.dmax].map((value) => value.toFixed(3)).join();
        if (key !== this.geometryKey) {
          this.geometryKey = key;
          this.resetHistory();
        }

        const [x0, y0, x1, y1] = geo.rect;
        const contentWidth = video.videoWidth * (x1 - x0);
        const contentHeight = video.videoHeight * (y1 - y0);
        const r = this.analyzer.rect;
        const motion = clamp(Number(settings.motion) || 0, 0, 2);
        const vx = ((velocity.x * (r.x1 - r.x0)) / (x1 - x0)) * motion;
        const vy = ((velocity.y * (r.y1 - r.y0)) / (y1 - y0)) * motion;
        const decay = 0.3 * Math.pow(0.03, clamp(Number(settings.persistence) || 0, 0, 1));
        const spread = clamp((Number(settings.blurRange) || 0) / 0.1, 0, 4);
        const strip = clamp(Number(settings.strip) || 0.08, 0.005, 0.5);
        const aspect = contentWidth / contentHeight;
        const continuity = clamp(Number(settings.continuity ?? 1) || 0, 0, 1);

        this.directions.forEach((direction, i) => {
          if (!used.includes(direction)) return;
          const across = direction.axis === 'y';
          const along = across ? contentWidth : contentHeight;
          const perpendicular = across ? contentHeight : contentWidth;
          const dmax = geo.dmax[i];
          const fresh = !direction.ready;

          if (advance || fresh) {
            const previous = direction.profiles[direction.profileIndex];
            const profile = direction.profiles[1 - direction.profileIndex];
            this.pass('profile', profile, {
              uVideo: VIDEO,
              uPrev: previous.texture,
              uRect: geo.rect,
              uSide: direction.side,
              uAcross: across,
              uWeighted: settings.average === 'weighted',
              uBand: across ? Math.min(strip * aspect, 0.5) : strip,
              // 細い帯だけで判定すると何でも連続に見えるので、最低でも6%の幅を調べる
              uProbe: across ? Math.min(Math.max(strip, 0.06) * aspect, 0.5) : Math.max(strip, 0.06),
              uLod: Math.max(0, Math.log2(along / PROFILE_H)),
              uAlpha: fresh ? 1 : RESPONSIVENESS,
            });
            direction.profileIndex = 1 - direction.profileIndex;

            const previousPan = direction.pans[direction.panIndex];
            const pan = direction.pans[1 - direction.panIndex];
            const texel = Math.max((dmax / pan.width) * perpendicular, along / pan.height);
            this.pass('advect', pan, {
              uVideo: VIDEO,
              uPrev: previousPan.texture,
              uRect: geo.rect,
              uSide: direction.side,
              uAcross: across,
              uDmax: dmax,
              uVel: across ? [vy, vx] : [vx, vy],
              uDecay: decay,
              uLod: Math.max(0, Math.log2(texel)),
              uReset: fresh,
            });
            direction.panIndex = 1 - direction.panIndex;
            direction.ready = true;
          }

          // 端の色を、端に沿って段階的にぼかす
          const profile = direction.profiles[direction.profileIndex];
          this.pass('blur', direction.p1, { uSrc: profile.texture, uDir: [0, 1 / PROFILE_H], uSigma: 4 });
          this.pass('copy', direction.q2, { uSrc: direction.p1.texture });
          this.pass('blur', direction.p2, { uSrc: direction.q2.texture, uDir: [0, 4 / PROFILE_H], uSigma: 3 });
          this.pass('copy', direction.q3, { uSrc: direction.p2.texture });
          this.pass('blur', direction.p3, { uSrc: direction.q3.texture, uDir: [0, 16 / PROFILE_H], uSigma: 2.5 });

          const { composed } = direction;
          this.pass('compose', composed, {
            uE: direction.pans[direction.panIndex].texture,
            uP0: profile.texture,
            uP1: direction.p1.texture,
            uP2: direction.p2.texture,
            uP3: direction.p3.texture,
            uDmax: dmax,
            uGap: geo.gap[i],
            uDetail: motion > 0 ? 1 : 0,
            uSpread: spread,
            uContinuity: continuity,
          });
          this.blur(composed, direction.t1, direction.l1, 1.4);
          this.pass('copy', direction.t2, { uSrc: composed.texture });
          this.blur(direction.t2, direction.l2, direction.t2, 2.4);
          this.pass('copy', direction.t3, { uSrc: direction.t2.texture });
          this.blur(direction.t3, direction.l3, direction.t3, 2.8);
          this.pass('copy', direction.t4, { uSrc: direction.t3.texture });
          this.blur(direction.t4, direction.l4, direction.t4, 2.6);
          this.pass('resolve', direction.resolved, {
            uL0: composed.texture,
            uL1: direction.l1.texture,
            uL2: direction.t2.texture,
            uL3: direction.t3.texture,
            uL4: direction.t4.texture,
            uDmax: dmax,
            uGap: geo.gap[i],
            uInner: INNER_BLUR,
            uSharp: SHARP_BLUR,
          });
        });

      } finally {
        // 従来の描画は、ユニット0に映像が選ばれている前提で読み込む
        gl.activeTexture(gl.TEXTURE0);
      }
    }

    // process で作った絵で部屋を描く
    drawRoom({ crop, frontSize, pictureSize, settings, screenCount, theater, width, height }) {
      const { gl } = this;
      const geo = this.frameGeometry;
      if (!geo) return;
      try {
        const [left, right, top, bottom] = this.directions.map((direction) => direction.resolved.texture);
        this.pass(
          'room',
          null,
          {
            uVideo: VIDEO,
            uExt0: left,
            uExt1: right,
            uExt2: top,
            uExt3: bottom,
            uFront: frontSize,
            uPicture: pictureSize,
            uCrop: crop,
            uEdges: geo.edges,
            uExtent: geo.extent,
            uDmax: geo.dmax,
            uColumnMap: geo.columnMap,
            uRowMap: geo.rowMap,
            uBrightness: settings.brightness,
            uScreenCount: screenCount,
            uTheater: theater.enabled ? 1 : 0,
            uTheaterView: theater.view,
            uTheaterScale: theater.scale,
            uTheaterEye: theater.eye,
            uTheaterRoom: theater.room,
            'uTheaterFloor[0]': theater.floors,
            'uTheaterPart[0]': theater.parts,
            'uTheaterRows[0]': theater.rows,
            'uTheaterSegs[0]': theater.segments,
            'uTheaterSegInfo[0]': theater.segmentInfo,
          },
          width,
          height
        );
      } finally {
        // 従来の描画は、ユニット0に映像が選ばれている前提で読み込む
        gl.activeTexture(gl.TEXTURE0);
      }
    }
  }

  globalThis.PeripheralViewMotion = PeripheralViewMotion;
})();
