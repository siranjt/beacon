/**
 * The five SQL queries that power the report. All take a single
 * {{entity_id}} template tag and filter to one entity. Database id annotated
 * on each query (Aurora=7, Postgres=2).
 */

/** Aurora db=7 → gbp.locations (1 row per entity) */
export const SQL_LOCATION = `
SELECT
  entity_id::text AS entity_id,
  name AS location_name,
  title,
  language_code,
  categories->'primary_category'->>'display_name' AS vertical_display,
  categories->'primary_category'->>'name'         AS vertical_id,
  storefront_address->>'locality'              AS city,
  storefront_address->>'administrative_area'   AS state,
  storefront_address->>'region_code'           AS country,
  phone_numbers->>'primary_phone'              AS phone,
  metadata->>'place_id'                         AS place_id,
  metadata->>'maps_uri'                         AS maps_uri,
  open_info->>'status'                          AS status,
  website_uri,
  created_at::text AS location_created_at
FROM gbp.locations
WHERE entity_id = {{entity_id}}::uuid
LIMIT 1
`;

/** Aurora db=7 → gbp.metrics joined to gbp.locations.name (monthly aggregate) */
export const SQL_GBP_CLICKS_MONTHLY = `
WITH loc AS (
  SELECT name FROM gbp.locations WHERE entity_id = {{entity_id}}::uuid
)
SELECT
  to_char(date_trunc('month', m.metrics_timestamp), 'YYYY-MM-DD') AS month,
  SUM(
      coalesce(m.website_clicks,0)
    + coalesce(m.desktop_map_clicks,0)
    + coalesce(m.desktop_search_clicks,0)
    + coalesce(m.mobile_map_clicks,0)
    + coalesce(m.mobile_search_clicks,0)
    + coalesce(m.call_clicks,0)
  )::int AS profile_clicks,
  SUM(coalesce(m.business_bookings,0))::int AS bookings,
  SUM(coalesce(m.business_direction_requests,0))::int AS direction_requests,
  SUM(coalesce(m.call_clicks,0))::int AS call_clicks
FROM gbp.metrics m
JOIN loc ON m.location_name = loc.name
WHERE m.metrics_timestamp >= '2023-01-01'
GROUP BY 1
ORDER BY 1
`;

/** Aurora db=7 → local_seo.rank (one row per keyword, computed) */
export const SQL_KEYWORD_RANKINGS = `
WITH ranked AS (
  SELECT
    keyword,
    dateval,
    min_rank,
    FIRST_VALUE(min_rank) OVER (
      PARTITION BY keyword ORDER BY dateval ASC
      ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
    ) AS first_rank,
    FIRST_VALUE(min_rank) OVER (
      PARTITION BY keyword ORDER BY dateval DESC
      ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
    ) AS latest_rank,
    MIN(min_rank) OVER (PARTITION BY keyword) AS best_rank
  FROM local_seo.rank
  WHERE entity_id = {{entity_id}}::uuid
)
SELECT DISTINCT
  keyword,
  first_rank  AS rank_when_joined,
  best_rank   AS rank_best,
  latest_rank AS rank_current
FROM ranked
ORDER BY rank_current ASC NULLS LAST, rank_best ASC NULLS LAST
LIMIT 25
`;

/** Aurora db=7 → entities.location_insights (latest forecast row) */
export const SQL_FORECAST = `
SELECT
  entity_id::text AS entity_id,
  created_at::text AS generated_at,
  predicted_6_month_revenue,
  predicted_6_month_leads,
  review_target,
  percentage_change_profile_clicks,
  with_zoca_6_month_profile_clicks,
  without_zoca_6_month_profile_clicks,
  gbp_score,
  website_score,
  gbp_audit,
  monthly_predictions,
  metadata
FROM entities.location_insights
WHERE entity_id = {{entity_id}}::uuid
ORDER BY created_at DESC
LIMIT 1
`;

/** Postgres db=2 → website.booking_enquiries (most-recent N leads) */
export const SQL_LEADS = `
SELECT
  id::text AS id,
  created_at::text AS created_at,
  status,
  source,
  utm_source,
  utm_medium,
  utm_campaign,
  service,
  service_variation_name,
  price,
  currency,
  is_l_to_b_active,
  booking_id::text AS booking_id,
  attributes->>'first_name'    AS first_name,
  attributes->>'last_name'     AS last_name,
  attributes->>'email'         AS email,
  attributes->>'phone_number'  AS phone,
  attributes->>'customer_type' AS customer_type,
  conversation_summary->'messages'->>0 AS first_message
FROM website.booking_enquiries
WHERE entity_id = {{entity_id}}::uuid
  AND is_test_lead = false
ORDER BY created_at DESC
LIMIT 200
`;
