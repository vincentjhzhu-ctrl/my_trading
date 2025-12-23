
import { D, clamp, q_money, q_cost3, q_ratio4, abs, max as dmax, min as dmin, floor_to_lot, LOT_SIZE } from "./decimal_fp.js";

// ==== Parsing helpers (match Python) ====
export function parseLevels(text){
  const out = [];
  for (const part of (text||"").split(",")){
    const p = part.trim();
    if (!p) continue;
    out.push(D(p));
  }
  return out;
}
export function parseTpRatios(text){
  const out = [];
  for (const part of (text||"").split(",")){
    const p = part.trim();
    if (!p) continue;
    out.push(D(p));
  }
  if (out.length === 0){
    return [D("0.15"),D("0.15"),D("0.20"),D("0.20"),D("0.30")];
  }
  return out;
}

export function tpRatioAdjusted(ratio, idx, strength){
  ratio = D(ratio);
  idx = Number(idx);
  const s = String(strength||"中");
  if (s === "低"){
    // 低：更激进，前段多卖
    if (idx <= 1) return clamp(ratio.add(D("0.05")), D("0"), D("1"));
    if (idx >= 4) return clamp(ratio.sub(D("0.05")), D("0"), D("1"));
    return ratio;
  }else if (s === "高"){
    // 高：更保守，前段少卖
    if (idx <= 1) return clamp(ratio.sub(D("0.05")), D("0"), D("1"));
    if (idx >= 4) return clamp(ratio.add(D("0.05")), D("0"), D("1"));
    return ratio;
  }
  return ratio;
}

// ==== Stats helpers (match Python) ====
export function mean(xs){
  if (!xs || xs.length === 0) return D("0");
  let s = D("0");
  for (const x of xs) s = s.add(x);
  return s.div(D(String(xs.length)));
}

export function percentileRank(sortedOrNot, x){
  const xs = [...(sortedOrNot||[])].map(D);
  if (xs.length === 0) return D("0.5");
  xs.sort((a,b)=>a.cmp(b));
  x = D(x);
  const n = xs.length;
  let cnt = 0;
  for (const v of xs){
    if (v.lte(x)) cnt++;
    else break;
  }
  return D(String(cnt)).div(D(String(n)));
}

export function atrPercent(highs, lows, closes, n=14){
  if (!closes || closes.length < n + 1) return D("0");
  const trs = [];
  const start = closes.length - n;
  for (let i=start;i<closes.length;i++){
    const hi = highs[i], lo = lows[i], prev = closes[i-1];
    const tr = dmax(hi.sub(lo), dmax(abs(hi.sub(prev)), abs(lo.sub(prev))));
    trs.push(tr);
  }
  const atr = mean(trs);
  const px = closes[closes.length-1];
  return px.gt(D("0")) ? atr.div(px) : D("0");
}

// ==== Scoring (match Python) ====
export function scoreFromPercentile(pct){ return clamp(D("1").sub(pct), D("0"), D("1")); }

export function scoreFromDrawdown(dd){
  dd = D(dd);
  if (dd.gte(D("0"))) return D("0.45");
  const x = dd.neg(); // positive drawdown
  const t = clamp(x.div(D("0.30")), D("0"), D("1"));
  const s = D("0.50").add(t.mul(D("0.45")));
  return clamp(s, D("0"), D("1"));
}

export function scoreFromMaDev(dev){
  dev = D(dev);
  const s = D("0.5").sub(clamp(dev.div(D("0.10")), D("-1"), D("1")).mul(D("0.25")));
  return clamp(s, D("0"), D("1"));
}

export function scoreFromTrend(price, ma200){
  price = D(price); ma200 = D(ma200);
  if (ma200.lte(D("0"))) return D("0.5");
  return price.gte(ma200) ? D("0.70") : D("0.30");
}

