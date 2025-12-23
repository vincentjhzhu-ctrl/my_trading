
import { D, q_cost3 } from "./decimal_fp.js";


// --- Network helpers: timeout + retry + proxy fallback (for GitHub Pages/CORS instability) ---
const ALLORIGINS = "https://api.allorigins.win/raw?url=";
let PROXY_BASE = ALLORIGINS;

// Allow user-provided proxy prefix, e.g. https://your-worker.workers.dev/?url=
export function setProxyBase(prefix){
  const v = (prefix||"").toString().trim();
  PROXY_BASE = v ? v : ALLORIGINS;
}

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

async function fetchWithTimeout(url, { timeoutMs=8000, headers=null } = {}){
  const ac = new AbortController();
  const t = setTimeout(()=>ac.abort(), timeoutMs);
  try{
    const r = await fetch(url, { cache:"no-store", headers: headers||undefined, signal: ac.signal });
    return r;
  }finally{
    clearTimeout(t);
  }
}

async function fetchTextSmart(url, { timeoutMs=8000, tries=2 } = {}){
  // direct -> proxy, with small retry/backoff. returns {ok, text, via, err}
  const attempts = [];
  for (let i=0;i<tries;i++){
    try{
      const r = await fetchWithTimeout(url, { timeoutMs });
      if (!r.ok) throw new Error("http "+r.status);
      const text = await r.text();
      return { ok:true, text, via:"direct" };
    }catch(e){
      attempts.push(String(e));
      await sleep(150*(i+1));
    }
  }
  // proxy fallback
  const purl = PROXY_BASE + encodeURIComponent(url);
  for (let i=0;i<tries;i++){
    try{
      const r = await fetchWithTimeout(purl, { timeoutMs: timeoutMs+2000 });
      if (!r.ok) throw new Error("proxy http "+r.status);
      const text = await r.text();
      return { ok:true, text, via:"proxy" };
    }catch(e){
      attempts.push(String(e));
      await sleep(180*(i+1));
    }
  }
  return { ok:false, text:"", via:"", err: attempts.join(" | ") };
}

async function fetchJsonSmart(url, opts={}){
  const t = await fetchTextSmart(url, opts);
  if (!t.ok) return { ok:false, data:null, via:t.via, err:t.err };
  try{
    return { ok:true, data: JSON.parse(t.text), via:t.via };
  }catch(e){
    return { ok:false, data:null, via:t.via, err:"json parse: "+String(e) };
  }
}

function parseJsonpPayload(text){
  // find first (...) block and JSON.parse it
  const m = String(text||"").match(/\((\{[\s\S]*\}|\[[\s\S]*\])\)\s*;?\s*$/);
  if (!m) return null;
  try{ return JSON.parse(m[1]); }catch(_){ return null; }
}
// --- End network helpers ---
export function isValidCode(code){
  code = (code||"").trim();
  return code.length === 6 && /^\d{6}$/.test(code);
}

export function marketPrefix(code){
  if (code.startsWith("6") || code.startsWith("5") || code.startsWith("51")) return "sh";
  if (code.startsWith("0") || code.startsWith("3")) return "sz";
  return "sh";
}

export function secid(code){
  // Eastmoney: 1=SH, 0=SZ
  const m = marketPrefix(code);
  return (m === "sh" ? "1" : "0") + "." + code;
}

function emNumberToDecimal(x){
  // Eastmoney quote numbers are typically integer-scaled (price*100). If string has '.', treat as already-decimal.
  if (x === null || x === undefined) return D("0");
  const s = String(x).trim();
  if (!s || s === "-") return D("0");
  try{
    if (s.includes(".")) return D(s);
    return D(s).div(D("100"));
  }catch(_){
    return D("0");
  }
}

