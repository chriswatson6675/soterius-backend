# Duplicate Resolution Report

Every organisation appears exactly once. Merges use STRONG identifiers only
(company number, FRN, SRA number, UKPRN, IF uuid) — never a shared domain,
because distinct firms legitimately share a domain (group brands / shared hosting).

## Merges

- **Organisations built from >1 source record:** 1857
- **Records collapsed:** 1965
- **Cross-regulator organisations (genuine multi-regulation):** 23

### Cross-regulator combinations

| Regulators | Organisations |
|---|---:|
| FCA + PRA | 19 |
| FCA + SRA | 4 |

### Sample cross-regulator organisations

- `ORG-0951D5CAE873` **Goldman Sachs International Bank** — FCA + PRA — goldmansachs.com
- `ORG-0F3E06F8CE13` **M2 Recovery Ltd** — FCA + SRA — m2recovery.com
- `ORG-1B6F40CB2319` **Barclays Capital Securities Limited** — FCA + PRA
- `ORG-2BE31BB71C84` **SAINSBURY'S FINANCIAL SERVICES LIMITED** — FCA + PRA — sainsburysbank.co.uk
- `ORG-360D433527B9` **Citibank UK Limited** — FCA + PRA
- `ORG-548A4BB86581` **ALRAYAN BANK LIMITED** — FCA + PRA — alrayanbank.co.uk
- `ORG-57BCD2A24DB8` **Credit Style Limited** — FCA + SRA — creditstyle.co.uk
- `ORG-6D8CD4CC59A1` **Castle Trust Capital PLC** — FCA + PRA — castletrust.co.uk
- `ORG-7BD1DB0C277E` **Morgan Stanley & Co. International Plc** — FCA + PRA — morganstanley.com
- `ORG-8585ABBB3B1C` **UBS AG** — FCA + PRA
- `ORG-8F82534EE9CC` **Goldman Sachs International** — FCA + PRA
- `ORG-95E23CF5A33C` **Citibank Europe plc** — FCA + PRA
- `ORG-963716909E8D` **CLIFFORD JAMES CONSULTANTS LIMITED** — FCA + SRA — clifford-james.com
- `ORG-9F9503A8FC34` **RBC Europe Limited** — FCA + PRA — rbccm.com
- `ORG-AB082BB1E17D` **JPMorgan Chase Bank, National Association** — FCA + PRA

## Contested domains (shared by >1 organisation)

To satisfy "no duplicate verified domains", each domain is owned by exactly one
organisation (best verification-source priority; ties broken by Organisation ID).
The other claimants keep the domain only as an unverified candidate and move to PENDING.

- **Distinct contested domains:** 890
- **Organisations demoted to candidate on a contested domain:** 1243

### Sample contested domains

| Domain | Owner | Other claimants |
|---|---|---:|
| hartwell.co.uk | ORG-43E772B0C1C9 | 1 |
| mandg.co.uk | ORG-19C10862406B | 2 |
| ajg.com | ORG-77203EB547C0 | 5 |
| aviva.co.uk | ORG-1A0458546331 | 4 |
| aon.com | ORG-FEA7AFD8C2E4 | 2 |
| columbiathreadneedle.com | ORG-1EC717B88EA0 | 4 |
| tankjowett.com | ORG-153E3065D710 | 3 |
| dechert.com | ORG-254AF7D8A8CB | 1 |
| bartlettgroup.com | ORG-5C3392C4CB24 | 1 |
| wearewilsons.com | ORG-49B3F6A7792F | 1 |
| partnersand.com | ORG-0CA338D53004 | 7 |
| tpicap.com | ORG-3DE0F359686B | 1 |
| ashleypage.co.uk | ORG-03FBCA68D413 | 1 |
| cliffordchance.com | ORG-161527A72F0A | 9 |
| lazardnet.com | ORG-EAD3EE991347 | 1 |
| traffords-insurance.co.uk | ORG-208787F64CD6 | 1 |
| irwinmitchell.com | ORG-3141271B2D44 | 3 |
| lycetts.co.uk | ORG-4D064A8308C9 | 1 |
| aberdeeninvestments.com | ORG-200E101735C1 | 2 |
| wdenis.co.uk | ORG-7368A6FDE0DD | 2 |
