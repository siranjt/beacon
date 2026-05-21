/**
 * Vertical → playbook lookup. Resolution order for any (vertical, action_id):
 *   1. The vertical's own playbook
 *   2. The default playbook
 * Returns undefined only if neither has the action — which shouldn't happen
 * for the IDs we currently support, but we keep the type honest.
 */

import type { Vertical } from "../types";
import { defaultPlaybook } from "./default";
import { spaMassagePlaybook } from "./spa_massage";
import { hairSalonPlaybook } from "./hair_salon";
import { nailSalonPlaybook } from "./nail_salon";
import { medSpaPlaybook } from "./med_spa";
import { beautySpecialtyPlaybook } from "./beauty_specialty";
import { barberPlaybook } from "./barber";
import { tanningPlaybook } from "./tanning";
import type { ActionBlock, ActionId, Playbook } from "./types";

const PLAYBOOKS: Record<Vertical, Playbook> = {
  spa_massage: spaMassagePlaybook,
  hair_salon: hairSalonPlaybook,
  nail_salon: nailSalonPlaybook,
  med_spa: medSpaPlaybook,
  beauty_specialty: beautySpecialtyPlaybook,
  barber: barberPlaybook,
  tanning: tanningPlaybook,
  default: {},
};

/** Resolve an action block for (vertical, actionId), falling back to default. */
export function getActionBlock(
  vertical: Vertical,
  actionId: ActionId
): ActionBlock | undefined {
  return PLAYBOOKS[vertical]?.[actionId] ?? defaultPlaybook[actionId];
}

export { defaultPlaybook };
export type { ActionBlock, ActionId, Playbook } from "./types";
