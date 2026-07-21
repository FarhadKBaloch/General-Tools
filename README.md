# General Tools

A small collection of self-contained browser tools.

## Weighted-Average Plug Pricing — `plug-pricing-calculator.html`

Determine plug prices from a job spreadsheet by rolling line items up into
**quantity-weighted average** costs — the blended price to pay (or charge) per plug.

Open the file in any browser; nothing is installed and no data leaves your machine.

### What it does

- **Group** line items by plug size (cell count), form (CP / LP), vendor,
  finished container, or a combination (e.g. Form × Cell, Vendor × Form).
- **Weight** each group by *qty needed* or *qty to buy* and compute
  `weighted cost = Σ(cost × qty) ÷ Σqty`.
- **Landed cost** applies a shipping % (defaults to 20%, matching the source sheet);
  an optional **sell markup %** produces a suggested price.
- **Set group cost** writes one negotiated plug price onto every line in a group at
  once — useful when a vendor quotes a flat rate for, say, all 72-cell CP.
- Summary tiles, a magnitude bar per group, and CSV export for both the group
  rollup and the priced line items.

### Loading data

- **Load Franklin Park** — the bundled sample (125 line items). Plug costs were
  stripped from the source file, so every cost starts blank for you to fill in.
- **Upload spreadsheet** — an `.xlsx`/`.xls`/`.csv` in the Franklin Park column
  layout (name, qty, container, cell count, form, plug cost, …, qty to buy, …, vendor, notes).

### Glossary

- **Plug** — one young plant from a tray. The tray's **cell count** (21, 32, 50, 72…) is the plug size.
- **Form** — `CP` cutting plug, `LP` liner plug.
- **Landed** — plug cost plus shipping.
