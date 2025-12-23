
// Fixed-point Decimal using BigInt (ROUND_HALF_UP), designed to match Python Decimal quantize(ROUND_HALF_UP)
// Internal scale = 18 (1e-18). All values stored as integer * 10^SCALE.
export const SCALE = 18n;
const TEN = 10n;
const POW10_CACHE = new Map();

export function pow10(n){
  const key = BigInt(n);
  if (POW10_CACHE.has(key)) return POW10_CACHE.get(key);
  let v = 1n;
  for (let i=0n;i<key;i++) v *= TEN;
  POW10_CACHE.set(key, v);
  return v;
}

const SCALE_FACTOR = pow10(SCALE);

function isIntString(s){ return /^-?\d+$/.test(s); }

export class Decimal {
  constructor(intScaled){ this.i = BigInt(intScaled); }

  static zero(){ return new Decimal(0n); }

  static from(x){
    if (x instanceof Decimal) return x;
    if (typeof x === "bigint") return new Decimal(x * SCALE_FACTOR);
    if (typeof x === "number"){
      if (!Number.isFinite(x)) throw new Error("bad number");
      // Convert via string to avoid binary drift in critical paths; caller should prefer strings.
      return Decimal.parse(String(x));
    }
    if (typeof x === "string") return Decimal.parse(x);
    if (x === null || x === undefined) return Decimal.zero();
    throw new Error("unsupported");
  }

  static parse(s){
    s = (s ?? "").toString().trim();
    if (s === "") return Decimal.zero();
    let sign = 1n;
    if (s[0] === "+"){ s = s.slice(1); }
    else if (s[0] === "-"){ sign = -1n; s = s.slice(1); }

    if (s.includes("e") || s.includes("E")){
      // Minimal scientific notation support (used rarely in UI). Convert using JS number, then parse fixed.
      const n = Number((sign===-1n? "-" : "") + s);
      if (!Number.isFinite(n)) return Decimal.zero();
      return Decimal.parse(String(n));
    }

    const parts = s.split(".");
    const intPart = parts[0] || "0";
    const fracPart = (parts[1] || "");
    if (!isIntString(intPart) || !/^\d*$/.test(fracPart)) throw new Error("bad decimal string");

    const ip = BigInt(intPart || "0");
    let fp = fracPart.slice(0, Number(SCALE)); // truncate beyond SCALE (Python does not truncate; but inputs are expected small)
    while (fp.length < Number(SCALE)) fp += "0";
    const fi = fp === "" ? 0n : BigInt(fp);
    return new Decimal(sign * (ip * SCALE_FACTOR + fi));
  }

  neg(){ return new Decimal(-this.i); }
  abs(){ return new Decimal(this.i < 0n ? -this.i : this.i); }

  add(b){ b = Decimal.from(b); return new Decimal(this.i + b.i); }
  sub(b){ b = Decimal.from(b); return new Decimal(this.i - b.i); }

  // ROUND_HALF_UP for mul/div to preserve SCALE precision
  mul(b){
    b = Decimal.from(b);
    const a = this.i, bb = b.i;
    if (a === 0n || bb === 0n) return Decimal.zero();
    const sign = (a < 0n) === (bb < 0n) ? 1n : -1n;
    const aa = a < 0n ? -a : a;
    const babs = bb < 0n ? -bb : bb;
    const prod = aa * babs;
    const q = prod / SCALE_FACTOR;
    const r = prod % SCALE_FACTOR;
    const halfUp = (r * 2n >= SCALE_FACTOR) ? 1n : 0n;
    return new Decimal(sign * (q + halfUp));
  }

  div(b){
    b = Decimal.from(b);
    if (b.i === 0n) throw new Error("div by zero");
    const a = this.i, bb = b.i;
    if (a === 0n) return Decimal.zero();
    const sign = (a < 0n) === (bb < 0n) ? 1n : -1n;
    const aa = a < 0n ? -a : a;
    const babs = bb < 0n ? -bb : bb;
    const num = aa * SCALE_FACTOR;
    const q = num / babs;
    const r = num % babs;
    const halfUp = (r * 2n >= babs) ? 1n : 0n;
    return new Decimal(sign * (q + halfUp));
  }

