// 映像をテクスチャとして読み、正面スクリーンを囲む部屋（壁・床・天井）を描く
(() => {
  const VERTEX_SHADER = `#version 300 es
out vec2 ndc;
void main() {
  // 頂点バッファなしで画面全体を覆う三角形を作る
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2) * 2.0 - 1.0;
  ndc = p;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

  // 映像の端を列や行ごとに平均し、小さなテクスチャへ書き出す
  const EDGE_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 ndc;
out vec4 color;

uniform sampler2D video;
uniform float strip;
uniform float lod;
uniform bool across;    // false: 左右の端を行ごとに平均、true: 上下の端を列ごとに平均
uniform bool weighted;
uniform vec2 crop;      // スクリーンに映っている範囲（映像全体に対する比率、中央基準）

const int SAMPLES = 24;

void main() {
  vec2 p = ndc * 0.5 + 0.5;
  vec3 sum = vec3(0.0);
  float total = 0.0;
  for (int i = 0; i < SAMPLES; i++) {
    float t = (float(i) + 0.5) / float(SAMPLES);
    float from = t * strip;
    float edge = (across ? p.y : p.x) < 0.5 ? from : 1.0 - from;
    vec2 uv = 0.5 + ((across ? vec2(p.x, edge) : vec2(edge, p.y)) - 0.5) * crop;
    // 端に近いほど重くする。範囲の外側の重みは端の約5%まで下がる
    float weight = weighted ? exp(-3.0 * t) : 1.0;
    sum += textureLod(video, uv, lod).rgb * weight;
    total += weight;
  }
  color = vec4(sum / total, 1.0);
}`;

  const ROOM_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 ndc;
out vec4 color;

uniform sampler2D video;
uniform sampler2D sideEdges;
uniform sampler2D acrossEdges;
uniform vec2 front;      // 正面スクリーンの半分のサイズ（NDC）
uniform vec2 picture;    // 正面スクリーン上で映像が映る範囲の半分のサイズ（NDC）
uniform vec2 crop;
uniform float aspect;    // スクリーンに映っている範囲の縦横比
uniform float blurRange;
uniform float brightness;
uniform int screenCount;

const int BLUR_TAPS = 8;

vec3 blurred(sampler2D map, vec2 at, vec2 range) {
  vec3 sum = texture(map, at).rgb;
  float total = 1.0;
  for (int i = 1; i <= BLUR_TAPS; i++) {
    float d = float(i) / float(BLUR_TAPS);
    float weight = exp(-3.0 * d * d);
    sum += (texture(map, at + range * d).rgb + texture(map, at - range * d).rgb) * weight;
    total += 2.0 * weight;
  }
  return sum / total;
}

float wallShade(float u, float across) {
  return mix(1.0, 0.3, pow(u, 1.4)) * (1.0 - 0.45 * pow(abs(across), 3.0));
}

void main() {
  // 視点から正面スクリーン面までの距離を1とした部屋を、ピクセルごとの視線で解く
  // 1/距離 が線形になるので、遠近が正しくかかる
  vec2 q = ndc / front;
  vec2 a = abs(q);
  // スクリーン上の位置を、映像の範囲を ±1 とする座標に直す（余白の分は範囲外に出る）
  vec2 toPicture = front / picture;

  vec3 result;
  if (a.x <= 1.0 && a.y <= 1.0) {
    vec2 p = ndc / picture;
    vec2 b = abs(p);
    // 映像の部分は、前面にある本物の<video>が表示される
    if (b.x <= 1.0 && b.y <= 1.0) {
      color = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }
    // 余白には、隣の壁との継ぎ目と同じ色を映像の端から延ばす
    vec2 margin = (abs(ndc) - picture) / max(front - picture, vec2(1e-4));
    if (margin.x >= margin.y) {
      vec2 at = vec2(p.x < 0.0 ? 0.25 : 0.75, 0.5 - 0.5 * clamp(p.y, -1.0, 1.0));
      result = blurred(sideEdges, at, vec2(0.0, blurRange)) * wallShade(0.0, q.y);
    } else {
      vec2 at = vec2(0.5 + 0.5 * clamp(p.x, -1.0, 1.0), p.y > 0.0 ? 0.25 : 0.75);
      result = blurred(acrossEdges, at, vec2(blurRange / aspect, 0.0)) * wallShade(0.0, q.x);
    }
  } else if (a.x >= a.y) {
    // 左右の壁：u=0 がスクリーンとの継ぎ目、u=1 が画面の端
    float u = (1.0 - 1.0 / a.x) / (1.0 - front.x);
    float v = q.y / a.x;
    float row = clamp(v * toPicture.y, -1.0, 1.0);
    vec2 at = vec2(q.x < 0.0 ? 0.25 : 0.75, 0.5 - 0.5 * row);
    result = blurred(sideEdges, at, vec2(0.0, blurRange)) * wallShade(u, v);
  } else {
    float u = (1.0 - 1.0 / a.y) / (1.0 - front.y);
    float s = q.x / a.y;
    float column = clamp(s * toPicture.x, -1.0, 1.0);
    bool above = q.y > 0.0;
    if (screenCount >= (above ? 4 : 5)) {
      // 上下のスクリーン
      vec2 at = vec2(0.5 + 0.5 * column, above ? 0.25 : 0.75);
      result = blurred(acrossEdges, at, vec2(blurRange / aspect, 0.0)) * wallShade(u, s);
    } else {
      // 床と天井：映像の上下端から光が回り込んだように、強くぼかして暗く映す
      vec2 uv = vec2(0.5 + 0.5 * column, above ? u * 0.2 : 1.0 - u * 0.2);
      float strength = above ? 0.14 : 0.3;
      result = textureLod(video, 0.5 + (uv - 0.5) * crop, 6.0).rgb * strength * pow(1.0 - u, 1.3);
    }
  }

  // なだらかな暗部に縞が出ないよう、わずかにノイズを混ぜる
  float noise = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  color = vec4(result * brightness + (noise - 0.5) / 255.0, 1.0);
}`;

  const EDGE_SAMPLES = 128;
  const SCREEN_COUNTS = { three: 3, four: 4, five: 5 };

  const compile = (gl, type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader));
    }
    return shader;
  };

  const link = (gl, fragmentSource, uniformNames) => {
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragmentSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program));
    }
    const uniforms = Object.fromEntries(
      uniformNames.map((name) => [name, gl.getUniformLocation(program, name)])
    );
    return { program, uniforms };
  };

  const createTexture = (gl, unit, minFilter) => {
    const texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minFilter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  };

  const createEdgeTarget = (gl, unit, width, height) => {
    const texture = createTexture(gl, unit, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { framebuffer, width, height };
  };

  class PeripheralViewRenderer {
    constructor(canvas, video) {
      this.canvas = canvas;
      this.video = video;
      this.frontSize = [1, 1];
      this.pictureSize = [1, 1];
      this.crop = [1, 1];
      this.settings = null;
      this.running = false;

      const gl = canvas.getContext('webgl2', { alpha: false, antialias: false });
      if (!gl) throw new Error('WebGL2 を利用できません');
      this.gl = gl;

      this.edgePass = link(gl, EDGE_FRAGMENT_SHADER, ['video', 'strip', 'lod', 'across', 'weighted', 'crop']);
      this.roomPass = link(gl, ROOM_FRAGMENT_SHADER, [
        'video',
        'sideEdges',
        'acrossEdges',
        'front',
        'picture',
        'crop',
        'aspect',
        'blurRange',
        'brightness',
        'screenCount',
      ]);

      gl.bindVertexArray(gl.createVertexArray());

      this.sideTarget = createEdgeTarget(gl, 1, 2, EDGE_SAMPLES);
      this.acrossTarget = createEdgeTarget(gl, 2, EDGE_SAMPLES, 2);
      createTexture(gl, 0, gl.LINEAR_MIPMAP_LINEAR);
    }

    start() {
      this.running = true;
      this.draw();
      const onFrame = () => {
        if (!this.running) return;
        this.draw();
        this.video.requestVideoFrameCallback(onFrame);
      };
      this.video.requestVideoFrameCallback(onFrame);
    }

    stop() {
      this.running = false;
    }

    drawEdge(target, strip, lod, across) {
      const { gl, edgePass } = this;
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      gl.viewport(0, 0, target.width, target.height);
      gl.uniform1f(edgePass.uniforms.strip, strip);
      gl.uniform1f(edgePass.uniforms.lod, Math.max(0, lod));
      gl.uniform1i(edgePass.uniforms.across, across ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // 一時停止中は新しいフレームが来ないので、変更時はここを直接呼ぶ
    draw() {
      const { gl, video, canvas, settings, edgePass, roomPass } = this;
      if (!video.videoWidth) return;

      const scale = Math.min(window.devicePixelRatio || 1, 1);
      const width = Math.max(1, Math.round(canvas.clientWidth * scale));
      const height = Math.max(1, Math.round(canvas.clientHeight * scale));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }

      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      gl.generateMipmap(gl.TEXTURE_2D);

      // 切り取って映している場合は、その範囲を映像全体とみなす
      const [cropX, cropY] = this.crop;
      const visibleWidth = video.videoWidth * cropX;
      const visibleHeight = video.videoHeight * cropY;
      const aspect = visibleWidth / visibleHeight;
      const screenCount = SCREEN_COUNTS[settings.screens] ?? 3;

      gl.useProgram(edgePass.program);
      gl.uniform1i(edgePass.uniforms.video, 0);
      gl.uniform1i(edgePass.uniforms.weighted, settings.average === 'weighted' ? 1 : 0);
      gl.uniform2f(edgePass.uniforms.crop, cropX, cropY);
      this.drawEdge(this.sideTarget, settings.strip, Math.log2(visibleHeight / EDGE_SAMPLES), false);
      // 上下のスクリーンか、正面スクリーンの上下の余白に使う
      if (screenCount > 3 || this.pictureSize[1] < this.frontSize[1]) {
        // 上下の端も左右と同じピクセル数を平均する
        const strip = Math.min(settings.strip * aspect, 0.5);
        this.drawEdge(this.acrossTarget, strip, Math.log2(visibleWidth / EDGE_SAMPLES), true);
      }

      gl.useProgram(roomPass.program);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, width, height);
      gl.uniform1i(roomPass.uniforms.video, 0);
      gl.uniform1i(roomPass.uniforms.sideEdges, 1);
      gl.uniform1i(roomPass.uniforms.acrossEdges, 2);
      gl.uniform2f(roomPass.uniforms.front, this.frontSize[0], this.frontSize[1]);
      gl.uniform2f(roomPass.uniforms.picture, this.pictureSize[0], this.pictureSize[1]);
      gl.uniform2f(roomPass.uniforms.crop, cropX, cropY);
      gl.uniform1f(roomPass.uniforms.aspect, aspect);
      gl.uniform1f(roomPass.uniforms.blurRange, settings.blurRange);
      gl.uniform1f(roomPass.uniforms.brightness, settings.brightness);
      gl.uniform1i(roomPass.uniforms.screenCount, screenCount);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  globalThis.PeripheralViewRenderer = PeripheralViewRenderer;
})();
