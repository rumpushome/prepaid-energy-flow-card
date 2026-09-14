/*!
 * Prepaid Energy Flow Card for Home Assistant
 * Solar, house, battery and prepaid meter as one animated flow diagram, with
 * figures sized to be read from across a room.
 *
 * The four legs obey one balance:
 *     solar + battery_discharge + grid_import = house_load
 * so whichever of house/grid you don't have a sensor for is derived.
 *
 * No build step required - drop this file in /config/www/ and add it as a
 * Lovelace resource of type "JavaScript Module".
 */

const CARD_VERSION = "1.1.1";

/* ------------------------------------------------------------------ *
 * Colour
 * ------------------------------------------------------------------ */

// red -> amber -> green. Going straight red->green passes through a muddy
// brown at the midpoint, which is where most readings sit.
const RAMP_DARK = ["#e5484d", "#ffb020", "#35d07f"];
const RAMP_LIGHT = ["#c62c31", "#a86a00", "#158a4f"];

const clamp01 = (t) => Math.max(0, Math.min(1, t));

function hex(h) {
  return [1, 3, 5].map((i) => parseInt(String(h).slice(i, i + 2), 16));
}

function mix(a, b, f) {
  const x = hex(a), y = hex(b);
  return "rgb(" + x.map((v, i) => Math.round(v + (y[i] - v) * f)).join(",") + ")";
}

function rampColor(t, light) {
  const s = light ? RAMP_LIGHT : RAMP_DARK;
  t = clamp01(t);
  const n = s.length - 1;
  const i = Math.min(n - 1, Math.floor(t * n));
  return mix(s[i], s[i + 1], t * n - i);
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  }[c]));
}

function startOfLocalDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Particle speed is quantised. Tying animation-duration directly to a live
// wattage would restart the animation on every sensor update, so the dots
// would stutter permanently instead of flowing.
const SPEED_STEPS = [0.6, 0.9, 1.3, 1.8, 2.4, 3.2];
function speedFor(watts) {
  const w = Math.max(watts, 1);
  const raw = 2600 / w;
  let best = SPEED_STEPS[0];
  for (const s of SPEED_STEPS) if (Math.abs(s - raw) < Math.abs(best - raw)) best = s;
  return best + "s";
}

const ICONS = {
  sun: "<path d='M12 5.5v-3M12 21.5v-3M5.5 12h-3M21.5 12h-3M7.4 7.4 5.3 5.3M18.7 18.7l-2.1-2.1M16.6 7.4l2.1-2.1M5.3 18.7l2.1-2.1' stroke='currentColor' stroke-width='2.4' stroke-linecap='round'/><circle cx='12' cy='12' r='4' fill='currentColor'/>",
  house: "<path d='M4 11 12 4l8 7v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19z' fill='none' stroke='currentColor' stroke-width='2.4' stroke-linejoin='round'/>",
  batt: "<rect x='4' y='7' width='15' height='10' rx='2.2' fill='none' stroke='currentColor' stroke-width='2.4'/><path d='M21 10.5v3' stroke='currentColor' stroke-width='2.4' stroke-linecap='round'/>",
  grid: "<path d='M13 2 5.5 13H11l-1 9 8.5-11.5H13z' fill='currentColor'/>",
};
const svgIcon = (p) => "<svg viewBox='0 0 24 24'>" + p + "</svg>";

/* ------------------------------------------------------------------ *
 * The card
 * ------------------------------------------------------------------ */

class EnergyFlowCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = null;
    this._hass = null;
    this._built = false;
    this._burnPerDay = null;   // kWh/day of prepaid actually consumed
    this._burnSource = null;
    this._lastFetch = 0;
    this._fetchPending = false;
    this._wireState = {};
    this._ro = null;
    this._ring = null;
  }

  connectedCallback() {
    this._observe();
  }

  disconnectedCallback() {
    if (this._ro) { this._ro.disconnect(); this._ro = null; }
  }

  // Sizing is measured rather than expressed in container query units, so it
  // works on the older WebViews that Fully Kiosk and similar kiosk browsers use.
  _observe() {
    if (this._ro || typeof ResizeObserver === "undefined") return;
    const card = this.shadowRoot && this.shadowRoot.querySelector("ha-card");
    if (!card) return;
    this._ro = new ResizeObserver((entries) => {
      for (const e of entries) this._sizeTo(e.contentRect.width);
    });
    this._ro.observe(card);
    // setConfig runs before the element is attached, so this first measurement
    // is often zero. Skipping it leaves the CSS default in place until the
    // observer reports a real width, rather than flashing the minimum size.
    const cs = getComputedStyle(card);
    const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    this._sizeTo(card.clientWidth - pad);
  }

  _sizeTo(contentWidth) {
    if (!(contentWidth > 0) || !this._config) return;
    const scale = Number(this._config.scale) || 1;
    const ring = Math.round(Math.max(62, Math.min(148, contentWidth * 0.25 * scale)));
    if (ring === this._ring) return;   // avoid pointless style writes
    this._ring = ring;
    const inner = this.shadowRoot.querySelector(".inner");
    if (inner) inner.style.setProperty("--ring", ring + "px");
  }

  static getConfigElement() {
    return document.createElement("prepaid-energy-flow-card-editor");
  }

  static getStubConfig(hass) {
    const find = (re) => {
      if (!hass || !hass.states) return undefined;
      return Object.keys(hass.states).find((id) => id.startsWith("sensor.") && re.test(id));
    };
    return {
      type: "custom:prepaid-energy-flow-card",
      solar_entity: find(/pv_power|solar_power/i),
      battery_soc_entity: find(/battery_soc|battery_level/i),
      battery_power_entity: find(/battery_power/i),
      house_entity: find(/load_power|house_power/i),
      prepaid_entity: find(/prepaid/i),
    };
  }

  setConfig(config) {
    if (!config) throw new Error("Invalid configuration");
    if (!config.solar_entity && !config.house_entity && !config.grid_entity) {
      throw new Error("Define at least solar_entity and one of house_entity / grid_entity");
    }
    this._config = Object.assign(
      {
        name: null,
        solar_entity: null,
        house_entity: null,
        grid_entity: null,
        battery_soc_entity: null,
        battery_power_entity: null,
        prepaid_entity: null,
        // Many inverters (Sunsynk, Deye and others) report positive when DISCHARGING; the card shows
        // positive when charging, so this defaults on.
        battery_power_invert: true,
        grid_power_invert: false,
        solar_power_invert: false,
        prepaid_full: null,          // null = auto from the last 30 days
        runway_window_days: 7,
        scale: 1,
        round: 2,
        // bad -> good. The smaller number is "good" for house, which the one
        // formula handles without a special case.
        solar_bad: 1, solar_good: 5,
        battery_bad: 30, battery_good: 100,
        prepaid_bad: 50, prepaid_good: 200,
        house_bad: 5, house_good: 1,
        runway_threshold: 5,
        animate: true,
      },
      config
    );
    this._built = false;
    this._burnPerDay = null;
    this._lastFetch = 0;
    this._render();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (!this._config) return;
    if (!this._built) {
      this._render();
    } else {
      // The skeleton never changes shape, so every update is a targeted patch.
      // A rebuild here would restart the particle flows on every sensor tick.
      this._applyLive();
    }
    this._maybeFetch(first);
  }

  get hass() {
    return this._hass;
  }

  getCardSize() {
    return 8;
  }

  getGridOptions() {
    // "auto" lets the sections view measure the real height instead of guessing.
    return { columns: 12, min_columns: 6, rows: "auto" };
  }

  /* --------------------------- readings --------------------------- */

  _st(id) {
    if (!id || !this._hass || !this._hass.states) return undefined;
    return this._hass.states[id];
  }

  _raw(id) {
    const st = this._st(id);
    if (!st) return null;
    const v = Number(st.state);
    return Number.isFinite(v) ? v : null;
  }

  // Power in kW regardless of whether the sensor reports W, kW or MW.
  _powerKw(id, invert) {
    const v = this._raw(id);
    if (v === null) return null;
    const st = this._st(id);
    const u = String((st.attributes && st.attributes.unit_of_measurement) || "W").trim();
    let kw = v;
    if (/^m?W$/i.test(u) && u.toLowerCase() === "mw") kw = v * 1000;
    else if (/^W$/i.test(u)) kw = v / 1000;
    else if (/^kW$/i.test(u)) kw = v;
    else if (/^MW$/.test(u)) kw = v * 1000;
    else kw = v / 1000; // unlabelled sensors on these inverters are watts
    return invert ? -kw : kw;
  }

  // Everything the card renders, derived once per update.
  _model() {
    const c = this._config;
    const solar = Math.max(0, this._powerKw(c.solar_entity, c.solar_power_invert) || 0);
    // After inversion: positive = charging, negative = discharging.
    const battPower = c.battery_power_entity
      ? this._powerKw(c.battery_power_entity, c.battery_power_invert)
      : null;
    const soc = this._raw(c.battery_soc_entity);
    const discharge = battPower === null ? 0 : Math.max(0, -battPower);
    const charge = battPower === null ? 0 : Math.max(0, battPower);

    let house = c.house_entity ? this._powerKw(c.house_entity, false) : null;
    let grid = c.grid_entity ? this._powerKw(c.grid_entity, c.grid_power_invert) : null;

    // solar + discharge + grid = house + charge
    if (house === null && grid !== null) {
      house = Math.max(0, solar + discharge + Math.max(0, grid) - charge);
    } else if (grid === null && house !== null) {
      grid = Math.max(0, house + charge - solar - discharge);
    } else if (house === null && grid === null) {
      house = 0;
      grid = 0;
    } else {
      grid = Math.max(0, grid);
    }

    const prepaid = this._raw(c.prepaid_entity);
    const net = solar - (house === null ? 0 : house);
    const burn = this._burnPerDay;
    const runway = prepaid !== null && burn && burn > 0 ? prepaid / burn : null;

    return { solar, house: house || 0, grid: grid || 0, soc, battPower, charge, discharge,
             prepaid, net, runway };
  }

  _light() {
    // Themes don't announce themselves, so infer from the card background.
    const probe = this.shadowRoot && this.shadowRoot.querySelector("ha-card");
    if (!probe) return false;
    const bg = getComputedStyle(probe).backgroundColor || "";
    const m = bg.match(/\d+/g);
    if (!m || m.length < 3) return false;
    return (0.2126 * +m[0] + 0.7152 * +m[1] + 0.0722 * +m[2]) > 140;
  }

  _colorFor(kind, v) {
    const c = this._config;
    const light = this._light();
    if (v === null || v === undefined || Number.isNaN(v)) return "var(--secondary-text-color)";
    if (kind === "runway") return rampColor(v >= Number(c.runway_threshold) ? 1 : 0, light);
    if (kind === "net") return rampColor(v >= 0 ? 1 : 0, light);
    const bad = Number(c[kind + "_bad"]);
    const good = Number(c[kind + "_good"]);
    if (!Number.isFinite(bad) || !Number.isFinite(good) || bad === good) {
      return rampColor(1, light);
    }
    return rampColor((v - bad) / (good - bad), light);
  }

  _fmt(v, digits) {
    if (v === null || v === undefined || Number.isNaN(v)) return "–";
    const d = digits === undefined ? Math.max(0, Math.min(3, Number(this._config.round))) : digits;
    return Number(v).toFixed(d);
  }

  _prepaidFull() {
    const c = this._config;
    if (c.prepaid_full !== null && c.prepaid_full !== undefined && c.prepaid_full !== "") {
      return Number(c.prepaid_full);
    }
    // Self-calibrating: the biggest balance seen recently is roughly a full top-up.
    return this._seenMax || 200;
  }

  /* ------------------- prepaid burn from history ------------------- */

  _maybeFetch(force) {
    if (!this._hass || !this._config.prepaid_entity) return;
    const now = Date.now();
    if (!force && now - this._lastFetch < 30 * 60 * 1000) return;
    if (this._fetchPending) return;
    this._fetchPending = true;
    this._lastFetch = now;
    this._fetchBurn()
      .catch((err) => { console.error("prepaid-energy-flow-card:", err); })
      .then(() => {
        this._fetchPending = false;
        if (this._built) this._applyLive();
      });
  }

  async _fetchBurn() {
    const c = this._config;
    const days = Math.max(1, Math.min(60, Number(c.runway_window_days) || 7));
    const end = new Date();
    const start = startOfLocalDay(new Date());
    start.setDate(start.getDate() - days);

    // The prepaid balance itself is the ground truth for what was consumed -
    // it needs no assumptions about solar, battery or derived import. Top-ups
    // make the balance jump UP, so only decreases count.
    try {
      const stats = await this._hass.callWS({
        type: "recorder/statistics_during_period",
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        statistic_ids: [c.prepaid_entity],
        period: "hour",
        types: ["state", "mean", "max"],
      });
      const rows = (stats && stats[c.prepaid_entity]) || [];
      const pick = (r) => {
        for (const k of ["state", "mean", "max"]) {
          const v = r[k];
          if (v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v))) return Number(v);
        }
        return null;
      };
      let prev = null, consumed = 0, seenMax = 0;
      for (const row of rows) {
        const v = pick(row);
        if (v === null) continue;
        if (v > seenMax) seenMax = v;
        if (prev !== null && v < prev) consumed += prev - v;
        prev = v;
      }
      if (seenMax > 0) this._seenMax = seenMax;
      if (consumed > 0) {
        this._burnPerDay = consumed / days;
        this._burnSource = "prepaid meter";
        return;
      }
    } catch (err) {
      // fall through to the grid sensor
    }

    // Fallback: a real grid sensor's own average, if one is configured.
    if (c.grid_entity) {
      try {
        const stats = await this._hass.callWS({
          type: "recorder/statistics_during_period",
          start_time: start.toISOString(),
          end_time: end.toISOString(),
          statistic_ids: [c.grid_entity],
          period: "hour",
          types: ["mean"],
        });
        const rows = (stats && stats[c.grid_entity]) || [];
        const vals = rows.map((r) => Number(r.mean)).filter((v) => Number.isFinite(v) && v > 0);
        if (vals.length) {
          const st = this._st(c.grid_entity);
          const u = String((st && st.attributes && st.attributes.unit_of_measurement) || "W");
          const scale = /^kW$/i.test(u) ? 1 : 1 / 1000;
          const meanKw = (vals.reduce((a, b) => a + b, 0) / vals.length) * scale;
          this._burnPerDay = meanKw * 24;
          this._burnSource = "grid sensor";
          return;
        }
      } catch (err) { /* ignore */ }
    }
    this._burnPerDay = null;
    this._burnSource = null;
  }

  /* --------------------------- rendering --------------------------- */

  _render() {
    if (!this._config) return;
    const c = this._config;
    this.shadowRoot.innerHTML =
      "<style>" + EnergyFlowCard.styles + "</style>" + this._skeleton();
    this._built = true;
    if (this._ro) { this._ro.disconnect(); this._ro = null; }
    this._ring = null;
    this._observe();
    this.shadowRoot.querySelectorAll("[data-more]").forEach((el) => {
      el.addEventListener("click", () => {
        const id = el.dataset.more;
        if (!id) return;
        this.dispatchEvent(new CustomEvent("hass-more-info", {
          detail: { entityId: id }, bubbles: true, composed: true,
        }));
      });
    });
    if (this._hass) this._applyLive();
  }

  // Built once. Every subsequent update only writes text, colours and classes,
  // so the animations are never interrupted.
  _skeleton() {
    const c = this._config;
    const dots = "<span class='dot'></span><span class='dot'></span><span class='dot'></span>";
    const node = (key, icon, label, entity) =>
      '<div class="node n-' + key + '" data-node="' + key + '"' +
        (entity ? ' data-more="' + escapeHtml(entity) + '"' : "") + ">" +
        '<div class="lab">' + svgIcon(icon) + label + "</div>" +
        '<div class="ring">' +
          (key === "batt" || key === "grid" ? '<div class="fill"></div>' : "") +
          (key === "solar" ? '<div class="rays">' +
            Array.from({ length: 8 }, (_, i) =>
              "<i style='transform:rotate(" + i * 45 + "deg)'></i>").join("") + "</div>" : "") +
          '<span class="big mono"><span data-v="' + key + '"></span><u data-u="' + key + '"></u></span>' +
        "</div>" +
        '<div class="sec" data-sec="' + key + '"></div>' +
      "</div>";

    return (
      '<ha-card style="--s:' + (Number(c.scale) || 1) + '">' +
        '<div class="inner">' +
          (c.name ? '<div class="hdr">' + escapeHtml(c.name) + "</div>" : "") +
          '<div class="flow">' +
            '<div class="wire w-v" data-wire="solar">' + dots + "</div>" +
            '<div class="wire w-l" data-wire="batt">' + dots + "</div>" +
            '<div class="wire w-r" data-wire="grid">' + dots + "</div>" +
            node("solar", ICONS.sun, "Solar", c.solar_entity) +
            node("house", ICONS.house, "House", c.house_entity) +
            node("batt", ICONS.batt, "Battery", c.battery_soc_entity || c.battery_power_entity) +
            node("grid", ICONS.grid, "Prepaid", c.prepaid_entity) +
          "</div>" +
          '<div class="f-foot">' +
            '<div data-tile="runway"><div class="k">Prepaid runway</div>' +
              '<div class="v mono" data-v="runway"></div>' +
              '<div class="sub" data-sec="runway"></div></div>' +
            '<div><div class="k" data-k="net"></div>' +
              '<div class="v mono" data-v="net"></div>' +
              '<div class="sub" data-sec="net"></div></div>' +
          "</div>" +
        "</div>" +
      "</ha-card>"
    );
  }

  _setWire(key, mode, watts) {
    const el = this.shadowRoot.querySelector('[data-wire="' + key + '"]');
    if (!el) return;
    const sp = speedFor(watts);
    const prev = this._wireState[key] || {};
    // Only touch the DOM when something really changed: rewriting the class or
    // the duration restarts the particle animation.
    if (prev.mode !== mode) {
      el.classList.toggle("on", mode === "on");
      el.classList.toggle("rev", mode === "rev");
      prev.mode = mode;
    }
    if (prev.sp !== sp) {
      el.style.setProperty("--sp", sp);
      prev.sp = sp;
    }
    this._wireState[key] = prev;
  }

  _applyLive() {
    const root = this.shadowRoot;
    if (!root.querySelector(".flow")) { this._render(); return; }
    const c = this._config;
    const m = this._model();
    const kwDigits = Math.max(0, Math.min(3, Number(c.round)));

    const set = (sel, txt) => { const e = root.querySelector(sel); if (e) e.textContent = txt; };
    const col = (key, colour) => {
      const e = root.querySelector('[data-node="' + key + '"]');
      if (e) e.style.color = colour;
    };
    const fill = (key, pct) => {
      const e = root.querySelector('[data-node="' + key + '"] .fill');
      if (e) e.style.height = Math.max(0, Math.min(100, pct)) + "%";
    };

    // --- nodes ---
    set('[data-v="solar"]', this._fmt(m.solar, kwDigits));
    set('[data-u="solar"]', "kW");
    col("solar", this._colorFor("solar", m.solar));
    const solarNode = root.querySelector('[data-node="solar"]');
    if (solarNode) solarNode.classList.toggle("live", m.solar > 0.02 && c.animate !== false);

    set('[data-v="house"]', this._fmt(m.house, kwDigits));
    set('[data-u="house"]', "kW");
    col("house", this._colorFor("house", m.house));
    const houseNode = root.querySelector('[data-node="house"]');
    if (houseNode) houseNode.classList.toggle("busy", m.house > 0.1 && c.animate !== false);

    set('[data-v="batt"]', m.soc === null ? "–" : this._fmt(m.soc, 0));
    set('[data-u="batt"]', m.soc === null ? "" : "%");
    col("batt", this._colorFor("battery", m.soc));
    fill("batt", m.soc === null ? 0 : m.soc);
    set('[data-sec="batt"]', m.battPower === null ? ""
      : (m.battPower >= 0 ? "+" : "−") + this._fmt(Math.abs(m.battPower), kwDigits) + " kW");

    set('[data-v="grid"]', m.prepaid === null ? "–" : this._fmt(m.prepaid, 1));
    set('[data-u="grid"]', "");
    col("grid", this._colorFor("prepaid", m.prepaid));
    fill("grid", m.prepaid === null ? 0 : (m.prepaid / this._prepaidFull()) * 100);
    const importing = m.grid > 0.02;
    set('[data-sec="grid"]', importing ? "▼ " + this._fmt(m.grid, kwDigits) + " kW" : "no import");
    const gridSec = root.querySelector('[data-sec="grid"]');
    if (gridSec) gridSec.classList.toggle("idle", !importing);

    // --- wires ---
    this._setWire("solar", m.solar > 0.02 ? "on" : "off", m.solar * 1000);
    this._setWire("batt",
      m.charge > 0.02 ? "rev" : m.discharge > 0.02 ? "on" : "off",
      Math.max(m.charge, m.discharge) * 1000);
    // Prepaid only ever flows into the house.
    this._setWire("grid", importing ? "on" : "off", m.grid * 1000);

    // --- footer ---
    const runwayEl = root.querySelector('[data-v="runway"]');
    if (runwayEl) {
      runwayEl.textContent = m.runway === null ? "–" : this._fmt(m.runway, 1) + " days";
      runwayEl.style.color = m.runway === null
        ? "var(--secondary-text-color)" : this._colorFor("runway", m.runway);
    }
    // Show the burn rate the runway is actually dividing by - it is the number
    // that explains the days figure. Which sensor it came from goes in the
    // tooltip rather than taking up the line.
    const runwayTile = root.querySelector('[data-tile="runway"]');
    if (this._burnPerDay) {
      set('[data-sec="runway"]',
          this._fmt(this._burnPerDay, 1) + " kWh/day · " + c.runway_window_days + "-day avg");
      if (runwayTile) runwayTile.title = "Averaged from the " + this._burnSource;
    } else {
      set('[data-sec="runway"]', "not enough history yet");
      if (runwayTile) runwayTile.title = "";
    }

    const up = m.net >= 0;
    set('[data-k="net"]', up ? "Solar surplus" : "Net draw");
    const netEl = root.querySelector('[data-v="net"]');
    if (netEl) {
      netEl.textContent = (up ? "▲ " : "▼ ") + this._fmt(Math.abs(m.net), kwDigits) + " kW";
      netEl.style.color = this._colorFor("net", m.net);
    }
    let sub;
    if (up) sub = m.charge > 0.02 ? "charging the battery" : "solar covering the house";
    else {
      const from = [];
      if (m.discharge > 0.02) from.push("battery");
      if (importing) from.push("prepaid");
      sub = from.length ? "from " + from.join(" + ") : "covered by solar";
    }
    set('[data-sec="net"]', sub);
  }
}

