
i
function showLoading(on, pct=0, text=""){
  const ov = document.querySelector("#loadingOverlay");
  if (!ov) return;
  if (!on){ ov.style.display="none"; return; }
  ov.style.display="flex";
  const p = Math.max(0, Math.min(1, pct));
  const pctEl = document.querySelector("#loadingPct");
  const txtEl = document.querySelector("#loadingText");
  const barEl = document.querySelector("#loadingBar");
  if (pctEl) pctEl.textContent = Math.round(p*100) + "%";
  if (txtEl) txtEl.textContent = text || "正在刷新数据...";
  if (barEl) barEl.style.width = Math.round(p*100) + "%";
}
mport { D, q_money, q_cost3, q_ratio4, floor_to_lot, LOT_SIZE, clamp, percentStr } from "./decimal_fp.js";
import { idbGet, idbSet, idbDel, ns } from "./storage.js";
import { parseCSV, toCSV } from "./csv.js";
import { fetchPriceSina, fetchPriceTencent, fetchPriceEastmoney, fetchKlineSina, fetchKlineEastmoney, fetchPremiumEastmoney, isValidCode, setProxyBase } from "./sources.js";
import {
  FeeConfig, modelConfigFromSettings, applyModeDefaults,
  parseLevels, parseTpRatios,
  computeModel, computePosition, valuationLevel, factorBrief,
  chooseAnchor, triggerPrice, buildDailySeries, buildCloseMap,
  tpRatioAdjusted, maxBuySharesForBudget, sellCashIn
} from "./model.js";
import { renderChart1, renderChart2 } from "./charts.js";

const $ = (sel)=>document.querySelector(sel);

function todayISO(){
  const d = new Date();
  d.setHours(0,0,0,0);
  return d.toISOString().slice(0,10);
}

function fmtMoney(x){ return q_money(x).toString(2); }
function fmtCost3(x){ return q_cost3(x).toString(3); }
function fmtRatio4(x){ return q_ratio4(x).toString(4); }

function tagForStatus(text){
  if (String(text).includes("✅") || String(text).includes("已进入")) return `<span class="tag ok">${esc(text)}</span>`;
  if (String(text).includes("⚠️") || String(text).includes("接近")) return `<span class="tag warn">${esc(text)}</span>`;
  if (String(text).includes("🛑") || String(text).includes("止损")) return `<span class="tag bad">${esc(text)}</span>`;
  return `<span class="tag">${esc(text)}</span>`;
}

function esc(s){
  return (s??"").toString().replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
}

// === Settings (match Python Settings.to_dict keys) ===
function defaultSettings(){
  return {
    mode: "ETF",
    fee_mode: "A",
    other_fee_rate: "0",
    other_fee_fixed: "0",
    proxy_url: "",
    max_position_value: "30000",
    available_cash: "3000",
    anchor_mode: "dynamic",
    anchor_fixed_value: "",
    use_custom_levels: false,
    custom_add_levels: "",
    custom_tp_levels: "",
    tp_base_ratios: "0.15,0.15,0.20,0.20,0.30",
    macro_override: "0.0",
    macro_strength: "中",
    market_expectation: "中性",
  };
}

function cleanSettings(obj){
  const d = defaultSettings();
  const out = { ...d };
  for (const k of Object.keys(d)){
    if (obj && obj[k] !== undefined) out[k] = obj[k];
  }
  out.use_custom_levels = !!out.use_custom_levels;
  return out;
}

function macroKFromStrength(strength){
  if (strength === "低") return D("0.10");
  if (strength === "高") return D("0.30");
  return D("0.20");
}

function biasFromExpectation(expectation, mk){
  // Python: bias_base=+/-0.35 ; bias = bias_base * (mk/0.20)
  let biasBase = D("0");
  if (expectation === "非常好(追涨)") biasBase = D("0.35");
  else if (expectation === "非常差(止损)") biasBase = D("-0.35");
  if (biasBase.isZero()) return D("0");
  return biasBase.mul(mk.div(D("0.20")));
}

const state = {
  code: "518880",
  secName: "",
  settings: defaultSettings(),
  ledger: [],
  overrides: new Map(),
  // external
  latest: { ok:false, price:D("0"), src:"none", name:"" },
  kline: { ok:false, source:"none", rows:[] },
  premium: { ok:false, source:"none", premium:null, iopv:null },
  // manual inputs (not exported into settings)
  manual: { latest_price:null, premium:null, iopv:null },
  // computed
  position: null,
  model: null,
  daily: [],
  closeMap: new Map(),
  closeSrc: "none",
};

function keyLedger(code){ return ns(code,"ledger"); }
function keySettings(code){ return ns(code,"settings"); }
function keyOverrides(code){ return ns(code,"overrides"); }
function keyCache(code, name){ return ns(code,`cache:${name}`); }

async function loadAll(){
  const [s, l, o] = await Promise.all([
    idbGet(keySettings(state.code)),
    idbGet(keyLedger(state.code)),
    idbGet(keyOverrides(state.code)),
  ]);
  state.settings = cleanSettings(s || {});
  state.ledger = Array.isArray(l) ? l : [];
  state.overrides = new Map(Array.isArray(o) ? o : []);
}

async function saveSettings(){
  await idbSet(keySettings(state.code), state.settings);
}

async function saveLedger(){
  await idbSet(keyLedger(state.code), state.ledger);
}

async function saveOverrides(){
  // stored as array entries
  await idbSet(keyOverrides(state.code), Array.from(state.overrides.entries()));
}

function parseDecimalOrNull(s){
  s = (s??"").toString().trim();
  if (!s) return null;
  try { return D(s); } catch { return null; }
}

