/**
 * Maps a Google primary-category display name to one of our action-library
 * playbooks. Several Google categories share the same advice (e.g. Hair
 * salon and Hairdresser), so we collapse them to a single playbook key.
 */

import type { Vertical } from "./types";

const MAP: Record<string, Vertical> = {
  // Hair-side
  "hair salon": "hair_salon",
  hairdresser: "hair_salon",

  // Nail-side
  "nail salon": "nail_salon",
  manicuría: "nail_salon",

  // Spa / massage
  spa: "spa_massage",
  "day spa": "spa_massage",
  "facial spa": "spa_massage",
  "massage spa": "spa_massage",
  "massage therapist": "spa_massage",

  // Med spa adjacent
  "medical spa": "med_spa",
  "permanent make-up clinic": "med_spa",

  // Specialty beauty
  "beauty salon": "beauty_specialty",
  "beauty parlour": "beauty_specialty",
  "eyelash salon": "beauty_specialty",
  "waxing hair removal service": "beauty_specialty",

  // Standalone
  "barber shop": "barber",
  "tanning salon": "tanning",
};

export function canonicalizeVertical(display: string | null | undefined): Vertical {
  if (!display) return "default";
  return MAP[display.trim().toLowerCase()] ?? "default";
}