/* ------------------------------------------------------------------ *
 * Styles
 * ------------------------------------------------------------------ */

EnergyFlowCard.styles = [
  ":host { display: block;",
  "  --ef-hair: var(--divider-color, rgba(127,137,150,0.2));",
  "  --ef-faint: var(--disabled-text-color, var(--secondary-text-color));",
  "  --ef-track: rgba(127,137,150,0.26);",
  "  --ef-sunk: rgba(127,137,150,0.12);",
  "  --w-solar: #ffc93f; --w-batt: #56ccf2; --w-grid: #a78bfa; }",

  // Everything derives from --ring, which tracks the card's own width. A fixed
  // size is wrong on some card somewhere; this grows and shrinks as one piece.
  "ha-card { padding: 16px; --s: 1; }",
  // --ring is measured in JS and written inline. It deliberately does NOT
  // use container query units: those need WebView 105+, and an older
  // Android WebView (Fully Kiosk) makes the whole value invalid, which
  // takes every derived size with it and collapses the card to one line.
  // This static value is the floor if ResizeObserver is missing too.
  ".inner { --ring: calc(84px * var(--s));",
  "  --val: calc(var(--ring) * 0.30); --lab: calc(var(--ring) * 0.115);",
  "  --sec: calc(var(--ring) * 0.165); --nw: calc(var(--ring) * 1.06);",
  "  --gap: calc(var(--ring) * 0.34); --labh: calc(var(--lab) * 2.2);",
  "  --row2: calc(var(--labh) + var(--ring) + var(--gap)); }",
  ".mono { font-family: ui-monospace, 'SF Mono', 'Cascadia Mono', Menlo, Consolas, monospace;",
  "  font-variant-numeric: tabular-nums; }",
  ".hdr { font-size: 13px; font-weight: 600; margin-bottom: 10px;",
  "  color: var(--primary-text-color); }",

  "@keyframes ef-spin { to { transform: rotate(360deg); } }",
  "@keyframes ef-bob { 0%,100% { transform: scale(1); } 50% { transform: scale(1.05); } }",

  // Two label rows, two rings, the gap and the secondary line.
  ".flow { position: relative;",
  "  height: calc(var(--labh)*2 + var(--ring)*2 + var(--gap) + var(--sec)*1.5); }",
  ".node { position: absolute; width: var(--nw); text-align: center; cursor: pointer; }",
  ".node .lab { display: flex; align-items: center; justify-content: center; gap: 4px;",
  "  height: var(--labh); font-size: var(--lab); font-weight: 700; letter-spacing: 0.11em;",
  "  text-transform: uppercase; opacity: 0.9; }",
  ".node .lab svg { width: calc(var(--lab) * 1.35); height: calc(var(--lab) * 1.35); }",
  ".node .ring { width: var(--ring); height: var(--ring); margin: 0 auto; border-radius: 50%;",
  "  position: relative; display: flex; align-items: center; justify-content: center;",
  "  background: var(--ef-sunk); border: 2px solid currentColor; overflow: hidden; }",
  ".node .fill { position: absolute; left: 0; right: 0; bottom: 0; height: 0;",
  "  background: currentColor; opacity: 0.22; transition: height 0.5s ease; }",
  ".node .fill::after { content: ''; position: absolute; left: 0; right: 0; top: 0; height: 2px;",
  "  background: currentColor; opacity: 0.85; }",
  ".node .big { position: relative; z-index: 1; font-size: var(--val); font-weight: 600;",
  "  line-height: 1; letter-spacing: -0.02em; }",
  ".node .big u { text-decoration: none; font-size: calc(var(--val) * 0.42);",
  "  opacity: 0.7; margin-left: 1px; }",
  ".node .sec { font-size: var(--sec); font-weight: 600; line-height: 1.35;",
  "  height: calc(var(--sec) * 1.5); }",
  ".node .sec.idle { opacity: 0.45; font-weight: 500; }",
  ".n-solar { top: 0; left: 50%; transform: translateX(-50%); }",
  ".n-house { top: var(--row2); left: 50%; transform: translateX(-50%); }",
  ".n-batt { top: var(--row2); left: 0; }",
  ".n-grid { top: var(--row2); right: 0; }",
  ".n-solar .rays { position: absolute; inset: calc(var(--ring) * -0.09); }",
  ".n-solar .rays i { position: absolute; left: 50%; top: 0; width: 2px;",
  "  height: calc(var(--ring) * 0.09); margin-left: -1px; border-radius: 1px;",
  "  background: currentColor; opacity: 0.65;",
  "  transform-origin: 50% calc(var(--ring) * 0.59); }",
  ".n-solar.live .rays { animation: ef-spin 9s linear infinite; }",
  ".n-house.busy .ring { animation: ef-bob 2.4s ease-in-out infinite; }",

  ".wire { position: absolute; background: var(--ef-track); border-radius: 2px; }",
  ".w-v { width: 3px; left: 50%; margin-left: -1.5px;",
  "  top: calc(var(--labh) + var(--ring)); height: var(--gap); color: var(--w-solar); }",
  ".w-l { height: 3px; left: var(--nw); right: calc(50% + var(--nw)/2);",
  "  top: calc(var(--row2) + var(--labh) + var(--ring)/2); color: var(--w-batt); }",
  ".w-r { height: 3px; left: calc(50% + var(--nw)/2); right: var(--nw);",
  "  top: calc(var(--row2) + var(--labh) + var(--ring)/2); color: var(--w-grid); }",
  ".wire .dot { position: absolute; width: 7px; height: 7px; border-radius: 50%;",
  "  background: currentColor; opacity: 0; }",
  ".w-v .dot { left: -2px; } .w-l .dot, .w-r .dot { top: -2px; }",
  "@keyframes ef-fv { 0% { top: 0; opacity: 0; } 15% { opacity: 1; }",
  "  85% { opacity: 1; } 100% { top: 100%; opacity: 0; } }",
  "@keyframes ef-fr { 0% { left: 0; opacity: 0; } 15% { opacity: 1; }",
  "  85% { opacity: 1; } 100% { left: 100%; opacity: 0; } }",
  "@keyframes ef-fl { 0% { left: 100%; opacity: 0; } 15% { opacity: 1; }",
  "  85% { opacity: 1; } 100% { left: 0; opacity: 0; } }",
  ".w-v.on .dot { animation: ef-fv var(--sp, 1.5s) linear infinite; }",
  ".w-l.on .dot { animation: ef-fr var(--sp, 1.5s) linear infinite; }",
  ".w-l.rev .dot { animation: ef-fl var(--sp, 1.5s) linear infinite; }",
  ".w-r.on .dot { animation: ef-fl var(--sp, 1.5s) linear infinite; }",
  ".wire .dot:nth-child(2) { animation-delay: calc(var(--sp, 1.5s) / 3); }",
  ".wire .dot:nth-child(3) { animation-delay: calc(var(--sp, 1.5s) / 3 * 2); }",

  ".f-foot { display: flex; gap: 8px; margin-top: calc(var(--ring) * 0.14); }",
  ".f-foot > div { flex: 1 1 0; background: var(--ef-sunk); border-radius: 9px;",
  "  padding: calc(var(--ring)*0.09) calc(var(--ring)*0.12); min-width: 0; }",
  ".f-foot .k { font-size: var(--lab); letter-spacing: 0.1em; text-transform: uppercase;",
  "  color: var(--ef-faint); font-weight: 700; }",
  ".f-foot .v { font-size: calc(var(--ring) * 0.215); font-weight: 600; margin-top: 3px;",
  "  line-height: 1.1; white-space: nowrap; }",
  ".f-foot .sub { font-size: calc(var(--lab) * 0.98); color: var(--ef-faint); margin-top: 3px;",
  "  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }",

  "@media (prefers-reduced-motion: reduce) {",
  "  .wire .dot, .n-solar .rays, .n-house .ring { animation: none !important; } }",
].join("\n");