async function fetchExternal(){
  // configure proxy prefix (optional)
  setProxyBase(state.settings.proxy_url || "");

  // 1) Latest + Name: Sina only (script/gbk) -> cache -> manual
  showLoading(true, 0.30, "读取最新价/名称（新浪）...");
  const sina = await fetchPriceSina(state.code);
  let best = sina;

  if (!best.ok){
    const cached = await idbGet(keyCache(state.code,"latest"));
    if (cached?.price){
      best = { ok:true, source:"cache", price:D(String(cached.price)), name:cached.name||"", raw:"" };
    }
  }

  if (!best.ok){
    const manualPrice = D(String(state.settings.manual_latest_price || "0"));
    state.latest = { ok:true, price:q_cost3(manualPrice), src:"manual", name: best.name || "" };
  }else{
    state.latest = { ok:true, price:q_cost3(best.price), src:best.source||"sina", name: best.name || "" };
  }
  state.secName = (best.name || state.secName || "");

  if (best.ok && best.source !== "cache"){
    await idbSet(keyCache(state.code,"latest"), { ts:Date.now(), source:best.source, price:q_cost3(best.price).toString(3), name:best.name||"" });
  }

  // 2) Kline: Sina only -> cache
  showLoading(true, 0.55, "读取K线（新浪）...");
  const klS = await fetchKlineSina(state.code, 420);
  let kl = klS;
  if (!kl.ok){
    const cachedK = await idbGet(keyCache(state.code,"kline"));
    if (cachedK?.rows?.length){
      kl = { ok:true, source:"cache", rows:cachedK.rows };
    }
  }else{
    await idbSet(keyCache(state.code,"kline"), { ts:Date.now(), source:klS.source, rows:klS.rows });
  }
  state.kline = kl;

  // 3) Premium/IOPV: AKShare (东财字段) via fetch+proxy; else manual
  showLoading(true, 0.80, "读取折溢价/IOPV（AKShare）...");
  const manualPrem = (state.settings.manual_premium!==undefined && state.settings.manual_premium!==null && String(state.settings.manual_premium)!=="")
    ? D(String(state.settings.manual_premium))
    : null;
  const manualIOPV = (state.settings.manual_iopv!==undefined && state.settings.manual_iopv!==null && String(state.settings.manual_iopv)!=="")
    ? D(String(state.settings.manual_iopv))
    : null;

  if (manualPrem!==null || manualIOPV!==null){
    let prem = manualPrem;
    let iopv = manualIOPV;
    const p = state.latest?.price ? D(String(state.latest.price)) : D("0");
    if (prem===null && iopv!==null && p.gt(D("0"))){
      prem = p.div(iopv).minus(D("1"));
    }
    if (iopv===null && prem!==null && p.gt(D("0"))){
      iopv = p.div(prem.plus(D("1")));
    }
    state.premium = { ok:true, source:"manual", premium: prem, iopv: iopv };
  }else{
    const premAuto = await fetchPremiumEastmoney(state.code); // source renamed to akshare in sources.js
    let premBest = premAuto;
    if (!premBest.ok){
      const cachedP = await idbGet(keyCache(state.code,"premium"));
      if (cachedP) premBest = { ok:true, source:"cache", premium: cachedP.premium?D(String(cachedP.premium)):null, iopv: cachedP.iopv?D(String(cachedP.iopv)):null };
    }else{
      await idbSet(keyCache(state.code,"premium"), { ts:Date.now(), source:premAuto.source, premium: premAuto.premium?premAuto.premium.toString():null, iopv: premAuto.iopv?premAuto.iopv.toString():null });
    }
    state.premium = premBest;
  }
}


function klineToSeries(klineRows){
  // Build closes/highs/lows arrays of Decimal
  const closes=[], highs=[], lows=[];
  for (const r of (klineRows||[])){
    const c = parseDecimalOrNull(r.close);
    const h = parseDecimalOrNull(r.high);
    const l = parseDecimalOrNull(r.low);
    if (!c || !h || !l) continue;
    closes.push(c);
    highs.push(h);
    lows.push(l);
  }
  return { closes, highs, lows };
}

function buildCloseMapForDaily(){
  // create close_map based on kline rows and daily range
  if (!state.ledger.length){
    state.closeMap = new Map();
    state.closeSrc = "none";
    return;
  }
  const start = state.ledger.map(r=>r.date).sort()[0];
  const end = todayISO();
  const cm = buildCloseMap(state.kline.ok? state.kline.rows : [], start, end);
  state.closeMap = cm;
  state.closeSrc = state.kline.ok ? String(state.kline.source||"kline") : "none";
}

function computeAll(){
  // ledger rows internal decimals
  const ledger = state.ledger.map(r=>({
    date: r.date,
    code: state.code,
    delta_shares: Number(r.delta_shares||0),
    delta_cash: D(r.delta_cash||"0"),
    price: D(r.trade_price||"0"),
    fee_commission: D(r.fee_commission||"0"),
    fee_other: D(r.fee_other||"0"),
    note: r.note||"",
  })).sort((a,b)=>String(a.date).localeCompare(String(b.date)));

  const fee = new FeeConfig({
    mode: state.settings.fee_mode,
    other_fee_rate: state.settings.other_fee_rate,
    other_fee_fixed: state.settings.other_fee_fixed,
  });

  const pos = computePosition(ledger);
  const total_shares = pos.total_shares;
  const total_cash = D(pos.total_cash); // already q_money
  const avg_cost = total_shares > 0 ? total_cash.div(D(String(total_shares))) : D("0");
  const mv = state.latest.ok ? state.latest.price.mul(D(String(total_shares))) : D("0");
  const unreal = mv.sub(total_cash);
  const realized = D(pos.realized_pnl);
  const total_pnl = realized.add(unreal);
  const pnl_rate = !total_cash.isZero() ? total_pnl.div(total_cash) : D("0");

  state.position = {
    total_shares,
    total_cash: q_money(total_cash),
    avg_cost: q_cost3(avg_cost),
    market_value: q_money(mv),
    realized_pnl: q_money(realized),
    unrealized_pnl: q_money(unreal),
    total_pnl: q_money(total_pnl),
    pnl_rate,
  };

  const cfg = modelConfigFromSettings(state.settings);
  // if use custom levels
  if (state.settings.use_custom_levels){
    const add = parseLevels(state.settings.custom_add_levels);
    const tp = parseLevels(state.settings.custom_tp_levels);
    if (add.length) cfg.add_levels = add;
    if (tp.length) cfg.tp_levels = tp;
  }
  // weights are already in cfg via apply defaults; keep.

  const mk = macroKFromStrength(state.settings.macro_strength);
  const moUser = parseDecimalOrNull(state.settings.macro_override) ?? D("0");
  const bias = biasFromExpectation(state.settings.market_expectation, mk);
  const moEffective = clamp(moUser.add(bias), D("-1"), D("1"));

  // premium data uses auto only; manual provided separately
  const kseries = klineToSeries(state.kline.ok ? state.kline.rows : []);
  const premAuto = state.premium.ok ? state.premium.premium : null;
  const iopvAuto = state.premium.ok ? state.premium.iopv : null;

  const model = computeModel({
    cfg,
    mode: state.settings.mode,
    latest_price: state.latest.ok ? state.latest.price : D("0"),
    current_shares: total_shares,
    max_position_value: D(state.settings.max_position_value),
    available_cash: D(state.settings.available_cash),
    fee,
    premium_data: { source: state.premium.source || "none", premium: premAuto, iopv: iopvAuto, kline: { ok: state.kline.ok, source: state.kline.source || "none", ...kseries } },
    manual_premium: state.manual.premium,
    manual_iopv: state.manual.iopv,
    macro_override: moEffective,
    macro_k: mk,
  });
  state.model = model;

  buildCloseMapForDaily();
  // daily series
  const daily = buildDailySeries({
    code: state.code,
    ledgerRows: ledger,
    overrides: state.overrides,
    todayPriceTuple: { price: state.latest.ok? state.latest.price : D("0"), src: state.latest.src },
    closeMap: state.closeMap,
    closeSrc: state.closeSrc,
  });
  state.daily = daily;
}

