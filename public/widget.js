(function initStickyAnalyticsWidget() {
  "use strict";

  const WIDGET_ID = "__wa_sticky_footer_widget__";
  const STYLE_ID = "__wa_sticky_footer_style__";

  if (document.getElementById(WIDGET_ID)) {
    return;
  }

  const scriptTag = document.currentScript;
  const rawBaseUrl =
    (scriptTag && (scriptTag.dataset.endpoint || scriptTag.dataset.baseUrl)) ||
    window.location.origin;
  const baseUrl = rawBaseUrl.replace(/\/+$/, "");
  const apiKey = (scriptTag && scriptTag.dataset.apiKey) || "";
  const shouldTrack = ((scriptTag && scriptTag.dataset.track) || "true").toLowerCase() !== "false";
  const pollMsRaw = Number((scriptTag && scriptTag.dataset.pollMs) || 5000);
  const pollMs = Number.isFinite(pollMsRaw) && pollMsRaw >= 1000 ? pollMsRaw : 5000;

  if (!apiKey) {
    console.warn("[Analytics Widget] Missing data-api-key on <script>.");
  }

  injectStyles();
  const ui = createWidget();
  document.body.appendChild(ui.root);

  let previousTotalViews = null;
  let isRequestInFlight = false;

  ui.totalValue.addEventListener("animationend", () => {
    ui.totalValue.classList.remove("wa-flash");
  });

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${WIDGET_ID} {
        position: fixed;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: 2147483000;
        height: 48px;
        display: flex;
        align-items: center;
        box-sizing: border-box;
        padding: 0 14px;
        background: rgba(10, 13, 20, 0.94);
        border-top: 1px solid rgba(255, 255, 255, 0.12);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        color: #e8edf7;
        font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 12px;
      }

      #${WIDGET_ID} .wa-row {
        width: 100%;
        display: flex;
        align-items: center;
        gap: 14px;
        min-width: 0;
      }

      #${WIDGET_ID} .wa-item {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
        white-space: nowrap;
      }

      #${WIDGET_ID} .wa-label {
        color: rgba(229, 237, 255, 0.7);
        letter-spacing: 0.01em;
      }

      #${WIDGET_ID} .wa-value {
        color: #ffffff;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
      }

      #${WIDGET_ID} .wa-dot {
        width: 9px;
        height: 9px;
        border-radius: 50%;
        background: #28d76f;
        box-shadow: 0 0 0 1px rgba(15, 30, 20, 0.35), 0 0 12px rgba(40, 215, 111, 0.8);
        animation: waPulse 1.45s ease-in-out infinite;
      }

      #${WIDGET_ID} .wa-spacer {
        flex: 1;
      }

      #${WIDGET_ID} .wa-chart-wrap {
        width: 104px;
        height: 30px;
        display: inline-flex;
        align-items: center;
      }

      #${WIDGET_ID} .wa-sparkline {
        width: 100px;
        height: 30px;
        overflow: visible;
      }

      #${WIDGET_ID} .wa-sparkline path {
        fill: none;
        stroke: rgba(255, 255, 255, 0.95);
        stroke-width: 2;
        stroke-linecap: round;
        stroke-linejoin: round;
      }

      #${WIDGET_ID}.wa-offline .wa-dot {
        background: #ff6b6b;
        box-shadow: 0 0 0 1px rgba(30, 16, 16, 0.35), 0 0 10px rgba(255, 107, 107, 0.8);
        animation: none;
      }

      #${WIDGET_ID} .wa-total-value.wa-flash {
        animation: waFlash 900ms ease-out;
      }

      @keyframes waPulse {
        0%, 100% { opacity: 0.35; transform: scale(0.85); }
        50% { opacity: 1; transform: scale(1.15); }
      }

      @keyframes waFlash {
        0% { color: #7cf5b3; text-shadow: 0 0 14px rgba(71, 255, 153, 0.95); }
        100% { color: #ffffff; text-shadow: none; }
      }

      @media (max-width: 760px) {
        #${WIDGET_ID} {
          height: 44px;
          padding: 0 10px;
          font-size: 11px;
        }

        #${WIDGET_ID} .wa-row {
          gap: 10px;
        }

        #${WIDGET_ID} .wa-chart-wrap {
          display: none;
        }

        #${WIDGET_ID} .wa-label.slim-hidden {
          display: none;
        }
      }
    `;

    document.head.appendChild(style);
  }

  function createWidget() {
    const root = document.createElement("div");
    root.id = WIDGET_ID;
    root.innerHTML = `
      <div class="wa-row">
        <div class="wa-item">
          <span class="wa-dot" aria-hidden="true"></span>
          <span class="wa-label">Online</span>
          <span class="wa-value" data-wa-online>0</span>
        </div>
        <div class="wa-item">
          <span class="wa-label">Total</span>
          <span class="wa-value wa-total-value" data-wa-total>0</span>
        </div>
        <div class="wa-item">
          <span class="wa-label slim-hidden">Today</span>
          <span class="wa-value" data-wa-today>0</span>
        </div>
        <div class="wa-item">
          <span class="wa-label slim-hidden">Top</span>
          <span class="wa-value" data-wa-country>--</span>
        </div>
        <span class="wa-spacer"></span>
        <div class="wa-chart-wrap" aria-hidden="true">
          <svg class="wa-sparkline" viewBox="0 0 100 30" preserveAspectRatio="none">
            <path data-wa-sparkline d=""></path>
          </svg>
        </div>
      </div>
    `;

    return {
      root,
      onlineValue: root.querySelector("[data-wa-online]"),
      totalValue: root.querySelector("[data-wa-total]"),
      todayValue: root.querySelector("[data-wa-today]"),
      countryValue: root.querySelector("[data-wa-country]"),
      sparklinePath: root.querySelector("[data-wa-sparkline]")
    };
  }

  function buildApiUrl(pathname, query) {
    const url = new URL(baseUrl + pathname);
    if (apiKey) {
      url.searchParams.set("apiKey", apiKey);
    }
    if (query && typeof query === "object") {
      Object.entries(query).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      });
    }
    return url.toString();
  }

  function formatNumber(value) {
    return Number(value || 0).toLocaleString();
  }

  function toSparklinePath(points, width, height) {
    if (!Array.isArray(points) || points.length === 0) {
      return "";
    }

    const values = points.map((n) => Number(n) || 0);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const padding = 2;
    const step = values.length > 1 ? (width - padding * 2) / (values.length - 1) : 0;

    return values
      .map((value, index) => {
        const x = padding + index * step;
        const y = height - padding - ((value - min) / range) * (height - padding * 2);
        return `${index === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
      })
      .join(" ");
  }

  function flashTotalValue() {
    ui.totalValue.classList.remove("wa-flash");
    void ui.totalValue.offsetWidth;
    ui.totalValue.classList.add("wa-flash");
  }

  function applyStats(data) {
    const totalViews = Number(data.totalViews) || 0;
    const todayViews = Number(data.todayViews) || 0;
    const currentOnline = Number(data.currentOnline) || 0;
    const topCountry = data.topCountry || "--";
    const sparkline = Array.isArray(data.sparkline) ? data.sparkline : [];

    if (previousTotalViews !== null && totalViews > previousTotalViews) {
      flashTotalValue();
    }
    previousTotalViews = totalViews;

    ui.onlineValue.textContent = formatNumber(currentOnline);
    ui.totalValue.textContent = formatNumber(totalViews);
    ui.todayValue.textContent = formatNumber(todayViews);
    ui.countryValue.textContent = String(topCountry);
    ui.sparklinePath.setAttribute("d", toSparklinePath(sparkline, 100, 30));
  }

  async function fetchStats() {
    if (isRequestInFlight || !apiKey) return;

    isRequestInFlight = true;
    try {
      const response = await fetch(buildApiUrl("/api/stats"), {
        method: "GET",
        mode: "cors",
        cache: "no-store"
      });
      if (!response.ok) {
        throw new Error("Failed to fetch stats");
      }

      const payload = await response.json();
      applyStats(payload);
      ui.root.classList.remove("wa-offline");
    } catch (error) {
      ui.root.classList.add("wa-offline");
    } finally {
      isRequestInFlight = false;
    }
  }

  function trackPageVisit() {
    if (!apiKey || !shouldTrack) return;

    fetch(
      buildApiUrl("/track", {
        url: window.location.href
      }),
      {
        method: "GET",
        mode: "cors",
        cache: "no-store",
        keepalive: true
      }
    ).catch(() => {
      // Ignore tracking failures to avoid breaking host page.
    });
  }

  trackPageVisit();
  fetchStats();
  const intervalId = window.setInterval(fetchStats, pollMs);

  window.addEventListener(
    "pagehide",
    () => {
      clearInterval(intervalId);
    },
    { once: true }
  );
})();
