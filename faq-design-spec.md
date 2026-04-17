# FAQ Section Design Spec — TXGasPrices.net
## Approved design — integrate exactly as described

---

## STRUCTURE (top to bottom)

### 1. HEADER
```
[Title left]                              [Live dot · Time CT · Temp emoji]
Fuel prices & local data — {CITY}, TX ⛽
[pill][pill][pill][pill][pill][pill]
```

- Title: `Fuel prices & local data — {CITY_NAME}, TX ⛽`
- Right side: green live dot (5px circle #1D9E75) + time in CT + weather temp + weather emoji
- Pills row below title: County, Region, Primary highway, Population formatted, Elevation

### 2. LOCAL CONTEXT LINE
- Italic sentence from `cities-info.json → local_fact`
- Background: `var(--color-background-secondary)`
- Border bottom: `0.5px solid var(--color-border-tertiary)`
- Font: 11.5px italic, color: `var(--color-text-secondary)`

### 3. STAT CARDS (4 cards in a row)
| Card | Value | Label |
|------|-------|-------|
| 1 | Population formatted (139K / 2.3M) | population |
| 2 | vehicles_per_household from cities-info.json | vehicles / household |
| 3 | truck_ownership_pct from cities-info.json | truck ownership |
| 4 | ~$XX estimated monthly fuel | est. monthly fuel |

Monthly fuel formula: `Math.round(cheapestPrice * vehiclesPerHousehold * 12000 / 25 / 12)`

Card style: `background: var(--color-background-secondary)`, border-radius 7px, padding 7px 8px, text-center

### 4. FAQ ACCORDION
- Each question uses `<details><summary>` HTML
- Green left border `3px solid #1D9E75` when open
- Summary color turns `#1D9E75` when open
- `+` icon right side, becomes `−` when open
- Padding: 11px 16px on summary, open state gets padding-left 13px

### 5. SOURCE CITATION (bottom of each answer)
- Small gray line: `font-size: 10px, color: var(--color-text-tertiary)`
- Border-top: `0.5px solid var(--color-border-tertiary)`, padding-top 4px, margin-top 5px
- Apify cities: `Source: GasBuddy via Apify, updated {UPDATED} CT`
- AAA fallback cities: `Source: AAA Texas, updated {UPDATED} CT`

---

## MEMBERSHIP BADGE
Yellow badge inline in answer text:
```
background: #FEF3C7
color: #92400E
border: 1px solid #F59E0B
border-radius: 4px
padding: 1px 5px
font-size: 10px
font-weight: 500
```
Text: `membership price`
Only show for: Sam's Club, Costco, BJ's — NOT Walmart, NOT Walmart Neighborhood Market

---

## QUESTION TEXT RULES
- Always include `, TX` after city name in question text
- Examples:
  - "What is the cheapest gas station in Houston, TX right now?"
  - "Why aren't gas prices in Midland, TX lower given nearby oil production?"
  - "Are fuel prices cheaper near the Texas-Mexico border in Laredo, TX?"
  - "Do I need a membership to get the cheapest fuel in Allen, TX?"
  - "How much does a full tank cost in College Station, TX?"

---

## ANSWER TEXT RULES
- Bold: chain names, prices, key numbers, highway names
- Include county name + highway in answers where relevant
- Include city, TX in first mention within answer
- All prices: 2 decimal places ($3.52 not $3.520)
- Tank costs: 15-gallon and 20-gallon always shown
- Membership answers: include breakeven math (gallons needed = membership_fee / price_diff)

---

## PILLS DATA SOURCES
All from existing data:
- County: `towns.json → county`
- Region: `cities-info.json → region` (human-readable: "Permian Basin", "South Texas", "DFW Metroplex", etc.)
- Highway: `cities-info.json → highway_primary`
- Population: `towns.json → population` (format: 139K, 2.3M)
- Elevation: hardcode per city or skip if unavailable

---

## CSS CLASSES NEEDED
```css
.faq-section { background: var(--color-background-primary); border: 0.5px solid var(--color-border-tertiary); border-radius: 12px; overflow: hidden; }
.faq-header { padding: 13px 16px; border-bottom: 0.5px solid var(--color-border-tertiary); }
.faq-title-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
.faq-title { font-size: 13px; font-weight: 500; color: var(--color-text-primary); }
.faq-live { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--color-text-secondary); flex-shrink: 0; }
.live-dot { width: 5px; height: 5px; border-radius: 50%; background: #1D9E75; flex-shrink: 0; }
.weather-val { font-size: 12px; font-weight: 500; color: var(--color-text-primary); }
.pills { display: flex; flex-wrap: wrap; gap: 4px; }
.pill { font-size: 10px; padding: 2px 7px; border-radius: 20px; background: var(--color-background-secondary); color: var(--color-text-secondary); border: 0.5px solid var(--color-border-tertiary); }
.faq-context { padding: 9px 16px; font-size: 11.5px; color: var(--color-text-secondary); line-height: 1.6; border-bottom: 0.5px solid var(--color-border-tertiary); background: var(--color-background-secondary); font-style: italic; }
.faq-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; padding: 10px 16px; border-bottom: 0.5px solid var(--color-border-tertiary); }
.faq-stat { background: var(--color-background-secondary); border-radius: 7px; padding: 7px 8px; text-align: center; }
.faq-stat-val { font-size: 14px; font-weight: 500; color: var(--color-text-primary); }
.faq-stat-lbl { font-size: 9px; color: var(--color-text-secondary); margin-top: 2px; line-height: 1.3; }
.faq-src { font-size: 10px; color: var(--color-text-tertiary); margin-top: 5px; display: block; border-top: 0.5px solid var(--color-border-tertiary); padding-top: 4px; }
.cc-mbr { display: inline-block; background: #FEF3C7; color: #92400E; border: 1px solid #F59E0B; border-radius: 4px; padding: 1px 5px; font-size: 10px; font-weight: 500; margin-left: 2px; }
```

---

## TOKENS NEEDED IN generate.js
- `{{FAQ_CITY_TITLE}}` — "Fuel prices & local data — Houston, TX ⛽"
- `{{FAQ_PILLS_HTML}}` — rendered pill row
- `{{FAQ_CONTEXT}}` — local_fact sentence from cities-info.json
- `{{FAQ_STATS_HTML}}` — 4 stat cards rendered
- `{{FAQ_ITEMS_HTML}}` — existing accordion items (unchanged)
- `{{DATA_SOURCE}}` — "GasBuddy via Apify" or "AAA Texas"
- `{{UPDATED}}` — timestamp in CT

---

## EXAMPLE OUTPUT — Midland TX
Header: `Fuel prices & local data — Midland, TX ⛽` | `9:42 AM CT  63°F ☀️`
Pills: `Midland County` `Permian Basin` `West Texas` `I-20 corridor` `139,488 residents` `2,779 ft elevation`
Context: "Midland is the business capital of the Permian Basin..."
Stats: 139K population | 2.3 vehicles/household | 42% truck ownership | ~$85 est. monthly fuel
Questions: 4 questions with source citations, membership breakeven math, city TX in all questions