export function riskDampFromVol(volpct, mode){
  const v = D(volpct).toNumber();
  if (String(mode) === "A股"){
    if (v <= 0.015) return D("0.92");
    if (v <= 0.03)  return D("0.80");
    if (v <= 0.06)  return D("0.62");
    if (v <= 0.10)  return D("0.48");
    return D("0.40");
  }else{
    if (v <= 0.01)  return D("0.95");
    if (v <= 0.03)  return D("0.85");
    if (v <= 0.06)  return D("0.70");
    if (v <= 0.10)  return D("0.55");
    return D("0.45");
  }
}

export function scoreFromPremium(prem){
  prem = D(prem);
  const s = D("0.5").sub(clamp(prem.div(D("0.03")), D("-1"), D("1")).mul(D("0.30")));
  return clamp(s, D("0"), D("1"));
}

// ==== Weights normalization (match Python) ====
export function normalizeWeights(ws){
  let s = D("0");
  for (const k of Object.keys(ws)) s = s.add(ws[k]);
  if (s.lte(D("0"))) {
    const out = {};
    const n = Object.keys(ws).length;
    for (const k of Object.keys(ws)) out[k] = D("1").div(D(String(n)));
    return out;
  }
  const out = {};
  for (const k of Object.keys(ws)) out[k] = ws[k].div(s);
  return out;
}

// ==== Fee model (match Python FeeConfig) ====
export class FeeConfig {
  constructor({mode="A", commission_rate="0.0001", commission_min="5", other_fee_rate="0", other_fee_fixed="0"}={}){
    this.mode = (mode||"A").toUpperCase();
    this.commission_rate = D(commission_rate);
    this.commission_min = D(commission_min);
    this.other_fee_rate = D(other_fee_rate);
    this.other_fee_fixed = D(other_fee_fixed);
  }
  calcCommission(turnover){
    let c = D(turnover).mul(this.commission_rate);
    if (c.lt(this.commission_min)) c = this.commission_min;
    return q_money(c);
  }
  calcOtherFee(turnover){
    if (this.mode === "A") return D("0");
    return q_money(D(turnover).mul(this.other_fee_rate).add(this.other_fee_fixed));
  }
  cashflow(side, price, shares){
    shares = floor_to_lot(shares);
    if (shares <= 0) return { delta_cash:D("0"), turnover:D("0"), commission:D("0"), other_fee:D("0") };
    const turnover = q_money(D(price).mul(D(String(shares))));
    const commission = this.calcCommission(turnover);
    const other_fee = this.calcOtherFee(turnover);
    let delta_cash;
    if (String(side).toUpperCase() === "BUY"){
      delta_cash = turnover.add(commission).add(other_fee);
    }else{
      delta_cash = turnover.sub(commission).sub(other_fee).neg();
    }
    return { delta_cash:q_money(delta_cash), turnover, commission, other_fee };
  }
}

export function maxBuySharesForBudget(price, budget_cash, fee){
  price = D(price); budget_cash = D(budget_cash);
  if (price.lte(D("0")) || budget_cash.lte(D("0"))) return {shares:0, cost:D("0")};
  const rough = D(budget_cash).div(price).toIntegralHalfUp();
  let shares = floor_to_lot(rough);
  while (shares > 0){
    const { delta_cash } = fee.cashflow("BUY", price, shares);
    if (delta_cash.lte(budget_cash)) return {shares, cost:delta_cash};
    shares -= LOT_SIZE;
  }
  return {shares:0, cost:D("0")};
}

export function sellCashIn(price, shares, fee){
  const { delta_cash } = fee.cashflow("SELL", price, shares);
  return delta_cash.neg();
}

// ==== ModelConfig / defaults (match Python apply_mode_defaults) ====
export function modelConfigFromSettings(settings){
  const mode = settings.mode || "ETF";
  const cfg = {
    mode,
    min_target: D("0.15"),
    max_target: D("1.00"),
    w_percentile: D("1.0"),
    w_drawdown: D("1.0"),
    w_ma_dev: D("1.0"),
    w_trend: D("0.8"),
    w_vol_risk: D("0.8"),
    w_premium: D("0.8"),
    add_levels: [],
    tp_levels: [],
  };
  applyModeDefaults(cfg);
  return cfg;
}