function emMaybeScaledRatio(x){
  // premium ratio sometimes comes scaled; keep heuristics conservative
  if (x === null || x === undefined) return null;
  const s = String(x).trim();
  if (!s || s === "-") return null;
  try{
    const d = D(s.includes(".") ? s : s);
    if (d.abs().lte(D("1"))) return d;
    if (d.abs().lte(D("10000"))) return d.div(D("10000"));
    return null;
  }catch(_){
    return null;
  }
}

function loadScript(url, timeoutMs=8000, charset=null){
  return new Promise((resolve, reject)=>{
    const s = document.createElement("script");
    if (charset) s.charset = charset;
    const t = setTimeout(()=>{
      s.remove();
      reject(new Error("timeout"));
    }, timeoutMs);
    s.src = url;
    s.async = true;
    s.onload = ()=>{ clearTimeout(t); s.remove(); resolve(true); };
    s.onerror = ()=>{ clearTimeout(t); s.remove(); reject(new Error("load error")); };
    document.head.appendChild(s);
  });
}

// Sina real-time: returns JS assignment: var hq_str_shXXXXXX="name,open,prev,price,high,low,..."

export async function fetchPriceSina(code){
  const mp = marketPrefix(code);
  const varName = `hq_str_${mp}${code}`;
  const url = `https://hq.sinajs.cn/list=${mp}${code}`;
  // Prefer script injection (no CORS), but some networks block Sina; then fall back to proxy-fetch parsing.
  try{
    await loadScript(url, 8000, "gbk");
    const raw = window[varName];
    if (!raw) throw new Error("empty");
    const parts = raw.split(",");
    const name = (parts[0]||"").trim();
    const price = parts[3] ? D(parts[3]) : D("0");
    if (price.lte(D("0"))) throw new Error("bad price");
    return { ok:true, source:"sina", price:q_cost3(price), name, raw };
  }catch(e){
    // proxy fallback
    const t = await fetchTextSmart(url, { timeoutMs: 9000, tries: 2 });
    if (!t.ok) return { ok:false, source:"sina", price:D("0"), name:"", err: String(e)+" | "+(t.err||"") };
    // var hq_str_shXXXXXX="name,open,prev,price,...";
    const m = t.text.match(/hq_str_\w+\d{6}="([^"]*)"/);
    const raw = m ? m[1] : "";
    const parts = raw ? raw.split(",") : [];
    const name = (parts[0]||"").trim();
    const price = parts[3] ? D(parts[3]) : D("0");
    if (price.lte(D("0"))) return { ok:false, source: t.via==="proxy" ? "sina+proxy" : "sina", price:D("0"), name:"", err:"bad price" };
    return { ok:true, source: t.via==="proxy" ? "sina+proxy" : "sina", price:q_cost3(price), name, raw };
  }finally{
    // cleanup jsonp global if any
    try{ delete window[varName]; }catch(_){}
  }
}


// Tencent real-time quote (script injection, usually more stable than browser-fetch)
export async function fetchPriceTencent(code){
  const mp = marketPrefix(code);
  const varName = `v_${mp}${code}`;
  const url = `https://qt.gtimg.cn/q=${mp}${code}`;
  try{
    await loadScript(url, 8000, "gbk");
    const raw = window[varName];
    if (!raw) throw new Error("empty");
    // format: v_sh600000="1~name~code~price~..."
    const payload = raw.split("=")[1]?.replaceAll('"','').replaceAll(";","") || "";
    const parts = payload.split("~");
    const name = (parts[1]||"").trim();
    const price = parts[3] ? D(parts[3]) : D("0");
    if (price.lte(D("0"))) throw new Error("bad price");
    return { ok:true, source:"tencent", price:q_cost3(price), name, raw:payload };
  }catch(e){
    const t = await fetchTextSmart(url, { timeoutMs: 9000, tries: 2 });
    if (!t.ok) return { ok:false, source:"tencent", price:D("0"), name:"", err:String(e)+" | "+(t.err||"") };
    const mm = t.text.match(/v_\w+\d{6}="([^"]*)"/);
    const payload = mm ? mm[1] : "";
    const parts = payload ? payload.split("~") : [];
    const name = (parts[1]||"").trim();
    const price = parts[3] ? D(parts[3]) : D("0");
    if (price.lte(D("0"))) return { ok:false, source: t.via==="proxy" ? "tencent+proxy" : "tencent", price:D("0"), name:"", err:"bad price" };
    return { ok:true, source: t.via==="proxy" ? "tencent+proxy" : "tencent", price:q_cost3(price), name, raw:payload };
  }finally{
    try{ delete window[varName]; }catch(_){}
  }
}


