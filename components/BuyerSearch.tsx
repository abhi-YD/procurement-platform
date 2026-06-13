"use client";

import { useState, useEffect, useMemo } from "react";
import dynamic from "next/dynamic";
import { Fraunces } from "next/font/google";
import { createClient } from "@/lib/supabase/client";
import { scoreVendors, PRESETS, CatalogItem } from "@/lib/scoring";
import { haversineKm } from "@/lib/distance";
import { geocodeAddress } from "@/lib/geocode";
import { useRouter } from "next/navigation";

const fraunces = Fraunces({ subsets: ["latin"], weight: ["500", "600"] });

const LocationMap = dynamic(() => import("@/components/map/LocationMap"), {
  ssr: false,
  loading: () => <div className="h-56 rounded-xl bg-stone-100 animate-pulse" />,
});

type CatalogRow = CatalogItem & { stock?: number | null };
type Decorated = CatalogRow & { company_name?: string; distanceKm?: number | null };
type Row = Decorated & { score: number };
type Pos = { lat: number; lng: number };

const OPTIONS = [
  { key: "price_critical", label: "Lowest price", desc: "Cost matters most" },
  { key: "fast_delivery", label: "Fast delivery", desc: "I need it quickly" },
  { key: "quality_first", label: "Quality & warranty", desc: "Reliability over price" },
  { key: "balanced", label: "Balanced", desc: "Weigh everything evenly" },
];

