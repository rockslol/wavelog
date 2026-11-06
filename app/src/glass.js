const VS = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float;
uniform sampler2D bg;
uniform vec2 size, full;
uniform float inset, radius, dpr, light, tint;
uniform vec4 hue;
out vec4 o;

float box(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
vec3 at(vec2 p, float lod) {
  vec2 uv = clamp((p + (full - size) * 0.5) / full, 0.0, 1.0);
  vec4 t = textureLod(bg, uv, 7.0);
  vec3 c = t.bgr / max(t.a, 1e-4);
  for (float l = 6.0; l >= lod - 0.5; l -= 1.0) {
    t = textureLod(bg, uv, max(l, lod));
    c = mix(c, t.bgr / max(t.a, 1e-4), smoothstep(0.0, 1.0, t.a));
  }
  return c;
}
vec3 frost(vec2 p, float lod) {
  float s = exp2(lod) * 1.5 * dpr;
  vec3 c = vec3(0.0);
  float t = 0.0;
  for (int i = -2; i <= 2; i++) for (int j = -2; j <= 2; j++) {
    vec2 k = vec2(float(i), float(j));
    float w = exp(-dot(k, k) / 4.5);
    c += at(p + k * s, lod) * w;
    t += w;
  }
  return c / t;
}

void main() {
  vec2 p = vec2(gl_FragCoord.x, size.y - gl_FragCoord.y);
  vec2 c = size * 0.5, b = c - inset;
  float d = box(p - c, b, radius);
  float aa = clamp(0.5 - d, 0.0, 1.0);
  float shadow = 0.3 * exp(-pow(max(box(p - c - vec2(0.0, 3.0 * dpr), b, radius), 0.0) / (5.5 * dpr), 2.0));
  shadow = max(shadow, 0.55 * smoothstep(1.8 * dpr, 0.0, d));
  if (aa <= 0.0) { o = vec4(0.0, 0.0, 0.0, shadow); return; }

  vec2 e = vec2(1.0, 0.0);
  vec2 n = normalize(vec2(box(p - c + e, b, radius) - box(p - c - e, b, radius),
                          box(p - c + e.yx, b, radius) - box(p - c - e.yx, b, radius)) + 1e-6);
  float x = clamp(-d / (20.0 * dpr), 0.0, 1.0);
  float bend = pow(1.0 - x, 2.6);
  vec2 disp = n * bend * 16.0 * dpr;
  float lod = mix(2.4, 1.2, bend);
  vec3 col = frost(p + disp, lod);
  if (bend > 0.03) {
    col.r = frost(p + disp * 1.18, lod).r;
    col.b = frost(p + disp * 0.82, lod).b;
  }

  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(lum), col, 1.45);
  col = mix(col, hue.rgb * (0.6 + lum * 0.8), hue.a * (1.0 - 0.45 * light));
  col = mix(mix(col, vec3(0.05, 0.05, 0.06), clamp(0.05 + tint * 0.6 + lum * (0.15 + tint * 0.3), 0.0, 0.95)), mix(col, vec3(0.97), 0.12 + tint * 0.7) * 0.97, light);
  col += bend * 0.05;

  float sun = dot(n, normalize(vec2(-0.55, -0.85)));
  float rim = smoothstep(2.4 * dpr, 0.0, -d);
  col += rim * (0.12 + 0.88 * max(sun, 0.0)) * 0.8 + rim * max(-sun, 0.0) * 0.3;
  col += pow(1.0 - x, 7.0) * max(sun, 0.0) * 0.18;
  col += (fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;

  o = vec4(col * aa, aa) + vec4(0.0, 0.0, 0.0, shadow) * (1.0 - aa);
}`;

export function glass(canvas, frame, { inset, radius, onLight, tint = () => 0.4, hue = () => null }) {
  const gl = canvas.getContext("webgl2", { premultipliedAlpha: true });
  if (!gl) return false;
  const shader = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  };
  const pr = gl.createProgram();
  gl.attachShader(pr, shader(gl.VERTEX_SHADER, VS));
  gl.attachShader(pr, shader(gl.FRAGMENT_SHADER, FS));
  gl.bindAttribLocation(pr, 0, "p");
  gl.linkProgram(pr);
  if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) return false;
  gl.useProgram(pr);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  for (const k of ["TEXTURE_WRAP_S", "TEXTURE_WRAP_T"]) gl.texParameteri(gl.TEXTURE_2D, gl[k], gl.CLAMP_TO_EDGE);
  const u = (name) => gl.getUniformLocation(pr, name);
  let light = 0, target = 0, ready = false, idle = 0, first = true, drawn = -1;
  const tone = [0, 0, 0, 0];

  const tick = async () => {
    const f = await frame(first).catch(() => null);
    if (f) first = false;
    if (f) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, f.w, f.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, f.data);
      gl.uniform2f(u("full"), f.w * 2, f.h * 2);
      gl.generateMipmap(gl.TEXTURE_2D);
      let sum = 0, n = 0;
      for (let i = 0; i < f.data.length; i += 4 * 7) if (f.data[i + 3]) sum += 0.0722 * f.data[i] + 0.7152 * f.data[i + 1] + 0.2126 * f.data[i + 2], n++;
      const lum = sum / Math.max(n, 1) / 255;
      const next = lum > 0.62 ? 1 : lum < 0.48 ? 0 : target;
      if (next !== target) onLight?.((target = next));
      ready = true;
    }
    const want = hue() || tone.slice(0, 3);
    if (tone[3] < 0.01) tone.splice(0, 3, ...want);
    const toneGoal = [...want, hue() ? 0.42 : 0];
    const shift = toneGoal.some((v, i) => Math.abs(v - tone[i]) > 0.004);
    if (shift) toneGoal.forEach((v, i) => (tone[i] += (v - tone[i]) * 0.2));
    const moving = Math.abs(target - light) > 0.01 || tint() !== drawn || shift;
    if (ready && (f || moving)) {
      drawn = tint();
      light += (target - light) * 0.3;
      const dpr = devicePixelRatio;
      canvas.width = Math.round(canvas.clientWidth * dpr);
      canvas.height = Math.round(canvas.clientHeight * dpr);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(u("size"), canvas.width, canvas.height);
      gl.uniform1f(u("light"), light);
      gl.uniform1f(u("tint"), drawn);
      gl.uniform4f(u("hue"), ...tone);
      gl.uniform1f(u("inset"), inset * dpr);
      gl.uniform1f(u("radius"), radius * dpr);
      gl.uniform1f(u("dpr"), dpr);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    idle = f || moving ? 0 : idle + 1;
    setTimeout(tick, idle ? Math.min(1000, 150 + idle * 50) : 110);
  };
  tick();
  return true;
}