export function applyModeDefaults(cfg){
  if ((cfg.mode||"ETF") === "ETF"){
    cfg.min_target = D("0.15");
    cfg.max_target = D("1.00");
    cfg.w_percentile = D("1.00");
    cfg.w_drawdown = D("1.00");
    cfg.w_ma_dev = D("1.00");
    cfg.w_trend = D("0.90");
    cfg.w_vol_risk = D("0.80");
    cfg.w_premium = D("0.80");
    cfg.add_levels = [D("-0.03"),D("-0.05"),D("-0.08"),D("-0.12"),D("-0.18")];
    cfg.tp_levels  = [D("0.05"),D("0.08"),D("0.12"),D("0.18"),D("0.25")];
  }else{
    cfg.min_target = D("0.10");
    cfg.max_target = D("1.00");
    cfg.w_percentile = D("1.00");
    cfg.w_drawdown = D("1.00");
    cfg.w_ma_dev = D("1.00");
    cfg.w_trend = D("1.10");
    cfg.w_vol_risk = D("1.00");
    cfg.w_premium = D("0.00");
    cfg.add_levels = [D("-0.04"),D("-0.07"),D("-0.10"),D("-0.15"),D("-0.22")];
    cfg.tp_levels  = [D("0.06"),D("0.10"),D("0.15"),D("0.22"),D("0.30")];
  }
}

// ==== Smart anchor (match Python) ====
export function computeSmartAnchor(closes){
  if (!closes || closes.length < 60) return { anchor:D("0"), note:"K线不足" };
  const ma20 = mean(closes.slice(-20));
  const ma60 = mean(closes.slice(-60));
  const recentLow = closes.slice(-60).reduce((a,b)=>a.lt(b)?a:b, closes[closes.length-60]);
  const anchor = ma20.mul(D("0.5")).add(ma60.mul(D("0.3"))).add(recentLow.mul(D("0.2")));
  return { anchor:q_cost3(anchor), note:`MA20=${q_cost3(ma20)}, MA60=${q_cost3(ma60)}, low60=${q_cost3(recentLow)}` };
}

