import Link from "next/link";
import ZocaLogo from "@/components/ZocaLogo";
import { BeaconMark } from "@/components/BeaconMark";
import { V2UserMenu } from "@/components/customer/v2/V2UserMenu";

/**
 * Miss Payment Beacon — page header.
 *
 * Mirrors EscalationHeader's lockup: ZOCA wordmark | divider | flame +
 * "Beacon". Single page surface for now (no sub-nav) — if drill-downs
 * land later, add a NavLink list like Escalation does.
 */
export default function MissPaymentHeader() {
  return (
    <header className="flex items-center justify-between mb-12">
      <Link
        href="/"
        className="flex items-center gap-4 no-underline"
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
        <V2UserMenu />
      </div>
    </header>
  );
}
