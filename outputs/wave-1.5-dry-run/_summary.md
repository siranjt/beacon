# Wave 1.5 dry-run — extraction report

Generated: 2026-06-05T09:02:45.422Z
Model: claude-haiku-4-5-20251001
Sample size: 20

## customer_notes table audit

| Metric | Value |
|---|---|
| total_rows | 167 |
| distinct_entities | 166 |
| distinct_ams | 9 |
| avg_note_length | 97 |
| max_note_length | 417 |
| total_text_length | 16191 |

## Extraction stats

- Total candidates emitted: **74**
- Valid (catalog-conformant): **74**
- Invalid (schema violations): **0**
- Empty extractions: 0
- API errors: 0
- Avg valid candidates per customer: 3.7

## Category distribution

| Category | Count |
|---|---|
| operational | 31 |
| concerns | 20 |
| behavioral | 14 |
| identity | 7 |
| relationship | 2 |

## Subcategory distribution (top 15)

| Subcategory | Count |
|---|---|
| renewal | 17 |
| latent_risk | 15 |
| comms_preference | 11 |
| next_call_agenda | 5 |
| performance_context | 4 |
| onboarding | 3 |
| business_profile | 2 |
| feature_usage | 2 |
| integration | 2 |
| tech_stack | 2 |
| competitive_context | 2 |
| decision_makers | 2 |
| engagement | 2 |
| assignment | 2 |
| owner_info | 1 |

## Per-customer summary

| Entity | Bizname | AMs | Chars in | Valid | Invalid | Status |
|---|---|---|---|---|---|---|
| `48416e2d` | Sante Wellness & Aesthetics | 1 | 417 | 6 | 0 | ok |
| `cca9ec0e` | Naree Massage & Spa | 1 | 350 | 6 | 0 | ok |
| `e6e817f6` | Calm Minds Matter | Reiki Practitioner, Holistic Wellness Life Coach | 1 | 315 | 4 | 0 | ok |
| `d7809778` | Browfection Studio | 1 | 294 | 4 | 0 | ok |
| `127d40cf` | Sadjo African Hair Braiding | 1 | 293 | 4 | 0 | ok |
| `96cacad9` | Habibti Salon - Hair and Beauty | Braiding | 1 | 277 | 3 | 0 | ok |
| `adbaf37a` | Manny - Online & Personal Fitness Trainer | 1 | 277 | 5 | 0 | ok |
| `88298ef3` | Sky Dental Clinic | Best dentist in koramangala | 1 | 268 | 5 | 0 | ok |
| `6fa7c16b` | Hydrat8 Med spa & Wellness | 1 | 267 | 5 | 0 | ok |
| `2660da42` | Radiant Elements Medical Spa | 1 | 262 | 3 | 0 | ok |
| `fce7a080` | Houston Mobile Massage - Swedish massage, Deep Tissue Massage, Gua Shua in Houston, TX | 1 | 251 | 2 | 0 | ok |
| `4e73850c` | Rosy Tips Nail Salon Chula Vista CA | 1 | 249 | 4 | 0 | ok |
| `68fef837` | Your New Barber | 1 | 241 | 3 | 0 | ok |
| `4ed0f5bc` | Patrick Einwechter & Son, Inc | 1 | 224 | 2 | 0 | ok |
| `8819ec3f` | Waxflower spa, Eyebrows Threading, Laser Hair Removal | 1 | 221 | 4 | 0 | ok |
| `5265074e` | Contornos Studio | Eyebrows, Lashes & Facials | 1 | 214 | 2 | 0 | ok |
| `31d8b0b4` | Glo Spa | 1 | 214 | 4 | 0 | ok |
| `eba5da75` | Connected Health Suwanee | 1 | 199 | 2 | 0 | ok |
| `044dfbd0` | Millie's All About You Salon Spa | 1 | 192 | 3 | 0 | ok |
| `e7b45fde` | Celebrityz Barbershop | 1 | 179 | 3 | 0 | ok |

## How to review this

1. Open `_summary.md` (this file) — start here. Look at the category distribution + per-customer table to spot outliers.
2. Sample-read 3-5 of the `<entity_id>-<bizname>.json` files. Focus on the `candidate_facts` array.
3. For each candidate, ask:
   - Is the (category, subcategory, field_name) classification right?
   - Is the value accurate to the source_quote? (No invention, no inference.)
   - Is anything missing that's clearly in the notes?
4. If quality is solid: approve to ship the Validate inbox + run on the full book.
5. If the prompt needs tuning: send back specific failure cases and we'll iterate before the full run.