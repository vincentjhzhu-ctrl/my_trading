
import { D } from "./decimal_fp.js";

function clear(ctx, w, h){
  ctx.clearRect(0,0,w,h);
  ctx.fillStyle = "rgba(2,6,23,.20)";
  ctx.fillRect(0,0,w,h);
}

function drawLine(ctx, pts, color){
  if (pts.length < 2) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i=1;i<pts.length;i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
}

function drawText(ctx, x, y, text, color="rgba(229,231,235,.9)"){
  ctx.fillStyle = color;
  ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace";
  ctx.fillText(text, x, y);
}

function niceMinMax(values){
  let mn = Infinity, mx = -Infinity;
  for (const v of values){
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    mn = Math.min(mn, n);
    mx = Math.max(mx, n);
  }
  if (mn === Infinity){ mn = 0; mx = 1; }
  if (mx === mn){ mx = mn + 1; }
  return {mn, mx};
}

export function renderChart1(canvas, dailyRows){
  // Net invest (total_cash) vs market_value
  const ctx = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.floor(rect.width * devicePixelRatio);
  canvas.height = Math.floor((canvas.getAttribute("height")||220) * devicePixelRatio);
  const w = canvas.width, h = canvas.height;
  clear(ctx, w, h);
  const padL = 54*devicePixelRatio, padR = 14*devicePixelRatio, padT = 14*devicePixelRatio, padB = 26*devicePixelRatio;

  const xs = dailyRows.map((_,i)=>i);
  const net = dailyRows.map(r=>Number(D(r.total_cash).toNumber()));
  const mv  = dailyRows.map(r=>Number(D(r.market_value).toNumber()));
  const {mn, mx} = niceMinMax([...net, ...mv]);

  const x0 = padL, x1 = w - padR;
  const y0 = h - padB, y1 = padT;

  // grid
  ctx.strokeStyle = "rgba(148,163,184,.15)";
  ctx.lineWidth = 1;
  for (let i=0;i<=4;i++){
    const y = y1 + (y0-y1)*i/4;
    ctx.beginPath(); ctx.moveTo(x0,y); ctx.lineTo(x1,y); ctx.stroke();
  }

  function xy(i, v){
    const x = x0 + (x1-x0) * (i/(xs.length-1||1));
    const y = y0 - (y0-y1) * ((v - mn)/(mx - mn));
    return {x,y};
  }

  const pNet = net.map((v,i)=>xy(i,v));
  const pMv  = mv.map((v,i)=>xy(i,v));

  drawLine(ctx, pNet, "rgba(59,130,246,.95)");
  drawLine(ctx, pMv,  "rgba(16,185,129,.95)");

  drawText(ctx, 12*devicePixelRatio, 16*devicePixelRatio, "累计净投入 vs 市值");
  const last = dailyRows[dailyRows.length-1];
  drawText(ctx, 12*devicePixelRatio, 34*devicePixelRatio, `净投=${last?String(last.total_cash):"-"}  市值=${last?String(last.market_value):"-"}`, "rgba(156,163,175,.95)");
}

export function renderChart2(canvas, dailyRows){
  // pnl_rate
  const ctx = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.floor(rect.width * devicePixelRatio);
  canvas.height = Math.floor((canvas.getAttribute("height")||220) * devicePixelRatio);
  const w = canvas.width, h = canvas.height;
  clear(ctx, w, h);
  const padL = 54*devicePixelRatio, padR = 14*devicePixelRatio, padT = 14*devicePixelRatio, padB = 26*devicePixelRatio;

  const xs = dailyRows.map((_,i)=>i);
  const rr = dailyRows.map(r=>Number(D(r.pnl_rate).mul(D("100")).toNumber()));
  const {mn, mx} = niceMinMax(rr);

  const x0 = padL, x1 = w - padR;
  const y0 = h - padB, y1 = padT;

  ctx.strokeStyle = "rgba(148,163,184,.15)";
  ctx.lineWidth = 1;
  for (let i=0;i<=4;i++){
    const y = y1 + (y0-y1)*i/4;
    ctx.beginPath(); ctx.moveTo(x0,y); ctx.lineTo(x1,y); ctx.stroke();
  }

  function xy(i, v){
    const x = x0 + (x1-x0) * (i/(xs.length-1||1));
    const y = y0 - (y0-y1) * ((v - mn)/(mx - mn));
    return {x,y};
  }

  const pts = rr.map((v,i)=>xy(i,v));
  drawLine(ctx, pts, "rgba(245,158,11,.95)");

  drawText(ctx, 12*devicePixelRatio, 16*devicePixelRatio, "每日总收益率(含已实现)");
  const last = dailyRows[dailyRows.length-1];
  drawText(ctx, 12*devicePixelRatio, 34*devicePixelRatio, `最新=${last?D(last.pnl_rate).mul(D("100")).toString(2)+"%":"-"}`, "rgba(156,163,175,.95)");
}