/* ------------------------------------------------------------------ *
 * Visual editor
 * ------------------------------------------------------------------ */

const SCHEMA = [
  { name: "name", selector: { text: {} } },
  { name: "solar_entity", selector: { entity: { domain: ["sensor"] } } },
  { name: "house_entity", selector: { entity: { domain: ["sensor"] } } },
  { name: "grid_entity", selector: { entity: { domain: ["sensor"] } } },
  { name: "battery_soc_entity", selector: { entity: { domain: ["sensor"] } } },
  { name: "battery_power_entity", selector: { entity: { domain: ["sensor"] } } },
  { name: "prepaid_entity", selector: { entity: { domain: ["sensor"] } } },
  {
    type: "grid",
    schema: [
      { name: "battery_power_invert", selector: { boolean: {} } },
      { name: "grid_power_invert", selector: { boolean: {} } },
      { name: "animate", selector: { boolean: {} } },
      { name: "round", selector: { number: { min: 0, max: 3, mode: "box" } } },
      { name: "scale", selector: { number: { min: 0.6, max: 1.6, step: 0.05, mode: "box" } } },
      { name: "runway_window_days", selector: { number: { min: 1, max: 60, mode: "box" } } },
      { name: "prepaid_full", selector: { number: { mode: "box", step: "any" } } },
      { name: "runway_threshold", selector: { number: { mode: "box", step: "any" } } },
    ],
  },
  {
    type: "grid",
    schema: [
      { name: "solar_bad", selector: { number: { mode: "box", step: "any" } } },
      { name: "solar_good", selector: { number: { mode: "box", step: "any" } } },
      { name: "house_bad", selector: { number: { mode: "box", step: "any" } } },
      { name: "house_good", selector: { number: { mode: "box", step: "any" } } },
      { name: "battery_bad", selector: { number: { mode: "box", step: "any" } } },
      { name: "battery_good", selector: { number: { mode: "box", step: "any" } } },
      { name: "prepaid_bad", selector: { number: { mode: "box", step: "any" } } },
      { name: "prepaid_good", selector: { number: { mode: "box", step: "any" } } },
    ],
  },
];