function renderTop(){
  $("#secName").textContent = state.secName ? `${state.code} · ${state.secName}` : state.code;
  $("#latestPrice").textContent = state.latest.ok ? fmtCost3(state.latest.price) : "—";
  $("#latestSrc").textContent = state.latest.ok ? state.latest.src : "手动输入/离线";
  const st = [];
  st.push(`name:${state.secName? "✅" : "⚠️"}`);
  st.push(`price:${state.latest.ok? "✅":"⚠️"}(${state.latest.src})`);
  st.push(`kline:${state.kline.ok? "✅":"⚠️"}(${state.kline.source||"none"})`);
  st.push(`premium:${(state.model?.ok_premium)? "✅":"⚠️"}(${state.model?.premium_source||"none"})`);
  $("#dataStatus").textContent = st.join("  ");
}

function renderSummary(){
  const pos = state.position || {};
  const mo = state.model || {};
  const kv = [
    ["持仓股数", String(pos.total_shares ?? 0)],
    ["含费均价(3)", pos.avg_cost ? fmtCost3(pos.avg_cost) : "0.000"],
    ["累计净投入", pos.total_cash ? fmtMoney(pos.total_cash) : "0.00"],
    ["当前市值", pos.market_value ? fmtMoney(pos.market_value) : "0.00"],
    ["已实现收益", pos.realized_pnl ? fmtMoney(pos.realized_pnl) : "0.00"],
    ["未实现收益", pos.unrealized_pnl ? fmtMoney(pos.unrealized_pnl) : "0.00"],
    ["总收益", pos.total_pnl ? fmtMoney(pos.total_pnl) : "0.00"],
    ["总收益率", pos.pnl_rate ? percentStr(pos.pnl_rate,2) : "0.00%"],
    ["估值等级", mo.cheapness ? valuationLevel(mo.cheapness) : "-"],
    ["目标仓位比例", mo.target_ratio ? percentStr(mo.target_ratio,2) : "-"],
    ["目标股数", mo.target_shares!=null ? String(mo.target_shares) : "-"],
    ["建议调整股数", mo.delta_shares!=null ? String(mo.delta_shares) : "-"],
    ["建议买入股数", mo.buy_shares!=null ? String(mo.buy_shares) : "-"],
    ["预计扣款(含费)", mo.buy_cash ? fmtMoney(mo.buy_cash) : "0.00"],
    ["建议卖出股数", mo.sell_shares!=null ? String(mo.sell_shares) : "-"],
    ["预计到账(含费)", mo.sell_cash_in ? fmtMoney(mo.sell_cash_in) : "0.00"],
    ["因子简述", mo.factors ? factorBrief(mo.factors) : "-"],
    ["buy_scale / sell_scale", mo.buy_scale? `${fmtRatio4(mo.buy_scale)} / ${fmtRatio4(mo.sell_scale)}` : "-"],
  ];
  const wrap = $("#summaryKV");
  wrap.innerHTML = kv.map(([k,v])=>`<div class="kv"><div class="kv-k">${esc(k)}</div><div class="kv-v mono">${esc(v)}</div></div>`).join("");

  // sync form inputs from settings
  $("#macroOverride").value = String(state.settings.macro_override ?? "0.0");
  $("#macroStrength").value = String(state.settings.macro_strength ?? "中");
  $("#marketExpectation").value = String(state.settings.market_expectation ?? "中性");
  $("#modeSelect").value = String(state.settings.mode ?? "ETF");
  $("#feeMode").value = String(state.settings.fee_mode ?? "A");
  $("#otherFeeRate").value = String(state.settings.other_fee_rate ?? "0");
  $("#otherFeeFixed").value = String(state.settings.other_fee_fixed ?? "0");
  $("#proxyUrl").value = String(state.settings.proxy_url ?? "");
  $("#maxPosValue").value = String(state.settings.max_position_value ?? "30000");
  $("#availCash").value = String(state.settings.available_cash ?? "3000");

  // manual fields
  $("#manualLatestPrice").value = state.manual.latest_price ? state.manual.latest_price.toString(3) : "";
  $("#manualPremium").value = state.manual.premium ? state.manual.premium.toString(4) : "";
  $("#manualIOPV").value = state.manual.iopv ? state.manual.iopv.toString(3) : "";
}