// ==== Model compute (match Python compute_model) ====
export function computeModel({
  cfg,
  mode,
  latest_price,
  current_shares,
  max_position_value,
  available_cash,
  fee,
  premium_data,
  manual_premium,
  manual_iopv,
  macro_override,
  macro_k,
}){
  const ws = {
    percentile: cfg.w_percentile,
    drawdown: cfg.w_drawdown,
    ma_dev: cfg.w_ma_dev,
    trend: cfg.w_trend,
    vol_risk: cfg.w_vol_risk,
    premium: (mode === "ETF") ? cfg.w_premium : D("0"),
  };
  const wn = normalizeWeights(ws);
  const factors = [];
  const kline = premium_data?.kline || { ok:false, source:"none", closes:[], highs:[], lows:[] };
  const closes = kline.ok ? kline.closes.slice() : [];
  const highs = kline.ok ? kline.highs.slice() : [];
  const lows  = kline.ok ? kline.lows.slice() : [];

  // helper add factor
  function addFactor(name, ok, source, raw, score, w, contrib, note){
    factors.push({ name, ok, source, raw, score, weight:w, contribution:contrib, note });
  }

  latest_price = D(latest_price);
  max_position_value = D(max_position_value);
  available_cash = D(available_cash);

  if (kline.ok && closes.length >= 60){
    const xs = closes.length >= 250 ? closes.slice(-250) : closes;
    const pct = percentileRank(xs, latest_price);
    const score = scoreFromPercentile(pct);
    const w = wn.percentile;
    const contrib = score.sub(D("0.5")).mul(w);
    addFactor("历史分位(越低越便宜)", true, kline.source, pct, score, w, contrib, "pct越高越贵，score=1-pct");
  }else{
    const w = wn.percentile;
    const score = D("0.5");
    addFactor("历史分位(越低越便宜)", false, kline.source, null, score, w, score.sub(D("0.5")).mul(w), "K线不足，中性");
  }

  if (kline.ok && closes.length >= 60){
    const xs = closes.length >= 250 ? closes.slice(-250) : closes;
    let peak = xs[0] || latest_price;
    for (const c of xs) if (c.gt(peak)) peak = c;
    const dd = peak.gt(D("0")) ? latest_price.div(peak).sub(D("1")) : D("0");
    const score = scoreFromDrawdown(dd);
    const w = wn.drawdown;
    const contrib = score.sub(D("0.5")).mul(w);
    addFactor("回撤(越深越便宜)", true, kline.source, dd, score, w, contrib, "dd<=0 越负越便宜");
  }else{
    const w = wn.drawdown;
    const score = D("0.5");
    addFactor("回撤(越深越便宜)", false, kline.source, null, score, w, score.sub(D("0.5")).mul(w), "K线不足，中性");
  }

  if (kline.ok && closes.length >= 30){
    const ma20 = mean(closes.slice(-20));
    const dev = ma20.gt(D("0")) ? latest_price.div(ma20).sub(D("1")) : D("0");
    const score = scoreFromMaDev(dev);
    const w = wn.ma_dev;
    const contrib = score.sub(D("0.5")).mul(w);
    addFactor("MA20偏离(负=便宜)", true, kline.source, dev, score, w, contrib, "dev=price/ma20-1");
  }else{
    const w = wn.ma_dev;
    const score = D("0.5");
    addFactor("MA20偏离(负=便宜)", false, kline.source, null, score, w, score.sub(D("0.5")).mul(w), "K线不足，中性");
  }

  if (kline.ok && closes.length >= 220){
    const ma200 = mean(closes.slice(-200));
    const score = scoreFromTrend(latest_price, ma200);
    const w = wn.trend;
    const contrib = score.sub(D("0.5")).mul(w);
    addFactor("趋势(MA200)", true, kline.source, ma200, score, w, contrib, "price>MA200 更敢持");
  }else{
    const w = wn.trend;
    const score = D("0.5");
    addFactor("趋势(MA200)", false, kline.source, null, score, w, score.sub(D("0.5")).mul(w), "K线不足，中性");
  }

  let volpct = D("0");
  if (kline.ok && closes.length >= 20 && highs.length === closes.length && lows.length === closes.length){
    volpct = atrPercent(highs, lows, closes, 14);
    const damp = riskDampFromVol(volpct, mode);
    const score = damp;
    const w = wn.vol_risk;
    const contrib = score.sub(D("0.5")).mul(w);
    addFactor("波动抑制(ATR%)", true, kline.source, volpct, score, w, contrib, "波动越大，越抑制加仓");
  }else{
    const w = wn.vol_risk;
    const score = D("0.5");
    addFactor("波动抑制(ATR%)", false, kline.source, null, score, w, score.sub(D("0.5")).mul(w), "K线不足，中性");
  }

  let prem_used = null, iopv_used = null, prem_ok = false, prem_src = "n/a";
  const premAuto = premium_data?.premium ?? null;
  const iopvAuto = premium_data?.iopv ?? null;

  if (mode === "ETF"){
    let autoPrem = premAuto, autoIopv = iopvAuto;
    const srcSuffix = [];
    if (autoPrem === null && autoIopv !== null && latest_price.gt(D("0")) && D(autoIopv).gt(D("0"))){
      autoPrem = latest_price.sub(autoIopv).div(autoIopv);
      srcSuffix.push("premium_from_iopv");
    }
    if (autoIopv === null && autoPrem !== null && latest_price.gt(D("0"))){
      const denom = D("1").add(autoPrem);
      if (denom.gt(D("0"))){
        autoIopv = latest_price.div(denom);
        srcSuffix.push("iopv_from_premium");
      }
    }

    if (manual_iopv !== null && D(manual_iopv).gt(D("0")) && latest_price.gt(D("0"))){
      iopv_used = D(manual_iopv);
      prem_used = latest_price.sub(iopv_used).div(iopv_used);
      prem_ok = true;
      prem_src = "manual_iopv";
    }else if (manual_premium !== null){
      prem_used = D(manual_premium);
      const denom = D("1").add(prem_used);
      if (latest_price.gt(D("0")) && denom.gt(D("0"))) iopv_used = latest_price.div(denom);
      prem_ok = true;
      prem_src = "manual_premium";
    }else if (autoPrem !== null || autoIopv !== null){
      prem_used = autoPrem !== null ? D(autoPrem) : null;
      iopv_used = autoIopv !== null ? D(autoIopv) : null;
      prem_ok = prem_used !== null;
      prem_src = premium_data?.source || "auto";
      if (srcSuffix.length) prem_src = prem_src + "(" + srcSuffix.join("+") + ")";
    }else{
      prem_ok = false;
      prem_src = premium_data?.source || "none";
    }

    const w = wn.premium;
    if (prem_used !== null){
      const score = scoreFromPremium(prem_used);
      const contrib = score.sub(D("0.5")).mul(w);
      addFactor("折溢价/IOPV", true, prem_src, prem_used, score, w, contrib, "溢价>0 降低买入倾向");
    }else{
      const score = D("0.5");
      addFactor("折溢价/IOPV", false, prem_src, null, score, w, score.sub(D("0.5")).mul(w), "无法获取，中性");
    }
  }

  let totalContrib = D("0");
  for (const fr of factors) totalContrib = totalContrib.add(fr.contribution);
  const cheapness = clamp(D("0.5").add(totalContrib), D("0"), D("1"));

  macro_override = clamp(D(macro_override), D("-1"), D("1"));
  macro_k = clamp(D(macro_k), D("0"), D("1"));
  const buy_scale = clamp(D("1").add(macro_k.mul(macro_override)), D("0.50"), D("1.50"));
  const sell_scale = clamp(D("1").sub(macro_k.mul(macro_override)), D("0.50"), D("1.50"));

  const target_ratio_base = clamp(cfg.min_target.add(cfg.max_target.sub(cfg.min_target).mul(cheapness)), D("0"), D("1"));
  const target_ratio = clamp(target_ratio_base.mul(D("1").add(macro_k.mul(macro_override))), D("0"), D("1"));

  const target_value = q_money(max_position_value.mul(target_ratio));
  let target_shares = 0;
  if (latest_price.gt(D("0"))){
    const rough = target_value.div(latest_price).toIntTrunc();
    target_shares = floor_to_lot(rough);
  }

  const delta_shares = target_shares - Number(current_shares||0);

  let buy_shares = 0, buy_cash = D("0"), sell_shares = 0, sell_cash_in_amt = D("0");
  if (delta_shares > 0){
    let desired = floor_to_lot(delta_shares);
    if (desired > 0){
      const aff = maxBuySharesForBudget(latest_price, available_cash, fee);
      buy_shares = Math.min(desired, aff.shares);
      buy_shares = floor_to_lot(buy_shares);
      if (buy_shares > 0){
        buy_cash = fee.cashflow("BUY", latest_price, buy_shares).delta_cash;
      }
    }
  }else if (delta_shares < 0){
    let desiredSell = floor_to_lot(-delta_shares);
    desiredSell = Math.min(desiredSell, floor_to_lot(current_shares));
    sell_shares = desiredSell;
    if (sell_shares > 0){
      sell_cash_in_amt = q_money(sellCashIn(latest_price, sell_shares, fee));
    }
  }

  const reason = `cheapness=${q_ratio4(cheapness).toString(4)} -> target_ratio=${q_ratio4(target_ratio).toString(4)}; target_shares=${target_shares}`;

  return {
    ok_kline: kline.ok,
    kline_source: kline.source || "none",
    ok_premium: prem_ok,
    premium_source: prem_src,
    premium: prem_used,
    iopv: iopv_used,
    factors,
    cheapness,
    target_ratio_base,
    target_ratio,
    target_value,
    target_shares,
    delta_shares,
    buy_shares,
    buy_cash,
    sell_shares,
    sell_cash_in: sell_cash_in_amt,
    reason,
    buy_scale,
    sell_scale,
    macro_override,
    macro_k,
    volpct,
  };
}