export async function fetchPriceEastmoney(code){
  const baseUrls = [
    "https://push2.eastmoney.com",
    "https://80.push2.eastmoney.com",
  ];
  const path = `/api/qt/stock/get?secid=${encodeURIComponent(secid(code))}&fields=f43,f58,f169,f170`;
  let lastErr = "";
  for (const base of baseUrls){
    const url = base + path;
    const j = await fetchJsonSmart(url, { timeoutMs: 9000, tries: 2 });
    if (!j.ok){ lastErr = j.err || ""; continue; }
    const data = j.data?.data;
    const px = data?.f43;
    const name = data?.f58 || "";
    const price = emNumberToDecimal(px);
    if (price.lte(D("0"))){ lastErr = "bad price"; continue; }
    const src = j.via==="proxy" ? "akshare+proxy" : "akshare";
    return { ok:true, source: src, price:q_cost3(price), name, em:data };
  }
  return { ok:false, source:"akshare", price:D("0"), name:"", err:lastErr || "fetch failed" };
}

// Kline via Sina (preferred). If CORS blocks, this will fail and caller should fall back.

export async function fetchKlineSina(code, datalen=420){
  const mp = marketPrefix(code);
  // Sina JSONP is "var <name>=...;" style, not callback(). We load via <script> and read global.
  const varName = "__kline_" + Math.random().toString(36).slice(2);
  const symbol = `${mp}${code}`;
  const url = `https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20${encodeURIComponent(varName)}=/CN_MarketData.getKLineData?symbol=${encodeURIComponent(symbol)}&scale=240&ma=no&datalen=${encodeURIComponent(String(datalen))}`;
  try{
    await loadScript(url, 10000, "gbk");
    const data = window[varName];
    if (!data) throw new Error("empty");
    const rows = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : null);
    if (!rows || rows.length < 30) throw new Error("no rows");
    return { ok:true, source:"sina", rows: rows.map(r=>({
      day: r.day || r.date || r.f51,
      open: r.open ?? r.f52,
      high: r.high ?? r.f53,
      low:  r.low  ?? r.f54,
      close:r.close?? r.f55
    })) };
  }catch(e){
    // proxy fetch fallback: parse "var <varName>=...;"
    const t = await fetchTextSmart(url, { timeoutMs: 12000, tries: 2 });
    if (!t.ok) return { ok:false, source:"sina", rows:[], err:String(e)+" | "+(t.err||"") };
    const re = new RegExp(`var\\s+${varName}\\s*=\\s*([\\s\\S]*?);\\s*$`);
    const m = t.text.match(re);
    if (!m) return { ok:false, source: t.via==="proxy" ? "sina+proxy" : "sina", rows:[], err:"parse fail" };
    let payload = null;
    try{ payload = JSON.parse(m[1]); }catch(_){ payload = null; }
    const rows = Array.isArray(payload) ? payload : (Array.isArray(payload?.data) ? payload.data : null);
    if (!rows || rows.length < 30) return { ok:false, source: t.via==="proxy" ? "sina+proxy" : "sina", rows:[], err:"no rows" };
    return { ok:true, source: t.via==="proxy" ? "sina+proxy" : "sina", rows: rows.map(r=>({
      day: r.day || r.date || r.f51,
      open: r.open ?? r.f52,
      high: r.high ?? r.f53,
      low:  r.low  ?? r.f54,
      close:r.close?? r.f55
    })) };
  }finally{
    try{ delete window[varName]; }catch(_){}
  }
}