function renderFactors(){
  const mo = state.model || {};
  $("#factorHint").textContent = mo.reason || "-";
  const tbody = $("#factorTable tbody");
  tbody.innerHTML = "";
  for (const fr of (mo.factors||[])){
    const ok = fr.ok ? "✅" : "⚠️";
    const raw = fr.raw==null ? "-" : (fr.name.includes("折溢价") ? D(fr.raw).toString(4) : D(fr.raw).toString(4));
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${esc(fr.name)}</td>
      <td class="mono">${ok}</td>
      <td class="mono">${esc(fr.source||"-")}</td>
      <td class="mono">${esc(raw)}</td>
      <td class="mono">${esc(D(fr.score).toString(4))}</td>
      <td class="mono">${esc(D(fr.weight).toString(4))}</td>
      <td class="mono">${esc(q_ratio4(fr.contribution).toString(4))}</td>
      <td>${esc(fr.note||"")}</td>
    `;
    tbody.appendChild(tr);
  }
}


function renderOrders(){
  const mo = state.model || {};
  const kseries = klineToSeries(state.kline.ok? state.kline.rows : []);
  const anchorMode = state.settings.anchor_mode || "dynamic";
  const anchorFixed = state.settings.anchor_fixed_value || "";
  const { anchor, src } = chooseAnchor(anchorMode, anchorFixed, kseries.closes);
  $("#anchorValue").textContent = anchor.gt(D("0")) ? fmtCost3(anchor) : "—";
  $("#anchorSrc").textContent = src;

  $("#anchorMode").value = anchorMode;
  $("#anchorFixed").value = anchorFixed;
  $("#useCustomLevels").value = state.settings.use_custom_levels ? "true" : "false";
  $("#addLevels").value = state.settings.custom_add_levels || "";
  $("#tpLevels").value = state.settings.custom_tp_levels || "";
  $("#tpBaseRatios").value = state.settings.tp_base_ratios || "0.15,0.15,0.20,0.20,0.30";

  const fee = new FeeConfig({
    mode: state.settings.fee_mode,
    other_fee_rate: state.settings.other_fee_rate,
    other_fee_fixed: state.settings.other_fee_fixed,
  });

  const latest = state.latest.ok ? state.latest.price : D("0");
  const total_shares = state.position?.total_shares ?? 0;
  const expect = state.settings.market_expectation || "中性";
  const strength = state.settings.macro_strength || "中";

  // Determine levels (match Python apply_mode_defaults + custom overrides)
  const cfg = modelConfigFromSettings(state.settings);
  if (state.settings.use_custom_levels){
    const add = parseLevels(state.settings.custom_add_levels);
    const tp = parseLevels(state.settings.custom_tp_levels);
    if (add.length) cfg.add_levels = add;
    if (tp.length) cfg.tp_levels = tp;
  }
  const add_levels = cfg.add_levels;
  const tp_levels  = cfg.tp_levels;

  const max_pos_value = D(state.settings.max_position_value);
  const target_ratio = mo.target_ratio ? D(mo.target_ratio) : D("0");
  const buy_scale = mo.buy_scale ? D(mo.buy_scale) : D("1");
  const sell_scale = mo.sell_scale ? D(mo.sell_scale) : D("1");

  function targetSharesAt(px){
    px = D(px);
    if (px.lte(D("0"))) return 0;
    const target_value = max_pos_value.mul(target_ratio);
    const raw = target_value.div(px).toIntTrunc(); // Python int()
    return floor_to_lot(raw);
  }

  function trigStateAdd(trig){
    if (latest.lte(D("0")) || trig.lte(D("0"))) return "⏳ 未触发";
    if (latest.lte(trig)) return "✅ 已进入加仓区间";
    const gap = latest.sub(trig).div(latest);
    if (gap.lte(D("0.005"))) return "⚠️ 接近触发";
    return "⏳ 未触发";
  }
  function trigStateTp(trig){
    if (latest.lte(D("0")) || trig.lte(D("0"))) return "⏳ 未触发";
    if (latest.gte(trig)) return "✅ 已进入止盈区间";
    const gap = trig.sub(latest).div(latest);
    if (gap.lte(D("0.005"))) return "⚠️ 接近触发";
    return "⏳ 未触发";
  }
  function trigStateStop(trig){
    if (latest.lte(D("0")) || trig.lte(D("0"))) return "⏳ 未触发";
    if (latest.lte(trig)) return "🛑 已进入止损区间";
    const gap = latest.sub(trig).div(latest);
    if (gap.lte(D("0.005"))) return "⚠️ 接近触发";
    return "⏳ 未触发";
  }

  // ---- Add table (match Python) ----
  const addRows = [];
  if (expect === "非常好(追涨)" && latest.gt(D("0"))){
    const chase_pct = D("0.02");
    const trig = triggerPrice(anchor, chase_pct);
    let buy_sh = maxBuySharesForBudget(trig, D(state.settings.available_cash).mul(buy_scale), fee).shares;
    buy_sh = floor_to_lot(Math.floor(buy_sh * 0.15));
    const est_cash = buy_sh>0 ? fee.cashflow("BUY", trig, buy_sh).delta_cash : D("0");
    const stateStr = (latest.gte(trig) ? "✅ 已进入追涨区间" : (trig.sub(latest).div(latest).lte(D("0.005")) ? "⚠️ 接近触发" : "⏳ 未触发"));
    addRows.push({
      pct: `追涨 +${chase_pct.mul(D("100")).toString(1)}%`,
      trig,
      buy_shares: buy_sh,
      est_cash,
      state: stateStr,
      note: buy_sh>0 ? `追涨(资金×buy_scale×0.15)` : "资金不足",
    });
  }

  let remaining_cash = D(state.settings.available_cash);
  let prev_target = total_shares;
  for (let i=0;i<add_levels.length;i++){
    const pct = add_levels[i];
    const trig = triggerPrice(anchor, pct);
    const tgt = targetSharesAt(trig);
    const need = Math.max(0, tgt - prev_target);

    // scaled_need = ROUND_HALF_UP(need * buy_scale) then floor_to_lot
    let needScaled = 0;
    if (need > 0){
      const scaled = D(String(need)).mul(buy_scale).quantize(D("1"), "half_up"); // integer
      needScaled = floor_to_lot(Number(scaled.toString(0)));
    }
    let buy_sh = needScaled;
    let est_cash = D("0");
    if (buy_sh > 0 && remaining_cash.gt(D("0"))){
      const cap = maxBuySharesForBudget(trig, remaining_cash, fee);
      buy_sh = Math.min(buy_sh, cap.shares);
      buy_sh = floor_to_lot(buy_sh);
      est_cash = buy_sh>0 ? fee.cashflow("BUY", trig, buy_sh).delta_cash : D("0");
      remaining_cash = remaining_cash.sub(est_cash);
    }else{
      buy_sh = 0;
    }
    const stateStr = trigStateAdd(trig);
    addRows.push({
      pct: `${pct.mul(D("100")).toString(2)}%`,
      trig,
      buy_shares: buy_sh,
      est_cash,
      state: stateStr,
      note: `target=${tgt}, need=${need}, scaled_need=${needScaled}`,
    });
    prev_target = tgt;
  }

  const addTbody = $("#addTable tbody");
  addTbody.innerHTML = "";
  for (const r of addRows){
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="mono">${esc(r.pct)}</td>
      <td class="mono">${esc(fmtCost3(r.trig))}</td>
      <td class="mono">${esc(String(r.buy_shares))}</td>
      <td class="mono">${esc(fmtMoney(r.est_cash))}</td>
      <td>${tagForStatus(r.state)}</td>
    `;
    addTbody.appendChild(tr);
  }

  // ---- TP table (match Python) ----
  const tpRows = [];
  let remaining_shares = total_shares;

  if (expect === "非常差(止损)" && latest.gt(D("0"))){
    let stop_pct = D("-0.08");
    let keep_ratio = D("0.5");
    if (strength === "低"){ stop_pct = D("-0.06"); keep_ratio = D("0.7"); }
    else if (strength === "高"){ stop_pct = D("-0.10"); keep_ratio = D("0.3"); }
    const trig = triggerPrice(anchor, stop_pct);
    let sell_sh = floor_to_lot(Math.floor(total_shares * (1 - keep_ratio.toNumber())));
    sell_sh = Math.min(sell_sh, remaining_shares);
    const est_cash_in = sell_sh>0 ? sellCashIn(trig, sell_sh, fee) : D("0");
    const stateStr = trigStateStop(trig);
    tpRows.push({
      pct: `止损 ${stop_pct.mul(D("100")).toString(1)}%`,
      trig,
      sell_shares: sell_sh,
      est_cash_in,
      state: stateStr,
      note: sell_sh>0 ? `保留约 ${(keep_ratio.mul(D("100")).toString(0))}% 仓位` : "仓位不足",
    });
    remaining_shares -= sell_sh;
  }

  const tp_base_ratios = parseTpRatios(state.settings.tp_base_ratios);
  for (let i=0;i<tp_levels.length;i++){
    const pct = tp_levels[i];
    const trig = triggerPrice(anchor, pct);
    let ratio = tp_base_ratios[i] ?? tp_base_ratios[tp_base_ratios.length-1] ?? D("0.2");
    ratio = tpRatioAdjusted(ratio, i, strength);
    let ratioAdj = clamp(ratio.mul(sell_scale), D("0"), D("1"));

    const sell_raw = floor_to_lot(Math.floor(total_shares * ratioAdj.toNumber()));
    const statusErr = sell_raw > remaining_shares;
    const sell_sh = Math.min(sell_raw, remaining_shares);
    const est_cash_in = sell_sh>0 ? sellCashIn(trig, sell_sh, fee) : D("0");
    const stateStr = trigStateTp(trig);
    let note = `ratio_base=${ratio.toString(3)}, sell_scale=${sell_scale.toString(3)}`;
    let extra = "";
    if (sell_raw <= 0) extra = "仓位不足";
    else if (statusErr) extra = "超出剩余仓位";
    tpRows.push({
      pct: `${pct.mul(D("100")).toString(2)}%`,
      trig,
      sell_shares: sell_sh,
      est_cash_in,
      state: stateStr,
      note: extra || note,
      bad: extra ? true : false,
    });
    remaining_shares -= sell_sh;
  }

  const tpTbody = $("#tpTable tbody");
  tpTbody.innerHTML = "";
  for (const r of tpRows){
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="mono">${esc(r.pct)}</td>
      <td class="mono">${esc(fmtCost3(r.trig))}</td>
      <td class="mono">${esc(String(r.sell_shares))}</td>
      <td class="mono">${esc(fmtMoney(r.est_cash_in))}</td>
      <td>${r.bad? `<span class="tag bad">${esc(r.note)}</span>` : tagForStatus(r.state)}</td>
    `;
    tpTbody.appendChild(tr);
  }
}


function renderLedger(){
  const tbody = $("#ledgerTable tbody");
  tbody.innerHTML = "";
  const rows = [...state.ledger].sort((a,b)=>String(b.date).localeCompare(String(a.date)));
  for (let idx=0; idx<rows.length; idx++){
    const r = rows[idx];
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="mono">${esc(r.date)}</td>
      <td class="mono">${esc(String(r.delta_shares))}</td>
      <td class="mono">${esc(String(r.delta_cash))}</td>
      <td class="mono">${esc(String(r.trade_price))}</td>
      <td class="mono">${esc(String(r.fee_commission||"0"))}</td>
      <td class="mono">${esc(String(r.fee_other||"0"))}</td>
      <td>${esc(r.note||"")}</td>
      <td><button class="btn danger" data-del="${idx}">删</button></td>
    `;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll("button[data-del]").forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const idx = Number(btn.getAttribute("data-del"));
      // delete by index in sorted view: map to actual by identity
      const toDelete = rows[idx];
      const j = state.ledger.findIndex(x=> x.date===toDelete.date && String(x.delta_shares)===String(toDelete.delta_shares) && String(x.delta_cash)===String(toDelete.delta_cash) && String(x.trade_price)===String(toDelete.trade_price) && (x.note||"")===(toDelete.note||""));
      if (j>=0){
        state.ledger.splice(j,1);
        await saveLedger();
        await refreshAndRender();
      }
    });
  });
}