export function valuationLevel(cheapness){
  cheapness = D(cheapness);
  if (cheapness.gte(D("0.80"))) return "很便宜";
  if (cheapness.gte(D("0.65"))) return "偏便宜";
  if (cheapness.gte(D("0.45"))) return "中性";
  if (cheapness.gte(D("0.30"))) return "偏贵";
  return "很贵";
}

export function factorBrief(factors){
  if (!factors || !factors.length) return "-";
  const ordered = [...factors].sort((a,b)=>abs(b.contribution).cmp(abs(a.contribution)));
  const top = ordered.slice(0,3);
  return top.map(fr=>{
    const s = fr.contribution.gte(D("0")) ? "+" : "";
    return `${fr.name}:${s}${q_ratio4(fr.contribution).toString(4)}`;
  }).join(" | ");
}

// ==== Anchor selection ====
export function chooseAnchor(anchorMode, anchorFixedValue, klineCloses){
  const mode = String(anchorMode||"dynamic");
  if (mode === "fixed"){
    const av = D(anchorFixedValue||"0");
    if (av.gt(D("0"))) return { anchor:q_cost3(av), src:"fixed" };
    return { anchor:D("0"), src:"fixed(0)" };
  }
  if (mode === "smart"){
    const { anchor, note } = computeSmartAnchor(klineCloses||[]);
    return { anchor, src:`smart:${note}` };
  }
  // dynamic = MA20
  if (klineCloses && klineCloses.length >= 20){
    const ma20 = mean(klineCloses.slice(-20));
    return { anchor:q_cost3(ma20), src:"dynamic:MA20" };
  }
  return { anchor:D("0"), src:"dynamic:none" };
}

