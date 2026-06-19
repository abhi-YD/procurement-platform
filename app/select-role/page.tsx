"use client";

import { useState } from"react";
import { useRouter } from"next/navigation";
import { createClient } from"@/lib/supabase/client";

export default function SelectRole() {
  const [step, setStep] = useState<"role" |"company">("role");
  const [role, setRole] = useState<"buyer" |"vendor" | null>(null);
  const [companyName, setCompanyName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();
  const supabase = createClient();

  const pickRole = (r:"buyer" |"vendor") => {
    setRole(r);
    setStep("company");
  };

  const save = async () => {
    if (!companyName.trim()) { setError("Please enter your company name."); return; }
    if (!role) return;
    setSaving(true);
    setError("");

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return router.push("/");

    const updateData: any = { role, company_name: companyName.trim() };
    if (role ==="vendor" && contactEmail.trim()) {
      updateData.contact_email = contactEmail.trim();
    }

    const { error: dbErr } = await supabase
      .from("profiles")
      .update(updateData)
      .eq("id", user.id);

    if (dbErr) { setError(dbErr.message); setSaving(false); return; }
    router.refresh();
    router.push("/dashboard");
  };

  return (
    <main className="min-h-screen bg-[#faf8f5] flex flex-col items-center justify-center p-6 relative">
      {/* Background grid */}
      <div className="absolute inset-0 z-0 overflow-hidden pointer-events-none opacity-20">
        <svg className="absolute inset-0 w-full h-full stroke-neutral-300/60 [mask-image:radial-gradient(60%_60%_at_50%_50%,white,transparent)]" aria-hidden="true">
          <defs>
            <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M.5 40V.5H40" fill="none" strokeWidth="0.5" strokeDasharray="2 2" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#grid)" />
        </svg>
      </div>

      <div className="w-full max-w-2xl z-10 flex flex-col items-center">
        {/* App Logo */}
        <div className="mb-12 flex flex-col items-center">
          <span className="text-sm font-bold tracking-[0.2em] text-[#0F1E3C]">
            PROCURE<span className="text-[#E8A838]">·</span>AI
          </span>
        </div>

        <div className="w-full text-center animate-fade-up">
          {step ==="role" ? (
            <>
              <h1 className="text-3xl sm:text-4xl text-[#0F1E3C] tracking-tight">
                How will you use the platform?
              </h1>
              <p className="mt-3 text-sm text-[#6B7280] max-w-md mx-auto">
                This configures your default workspace interface. Please choose carefully as this role cannot be changed.
              </p>
              <div className="mt-10 grid sm:grid-cols-2 gap-6 w-full text-left">
                <RoleCard
                  title="I'm a Buyer"
                  desc="Upload RFQs, search and compare vendor catalogues, and get AI recommendations."
                  icon={<BuyerIcon />}
                  onClick={() => pickRole("buyer")}
                />
                <RoleCard
                  title="I'm a Vendor"
                  desc="Upload product catalogues, specify service areas, and participate in deals."
                  icon={<VendorIcon />}
                  onClick={() => pickRole("vendor")}
                />
              </div>
            </>
          ) : (
            <div className="w-full max-w-md mx-auto bg-white border border-neutral-200 rounded-2xl p-8 shadow-[0_8px_30px_rgb(15,30,60,0.02)] text-left">
              <button
                onClick={() => { setStep("role"); setError(""); }}
                className="inline-flex items-center gap-1 text-xs font-semibold text-[#6B7280] hover:text-[#0F1E3C] transition-colors mb-6 cursor-pointer"
              >
                &larr; Back to role selection
              </button>
              <h2 className="text-2xl font-bold text-[#0F1E3C] tracking-tight">
                Company Details
              </h2>
              <p className="mt-1 text-xs text-[#6B7280] leading-relaxed">
                {role ==="vendor"
                  ?"Buyers will see this information when comparing and selecting vendors."
                  :"This company identifier will be attached to your RFQ profile."}
              </p>

              <div className="mt-6 space-y-4">
                <div>
                  <label className="block text-xs font-bold text-[#0F1E3C] uppercase tracking-wider mb-2">
                    Company / Business Name
                  </label>
                  <input
                    type="text"
                    value={companyName}
                    onChange={(e) => { setCompanyName(e.target.value); setError(""); }}
                    onKeyDown={(e) => e.key ==="Enter" && save()}
                    placeholder={role ==="vendor" ?"e.g. Apex Industrial Supplies" :"e.g. Logistics Global Ltd"}
                    autoFocus
                    className="w-full rounded-xl border border-neutral-300 bg-white px-4 py-3 text-sm text-[#111827] outline-none focus:border-[#0F1E3C] focus:ring-2 focus:ring-[#0F1E3C]/10 transition-all placeholder:text-neutral-400"
                  />
                </div>
                
                {role ==="vendor" && (
                  <div>
                    <label className="block text-xs font-bold text-[#0F1E3C] uppercase tracking-wider mb-2">
                      Contact Email (For RFQs)
                    </label>
                    <input
                      type="email"
                      value={contactEmail}
                      onChange={(e) => { setContactEmail(e.target.value); setError(""); }}
                      onKeyDown={(e) => e.key ==="Enter" && save()}
                      placeholder="sales@company.com"
                      className="w-full rounded-xl border border-neutral-300 bg-white px-4 py-3 text-sm text-[#111827] outline-none focus:border-[#0F1E3C] focus:ring-2 focus:ring-[#0F1E3C]/10 transition-all placeholder:text-neutral-400"
                    />
                  </div>
                )}

                {error && <p className="text-xs font-medium text-red-600 animate-fade-in">{error}</p>}
              </div>

              <button
                onClick={save}
                disabled={saving || !companyName.trim()}
                className="mt-6 w-full rounded-xl bg-[#0F1E3C] hover:bg-[#1A315C] px-5 py-3.5 text-sm font-semibold text-white transition-all active:scale-[0.99] disabled:opacity-50 cursor-pointer text-center"
              >
                {saving
                  ?"Setting up workspace..."
                  :`Continue as ${role ==="vendor" ?"Vendor" :"Buyer"} →`}
              </button>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

function RoleCard({ title, desc, icon, onClick }: {
  title: string; desc: string; icon: React.ReactNode; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="group bg-white rounded-2xl border border-neutral-200 p-8 text-left transition-all hover:border-[#E8A838] hover:shadow-[0_8px_30px_rgb(232,168,56,0.06)] active:scale-[0.99] cursor-pointer flex flex-col justify-between h-full"
    >
      <div>
        <div className="h-12 w-12 rounded-xl bg-[#0F1E3C]/5 text-[#0F1E3C] flex items-center justify-center transition-colors group-hover:bg-[#E8A838]/10 group-hover:text-[#E8A838] mb-6">
          {icon}
        </div>
        <h3 className="text-lg font-bold text-[#0F1E3C] group-hover:text-[#E8A838] transition-colors">{title}</h3>
        <p className="mt-2 text-sm text-[#6B7280] leading-relaxed">{desc}</p>
      </div>
      <span className="mt-6 inline-flex items-center gap-1 text-xs font-bold text-[#0F1E3C] group-hover:translate-x-1 transition-transform">
        Choose Role &rarr;
      </span>
    </button>
  );
}

function BuyerIcon() {
  return (
    <svg className="w-6 h-6 stroke-current" fill="none" strokeWidth="2" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
      <path d="M12 7v6m-3-3h6" />
    </svg>
  );
}

function VendorIcon() {
  return (
    <svg className="w-6 h-6 stroke-current" fill="none" strokeWidth="2" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
    </svg>
  );
}