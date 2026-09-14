# Prepaid Energy Flow Card

A Home Assistant dashboard card showing solar, house, battery and a prepaid
electricity meter as one animated flow diagram, with figures sized to be read
from across a room. It answers two questions separate cards can't: **is solar
covering the house right now**, and **how long will the prepaid units last at
your real rate of use**.

![Prepaid Energy Flow Card](https://raw.githubusercontent.com/rumpushome/prepaid-energy-flow-card/main/images/preview.png)

The prepaid meter is optional, and without it the card is a plain solar/battery
flow.

## Install

### HACS

[![Open this repository in HACS](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=rumpushome&repository=prepaid-energy-flow-card&category=plugin)

Or add it by hand:
1. Go to **HACS → ⋮ → Custom repositories**.
2. Paste `https://github.com/rumpushome/prepaid-energy-flow-card` and choose type **Dashboard**.
3. Download **Prepaid Energy Flow Card**. HACS adds the dashboard resource for you.

### Manual

1. Download `prepaid-energy-flow-card.js` from the
   [latest release](https://github.com/rumpushome/prepaid-energy-flow-card/releases/latest)
   and copy it into `config/www/`.
2. **Settings → Dashboards → ⋮ → Resources → + Add Resource**
   - URL: `/local/prepaid-energy-flow-card.js?v=1`
   - Type: **JavaScript Module**
3. Hard-refresh, then **+ Add Card** → **Prepaid Energy Flow Card**.

## Example configuration

```yaml
type: custom:prepaid-energy-flow-card
solar_entity: sensor.solar_power
battery_soc_entity: sensor.battery_soc
battery_power_entity: sensor.battery_power
battery_power_invert: true          # this sensor reads + while discharging
house_entity: sensor.house_power
prepaid_entity: sensor.prepaid_balance
```

### House load or grid import?

These are easy to mix up. They're related, but not the same:

```
solar + battery_discharge + grid_import = house_load
```

On Sunsynk and Deye inverters, for example, the `load_power` sensor means
**total house load**, not grid import.

**How to tell:** at night, with no solar and the battery supplying about 2 kW:

- if the sensor also reads about 2 kW, it's **house load**, so use it as `house_entity`;
- if it reads near zero, it's **grid import**, so use it as `grid_entity`.

Whichever of the two you leave blank is worked out from the sum above, so the
card works either way. But putting a sensor in the wrong one makes both the
House and Prepaid figures wrong.

If you have sensors for both, set both and nothing is worked out.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `name` | – | Card title. Leave it out and no title row is drawn at all. |
| `solar_entity` | – | Solar production. W, kW or MW, converted automatically. |
| `house_entity` | – | House load. Worked out if left out. |
| `grid_entity` | – | Grid import. Worked out if left out. |
| `battery_soc_entity` | – | Battery charge, %. |
| `battery_power_entity` | – | Battery power. |
| `battery_power_invert` | `true` | Turn on if your sensor is **+ while discharging**. The card always shows **+ charging, − discharging**. |
| `grid_power_invert` | `false` | Turn on if your grid sensor is + when exporting. |
| `prepaid_entity` | – | Prepaid balance, kWh. |
| `prepaid_full` | auto | The "full" balance the prepaid ring fills against. Auto = the highest balance seen in the window. |
| `runway_window_days` | `7` | How many days the runway averages over. |
| `runway_threshold` | `5` | The runway turns red below this many days. |
| `scale` | `1` | Size multiplier on top of the automatic sizing. |
| `round` | `2` | Decimal places for kW figures. |
| `animate` | `true` | Moving flows, sun rays, house pulse. |
| `solar_bad` / `solar_good` | `1` / `5` | kW. |
| `house_bad` / `house_good` | `5` / `1` | kW. Note that "good" is the *lower* number here. |
| `battery_bad` / `battery_good` | `30` / `100` | %. |
| `prepaid_bad` / `prepaid_good` | `50` / `200` | Balance units. |

## Units

Solar, house, battery and grid are **power** sensors, so the card shows **kW**,
not kWh. kWh measures energy built up over time and would be wrong for a live
reading. A prepaid balance really is kWh, so it stays kWh.

W, kW and MW are detected from each sensor's `unit_of_measurement`, so you don't
need template sensors to convert them.

## Colour

Every figure is coloured by how good it is, from red through amber to green:

| | Red at | Green at |
| --- | --- | --- |
| Solar | ≤1 kW | ≥5 kW |
| Battery | 30% | 100% |
| Prepaid | ≤50 | ≥200 |
| House | ≥5 kW | ≤1 kW |
| Runway | <5 days | ≥5 days (straight switch, no in-between) |
| Surplus | negative | positive (straight switch, no in-between) |

The colours pass through amber rather than going straight from red to green,
which would be a muddy brown in the middle, where most readings sit.

**The connecting lines keep fixed colours** (amber = solar, cyan = battery,
violet = prepaid). If the circles *and* the lines all turned red and green, you'd
lose the ability to see which path is live, which is the point of the diagram.

## The prepaid runway

Prepaid units are only used when the house draws more than solar and the battery
can cover:

```
import = max(0, house − solar − battery_discharge)
```

That live figure is shown under the prepaid balance. But it **can't** be the
basis for the runway: most of the time it's zero, which would make the runway
endless until a cloud passed.

So the runway uses **how fast the prepaid balance itself has fallen** over the
window, read from long-term statistics. That's the real figure: it needs no
assumptions about solar or the battery, and already includes whatever they
contributed. **Top-ups are ignored**, because a balance that jumps *up* isn't
negative usage.

One known limitation: the hour in which a top-up lands is skipped entirely,
because usage and the top-up can't be separated within the same hour. That costs
about 0.6% of the data on a 7-day window.

If there's no usable statistics history, the card falls back to a configured
`grid_entity`'s own average. If that's missing too, it says **"not enough history
yet"** rather than making up a number.

The caption under the runway shows the rate it divides by, e.g.
`5.0 kWh/day · 30-day avg`, since that's the number that explains the days
figure. The sensor the average came from is in the tile's tooltip.

## Sizing

All the sizes come from one value that follows the card's own width, so the
whole card grows and shrinks as one piece and can't break its own layout:

| Card width | Main figures |
| --- | --- |
| 340px | ~23px |
| 470px | ~33px |
| 620px | ~44px |

For a wall tablet, give the card more width rather than raising `scale`: you get
bigger figures without the layout getting cramped.

The size is **measured in JavaScript** (`ResizeObserver`) rather than with CSS
container query units. Kiosk browsers such as Fully Kiosk often run an older
Android System WebView without container query support, and there the card would
collapse onto a single line. If `ResizeObserver` is missing too, a fixed size
applies and the card still lays out correctly, just without adapting to width.

## Troubleshooting

**Card doesn't appear**
The resource isn't loading. Check the URL and that the type is *JavaScript
Module*. The browser console logs `PREPAID-ENERGY-FLOW-CARD v1.1.1` when the
card loads.

**Battery sign is backwards**
Flip `battery_power_invert`. The card always shows + charging, − discharging.

**House or Prepaid figure looks wrong**
Almost certainly the house-load-or-grid-import question above. Swap the sensor
between `house_entity` and `grid_entity` and see which makes the diagram add up.

**Prepaid shows "no import" while the meter is clearly running**
The worked-out import is `house − solar − battery_discharge`. If your house sensor
is actually grid import, that sum is wrong. See above.

**Runway says "not enough history yet"**
The prepaid sensor has no long-term statistics. It needs `state_class:
measurement` for Home Assistant to keep them, and they build up from that point.

**The moving flows stutter**
They shouldn't: flow speed moves in six fixed steps precisely so that small
changes in wattage don't restart the animation. If you see it, open an issue with
the card width and the wattage.

## Licence

[MIT](LICENSE)
