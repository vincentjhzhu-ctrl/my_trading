# Trading Ledger PWA（离线可用 / GitHub Pages 可跑）

这是把 `share_trading_final_macro_expect_fixed7_iopv.py`（tkinter 单文件）按“功能/口径/字段完全对齐”的方式，移植成 **纯静态 PWA** 的版本。

> 重要：本 PWA 的 **成本/现金流/收益/因子/条件单** 计算口径严格按 Python 版实现（ROUND_HALF_UP；金额 2 位、成本 3 位；100 股整百向下）。

---

## 1. 运行方式

### 本地运行（推荐）
由于 Service Worker 缓存策略，建议用本地静态服务器启动（不要直接双击打开 html）：

```bash
# 任意方式之一：
python -m http.server 8000
# 或
npx serve .
```

浏览器打开：`http://localhost:8000/?code=518880`

### GitHub Pages 部署
1. 新建一个仓库，把本 zip 解压后的文件全部放到仓库根目录（或 `docs/`，但要同步调整 Pages 设置）
2. GitHub 仓库 Settings → Pages：
   - Source: Deploy from a branch
   - Branch: main / root
3. Pages URL 形如 `https://<user>.github.io/<repo>/?code=518880`

---

## 2. 单标独立数据空间（与 Python “复制脚本改文件名” 等价）

- 用 URL：`/?code=518880`
- 或顶部输入 code 切换

数据会以 `code` 为 namespace 保存到 IndexedDB：
- `ledger`（流水）
- `settings`（参数）
- `overrides`（价格覆盖）

同时提供 **导入/导出**（CSV/JSON），可像桌面版一样按标的备份迁移。

---

## 3. 数据导入/导出

右上角：
- 导出 `ledger_<code>.csv`
- 导出 `settings_<code>.json`
- 导出 `price_overrides_<code>.csv`
- 导出 daily series（CSV）
- 导出 Excel（XML）——包含 2 个 sheet（`ledger` 和 `<code>`），字段与 Python Excel 导出一致  
  > 注意：静态前端无法可靠嵌入 Excel 图表对象。本实现保证 **数据列一致**，并在 App 内提供两张曲线图（净投入 vs 市值、收益率曲线）。

导入：
- 选择 CSV / JSON 文件即可：
  - ledger CSV（字段与 Python 一致）
  - overrides CSV（date,code,latest_price）
  - settings JSON
  - bundle JSON（PWA 导出的整体备份）

---

## 4. 行情/K线/每日快照逻辑

- 最新价优先级：**新浪 → 腾讯（qt.gtimg.cn）→ Eastmoney（akshare 等价）→ 手动输入**
- K 线优先级：**新浪 K 线 → Eastmoney K 线 → 缓存**
- **不会因为外部数据失败崩溃**：UI 会显示数据源状态，并可用手动输入继续驱动所有计算。


### 提升稳定性的“自定义代理”（推荐）
GitHub Pages/手机浏览器常见失败原因是 **跨域/CORS** 或接口风控。PWA 支持在“设置”中填写 **代理前缀**：

- `代理前缀（可选）`：例如 `https://你的worker.workers.dev/?url=`

填写后，所有外部数据请求会在直连失败时自动走该代理（UI 的 `*_src` 会显示 `+proxy`）。

#### Cloudflare Worker 代理（最稳定的做法）
你可以在 Cloudflare Workers 新建一个 Worker，粘贴以下代码并部署（免费额度够用），然后把部署后的 URL 填到 `代理前缀`（注意以 `?url=` 结尾）：

```js
export default {
  async fetch(request) {
    const { searchParams } = new URL(request.url);
    const target = searchParams.get("url");
    if (!target) return new Response("missing url", { status: 400 });

    const resp = await fetch(target, {
      headers: { "User-Agent": request.headers.get("User-Agent") || "Mozilla/5.0" },
    });

    // 允许浏览器访问
    const h = new Headers(resp.headers);
    h.set("Access-Control-Allow-Origin", "*");
    h.set("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
    return new Response(resp.body, { status: resp.status, headers: h });
  }
};
```

> 说明：这是“纯转发 + 加 CORS 头”，不改你任何计算口径；只是让浏览器能稳定拿到数据。


### 每日快照（daily series）
生成顺序严格对齐 Python：
1) overrides（手动覆盖）  
2) close_map（K 线收盘价回填）  
3) ffill(nontrade) / ffill(trade) 降级  

---

## 5. 手续费模型（与 Python 一致）

- 模式 A：`commission=max(turnover*0.0001, 5)`，其他费=0
- 模式 B：佣金同上 + `other=turnover*other_fee_rate + other_fee_fixed`

UI 可编辑 `other_fee_rate / other_fee_fixed` 用于把成本页 0.001 的验算差异调平。

---

## 6. 宏观输入与市场预期

- `macro_override ∈ [-1, +1]`
- 强度：低/中/高（映射到 macro_k）
- 市场预期：正常 / 非常好(追涨) / 非常差(止损)
  - 非常好：条件单“加仓表”会出现追涨档
  - 非常差：条件单“止盈表”会出现止损建议
  - 同时会影响 buy_scale / sell_scale，从而改变每档的实际下单量力度

---

## 7. 离线与缓存

- PWA 带 `manifest.webmanifest` + `sw.js`
- 第一次打开后会缓存核心资源，后续可离线使用
- 外部行情接口无法离线时会自动回落到手动输入/缓存 K 线

---

## 8. 对齐验收建议

你可以用同一套：
- `ledger_<code>.csv`
- `settings_<code>.json`
- `price_overrides_<code>.csv`

分别喂给 Python 版和 PWA：
- avg_cost / net_invest / realized / unrealized / total pnl / pnl_rate
- 条件单每档 buy/sell shares 与金额

应当一致（显示格式允许差异，但数值精度一致）。


## 外部数据一直失败怎么办？（稳定性增强）
- 本版本已加入 **自动兜底代理**：直连失败会自动走 `api.allorigins.win` 代理拉取（不需要你额外部署后端）。
- 东财接口已加入 **多域名轮询**（push2 / 80.push2 / push2his / 80.push2his / 56.push2his），降低单点波动。
- 即使仍失败：
  1) 你可以在摘要页手动输入 latest price；
  2) 在因子页手动输入 premium/IOPV；
  3) K线会优先使用历史缓存（曾成功拉取过一次就会离线可用）。


## 数据源策略（已按你的偏好收敛）
- **名称/最新价：仅新浪 hq**（`<script charset="gbk">` 注入，避免 GBK 乱码与 CORS）
- **K线：仅新浪 K线 JSONP**（同样使用 `charset=gbk`）
- **折溢价/IOPV：AKShare 等价（东财字段）**，建议配置你自己的代理前缀以稳定跨域；否则可手动输入 premium 或 IOPV（手动优先级最高）
- 刷新时有进度遮罩，避免“像卡死”的体验
