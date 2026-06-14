import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import BrochureUpload from "@/components/BrochureUpload";
import BuyerSearch from "@/components/BuyerSearch";

export default async function Dashboard() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (!profile?.role) redirect("/select-role");

  return (
    <div className="w-full">
      {profile.role === "vendor" ? (
        <VendorHome />
      ) : (
        <BuyerHome />
      )}
    </div>
  );
}

function VendorHome() {
  return (
    <section className="p-8 flex flex-col items-center">
      <BrochureUpload />
    </section>
  );
}

function BuyerHome() {
  return (
    <section className="p-8 flex flex-col items-center w-full">
      <BuyerSearch />
    </section>
  );
}