export async function fetchKlineEastmoney(code, lmt=420){
  const bases = [
    "https://push2his.eastmoney.com",
    "https://80.push2his.eastmoney.com",
    "https://56.push2his.eastmoney.com",
  ];
  const path = `/api/qt/stock/kline/get?secid=${encodeURIComponent(secid(code))}&klt=101&fqt=0&end=20500101&lmt=${encodeURIComponent(String(lmt))}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56`;
  let lastErr = "";
  for (const base of bases){
    const url = base + path;
    const j = await fetchJsonSmart(url, { timeoutMs: 12000, tries: 2 });
    if (!j.ok){ lastErr = j.err || ""; continue; }
    const kl = j.data?.data?.klines;
    if (!Array.isArray(kl) || kl.length < 30){ lastErr = "no klines"; continue; }
    const rows = kl.map(line=>{
      const parts = String(line).split(",");
      // parts: date, open, close, high, low, vol...
      return { day: parts[0], open: parts[1], close: parts[2], high: parts[3], low: parts[4] };
    });
    const src = j.via==="proxy" ? "akshare+proxy" : "akshare";
    return { ok:true, source: src, rows };
  }
  return { ok:false, source:"akshare", rows:[], err:lastErr || "fetch failed" };
}


export async function fetchPremiumEastmoney(code){
  const baseUrls = [
    "https://push2.eastmoney.com",
    "https://80.push2.eastmoney.com",
  ];
  const path = `/api/qt/stock/get?secid=${encodeURIComponent(secid(code))}&fields=f43,f58,f169,f170`;
  let lastErr = "";
  for (const base of baseUrls){
    const url = base + path;
    const j = await fetchJsonSmart(url, { timeoutMs: 9000, tries: 2 });
    if (!j.ok){ lastErr = j.err || ""; continue; }
    const d = j.data?.data || {};
    const price = emNumberToDecimal(d?.f43);
    let iopv = null;
    let prem = null;
    const f169 = d?.f169;
    const f170 = d?.f170;
    if (f169!=null){
      const x = emNumberToDecimal(f169);
      if (x.gt(D("0")) && price.gt(D("0"))){
        iopv = q_cost3(x);
        // premium = (price/iopv -1)
        prem = price.div(x).minus(D("1"));
      }
    }else if (f170!=null){
      const rr = emMaybeScaledRatio(f170);
      prem = rr!==null ? rr : null;
      if (prem!==null && price.gt(D("0"))) iopv = q_cost3(price.div(prem.plus(D("1"))));
    }
    if (prem!==null){
      // sanity: premium typically within ±50%
      if (prem.abs().gt(D("0.5"))) prem = null;
    }
    const ok = (prem!==null) || (iopv!==null);
    const src = j.via==="proxy" ? "akshare+proxy" : "akshare";
    return { ok, source: src, premium: prem, iopv };
  }
  return { ok:false, source:"akshare", premium:null, iopv:null, err:lastErr || "fetch failed" };
}

// Generic JSONP helper (callback token replacement)
function jsonp(url, token="__CALLBACK__", timeoutMs=8000){
  return new Promise((resolve, reject)=>{
    const cb = "__jsonp_" + Math.random().toString(36).slice(2);
    const u = url.replaceAll(token, cb);
    const s = document.createElement("script");
    if (charset) s.charset = charset;
    let done = false;
    const t = setTimeout(()=>{
      if (done) return;
      done = true;
      cleanup();
      reject(new Error("timeout"));
    }, timeoutMs);
    function cleanup(){
      clearTimeout(t);
      try{ delete window[cb]; }catch(_){}
      s.remove();
    }
    window[cb] = (data)=>{
      if (done) return;
      done = true;
      cleanup();
      resolve(data);
    };
    s.src = u;
    s.async = true;
    s.onerror = ()=>{
      if (done) return;
      done = true;
      cleanup();
      reject(new Error("load error"));
    };
    document.head.appendChild(s);
  });
}