  cmp(b){
    b = Decimal.from(b);
    return this.i < b.i ? -1 : this.i > b.i ? 1 : 0;
  }
  lt(b){ return this.cmp(b) < 0; }
  lte(b){ return this.cmp(b) <= 0; }
  gt(b){ return this.cmp(b) > 0; }
  gte(b){ return this.cmp(b) >= 0; }
  eq(b){ return this.cmp(b) === 0; }

  isZero(){ return this.i === 0n; }

  // Quantize to dp decimals (ROUND_HALF_UP), keep internal SCALE
  quantize(dp){
    dp = Number(dp);
    if (dp < 0 || dp > Number(SCALE)) throw new Error("bad dp");
    const factor = pow10(SCALE - BigInt(dp)); // factor to drop
    const sign = this.i < 0n ? -1n : 1n;
    const aa = this.i < 0n ? -this.i : this.i;
    const q = aa / factor;
    const r = aa % factor;
    const halfUp = (r * 2n >= factor) ? 1n : 0n;
    const qq = q + halfUp;
    return new Decimal(sign * (qq * factor));
  }

  toString(dp=null){
    if (dp === null) dp = Number(SCALE);
    const v = this.quantize(dp);
    const sign = v.i < 0n ? "-" : "";
    const aa = v.i < 0n ? -v.i : v.i;
    const ip = aa / SCALE_FACTOR;
    const fp = aa % SCALE_FACTOR;
    if (dp === 0) return sign + ip.toString();
    const fracFull = fp.toString().padStart(Number(SCALE), "0").slice(0, dp);
    return sign + ip.toString() + "." + fracFull;
  }

  toNumber(){
    // For thresholds/branching only; not for money outputs.
    return Number(this.i) / Number(SCALE_FACTOR);
  }

  toIntTrunc(){
    // Truncate toward 0 (Python int() behavior for positive values)
    const q = this.i / SCALE_FACTOR;
    return Number(q);
  }


  // Python Decimal.to_integral_value(rounding=ROUND_HALF_UP)
  toIntegralHalfUp(){
    const sign = this.i < 0n ? -1n : 1n;
    const aa = this.i < 0n ? -this.i : this.i;
    const ip = aa / SCALE_FACTOR;
    const fp = aa % SCALE_FACTOR;
    const halfUp = (fp * 2n >= SCALE_FACTOR) ? 1n : 0n;
    return Number(sign * (ip + halfUp));
  }
}

export function D(x){ return Decimal.from(x); }

export function clamp(x, lo, hi){
  x = D(x); lo = D(lo); hi = D(hi);
  if (x.lt(lo)) return lo;
  if (x.gt(hi)) return hi;
  return x;
}

export function abs(x){ return D(x).abs(); }
export function max(a,b){ a=D(a); b=D(b); return a.gt(b)?a:b; }
export function min(a,b){ a=D(a); b=D(b); return a.lt(b)?a:b; }

export function q_money(x){ return D(x).quantize(2); }
export function q_cost3(x){ return D(x).quantize(3); }
export function q_ratio4(x){ return D(x).quantize(4); }

export const LOT_SIZE = 100;

export function floor_to_lot(shares){
  shares = Number(shares||0);
  if (!Number.isFinite(shares)) return 0;
  if (shares === 0) return 0;
  const s = Math.trunc(shares);
  if (s > 0) return Math.floor(s / LOT_SIZE) * LOT_SIZE;
  // negative: toward -inf to stay consistent with Python floor_to_lot for suggestions; for input we handle sign elsewhere
  return -Math.floor((-s) / LOT_SIZE) * LOT_SIZE;
}

export function percentStr(x, dp=2){
  const v = D(x).mul(D("100")).quantize(dp);
  return v.toString(dp) + "%";
}
