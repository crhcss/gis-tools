/**
 * 入口 loading 动画 Worker
 * 在独立线程中运行 Canvas 2D 绘制（几何 + 标题 + 进度 + 提示语）
 * 通过 OffscreenCanvas + transferControlToOffscreen 实现，不占用主线程
 *
 * 消息协议（主线程 → Worker）：
 *   { type: 'init', dpr, isLight, width, height }    初始化
 *   { type: 'theme', isLight }                        切换主题
 *   { type: 'text', percent, tip }                    更新文字通道
 *   { type: 'startEnding' }                           触发结束动画
 *
 * 消息协议（Worker → 主线程）：
 *   { type: 'cycleRemaining', value }                 当前轮次剩余时间
 *   { type: 'done' }                                  结束动画完成，可清理
 */

var ctx = null;
var W = 280;
var H = 380;

/**
 * requestAnimationFrame 降级实现（关键）
 *
 * DedicatedWorkerGlobalScope 里没有 requestAnimationFrame（它只存在于 Window 上下文）。
 * 直接调用会抛 ReferenceError，动画循环第一帧就停摆，导致：
 *   - cycleRemaining 只发出初始值后冻结
 *   - App.vue 中 `cycleRemaining <= 50` 永不成立，永远不触发 startEnding
 *   - entry-loader-mask 永不移除 —— 页面看起来就是"白屏"，
 *     且 Worker 内部错误不会打到主页面控制台，排查时看不到任何报错。
 *
 * 因此这里用 setTimeout 模拟 ~60fps 的帧循环。
 */