export function triggerPrice(anchor, pct){
  return q_cost3(D(anchor).mul(D("1").add(D(pct))));
}

// ==== Position / ledger ====
export function computePosition(ledgerRows){
  // ledgerRows: array of {date:'YYYY-MM-DD', delta_shares:int, delta_cash:Decimal, price:Decimal, fee_commission, fee_other, note}
  let total_shares = 0;
  let total_cash = D("0");
  let realized = D("0");
  for (const r of (ledgerRows||[])){
    const ds = Number(r.delta_shares||0);
    const dc = D(r.delta_cash||"0");
    if (ds > 0){
      total_shares += ds;
      total_cash = total_cash.add(dc);
    }else if (ds < 0){
      let sell_sh = -ds;
      sell_sh = total_shares > 0 ? Math.min(sell_sh, total_shares) : 0;
      const avg_before = total_shares > 0 ? total_cash.div(D(String(total_shares))) : D("0");
      const proceeds = dc.neg(); // positive
      realized = realized.add(proceeds.sub(avg_before.mul(D(String(sell_sh)))));
      total_shares -= sell_sh;
      total_cash = total_cash.add(dc);
    }
  }
  return { total_shares, total_cash:q_money(total_cash), realized_pnl:q_money(realized) };
}

export function buildDailySeries({code, ledgerRows, overrides, todayPriceTuple, closeMap, closeSrc}){
  // overrides: Map key `${date}|${code}` -> Decimal price
  const rows = [...(ledgerRows||[])].sort((a,b)=>String(a.date).localeCompare(String(b.date)));
  if (rows.length === 0){
    return [];
  }
  const start = rows[0].date;
  const startDate = new Date(start + "T00:00:00");
  const endDate = new Date(); // today local
  endDate.setHours(0,0,0,0);

  const byDate = new Map();
  for (const r of rows){
    const d = r.date;
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(r);
  }

  let cur = new Date(startDate);
  const oneDayMs = 24*3600*1000;
  let total_shares = 0;
  let total_cash = D("0");
  let realized = D("0");
  let last_close = null;
  let last_trade_price = null;

  const out = [];
  while (cur <= endDate){
    const ds = cur.toISOString().slice(0,10);
    let delta_shares = 0;
    let delta_cash = D("0");
    const dayRows = byDate.get(ds) || [];
    for (const r of dayRows){
      const dsh = Number(r.delta_shares||0);
      const dc = D(r.delta_cash||"0");
      if (dsh > 0){
        total_shares += dsh;
        total_cash = total_cash.add(dc);
      }else if (dsh < 0){
        let sell_sh = -dsh;
        sell_sh = total_shares > 0 ? Math.min(sell_sh, total_shares) : 0;
        const avg_before = total_shares > 0 ? total_cash.div(D(String(total_shares))) : D("0");
        const proceeds = dc.neg();
        realized = realized.add(proceeds.sub(avg_before.mul(D(String(sell_sh)))));
        total_shares -= sell_sh;
        total_cash = total_cash.add(dc);
      }
      delta_shares += dsh;
      delta_cash = delta_cash.add(dc);
    }
    if (dayRows.length){
      const tp = D(dayRows[dayRows.length-1].price||"0");
      if (tp.gt(D("0"))) last_trade_price = tp;
    }

    let latest_price = D("0");
    let price_src = "none";
    const ovKey = `${ds}|${code}`;
    const ov = overrides?.get(ovKey);
    if (ov && D(ov).gt(D("0"))){
      latest_price = D(ov);
      price_src = "override";
    }else{
      const todayIso = (new Date()).toISOString().slice(0,10);
      if (ds === todayIso && todayPriceTuple && D(todayPriceTuple.price||"0").gt(D("0"))){
        latest_price = D(todayPriceTuple.price);
        price_src = todayPriceTuple.src || "today";
      }else{
        const cm = closeMap?.get(ds);
        if (cm && D(cm).gt(D("0"))){
          latest_price = D(cm);
          price_src = closeSrc || "close";
          last_close = latest_price;
        }else if (last_close && D(last_close).gt(D("0"))){
          latest_price = D(last_close);
          price_src = "ffill(nontrade)";
        }else if (last_trade_price && D(last_trade_price).gt(D("0"))){
          latest_price = D(last_trade_price);
          price_src = "ffill(trade)";
        }else{
          latest_price = D("0");
          price_src = "none";
        }
      }
    }

    const avg_cost = total_shares > 0 ? total_cash.div(D(String(total_shares))) : D("0");
    const mv = latest_price.gt(D("0")) ? latest_price.mul(D(String(total_shares))) : D("0");
    const unreal = mv.sub(total_cash);
    const total_pnl = realized.add(unreal);
    const pnlr = !total_cash.isZero() ? total_pnl.div(total_cash) : D("0");

    out.push({
      date: ds,
      code,
      delta_shares: delta_shares,
      total_shares: total_shares,
      delta_cash: q_money(delta_cash),
      total_cash: q_money(total_cash),
      avg_cost: q_cost3(avg_cost),
      latest_price: latest_price.gt(D("0")) ? q_cost3(latest_price) : D("0"),
      market_value: q_money(mv),
      realized_pnl: q_money(realized),
      unrealized_pnl: q_money(unreal),
      total_pnl: q_money(total_pnl),
      pnl_rate: pnlr,
      price_src,
    });

    cur = new Date(cur.getTime()+oneDayMs);
  }
  return out;
}

export function buildCloseMap(klineRows, startIso, endIso){
  const mp = new Map();
  for (const r of (klineRows||[])){
    const d = String(r.day||"").slice(0,10);
    if (!d) continue;
    if (d < startIso || d > endIso) continue;
    const cl = D(r.close||"0");
    if (cl.gt(D("0"))) mp.set(d, cl);
  }
  return mp;
}
