import Link from "next/link";
import ZocaLogo from "@/components/ZocaLogo";
import { BeaconMark } from "@/components/BeaconMark";
import HealthBadge from "./HealthBadge";

/**
 * Shared header for every Escalation Beacon page.
 *
 * Left: ZOCA wordmark | divider | animated flame + Beacon (links to umbrella root)
 * Right: agent sub-nav (Customer 360 home, Queue, Triage, All tickets) + HealthBadge
 *
 * Pass `current` to dim the active link.
 */
export default function EscalationHeader({
  current,
}: {
  current?: "home" | "queue" | "triage" | "tickets";
}) {
  return (
    <header className="flex items-center justify-between mb-12">
      <Link
        href="/"
        className="flex items-center gap-4 text-text no-underline"
        style={{ color: "inherit", textDecoration: "none" }}
      >
        <ZocaLogo height={22} />
        <span
          aria-hidden
          style={{ width: 1, height: 22, background: "#D4C29B", display: "inline-block" }}
        />
        <span className="flex items-center gap-2">
          <BeaconMark size={26} flicker />
          <span style={{ fontFamily: 'Georgia, "Times New Roman", serif', fontWeight: 500, fontSize: 18 }}>
            Beacon
          </span>
        </span>
      </Link>
      <div className="flex items-center gap-6">
        <NavLink href="/escalation" label="Customer 360" active={current === "home"} />
        <NavLink href="/escalation/queue" label="Queue" active={current === "queue"} />
        <NavLink href="/escalation/triage" label="Triage" active={current === "triage"} />
        <NavLink href="/escalation/tickets" label="All tickets" active={current === "tickets"} />
        <HealthBadge />
      </div>
    </header>
  );
}

function NavLink({ href, label, active }: { href: string; label: string; active?: boolean }) {
  return (
    <Link
      href={href}
      className={
        active
          ? "text-sm text-text font-semibold"
          : "text-sm text-muted2 hover:text-text transition-colors"
      }
    >
      {label}
    </Link>
  );
}