const LABELS = {
  name: "Card title",
  solar_entity: "Solar production (W or kW)",
  house_entity: "House load — leave blank to derive",
  grid_entity: "Grid import — leave blank to derive",
  battery_soc_entity: "Battery charge (%)",
  battery_power_entity: "Battery power (W or kW)",
  prepaid_entity: "Prepaid balance (kWh)",
  battery_power_invert: "Battery sensor is + when discharging",
  grid_power_invert: "Grid sensor is + when exporting",
  animate: "Animations",
  round: "Decimal places",
  scale: "Size multiplier",
  runway_window_days: "Runway window (days)",
  prepaid_full: "Prepaid 'full' (blank = auto)",
  runway_threshold: "Runway red below (days)",
  solar_bad: "Solar red at (kW)", solar_good: "Solar green at (kW)",
  house_bad: "House red at (kW)", house_good: "House green at (kW)",
  battery_bad: "Battery red at (%)", battery_good: "Battery green at (%)",
  prepaid_bad: "Prepaid red at", prepaid_good: "Prepaid green at",
};

class EnergyFlowCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._hass = null;
    this._form = null;
  }

  setConfig(config) {
    this._config = Object.assign({}, config);
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._form) this._form.hass = hass;
  }

  _render() {
    if (!this._form) {
      const form = document.createElement("ha-form");
      form.computeLabel = (s) => LABELS[s.name] || s.name;
      form.addEventListener("value-changed", (ev) => {
        ev.stopPropagation();
        const next = Object.assign({}, ev.detail.value);
        Object.keys(next).forEach((k) => {
          if (next[k] === "" || next[k] === undefined || next[k] === null) delete next[k];
        });
        this._config = next;
        this.dispatchEvent(new CustomEvent("config-changed", {
          detail: { config: next }, bubbles: true, composed: true,
        }));
      });
      this.shadowRoot.appendChild(form);
      this._form = form;
    }
    this._form.schema = SCHEMA;
    this._form.data = this._config;
    if (this._hass) this._form.hass = this._hass;
  }
}

customElements.define("prepaid-energy-flow-card", EnergyFlowCard);
customElements.define("prepaid-energy-flow-card-editor", EnergyFlowCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "prepaid-energy-flow-card",
  name: "Prepaid Energy Flow Card",
  description: "Solar, house, battery and prepaid meter as one animated flow diagram.",
  preview: true,
});

console.info(
  "%c PREPAID-ENERGY-FLOW-CARD %c v" + CARD_VERSION + " ",
  "color: #1b1205; background: #ffc93f; font-weight: 700;",
  "color: #ffc93f; background: #222; font-weight: 700;"
);