export default function BuyerSearch() {
  const [catalogMeta, setCatalogMeta] = useState<CatalogRow[]>([]);
  const [selectedCategory, setSelectedCategory] = useState("");
  const [product, setProduct] = useState("");
  const [priority, setPriority] = useState("balanced");
  const [quantity, setQuantity] = useState<number | "">("");
  const [deadline, setDeadline] = useState<number | "">("");

  const [searchMode, setSearchMode] = useState<"exact" | "smart">("exact");
  const [smartQuery, setSmartQuery] = useState("");
  const [savingRfq, setSavingRfq] = useState<string | null>(null);

  const [loading, setLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [rawVendors, setRawVendors] = useState<Decorated[]>([]);

  // buyer location
  const [buyerPos, setBuyerPos] = useState<Pos | null>(null);
  const [address, setAddress] = useState("");
  const [searching, setSearching] = useState(false);

  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("vendor_catalog")
        .select("id, vendor_id, product_name, category, price, warranty_months, delivery_days, moq, stock");
      setCatalogMeta((data || []) as CatalogRow[]);
    })();
  }, [supabase]);

  const categories = useMemo(
    () => Array.from(new Set(catalogMeta.map((d) => d.category))).filter(Boolean).sort(),
    [catalogMeta]
  );

  const availableProducts = useMemo(() => {
    if (!selectedCategory) return [];
    return Array.from(
      new Set(catalogMeta.filter((d) => d.category === selectedCategory).map((d) => d.product_name))
    ).sort();
  }, [catalogMeta, selectedCategory]);

  const maxStock = useMemo(() => {
    if (!product) return null;
    const matching = catalogMeta.filter((c) => c.product_name === product && c.stock != null);
    if (matching.length === 0) return null;
    return Math.max(...matching.map((m) => m.stock!));
  }, [product, catalogMeta]);

  const overStockLimit = maxStock !== null && quantity !== "" && Number(quantity) > maxStock;

  // TABLE: re-ranks live whenever priority changes
  const results = useMemo<Row[]>(() => {
    if (!hasSearched || rawVendors.length === 0) return [];
    return scoreVendors(rawVendors as CatalogItem[], PRESETS[priority]) as Row[];
  }, [rawVendors, priority, hasSearched]);

  // RECOMMENDATION: always the best all-round vendor (balanced), independent of priority
  const recommendation = useMemo<Row | null>(() => {
    if (!hasSearched || rawVendors.length === 0) return null;
    const balanced = scoreVendors(rawVendors as CatalogItem[], PRESETS["balanced"]) as Row[];
    return balanced[0] || null;
  }, [rawVendors, hasSearched]);

  const findAddress = async () => {
    if (!address.trim()) return;
    setSearching(true);
    const result = await geocodeAddress(address);
    setSearching(false);
    if (result) setBuyerPos(result);
  };

  const search = async () => {
    if (searchMode === "exact" && (!product || overStockLimit)) return;
    if (searchMode === "smart" && !smartQuery.trim()) return;

    setLoading(true);
    setHasSearched(true);
    setRawVendors([]);

    let valid: CatalogRow[] = [];

    if (searchMode === "exact") {
      const { data, error } = await supabase
        .from("vendor_catalog")
        .select("id, vendor_id, product_name, category, price, warranty_months, delivery_days, moq, stock")
        .eq("product_name", product);
      if (error) { console.error(error); setLoading(false); return; }
      valid = (data || []) as CatalogRow[];
    } else {
      try {
        const res = await fetch("/api/embed", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ texts: [smartQuery] }),
        });
        const data = await res.json();
        if (data.embeddings && data.embeddings.length > 0) {
          const { data: rpcData, error: rpcErr } = await supabase.rpc("match_products", {
            query_embedding: `[${data.embeddings[0].join(",")}]`,
            match_threshold: 0.65,
            match_count: 20,
          });
          if (rpcErr) throw rpcErr;
          valid = (rpcData || []) as CatalogRow[];
        }
      } catch (e) {
        console.error("Smart search error:", e);
        setLoading(false);
        return;
      }
    }

    // company names + coordinates for the vendors we found
    const vendorIds = [...new Set(valid.map((c) => c.vendor_id))];
    const nameMap: Record<string, string> = {};
    const coordMap: Record<string, Pos> = {};
    if (vendorIds.length > 0) {
      const { data: profiles } = await supabase
        .from("profiles")
        .select("id, company_name, latitude, longitude")
        .in("id", vendorIds);
      profiles?.forEach((p) => {
        if (p.company_name) nameMap[p.id] = p.company_name;
        if (p.latitude != null && p.longitude != null) {
          coordMap[p.id] = { lat: p.latitude, lng: p.longitude };
        }
      });
    }

    // filter by quantity, stock and deadline
    valid = valid.filter((c) => {
      const q = Number(quantity);
      if (quantity !== "" && c.moq && q < c.moq) return false;
      if (quantity !== "" && c.stock != null && q > c.stock) return false;
      if (deadline !== "" && c.delivery_days && c.delivery_days > Number(deadline)) return false;
      return true;
    });

    // decorate with company name + distance, store raw (scoring happens in useMemo)
    const decorated: Decorated[] = valid.map((r) => {
      const vendorPos = coordMap[r.vendor_id];
      const distanceKm = buyerPos && vendorPos ? haversineKm(buyerPos, vendorPos) : null;
      return {
        ...r,
        company_name: nameMap[r.vendor_id] || `Vendor ${r.vendor_id.slice(0, 8)}`,
        distanceKm,
      };
    });

    setRawVendors(decorated);
    setLoading(false);
  };

  const saveRfq = async (vendorId: string, _companyName: string, selectedProduct: string, selectedPrice: number) => {
    setSavingRfq(vendorId);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setSavingRfq(null); return; }

    let savedAmount = 0;
    if (results.length > 1 && quantity) {
      const avgPrice = results.reduce((acc, r) => acc + r.price, 0) / results.length;
      if (avgPrice > selectedPrice) savedAmount = (avgPrice - selectedPrice) * Number(quantity);
    }

    await supabase.from("rfq_history").insert({
      buyer_id: user.id,
      vendor_id: vendorId,
      product_name: searchMode === "smart" ? smartQuery : selectedProduct,
      quantity: Number(quantity) || 1,
      price_per_unit: selectedPrice,
      saved_amount: savedAmount,
      priority,
    });
    router.push("/dashboard/history");
  };

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className={`${fraunces.className} text-2xl text-stone-900`}>Find the right vendor</h1>
        <p className="mt-2 text-stone-500">Build a request, and we&apos;ll rank the vendors that can fulfil it.</p>
      </div>

      {/* RFQ Builder */}
      <div className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <h2 className={`${fraunces.className} text-xl text-stone-900`}>Create Request for Quote</h2>
          <div className="flex bg-stone-100 p-1 rounded-lg">
            <button
              onClick={() => setSearchMode("exact")}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-all ${searchMode === "exact" ? "bg-white text-stone-900 shadow-sm" : "text-stone-500 hover:text-stone-700"}`}
            >
              Exact Product
            </button>
            <button
              onClick={() => setSearchMode("smart")}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-all ${searchMode === "smart" ? "bg-white text-stone-900 shadow-sm" : "text-stone-500 hover:text-stone-700"}`}
            >
              Smart Search ✨
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {searchMode === "exact" ? (
            <>
              <div>
                <label className="block text-sm font-medium text-stone-700 mb-2">Category</label>
                <select
                  value={selectedCategory}
                  onChange={(e) => { setSelectedCategory(e.target.value); setProduct(""); }}
                  className="w-full rounded-xl border border-stone-300 p-3 bg-white text-stone-900 outline-none focus:border-[#c2410c]"
                >
                  <option value="" disabled>Select a category…</option>
                  {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-stone-700 mb-2">Product</label>
                <select
                  value={product}
                  onChange={(e) => setProduct(e.target.value)}
                  disabled={!selectedCategory}
                  className="w-full rounded-xl border border-stone-300 p-3 bg-white text-stone-900 outline-none focus:border-[#c2410c] disabled:opacity-50"
                >
                  <option value="" disabled>{selectedCategory ? "Select a product…" : "Pick a category first…"}</option>
                  {availableProducts.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
            </>
          ) : (
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-stone-700 mb-2">Describe what you need (AI Search)</label>
              <input
                type="text"
                value={smartQuery}
                onChange={(e) => setSmartQuery(e.target.value)}
                placeholder="e.g. high performance laptop for 4k video editing"
                className="w-full rounded-xl border border-stone-300 p-3 bg-white text-stone-900 outline-none focus:border-[#c2410c]"
              />
            </div>
          )}

          <div className="relative">
            <label className="block text-sm font-medium text-stone-700 mb-2">Quantity needed</label>
            {overStockLimit && (
              <div className="absolute -top-12 left-0 z-10 rounded-lg bg-red-100 px-3 py-2 text-xs font-medium text-red-800 border border-red-200">
                Max available quantity is {maxStock}
              </div>
            )}
            <input
              type="number"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value ? Number(e.target.value) : "")}
              placeholder="e.g. 50"
              className={`w-full rounded-xl border p-3 bg-white text-stone-900 outline-none focus:ring-1 ${overStockLimit ? "border-red-400 focus:ring-red-500 bg-red-50" : "border-stone-300 focus:border-[#c2410c]"}`}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-stone-700 mb-2">Max delivery deadline (days)</label>
            <input
              type="number"
              value={deadline}
              onChange={(e) => setDeadline(e.target.value ? Number(e.target.value) : "")}
              placeholder="Optional"
              className="w-full rounded-xl border border-stone-300 p-3 bg-white text-stone-900 outline-none focus:border-[#c2410c]"
            />
          </div>

          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-stone-700 mb-2">What matters most?</label>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {OPTIONS.map((o) => (
                <button
                  key={o.key}
                  onClick={() => setPriority(o.key)}
                  className={`rounded-xl border p-3 text-left transition-all ${priority === o.key ? "border-[#c2410c] bg-[#fff7f2] shadow-[0_0_0_1px_#c2410c]" : "border-stone-300 bg-white hover:border-stone-400"}`}
                >
                  <p className="text-sm font-semibold text-stone-900">{o.label}</p>
                  <p className="mt-0.5 text-xs text-stone-500">{o.desc}</p>
                </button>
              ))}
            </div>
          </div>

          {/* buyer location */}
          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-stone-700 mb-2">Your location (optional — to see distance)</label>
            <div className="flex gap-2">
              <input
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") findAddress(); }}
                placeholder="e.g. Connaught Place, Delhi"
                className="flex-1 rounded-xl border border-stone-300 px-4 py-2.5 text-stone-900 outline-none focus:border-[#c2410c]"
              />
              <button
                onClick={findAddress}
                disabled={searching || !address.trim()}
                className="rounded-xl bg-[#c2410c] px-5 py-2.5 font-medium text-white hover:bg-[#a8370b] disabled:opacity-50"
              >
                {searching ? "Finding…" : "Find"}
              </button>
            </div>
            <div className="mt-3 overflow-hidden rounded-xl border border-stone-200">
              <LocationMap value={buyerPos} onPick={(p) => setBuyerPos(p)} height={220} />
            </div>
          </div>
        </div>

        <button
          onClick={search}
          disabled={(searchMode === "exact" && (!product || overStockLimit)) || (searchMode === "smart" && !smartQuery.trim()) || loading}
          className="mt-6 w-full md:w-auto px-8 py-3.5 rounded-xl bg-[#0c0a09] text-stone-50 font-medium transition-all hover:bg-stone-800 disabled:opacity-50"
        >
          {loading ? "Finding vendors…" : "Compare Vendors"}
        </button>
      </div>

      {/* Recommendation — best overall (balanced), independent of the chosen sort */}
      {hasSearched && !loading && recommendation && (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6">
          <h3 className="text-sm font-medium text-emerald-800 mb-2">Our recommendation · best overall</h3>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <p className={`${fraunces.className} text-2xl text-emerald-950`}>{recommendation.product_name}</p>
              <p className="text-emerald-700 mt-1 font-medium">Offered by {recommendation.company_name}</p>
            </div>
            <div className="flex gap-4">
              <div className="bg-white/60 px-4 py-2 rounded-lg border border-emerald-100">
                <p className="text-xs text-emerald-600 font-medium">Price</p>
                <p className="text-lg font-semibold text-emerald-900">₹{recommendation.price.toLocaleString()}</p>
              </div>
              <div className="bg-white/60 px-4 py-2 rounded-lg border border-emerald-100">
                <p className="text-xs text-emerald-600 font-medium">Overall match</p>
                <p className="text-lg font-semibold text-emerald-900">{Math.round(recommendation.score * 100)}%</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Results table — re-ranks live by the chosen priority */}
      {hasSearched && !loading && (
        results.length === 0 ? (
          <div className="rounded-2xl border border-stone-200 bg-white p-8 text-center text-stone-500">
            No vendors found matching your criteria. Try adjusting the quantity or deadline.
          </div>
        ) : (
          <div className="rounded-2xl border border-stone-200 bg-white overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="bg-stone-50 text-stone-500 border-b border-stone-200">
                <tr>
                  <th className="px-6 py-4 font-medium min-w-[180px]">Vendor</th>
                  <th className="px-6 py-4 font-medium">Match</th>
                  <th className="px-6 py-4 font-medium">Price (₹)</th>
                  <th className="px-6 py-4 font-medium">Delivery</th>
                  <th className="px-6 py-4 font-medium">Warranty</th>
                  <th className="px-6 py-4 font-medium">MOQ</th>
                  <th className="px-6 py-4 font-medium">Stock</th>
                  <th className="px-6 py-4 font-medium">Distance</th>
                  <th className="px-6 py-4 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {results.map((r, i) => (
                  <tr key={r.id} className={i === 0 ? "bg-[#fff7f2]/50" : "bg-white"}>
                    <td className="px-6 py-5">
                      <div className="flex items-center gap-2.5">
                        {i === 0 && <span className="w-2.5 h-2.5 rounded-full bg-[#c2410c]" />}
                        <span className={`font-semibold ${i === 0 ? "text-[#c2410c]" : "text-stone-900"}`}>{r.company_name}</span>
                      </div>
                    </td>
                    <td className="px-6 py-5 font-bold text-stone-900">{(r.score * 100).toFixed(0)}</td>
                    <td className="px-6 py-5 text-stone-800">₹{r.price.toLocaleString()}</td>
                    <td className="px-6 py-5 text-stone-600">{r.delivery_days ? `${r.delivery_days} days` : "—"}</td>
                    <td className="px-6 py-5 text-stone-600">{r.warranty_months ? `${r.warranty_months} mo` : "—"}</td>
                    <td className="px-6 py-5 text-stone-600">{r.moq ?? "—"}</td>
                    <td className="px-6 py-5 text-stone-600">{r.stock ?? "—"}</td>
                    <td className="px-6 py-5 text-stone-600">{r.distanceKm != null ? `≈ ${Math.round(r.distanceKm)} km` : "—"}</td>
                    <td className="px-6 py-5 text-right">
                      <button
                        onClick={() => saveRfq(r.vendor_id, r.company_name || "Vendor", r.product_name, r.price)}
                        disabled={savingRfq === r.vendor_id}
                        className="px-4 py-2 bg-stone-900 text-white text-xs font-medium rounded-lg hover:bg-[#c2410c] transition-colors disabled:opacity-50"
                      >
                        {savingRfq === r.vendor_id ? "Saving…" : "Award"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}