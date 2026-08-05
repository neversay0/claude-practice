// 간밤 미국장 브리핑을 "키 없이 무료로" 실시간 생성한다.
// 서버(Netlify)에서 직접 두 무료 소스를 가져와 조립하므로 API 키·CORS가 필요 없다.
//   1) Yahoo Finance(v8 chart) → 주요 지수 등락률로 지수 요약 한 줄
//   2) Google 뉴스 RSS(한국어) → "뉴욕증시/미국증시" 최신 헤드라인 4~6개
// 결과는 briefing.json과 동일한 스키마로 반환한다.

const INDICES = [
  { s: "^IXIC", n: "나스닥" },
  { s: "^GSPC", n: "S&P500" },
  { s: "^DJI", n: "다우" },
  { s: "^SOX", n: "필라델피아 반도체" },
  { s: "^VIX", n: "VIX" },
];
const NEWS_RSS =
  "https://news.google.com/rss/search?q=" +
  encodeURIComponent("뉴욕증시 OR 미국증시") +
  "&hl=ko&gl=KR&ceid=KR:ko";
const UA = "Mozilla/5.0 (compatible; us-market-dashboard/1.0)";
const CACHE_TTL_MS = 10 * 60 * 1000;

let _cache = null; // { at:number, body:object } — 웜 컨테이너 동안만 유지(best-effort)

function fetchT(url, ms) {
  const c = new AbortController();
  const id = setTimeout(() => c.abort(), ms);
  return fetch(url, { headers: { "user-agent": UA }, signal: c.signal }).finally(() => clearTimeout(id));
}

function kstNow() {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000); // UTC+9
  const p = (n) => String(n).padStart(2, "0");
  const date = `${kst.getUTCFullYear()}-${p(kst.getUTCMonth() + 1)}-${p(kst.getUTCDate())}`;
  const time = `${p(kst.getUTCHours())}:${p(kst.getUTCMinutes())}`;
  return { date, full: `${date} ${time}` };
}

async function fetchPct(sym) {
  const url =
    "https://query1.finance.yahoo.com/v8/finance/chart/" +
    encodeURIComponent(sym) +
    "?interval=1d&range=1d&includePrePost=true";
  const r = await fetchT(url, 7000);
  if (!r.ok) throw new Error("quote " + r.status);
  const j = await r.json();
  const m = j.chart.result[0].meta;
  const price = m.regularMarketPrice;
  const prev = (m.previousClose != null ? m.previousClose : m.chartPreviousClose);
  if (price == null || prev == null || prev === 0) throw new Error("no price");
  return { pct: ((price - prev) / prev) * 100 };
}

function decodeEntities(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d));
}

function parseNews(xml, max) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) && items.length < max) {
    const t = (m[1].match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "";
    let title = decodeEntities(t).trim();
    title = title.replace(/\s+-\s+[^-]+$/, ""); // "제목 - 매체명" 꼬리 제거
    if (title && !items.includes(title)) items.push(title);
  }
  return items;
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    body: JSON.stringify(obj),
  };
}

exports.handler = async (event) => {
  const force = ((event.queryStringParameters || {}).force === "1");
  if (!force && _cache && (Date.now() - _cache.at) < CACHE_TTL_MS) {
    return json(200, { ..._cache.body, cached: true });
  }

  const kst = kstNow();

  // 지수 + 뉴스를 병렬로 수집(부분 실패 허용)
  const [quoteRes, newsRes] = await Promise.allSettled([
    Promise.all(INDICES.map((i) => fetchPct(i.s).then((q) => ({ n: i.n, pct: q.pct })).catch(() => null))),
    fetchT(NEWS_RSS, 7000).then((r) => (r.ok ? r.text() : Promise.reject(new Error("rss " + r.status)))),
  ]);

  const items = [];
  let lead = "";

  // 1) 지수 요약 한 줄
  if (quoteRes.status === "fulfilled") {
    const qs = quoteRes.value.filter(Boolean);
    if (qs.length) {
      const parts = qs.map((q) => `${q.n} ${q.pct >= 0 ? "+" : ""}${q.pct.toFixed(2)}%`);
      items.push("지수: " + parts.join(", ") + " (직전 종가 대비)");
      const big = qs.filter((q) => ["나스닥", "S&P500", "다우"].includes(q.n));
      if (big.length) {
        const up = big.filter((q) => q.pct > 0.05).length;
        const down = big.filter((q) => q.pct < -0.05).length;
        const mood = up === big.length ? "일제히 상승" : down === big.length ? "일제히 하락" : "혼조";
        lead = `간밤 뉴욕증시는 주요 지수가 ${mood} 마감했습니다.`;
      }
    }
  }

  // 2) 뉴스 헤드라인
  if (newsRes.status === "fulfilled") {
    for (const h of parseNews(newsRes.value, 6)) items.push("뉴스: " + h);
  }

  if (items.length === 0) {
    return json(502, { error: "no_data", message: "지수·뉴스 데이터를 모두 가져오지 못했습니다." });
  }

  const body = {
    date: `${kst.date} · 간밤 미국장`,
    asof: `${kst.full} KST 기준 · 자동 생성(무키)`,
    lead,
    items,
    source: "출처: Yahoo Finance(지수) · Google 뉴스(헤드라인) · 정보 제공용이며 투자 자문이 아닙니다.",
  };

  _cache = { at: Date.now(), body };
  return json(200, body);
};
