import V2OneOnOnePrepClient from "@/components/customer/v2/OneOnOne/V2OneOnOnePrepClient";

export const dynamic = "force-dynamic";

type PageProps = { params: { am: string } };

export default function OneOnOnePrepPage({ params }: PageProps) {
  const amName = decodeURIComponent(params.am || "");
  return <V2OneOnOnePrepClient amName={amName} />;
}