function renderDailyTable(){
  const table = $("#dailyTable");
  const thead = table.querySelector("thead");
  const tbody = table.querySelector("tbody");
  const header = ["date","delta_shares","total_shares","delta_cash","total_cash","avg_cost","latest_price","price_src","market_value","realized_pnl","unrealized_pnl","total_pnl","pnl_rate"];
  thead.innerHTML = `<tr>${header.map(h=>`<th>${esc(h)}</th>`).join("")}</tr>`;
  tbody.innerHTML = "";
  const rows = state.daily.slice(-240).reverse(); // show latest 240
  for (const r of rows){
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="mono">${esc(r.date)}</td>
      <td class="mono">${esc(String(r.delta_shares))}</td>
      <td class="mono">${esc(String(r.total_shares))}</td>
      <td class="mono">${esc(String(r.delta_cash.toString(2)))}</td>
      <td class="mono">${esc(String(r.total_cash.toString(2)))}</td>
      <td class="mono">${esc(String(r.avg_cost.toString(3)))}</td>
      <td class="mono">${esc(r.latest_price.gt(D("0"))? r.latest_price.toString(3) : "0")}</td>
      <td class="mono">${esc(r.price_src)}</td>
      <td class="mono">${esc(String(r.market_value.toString(2)))}</td>
      <td class="mono">${esc(String(r.realized_pnl.toString(2)))}</td>
      <td class="mono">${esc(String(r.unrealized_pnl.toString(2)))}</td>
      <td class="mono">${esc(String(r.total_pnl.toString(2)))}</td>
      <td class="mono">${esc(percentStr(r.pnl_rate,2))}</td>
    `;
    tbody.appendChild(tr);
  }
}

function renderCharts(){
  const range = Number($("#chartRange").value || 240);
  const rows = range >= 99999 ? state.daily : state.daily.slice(-range);
  renderChart1($("#chart1"), rows);
  renderChart2($("#chart2"), rows);
}

async function refreshAndRender(){
  computeAll();
  renderTop();
  renderSummary();
  renderFactors();
  renderOrders();
  renderLedger();
  renderDailyTable();
  renderCharts();
}

async function fullRefresh(){
  showLoading(true, 0.02, "读取本地数据...");
  try{
    await loadAll();
    showLoading(true, 0.25, "读取最新价/名称（新浪）...");
    await fetchExternal();
    showLoading(true, 0.95, "渲染界面...");
    await refreshAndRender();
  }finally{
    showLoading(false);
  }
}
// === Export helpers ===
function downloadFile(filename, text, mime="text/plain"){
  const blob = new Blob([text], { type:mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 0);
}

function exportLedgerCSV(){
  const header = ["date","code","delta_shares","delta_cash","trade_price","fee_commission","fee_other","note"];
  const rows = state.ledger.map(r=>({
    date:r.date, code:state.code,
    delta_shares:String(r.delta_shares),
    delta_cash:String(r.delta_cash),
    trade_price:String(r.trade_price),
    fee_commission:String(r.fee_commission||"0"),
    fee_other:String(r.fee_other||"0"),
    note:String(r.note||""),
  })).sort((a,b)=>a.date.localeCompare(b.date));
  downloadFile(`ledger_${state.code}.csv`, toCSV(header, rows), "text/csv");
}

function exportOverridesCSV(){
  const header = ["date","code","latest_price"];
  const rows = Array.from(state.overrides.entries()).map(([k,v])=>{
    const [date, code] = k.split("|");
    return { date, code, latest_price: D(v).toString(3) };
  }).sort((a,b)=>a.date.localeCompare(b.date));
  downloadFile(`price_overrides_${state.code}.csv`, toCSV(header, rows), "text/csv");
}

function exportSettingsJSON(){
  downloadFile(`settings_${state.code}.json`, JSON.stringify(state.settings, null, 2), "application/json");
}

function exportDailyCSV(){
  const header = ["date","delta_shares","total_shares","delta_cash","total_cash","avg_cost","latest_price","price_src","market_value","realized_pnl","unrealized_pnl","total_pnl","pnl_rate"];
  const rows = state.daily.map(r=>({
    date:r.date,
    delta_shares:String(r.delta_shares),
    total_shares:String(r.total_shares),
    delta_cash:r.delta_cash.toString(2),
    total_cash:r.total_cash.toString(2),
    avg_cost:r.avg_cost.toString(3),
    latest_price:r.latest_price.gt(D("0"))? r.latest_price.toString(3):"0",
    price_src:r.price_src,
    market_value:r.market_value.toString(2),
    realized_pnl:r.realized_pnl.toString(2),
    unrealized_pnl:r.unrealized_pnl.toString(2),
    total_pnl:r.total_pnl.toString(2),
    pnl_rate: D(r.pnl_rate).toString(6),
  }));
  downloadFile(`${state.code}_daily_series.csv`, toCSV(header, rows), "text/csv");
}

function exportExcelXml(){
  // SpreadsheetML 2003 (Excel compatible), 2 sheets: ledger + <code>
  const ledgerHeader = ["date","code","delta_shares","delta_cash","trade_price","fee_commission","fee_other","note"];
  const ledgerRows = state.ledger.map(r=>[
    r.date, state.code, String(r.delta_shares), String(r.delta_cash), String(r.trade_price), String(r.fee_commission||"0"), String(r.fee_other||"0"), String(r.note||"")
  ]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])));

  const dailyHeader = ["date","delta_shares","total_shares","delta_cash","total_cash","avg_cost","latest_price","price_src","market_value","realized_pnl","unrealized_pnl","total_pnl","pnl_rate"];
  const dailyRows = state.daily.map(r=>[
    r.date, String(r.delta_shares), String(r.total_shares),
    r.delta_cash.toString(2), r.total_cash.toString(2), r.avg_cost.toString(3),
    r.latest_price.gt(D("0"))? r.latest_price.toString(3):"0", r.price_src,
    r.market_value.toString(2), r.realized_pnl.toString(2), r.unrealized_pnl.toString(2), r.total_pnl.toString(2),
    D(r.pnl_rate).toString(6)
  ]);

  function xmlEsc(s){
    return (s??"").toString()
      .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")
      .replaceAll('"',"&quot;").replaceAll("'","&apos;");
  }
  function sheetXml(name, header, rows){
    const cols = header.map(h=>`<Cell><Data ss:Type="String">${xmlEsc(h)}</Data></Cell>`).join("");
    const headRow = `<Row>${cols}</Row>`;
    const body = rows.map(r=>{
      const cells = r.map(v=>`<Cell><Data ss:Type="String">${xmlEsc(v)}</Data></Cell>`).join("");
      return `<Row>${cells}</Row>`;
    }).join("");
    return `
      <Worksheet ss:Name="${xmlEsc(name)}">
        <Table>
          ${headRow}
          ${body}
        </Table>
      </Worksheet>
    `;
  }

  const xml = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:html="http://www.w3.org/TR/REC-html40">
${sheetXml("ledger", ledgerHeader, ledgerRows)}
${sheetXml(state.code, dailyHeader, dailyRows)}
</Workbook>`;
  downloadFile(`${state.code}_export.xml`, xml, "application/xml");
}

function exportBundle(){
  // JSON bundle that can restore same per-code namespace
  const bundle = {
    kind: "trading_pwa_bundle_v1",
    code: state.code,
    settings: state.settings,
    ledger: state.ledger,
    overrides: Array.from(state.overrides.entries()).map(([k,v])=>[k, D(v).toString(18)]),
  };
  downloadFile(`bundle_${state.code}.json`, JSON.stringify(bundle, null, 2), "application/json");
}

async function importAnyFile(file){
  const name = file.name.toLowerCase();
  const text = await file.text();
  if (name.endsWith(".json")){
    const j = JSON.parse(text);
    if (j?.kind === "trading_pwa_bundle_v1" && j?.code){
      state.code = String(j.code);
      state.settings = cleanSettings(j.settings || {});
      state.ledger = Array.isArray(j.ledger) ? j.ledger : [];
      state.overrides = new Map(Array.isArray(j.overrides) ? j.overrides : []);
      await saveSettings(); await saveLedger(); await saveOverrides();
      await fullRefresh();
      return;
    }else{
      // assume settings_<code>.json
      state.settings = cleanSettings(j||{});
      await saveSettings();
      await fullRefresh();
      return;
    }
  }
  if (name.endsWith(".csv")){
    const parsed = parseCSV(text);
    const header = parsed.header.map(h=>h.toLowerCase());
    if (header.includes("latest_price")){
      // overrides
      const m = new Map();
      for (const r of parsed.data){
        const date = (r.date||r.DATE||r["date"]||"").slice(0,10);
        const code = (r.code||r.CODE||state.code).toString().trim() || state.code;
        const lp = parseDecimalOrNull(r.latest_price||r.LATEST_PRICE||"");
        if (date && lp && lp.gt(D("0"))){
          m.set(`${date}|${code}`, lp.toString(18));
        }
      }
      // merge into current code only
      for (const [k,v] of m.entries()){
        if (k.endsWith("|"+state.code)) state.overrides.set(k, v);
      }
      await saveOverrides();
      await fullRefresh();
      return;
    }
    // ledger
    const rows = [];
    for (const r of parsed.data){
      const date = (r.date||r.DATE||"").slice(0,10);
      const code = (r.code||r.CODE||state.code).toString().trim() || state.code;
      if (code !== state.code) continue;
      const ds = Number((r.delta_shares||r.DELTA_SHARES||"0").toString().trim()||0);
      const dc = (r.delta_cash||r.DELTA_CASH||"0").toString().trim() || "0";
      const tp = (r.trade_price||r.TRADE_PRICE||r.price||r.PRICE||"0").toString().trim() || "0";
      const fc = (r.fee_commission||r.FEE_COMMISSION||"0").toString().trim() || "0";
      const fo = (r.fee_other||r.FEE_OTHER||"0").toString().trim() || "0";
      const note = (r.note||r.NOTE||"").toString();
      if (!date) continue;
      rows.push({ date, delta_shares: ds, delta_cash: dc, trade_price: tp, fee_commission: fc, fee_other: fo, note });
    }
    state.ledger = rows;
    await saveLedger();
    await fullRefresh();
    return;
  }
  alert("不支持的文件类型（请导入 csv/json）。");
}

// === UI wiring ===
function setupTabs(){
  document.querySelectorAll(".tab").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      document.querySelectorAll(".tab").forEach(b=>b.classList.remove("active"));
      document.querySelectorAll(".pane").forEach(p=>p.classList.remove("active"));
      btn.classList.add("active");
      $("#pane-"+btn.dataset.tab).classList.add("active");
      // re-render tables to fix sticky headers after tab show
      renderCharts();
    });
  });
}