if (typeof requestAnimationFrame !== "function") {
  self.requestAnimationFrame = function (cb) {
    return setTimeout(function () {
      cb(typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
    }, 16);
  };
  self.cancelAnimationFrame = function (id) {
    clearTimeout(id);
  };
}

// 布局常量
var GEO_CY = 110;
var GEO_RADIUS = 78;
var TEXT_Y_TITLE = 232;
var TEXT_Y_PROGRESS = 268;
var PROGRESS_BAR_Y = 286;
var PROGRESS_BAR_W = 200;
var PROGRESS_BAR_H = 4;
var TEXT_Y_TIP = 318;

// 动画常量
var STAGE_DURATION = 1200;
var FADE = 220;
var END_CONTENT_FADE = 200;
var END_RING_SQUISH = 300;
var END_RING_COLLAPSE = 400;
var END_TOTAL = 900;
var CLEANUP_DELAY = 200;

// 状态
var rafId = null;
var startTs = 0;
var ending = false;
var endStartT = 0;

// 主题色
var isLight = false;
var GRAY_FRAME = "rgba(163, 166, 173, 0.45)";
var GRAY_DASH = "rgba(108, 110, 114, 0.35)";
var GEO_POINT_LINE = "#2563eb";
var GEO_POINT_FILL = "rgba(37, 99, 235, 0.12)";
var GEO_LINE_LINE = "#16a34a";
var GEO_POLY_LINE = "#ea580c";
var GEO_POLY_FILL = "rgba(234, 88, 12, 0.12)";
var TEXT_TITLE = "#e5eaf3";
var TEXT_PERCENT = "rgba(229, 234, 243, 0.85)";
var TEXT_TIP = "rgba(229, 234, 243, 0.5)";
var PROGRESS_TRACK = "rgba(163, 166, 173, 0.2)";
var PROGRESS_FILL = "#409EFF";

// 文字通道
var loaderText = { percent: "0%", tip: "正在加载地图核心模块" };

function updateThemeColors() {
  GRAY_FRAME = isLight ? "rgba(144, 147, 153, 0.45)" : "rgba(163, 166, 173, 0.45)";
  GRAY_DASH = isLight ? "rgba(192, 196, 204, 0.35)" : "rgba(108, 110, 114, 0.35)";
  TEXT_TITLE = isLight ? "#303133" : "#e5eaf3";
  TEXT_PERCENT = isLight ? "rgba(48, 49, 51, 0.85)" : "rgba(229, 234, 243, 0.85)";
  TEXT_TIP = isLight ? "rgba(48, 49, 51, 0.5)" : "rgba(229, 234, 243, 0.5)";
  PROGRESS_TRACK = isLight ? "rgba(144, 147, 153, 0.2)" : "rgba(163, 166, 173, 0.2)";
}

// ---- 绘制函数 ----

function drawGeometry(t) {
  var cx = W / 2;
  var cy = GEO_CY;

  var local = t % STAGE_DURATION;
  var cycleT = t % (STAGE_DURATION * 3);
  // 通知主线程轮次剩余时间
  self.postMessage({ type: "cycleRemaining", value: STAGE_DURATION * 3 - cycleT });

  drawOuterRing(cx, cy, t);

  var contentAlpha = 1;
  if (ending) {
    contentAlpha = Math.max(0, 1 - (t - endStartT) / END_CONTENT_FADE);
  }
  ctx.globalAlpha = contentAlpha;

  var stage = Math.floor(t / STAGE_DURATION) % 3;
  var local = t % STAGE_DURATION;
  var stageAlpha = 1;
  if (local > STAGE_DURATION - FADE)
    stageAlpha = (STAGE_DURATION - local) / FADE;
  ctx.globalAlpha = Math.max(0, Math.min(1, contentAlpha * stageAlpha));

  if (stage === 0) drawPoint(cx, cy, local);
  else if (stage === 1) drawLine(cx, cy, local);
  else drawPolygon(cx, cy, local);

  ctx.globalAlpha = 1;
}

function drawOuterRing(cx, cy, t) {
  ctx.save();

  if (!ending) {
    ctx.strokeStyle = GRAY_FRAME;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, GEO_RADIUS, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = GRAY_DASH;
    ctx.lineWidth = 1;
    for (var i = 0; i < 4; i++) {
      var a = (i * Math.PI) / 2 + Math.PI / 4;
      var x1 = cx + Math.cos(a) * (GEO_RADIUS + 4);
      var y1 = cy + Math.sin(a) * (GEO_RADIUS + 4);
      var x2 = cx + Math.cos(a) * (GEO_RADIUS + 12);
      var y2 = cy + Math.sin(a) * (GEO_RADIUS + 12);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
    ctx.restore();
    return;
  }

  var elapsed = t - endStartT;
  var tickAlpha = Math.max(0, 1 - elapsed / 200);
  if (tickAlpha > 0) {
    ctx.globalAlpha = tickAlpha;
    ctx.strokeStyle = GRAY_DASH;
    ctx.lineWidth = 1;
    for (var i = 0; i < 4; i++) {
      var a = (i * Math.PI) / 2 + Math.PI / 4;
      var x1 = cx + Math.cos(a) * (GEO_RADIUS + 4);
      var y1 = cy + Math.sin(a) * (GEO_RADIUS + 4);
      var x2 = cx + Math.cos(a) * (GEO_RADIUS + 12);
      var y2 = cy + Math.sin(a) * (GEO_RADIUS + 12);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  var R = GEO_RADIUS;
  var squishT = Math.min(elapsed / END_RING_SQUISH, 1);
  var collapseT = Math.max(0, Math.min((elapsed - END_RING_SQUISH) / END_RING_COLLAPSE, 1));

  if (squishT < 1) {
    var scaleY = 1 - squishT;
    ctx.strokeStyle = GRAY_FRAME;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(cx, cy, R, R * scaleY, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (collapseT < 1) {
    var lineHalfLen = R * (1 - collapseT);
    if (lineHalfLen > 0.5) {
      ctx.strokeStyle = GRAY_FRAME;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx - lineHalfLen, cy);
      ctx.lineTo(cx + lineHalfLen, cy);
      ctx.stroke();
    }
  }

  ctx.restore();
}

function drawPoint(cx, cy, local) {
  ctx.save();
  var RING_R = 16;
  var DOT_R = 5;
  var PEN_R = 2;
  var T1 = 200;
  var T2 = 1000;

  ctx.fillStyle = GEO_POINT_LINE;
  ctx.strokeStyle = GEO_POINT_LINE;
  ctx.lineWidth = 1.5;

  if (local < T1) {
    ctx.globalAlpha *= local / T1;
    ctx.beginPath();
    ctx.arc(cx, cy, DOT_R, 0, Math.PI * 2);
    ctx.fill();
  } else if (local < T2) {
    ctx.beginPath();
    ctx.arc(cx, cy, DOT_R, 0, Math.PI * 2);
    ctx.fill();
    var progress = (local - T1) / (T2 - T1);
    var startAngle = -Math.PI / 2;
    var endAngle = startAngle + progress * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(cx, cy, RING_R, startAngle, endAngle);
    ctx.stroke();
    var penX = cx + Math.cos(endAngle) * RING_R;
    var penY = cy + Math.sin(endAngle) * RING_R;
    ctx.beginPath();
    ctx.arc(penX, penY, PEN_R, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.arc(cx, cy, DOT_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, RING_R, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawLine(cx, cy, local) {
  ctx.save();
  ctx.strokeStyle = GEO_LINE_LINE;
  ctx.fillStyle = GEO_LINE_LINE;
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  var pts = [
    { x: cx - 56, y: cy + 30 },
    { x: cx - 18, y: cy - 40 },
    { x: cx + 24, y: cy + 12 },
    { x: cx + 58, y: cy - 24 },
  ];
  var DOT_R = 3;
  var PEN_R = 5;
  var T1 = 200;
  var T2 = 1000;

  var segs = [];
  var total = 0;
  for (var i = 1; i < pts.length; i++) {
    var dx = pts[i].x - pts[i - 1].x;
    var dy = pts[i].y - pts[i - 1].y;
    var len = Math.sqrt(dx * dx + dy * dy);
    segs.push({ from: pts[i - 1], to: pts[i], len: len });
    total += len;
  }

  if (local < T1) {
    ctx.globalAlpha *= local / T1;
    ctx.beginPath();
    ctx.arc(pts[0].x, pts[0].y, PEN_R, 0, Math.PI * 2);
    ctx.fill();
  } else if (local < T2) {
    var progress = (local - T1) / (T2 - T1);
    var targetLen = total * progress;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    var drawnLen = 0;
    var penX = pts[0].x, penY = pts[0].y;
    for (var s = 0; s < segs.length; s++) {
      var seg = segs[s];
      if (drawnLen + seg.len <= targetLen) {
        ctx.lineTo(seg.to.x, seg.to.y);
        drawnLen += seg.len;
        penX = seg.to.x;
        penY = seg.to.y;
      } else {
        var remain = targetLen - drawnLen;
        var ratio = remain / seg.len;
        penX = seg.from.x + (seg.to.x - seg.from.x) * ratio;
        penY = seg.from.y + (seg.to.y - seg.from.y) * ratio;
        ctx.lineTo(penX, penY);
        break;
      }
    }
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(pts[0].x, pts[0].y, DOT_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(penX, penY, PEN_R, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (var j = 1; j < pts.length; j++) ctx.lineTo(pts[j].x, pts[j].y);
    ctx.stroke();
    for (var k = 0; k < pts.length; k++) {
      ctx.beginPath();
      ctx.arc(pts[k].x, pts[k].y, DOT_R, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawPolygon(cx, cy, local) {
  ctx.save();
  ctx.strokeStyle = GEO_POLY_LINE;
  ctx.fillStyle = GEO_POLY_FILL;
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";

  var R = 46;
  var pts = [];
  for (var k = 0; k < 5; k++) {
    var ang = -Math.PI / 2 + (k * 2 * Math.PI) / 5;
    pts.push({ x: cx + Math.cos(ang) * R, y: cy + Math.sin(ang) * R });
  }
  var PEN_R = 5;
  var DOT_R = 3;
  var T1 = 200;
  var T2 = 1000;

  var segs = [];
  var total = 0;
  for (var i = 0; i < pts.length; i++) {
    var next = pts[(i + 1) % pts.length];
    var dx = next.x - pts[i].x;
    var dy = next.y - pts[i].y;
    var len = Math.sqrt(dx * dx + dy * dy);
    segs.push({ from: pts[i], to: next, len: len });
    total += len;
  }

  if (local < T1) {
    ctx.globalAlpha *= local / T1;
    ctx.fillStyle = GEO_POLY_LINE;
    ctx.beginPath();
    ctx.arc(pts[0].x, pts[0].y, PEN_R, 0, Math.PI * 2);
    ctx.fill();
  } else if (local < T2) {
    var progress = (local - T1) / (T2 - T1);
    var targetLen = total * progress;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    var drawnLen = 0;
    var penX = pts[0].x, penY = pts[0].y;
    for (var s = 0; s < segs.length; s++) {
      var seg = segs[s];
      if (drawnLen + seg.len <= targetLen) {
        ctx.lineTo(seg.to.x, seg.to.y);
        drawnLen += seg.len;
        penX = seg.to.x;
        penY = seg.to.y;
      } else {
        var remain = targetLen - drawnLen;
        var ratio = remain / seg.len;
        penX = seg.from.x + (seg.to.x - seg.from.x) * ratio;
        penY = seg.from.y + (seg.to.y - seg.from.y) * ratio;
        ctx.lineTo(penX, penY);
        break;
      }
    }
    ctx.stroke();
    ctx.fillStyle = GEO_POLY_LINE;
    ctx.beginPath();
    ctx.arc(penX, penY, PEN_R, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (var m = 1; m < pts.length; m++) ctx.lineTo(pts[m].x, pts[m].y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = GEO_POLY_LINE;
    for (var k = 0; k < pts.length; k++) {
      ctx.beginPath();
      ctx.arc(pts[k].x, pts[k].y, DOT_R, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawText(t) {
  var txt = loaderText;
  var textAlpha = 1;
  if (ending) {
    var elapsed = t - endStartT;
    var textFadeStart = END_RING_SQUISH;
    if (elapsed >= textFadeStart) {
      textAlpha = Math.max(0, 1 - (elapsed - textFadeStart) / END_RING_COLLAPSE);
    }
  }
  ctx.globalAlpha = textAlpha;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  ctx.fillStyle = TEXT_TITLE;
  ctx.font = '600 22px -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.fillText("GIS Tools", W / 2, TEXT_Y_TITLE);

  ctx.fillStyle = TEXT_PERCENT;
  ctx.font = "500 14px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
  ctx.fillText(txt.percent, W / 2, TEXT_Y_PROGRESS);

  var barX = (W - PROGRESS_BAR_W) / 2;
  var barY = PROGRESS_BAR_Y;
  ctx.fillStyle = PROGRESS_TRACK;
  roundRect(barX, barY, PROGRESS_BAR_W, PROGRESS_BAR_H, 2);
  ctx.fill();
  var pct = parseFloat(txt.percent) || 0;
  if (pct > 0) {
    ctx.fillStyle = PROGRESS_FILL;
    var fillW = Math.max(PROGRESS_BAR_H, (PROGRESS_BAR_W * pct) / 100);
    roundRect(barX, barY, fillW, PROGRESS_BAR_H, 2);
    ctx.fill();
  }

  ctx.fillStyle = TEXT_TIP;
  ctx.font = '400 12px -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.fillText(txt.tip || "", W / 2, TEXT_Y_TIP);
  ctx.globalAlpha = 1;
}

function roundRect(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawFrame(t) {
  ctx.clearRect(0, 0, W, H);
  drawGeometry(t);
  drawText(t);
}

function tick(ts) {
  if (!startTs) startTs = ts;
  var t = ts - startTs;
  drawFrame(t);

  if (ending) {
    var elapsed = t - endStartT;
    if (elapsed >= END_TOTAL + CLEANUP_DELAY) {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = null;
      self.postMessage({ type: "done" });
      return;
    }
  }

  rafId = requestAnimationFrame(tick);
}

// ---- 消息处理 ----

self.onmessage = function (e) {
  var msg = e.data;

  if (msg.type === "init") {
    // 接收 OffscreenCanvas
    var canvas = msg.canvas;
    W = msg.width || 280;
    H = msg.height || 380;
    isLight = !!msg.isLight;
    updateThemeColors();

    // 黄金分割点定位：几何动画中心在屏幕 38.2% 高度处
    // GEO_CY 是 canvas 内部坐标，需要根据屏幕高度映射
    var screenH = msg.screenHeight || 800;
    var goldenCy = screenH * 0.382;
    // canvas 在 CSS 中 margin-top = 38.2vh - 110px（110 是 GEO_CY 基准值）
    // 所以 canvas 顶部 = goldenCy - 110，GEO_CY 保持 110 不变
    // 但如果屏幕很小，需要确保内容不溢出
    if (screenH < 500) {
      // 小屏幕：整体上移，GEO_CY 减小
      var offset = (500 - screenH) * 0.3;
      GEO_CY = 110 - offset;
      TEXT_Y_TITLE = 232 - offset;
      TEXT_Y_PROGRESS = 268 - offset;
      PROGRESS_BAR_Y = 286 - offset;
      TEXT_Y_TIP = 318 - offset;
    }

    var dpr = msg.dpr || 1;

    canvas.width = W * dpr;
    canvas.height = H * dpr;
      ctx = canvas.getContext("2d");
    if (dpr !== 1) {
      ctx.scale(dpr, dpr);
    }

    rafId = requestAnimationFrame(tick);
  }

  if (msg.type === "theme") {
    isLight = !!msg.isLight;
    updateThemeColors();
  }

  if (msg.type === "text") {
    loaderText = { percent: msg.percent || "0%", tip: msg.tip || "" };
  }

  if (msg.type === "startEnding") {
    if (ending) return;
    ending = true;
    endStartT = performance.now() - startTs;
  }
};
