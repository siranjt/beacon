import { BeaconAmbient } from "./BeaconAmbient";

/**
 * BeaconPageShell — the umbrella's standard page wrapper.
 *
 * Every Beacon agent page should be wrapped in this:
 *  - Adds the BeaconAmbient flame + pulse ring + ember layer behind everything
 *  - Sets up the content z-index above the ambient
 *  - Applies the `.beacon-page` Watchfire typography scope:
 *      · Georgia serif headings via globals.css
 *      · `.brand-gradient-text` heraldic gradient (Sea Lapis → Char → Crimson → Brass)
 *      · `.live-dot` pulsing indicator
 *  - Standard end-to-end padding (32px top, 40px sides, 56px bottom)
 *  - No max-width — content reaches the viewport edge like v1 Customer Beacon
 *
 * Usage:
 *   <BeaconPageShell>
 *     <YourAgentHeader />
 *     <YourAgentHero />
 *     <YourAgentBody />
 *   </BeaconPageShell>
 *
 * Override `padding` if a page needs different breathing room. Otherwise
 * use the default for visual parity across agents.
 */
export default function BeaconPageShell({
  children,
  padding = "32px 40px 56px",
}: {
  children: React.ReactNode;
  padding?: string;
}) {
  return (
    <main
      className="beacon-page"
      style={{
        position: "relative",
        minHeight: "100vh",
        background: "var(--zoca-bg)",
        color: "var(--zoca-text)",
      }}
    >
      <BeaconAmbient />
      <div style={{ position: "relative", zIndex: 10, padding }}>{children}</div>
    </main>
  );
}