function parseCodeFromUrl(){
  const u = new URL(location.href);
  const c = u.searchParams.get("code");
  if (c && isValidCode(c)) return c;
  return null;
}
function setUrlCode(code){
  const u = new URL(location.href);
  u.searchParams.set("code", code);
  history.replaceState(null, "", u.toString());
}

async function init(){
  setupTabs();

  const c = parseCodeFromUrl();
  if (c) state.code = c;

  $("#codeInput").value = state.code;

  $("#codeGoBtn").addEventListener("click", async ()=>{
    const v = ($("#codeInput").value||"").trim();
    if (!isValidCode(v)){
      alert("请输入6位数字 code，例如 518880");
      return;
    }
    state.code = v;
    state.manual = { latest_price:null, premium:null, iopv:null };
    setUrlCode(v);
    await fullRefresh();
  });

  $("#refreshBtn").addEventListener("click", async ()=>{
    await fullRefresh();
  });

  $("#applyManualBtn").addEventListener("click", async ()=>{
    const mp = parseDecimalOrNull($("#manualLatestPrice").value);
    const pr = parseDecimalOrNull($("#manualPremium").value);
    const io = parseDecimalOrNull($("#manualIOPV").value);
    state.manual.latest_price = (mp && mp.gt(D("0"))) ? mp : null;
    // normalize premium if user typed percent-like >1
    if (pr && pr.abs().gt(D("1"))) state.manual.premium = pr.div(D("100"));
    else state.manual.premium = (pr && pr.abs().lt(D("1")))? pr : null;
    state.manual.iopv = (io && io.gt(D("0"))) ? io : null;
    await fullRefresh();
  });

  $("#saveSettingsBtn").addEventListener("click", async ()=>{
    state.settings.macro_override = ($("#macroOverride").value||"0").trim();
    state.settings.macro_strength = $("#macroStrength").value;
    state.settings.market_expectation = $("#marketExpectation").value;
    state.settings.mode = $("#modeSelect").value;
    state.settings.fee_mode = $("#feeMode").value;
    state.settings.other_fee_rate = ($("#otherFeeRate").value||"0").trim();
    state.settings.other_fee_fixed = ($("#otherFeeFixed").value||"0").trim();
    state.settings.proxy_url = ($("#proxyUrl").value||"").trim();
    state.settings.max_position_value = ($("#maxPosValue").value||"0").trim();
    state.settings.available_cash = ($("#availCash").value||"0").trim();
    await saveSettings();
    await fullRefresh();
  });

  $("#saveOrdersSettingsBtn").addEventListener("click", async ()=>{
    state.settings.anchor_mode = $("#anchorMode").value;
    state.settings.anchor_fixed_value = ($("#anchorFixed").value||"").trim();
    state.settings.use_custom_levels = $("#useCustomLevels").value === "true";
    state.settings.custom_add_levels = ($("#addLevels").value||"").trim();
    state.settings.custom_tp_levels = ($("#tpLevels").value||"").trim();
    state.settings.tp_base_ratios = ($("#tpBaseRatios").value||"").trim();
    await saveSettings();
    await fullRefresh();
  });

  $("#chartRange").addEventListener("change", ()=>{
    renderCharts();
  });

  // overrides
  $("#setOverrideBtn").addEventListener("click", async ()=>{
    const d = $("#overrideDate").value || todayISO();
    const p = parseDecimalOrNull($("#overridePrice").value);
    if (!p || p.lte(D("0"))){ alert("请输入有效价格"); return; }
    state.overrides.set(`${d}|${state.code}`, p.toString(18));
    await saveOverrides();
    await fullRefresh();
  });
  $("#clearOverrideBtn").addEventListener("click", async ()=>{
    const d = $("#overrideDate").value || todayISO();
    state.overrides.delete(`${d}|${state.code}`);
    await saveOverrides();
    await fullRefresh();
  });

  // entry calc and add
  $("#calcCashBtn").addEventListener("click", ()=>{
    calcTradeCashPreview();
  });
  $("#addTradeBtn").addEventListener("click", async ()=>{
    const rec = calcTradeCashPreview();
    if (!rec) return;
    state.ledger.push(rec);
    await saveLedger();
    await fullRefresh();
    // reset
    $("#tradeShares").value = "";
    $("#tradePrice").value = "";
    $("#tradeNote").value = "";
  });

  function calcTradeCashPreview(){
    const date = ($("#tradeDate").value || todayISO()).slice(0,10);
    const side = $("#tradeSide").value;
    let shares = Number(($("#tradeShares").value||"0").trim()||0);
    shares = Math.abs(Math.trunc(shares));
    shares = floor_to_lot(shares);
    if (shares <= 0){ alert("shares 需>=100且整百"); return null; }
    const price = parseDecimalOrNull($("#tradePrice").value);
    if (!price || price.lte(D("0"))){ alert("请输入有效 trade_price"); return null; }

    const fee = new FeeConfig({
      mode: state.settings.fee_mode,
      other_fee_rate: state.settings.other_fee_rate,
      other_fee_fixed: state.settings.other_fee_fixed,
    });
    const { delta_cash, commission, other_fee } = fee.cashflow(side, price, shares);
    const ds = side === "BUY" ? shares : -shares;
    const avgFill = delta_cash.abs().div(D(String(shares)));

    $("#calcDeltaCash").textContent = delta_cash.toString(2);
    $("#calcCommission").textContent = commission.toString(2);
    $("#calcOtherFee").textContent = other_fee.toString(2);
    $("#calcAvgFill").textContent = q_cost3(avgFill).toString(3);
    $("#calcDeltaCashNote").textContent = side === "BUY" ? "买入=成交额+佣金+其他费" : "卖出=-(成交额-佣金-其他费)";

    return {
      date,
      delta_shares: ds,
      delta_cash: delta_cash.toString(2),
      trade_price: q_cost3(price).toString(3),
      fee_commission: commission.toString(2),
      fee_other: other_fee.toString(2),
      note: ($("#tradeNote").value||"").toString(),
    };
  }

  // export buttons
  $("#exportLedgerBtn").addEventListener("click", exportLedgerCSV);
  $("#exportSettingsBtn").addEventListener("click", exportSettingsJSON);
  $("#exportOverridesBtn").addEventListener("click", exportOverridesCSV);
  $("#exportDailyCsvBtn").addEventListener("click", exportDailyCSV);
  $("#exportExcelXmlBtn").addEventListener("click", exportExcelXml);
  $("#exportBundleBtn").addEventListener("click", exportBundle);

  $("#importFile").addEventListener("change", async (e)=>{
    const file = e.target.files?.[0];
    if (!file) return;
    await importAnyFile(file);
    e.target.value = "";
  });

  // register SW
  if ("serviceWorker" in navigator){
    try{
      await navigator.serviceWorker.register("./sw.js");
    }catch(e){
      console.warn("SW failed", e);
    }
  }

  // initial
  setUrlCode(state.code);
  await fullRefresh();
}

init();
