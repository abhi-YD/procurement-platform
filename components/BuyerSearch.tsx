"use client";

import { useState, useEffect, useMemo } from"react";
import { createClient } from"@/lib/supabase/client";
import { scoreVendors, PRESETS, CatalogItem, ScoreBreakdown } from"@/lib/scoring";
import { haversineKm } from"@/lib/distance";
import { useRouter } from"next/navigation";

// Modular Subcomponents
import VendorSearchForm from"./VendorSearchForm";
import ActiveConstraints from"./ActiveConstraints";
import DeliveryDestination from"./DeliveryDestination";
import VendorResultsGrid from"./VendorResultsGrid";

type Pos = { lat: number; lng: number };

type EnhancedVendor = CatalogItem & {
  score: number;
  company_name?: string;
  contact_email?: string;
  breakdown?: ScoreBreakdown[];
  distanceKm?: number | null;
  vendorPos?: Pos | null;
};

export default function BuyerSearch() {
  const [catalogMeta, setCatalogMeta] = useState<{product_name: string, category: string, stock: number | null}[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  
  // Search parameters
  const [product, setProduct] = useState<string>("");
  const [priority, setPriority] = useState("balanced");
  const [quantity, setQuantity] = useState<number |"">("");
  const [deadline, setDeadline] = useState<number |"">("");
  
  const [searchMode, setSearchMode] = useState<"catalog" |"semantic">("catalog");
  const [smartQuery, setSmartQuery] = useState("");
  const [savingRfq, setSavingRfq] = useState<string | null>(null);
  const router = useRouter();
  
  const [loading, setLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [results, setResults] = useState<EnhancedVendor[]>([]);
  
  // Scoring Sliders State
  const [priceWeight, setPriceWeight] = useState(33);
  const [proximityWeight, setProximityWeight] = useState(33);
  const [deliveryWeight, setDeliveryWeight] = useState(34);

  // Delivery destination location state
  const [buyerPos, setBuyerPos] = useState<Pos | null>(null);
  const [locationAddress, setLocationAddress] = useState("");
  const [maxDistance, setMaxDistance] = useState<number>(500); // 500 ="Any"

  const [awardedRfq, setAwardedRfq] = useState<string | null>(null);
  const [feedbackModal, setFeedbackModal] = useState<{vendorId: string, companyName: string, product: string, price: number} | null>(null);
  const [feedbackRating, setFeedbackRating] = useState<number>(0);
  const [feedbackNotes, setFeedbackNotes] = useState<string>("");

  const supabase = useMemo(() => createClient(), []);

  // Fetch unique catalogue metadata on mount
  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("vendor_catalog").select("product_name, category, stock");
      if (data) {
        setCatalogMeta(data as {product_name: string, category: string, stock: number | null}[]);
      }
    })();
  }, [supabase]);

  const categories = useMemo(() => Array.from(new Set(catalogMeta.map((d) => d.category))).filter(Boolean).sort(), [catalogMeta]);
  const availableProducts = useMemo(() => {
    if (!selectedCategory) return [];
    return Array.from(new Set(catalogMeta.filter(d => d.category === selectedCategory).map((d) => d.product_name))).sort();
  }, [catalogMeta, selectedCategory]);

  const search = async (overrideParams?: {
    searchMode?:"catalog" |"semantic";
    smartQuery?: string;
    quantity?: number;
    locationAddress?: string;
    buyerPos?: Pos;
  }) => {
    const activeSearchMode = overrideParams?.searchMode ?? searchMode;
    const activeSmartQuery = overrideParams?.smartQuery ?? smartQuery;
    const activeQuantity = overrideParams?.quantity ?? quantity;
    const activeBuyerPos = overrideParams?.buyerPos ?? buyerPos;

    setLoading(true);
    setHasSearched(true);
    setSearchError(null);
    setResults([]);

    let valid: CatalogItem[] = [];

    if (activeSearchMode ==="catalog") {
      const activeProduct = product;
      const { data: catalogData, error: catalogErr } = await supabase
        .from("vendor_catalog")
        .select("id, vendor_id, product_name, category, price, warranty_months, delivery_days, moq, stock")
        .eq("product_name", activeProduct);

      if (catalogErr) { 
        console.error("Catalog fetch error:", catalogErr); 
        setSearchError("Failed to fetch products. Please try again.");
        setLoading(false); 
        return; 
      }
      valid = (catalogData || []) as CatalogItem[];
    } else {
      try {
        const res = await fetch("/api/embed", {
          method:"POST",
          headers: {"Content-Type":"application/json" },
          body: JSON.stringify({ texts: [activeSmartQuery] })
        });
        const data = await res.json();
        if (data.embeddings && data.embeddings.length > 0) {
          const { data: rpcData, error: rpcErr } = await supabase.rpc("match_products", {
            query_embedding:`[${data.embeddings[0].join(',')}]`,
            match_threshold: 0.5,
            match_count: 50
          });
          if (rpcErr) throw rpcErr;
          valid = (rpcData || []) as CatalogItem[];
        }
      } catch(e) {
        console.error("Smart search error:", e);
        setSearchError("Smart search failed. Please try again.");
        setLoading(false);
        return;
      }
    }

    const vendorIds = [...new Set(valid.map(c => c.vendor_id))];
    const newMap: Record<string, {name: string, email: string}> = {};
    const coordMap: Record<string, Pos> = {};
    if (vendorIds.length > 0) {
      const { data: profileData } = await supabase
        .from("profiles")
        .select("id, company_name, contact_email, latitude, longitude")
        .in("id", vendorIds);
      if (profileData) {
        profileData.forEach(p => {
          if (p.company_name) newMap[p.id] = { name: p.company_name, email: p.contact_email };
          if (p.latitude != null && p.longitude != null) {
            coordMap[p.id] = { lat: p.latitude, lng: p.longitude };
          }
        });
      }
    }

    // Filter by volume & deadline SLA parameters
    valid = valid.filter((c) => {
      if (activeQuantity && c.moq && activeQuantity < c.moq) return false;
      if (activeQuantity && c.stock && activeQuantity > c.stock) return false;
      if (deadline && c.delivery_days && c.delivery_days > deadline) return false;
      return true;
    });

    // Scoring weights presets mapping
    let customWeights = PRESETS[priority] || PRESETS.balanced;
    if (priority ==="custom") {
      const sum = priceWeight + deliveryWeight + 50; // Baseline rating/warranty constants
      customWeights = {
        price: priceWeight / sum,
        delivery_days: deliveryWeight / sum,
        warranty_months: 25 / sum,
        rating: 25 / sum,
      };
    }

    // Apply ranking calculations & proximity calculations
    let ranked = scoreVendors(valid, customWeights).map((r) => {
      const vendorPos = coordMap[r.vendor_id];
      const distanceKm = activeBuyerPos && vendorPos ? haversineKm(activeBuyerPos, vendorPos) : null;
      return {
        ...r,
        company_name: newMap[r.vendor_id]?.name ||`Vendor ${r.vendor_id.slice(0, 8)}`,
        contact_email: newMap[r.vendor_id]?.email,
        distanceKm,
        vendorPos,
      };
    });

    // Filter by max distance radius (if not"Any" which is 500)
    if (maxDistance < 500) {
      ranked = ranked.filter(r => r.distanceKm == null || r.distanceKm <= maxDistance);
    }

    setResults(ranked);
    setLoading(false);
  };

  // Quick preset query handler
  const handleTryPreset = async () => {
    setSearchMode("semantic");
    setSmartQuery("Office supplies");
    setQuantity(500);
    setLocationAddress("Mumbai, India");
    const mumbaiPos = { lat: 19.0760, lng: 72.8777 };
    setBuyerPos(mumbaiPos);

    // Trigger search instantly
    await search({
      searchMode:"semantic",
      smartQuery:"Office supplies",
      quantity: 500,
      locationAddress:"Mumbai, India",
      buyerPos: mumbaiPos
    });
  };

  const handleNegotiate = async (vendorId: string, companyName: string, selectedProduct: string, selectedPrice: number) => {
    setSavingRfq(vendorId);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    
    let savedAmount = 0;
    if (results.length > 1 && quantity) {
      const avgPrice = results.reduce((acc, r) => acc + r.price, 0) / results.length;
      if (avgPrice > selectedPrice) {
        savedAmount = (avgPrice - selectedPrice) * Number(quantity);
      }
    }

    const { data: newRfq } = await supabase.from("rfq_history").insert({
      buyer_id: user.id,
      vendor_id: vendorId,
      product_name: searchMode ==="semantic" ? smartQuery : selectedProduct,
      quantity: Number(quantity) || 1,
      price_per_unit: selectedPrice,
      saved_amount: savedAmount,
      priority,
      experience_rating: null,
      feedback_notes: null
    }).select().single();

    setAwardedRfq(vendorId);
    setSavingRfq(null);

    setTimeout(() => {
      if (newRfq?.id) {
        router.push(`/dashboard/deals/${newRfq.id}`);
      } else {
        router.push("/dashboard/deals");
      }
    }, 1000);
  };

  const handleAward = (vendorId: string, companyName: string, selectedProduct: string, selectedPrice: number) => {
    setFeedbackModal({ vendorId, companyName, product: selectedProduct, price: selectedPrice });
    setFeedbackRating(0);
    setFeedbackNotes("");
  };

  const saveAwardRating = async () => {
    if (!feedbackModal) return;
    setSavingRfq(feedbackModal.vendorId);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    let savedAmount = 0;
    if (results.length > 1 && quantity) {
      const avgPrice = results.reduce((acc, r) => acc + r.price, 0) / results.length;
      if (avgPrice > feedbackModal.price) {
        savedAmount = (avgPrice - feedbackModal.price) * Number(quantity);
      }
    }

    const { data: newRfq } = await supabase.from("rfq_history").insert({
      buyer_id: user.id,
      vendor_id: feedbackModal.vendorId,
      product_name: searchMode ==="semantic" ? smartQuery : feedbackModal.product,
      quantity: Number(quantity) || 1,
      price_per_unit: feedbackModal.price,
      saved_amount: savedAmount,
      priority,
      experience_rating: feedbackRating || null,
      feedback_notes: feedbackNotes || null
    }).select().single();

    setAwardedRfq(feedbackModal.vendorId);
    setFeedbackModal(null);
    setSavingRfq(null);

    setTimeout(() => {
      if (newRfq?.id) {
        router.push(`/dashboard/deals/${newRfq.id}`);
      } else {
        router.push("/dashboard/deals");
      }
    }, 1000);
  };

  return (
    <div className="w-full space-y-8 animate-fade-in">
      
      {/* 3-Column Split Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        
        {/* Left Column (320px width on desktop) - stacked forms */}
        <div className="lg:col-span-4 xl:col-span-3 space-y-6 w-full lg:max-w-[320px]">
          
          {/* 1. Sourcing Form Card */}
          <VendorSearchForm
            searchMode={searchMode}
            setSearchMode={setSearchMode}
            category={selectedCategory}
            setCategory={setSelectedCategory}
            categories={categories}
            item={product}
            setItem={setProduct}
            items={availableProducts}
            quantity={quantity}
            setQuantity={setQuantity}
            deadline={deadline}
            setDeadline={setDeadline}
            semanticQuery={smartQuery}
            setSemanticQuery={setSmartQuery}
            onSearch={() => search()}
            loading={loading}
          />

          {/* 2. active constraints config */}
          <ActiveConstraints
            priority={priority}
            setPriority={setPriority}
            priceWeight={priceWeight}
            setPriceWeight={setPriceWeight}
            proximityWeight={proximityWeight}
            setProximityWeight={setProximityWeight}
            deliveryWeight={deliveryWeight}
            setDeliveryWeight={setDeliveryWeight}
          />

          {/* 3. delivery destination geocode map */}
          <DeliveryDestination
            buyerPos={buyerPos}
            setBuyerPos={setBuyerPos}
            locationAddress={locationAddress}
            setLocationAddress={setLocationAddress}
            maxDistance={maxDistance}
            setMaxDistance={setMaxDistance}
          />
        </div>

        {/* Center/Right Column (flex-grow) - Results Area */}
        <div className="lg:col-span-8 xl:col-span-9 space-y-6 flex-1 min-w-0">
          
          {/* Header statistics info block */}
          {hasSearched && !loading && results.length > 0 && (
            <div className="bg-[#0F1E3C] border border-[#0F1E3C] rounded-[10px] p-5 text-white flex justify-between items-center animate-fade-in">
              <div className="text-left">
                <span className="text-[10px] font-bold uppercase tracking-wider bg-[#E8A838] text-[#0F1E3C] px-2 py-0.5 rounded-full">
                  AI Recommendation
                </span>
                <h3 className="text-lg tracking-tight mt-2.5">
                  Best vendor fit found for your query parameters.
                </h3>
              </div>
              <div className="bg-white/10 px-4 py-2 rounded-[8px] text-right  text-xs">
                <span>Top Score: </span>
                <span className="font-bold text-[#E8A838]">{Math.round(results[0].score * 100)}% Match</span>
              </div>
            </div>
          )}

          {/* Sourcing Search Error banner */}
          {searchError && (
            <div className="p-4 rounded-[10px] border border-red-200 bg-red-50 text-xs font-semibold text-red-700 text-left animate-fade-in">
              ⚠️ {searchError}
            </div>
          )}

          {/* Dynamic Grid Results */}
          <VendorResultsGrid
            vendors={results}
            loading={loading}
            hasSearched={hasSearched}
            onNegotiate={handleNegotiate}
            onAward={handleAward}
            onTryQuery={handleTryPreset}
          />
        </div>

      </div>

      {/* Award Rating popup details */}
      {feedbackModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-neutral-900/40 backdrop-blur-sm animate-fade-in">
          <div className="bg-white rounded-[10px] p-6 sm:p-8 max-w-md w-full shadow-2xl animate-fade-up flex flex-col relative text-left" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-[#0F1E3C] tracking-tight mb-2">Finalize Proposal Award</h3>
            <p className="text-neutral-500 text-xs leading-relaxed mb-6">
              You are awarding this bid to <strong className="text-[#0F1E3C]">{feedbackModal.companyName}</strong>. Rate the expected transaction experience to help our matching index.
            </p>
            
            <div className="flex items-center gap-2 mb-6 justify-center">
              {[1, 2, 3, 4, 5].map(star => (
                <button 
                  key={star} 
                  onClick={() => setFeedbackRating(star)}
                  className={`text-4xl transition-transform hover:scale-110 cursor-pointer ${feedbackRating >= star ?'text-[#E8A838]' :'text-neutral-200'}`}
                >
                  ★
                </button>
              ))}
            </div>

            <textarea
              value={feedbackNotes}
              onChange={e => setFeedbackNotes(e.target.value)}
              placeholder="Any specific negotiation concessions? (Optional)"
              className="w-full rounded-[8px] border border-neutral-300 p-3.5 bg-white text-xs outline-none focus:border-[#0F1E3C] focus:ring-1 focus:ring-[#0F1E3C] min-h-[100px] resize-y mb-6 text-[#111827]"
            />

            <div className="flex gap-3">
              <button
                onClick={saveAwardRating}
                className="flex-1 px-4 py-3 text-xs font-bold text-neutral-600 bg-neutral-100 rounded-[8px] hover:bg-neutral-200 transition-colors cursor-pointer"
              >
                Skip & Create Deal
              </button>
              <button
                onClick={saveAwardRating}
                disabled={feedbackRating === 0}
                className="flex-1 px-4 py-3 text-xs font-bold text-white bg-[#0F1E3C] rounded-[8px] hover:bg-[#1A315C] transition-colors disabled:opacity-50 cursor-pointer"
              >
                Submit & Create Deal
              </button>
            </div>
            <button onClick={() => setFeedbackModal(null)} className="absolute top-4 right-4 text-neutral-400 hover:text-[#0F1E3C] cursor-pointer">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
            </button>
          </div>
        </div>
      )}

    </div>
  );
}