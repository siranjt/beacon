// Phase 33.D — HubSpot constants.
//
// Confirmed via API probe on 2026-05-15 against
// https://api.hubapi.com/crm/v3/properties/2-221793621
//
// - Portal lives on the NA2 region (app-na2.hubspot.com).
// - The custom Locations object has objectTypeId "2-221793621".
// - Each Locations record has a `location_entity_id` property holding the
//   Zoca entity_id UUID. Sample: "Renee The Hair Pro" → bb90f09a-f557-...

export const HUBSPOT_PORTAL_ID = "243752563";
export const HUBSPOT_REGION = "na2"; // app-na2.hubspot.com
export const HUBSPOT_LOCATIONS_OBJECT_ID = "2-221793621";
export const HUBSPOT_LOCATION_ENTITY_ID_PROPERTY = "location_entity_id";

/**
 * Build a deep-link to a HubSpot Locations record.
 * Pattern (NA2 region):
 *   https://app-na2.hubspot.com/contacts/<portal>/record/<objectTypeId>/<recordId>
 */
export function buildHubspotLocationUrl(locationRecordId: string): string {
  return `https://app-${HUBSPOT_REGION}.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/${HUBSPOT_LOCATIONS_OBJECT_ID}/${locationRecordId}`;
}
