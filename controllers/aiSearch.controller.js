import supabase from '../config/supabase.js';

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

function normalizeListing(type, row) {
  if (!row) return null;

  const images =
    Array.isArray(row.images) ? row.images :
    row.image_urls && Array.isArray(row.image_urls) ? row.image_urls :
    [];

  const facilities =
    Array.isArray(row.facilities) ? row.facilities :
    typeof row.facilities === 'string' ? [row.facilities] :
    [];

  const strategicLocation =
    Array.isArray(row.strategic_location) ? row.strategic_location :
    typeof row.strategic_location === 'string' ? [row.strategic_location] :
    [];

  return {
    listing_type: type,
    id: row.id,
    custom_uuid: row.custom_uuid ?? null,
    title: row.title ?? row.name ?? null,
    description: row.description ?? null,
    images,
    price: row.price ?? null,
    zone: row.zone ?? null,
    bed_room: row.bed_room ?? row.bedrooms ?? null,
    bath_room: row.bath_room ?? row.bathrooms ?? null,
    building_area: row.building_area ?? null,
    land_area: row.land_area ?? null,
    facilities,
    strategic_location: strategicLocation,
    // Location table fields (populated later by attachLocationData)
    province: null,
    city: null,
    subdistrict: null,
    village: null,
    location_detail: null,
    postal_code: null,
    longitude: null,
    latitude: null,
  };
}

// ── Batch-fetch location data for an array of listings and attach it ──

async function attachLocationData(listings) {
  if (!listings.length) return listings;

  const uuids = listings
    .map(l => l.custom_uuid)
    .filter(Boolean);

  if (!uuids.length) return listings;

  const { data: locationRows, error } = await supabase
    .from('location')
    .select('*')
    .in('product_uuid', uuids);

  if (error || !locationRows?.length) return listings;

  // Build a map: product_uuid -> location row
  const locationMap = {};
  for (const loc of locationRows) {
    locationMap[loc.product_uuid] = loc;
  }

  // Attach location fields to each listing
  for (const listing of listings) {
    const loc = locationMap[listing.custom_uuid];
    if (loc) {
      listing.province = loc.province ?? null;
      listing.city = loc.city ?? null;
      listing.subdistrict = loc.subdistrict ?? null;
      listing.village = loc.village ?? null;
      listing.location_detail = loc.location_detail ?? null;
      listing.postal_code = loc.postal_code ?? null;
      listing.longitude = loc.longitude ?? null;
      listing.latitude = loc.latitude ?? null;
    }
  }

  return listings;
}

async function analyzeQueryWithGroq(userQuery) {
  if (!process.env.GROQ_API_KEY) {
    // Fallback: no analysis, search everything with no filters
    return {
      preferred_types: ['apartment', 'villa', 'land'],
      must_be_land: false,
      min_bedrooms: null,
      min_land_area: null,
      location_keywords: [],
      hard_constraints: [],
    };
  }

  const systemPrompt = `
You analyze real estate search queries and turn them into a structured JSON filter.

Supported listing types:
- "apartment"
- "villa" (use for standalone houses/villas, mapped to property table)
- "land"

Rules:
- NEVER hallucinate geography or facts not in the query.
- If the user clearly wants only land (e.g. "land", "plot", "empty land"), set must_be_land: true.
- If the user says "villa", "house", etc, include "villa" in preferred_types.
- Extract MINIMUM constraints only when explicit (e.g. "at least 3 bedrooms" => min_bedrooms: 3).
- min_land_area is in square meters if mentioned.
- Extract location_keywords as important place names or areas mentioned (e.g. "Canggu", "Echo Beach").

Respond STRICTLY as minified JSON with this shape (no extra keys, no comments):
{
  "preferred_types": string[],     // subset of ["apartment","villa","land"], at least one
  "must_be_land": boolean,         // true if the user clearly wants land only
  "min_bedrooms": number | null,
  "min_land_area": number | null,  // in m2, null if none
  "location_keywords": string[],   // important location names, can be empty
  "hard_constraints": string[]     // short natural-language constraints like "has_pool"
}
  `.trim();

  const userPrompt = `
User query:
${userQuery}
  `.trim();

  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0,
    }),
  });

  if (!response.ok) {
    throw new Error(`Groq query-analyzer error: ${response.status} ${response.statusText}`);
  }

  const json = await response.json();
  const content = json.choices?.[0]?.message?.content;

  let parsed;
  try {
    parsed = typeof content === 'string' ? JSON.parse(content) : content;
  } catch {
    throw new Error('Failed to parse Groq query-analyzer JSON');
  }

  return {
    preferred_types: Array.isArray(parsed.preferred_types) && parsed.preferred_types.length
      ? parsed.preferred_types
      : ['apartment', 'villa', 'land'],
    must_be_land: Boolean(parsed.must_be_land),
    min_bedrooms: typeof parsed.min_bedrooms === 'number' ? parsed.min_bedrooms : null,
    min_land_area: typeof parsed.min_land_area === 'number' ? parsed.min_land_area : null,
    location_keywords: Array.isArray(parsed.location_keywords) ? parsed.location_keywords : [],
    hard_constraints: Array.isArray(parsed.hard_constraints) ? parsed.hard_constraints : [],
  };
}

async function getQueryEmbedding(query) {
  const { data, error } = await supabase.functions.invoke('full_embed', {
    body: { text: query }
  });

  if (error) {
    throw new Error(error.message || 'Failed to generate query embedding');
  }

  if (!data || !Array.isArray(data.embedding)) {
    throw new Error('Embedding not returned from full_embed function');
  }

  return data.embedding;
}

async function runVectorSearch(queryEmbedding, matchCount, queryAnalysis) {
  const types = queryAnalysis?.preferred_types || ['apartment', 'villa', 'land'];
  const mustBeLand = !!queryAnalysis?.must_be_land;
  const minBedrooms = queryAnalysis?.min_bedrooms ?? null;
  const minLandArea = queryAnalysis?.min_land_area ?? null;
  const locationKeywords = Array.isArray(queryAnalysis?.location_keywords)
    ? queryAnalysis.location_keywords
    : [];

  const shouldSearchApartment = !mustBeLand && types.includes('apartment');
  const shouldSearchProperty = !mustBeLand && types.includes('villa'); // villas live in property table
  const shouldSearchLand = types.includes('land');

  const searches = [];

  if (shouldSearchApartment) {
    searches.push(
      supabase.rpc('search_apartment', {
        query_embedding: queryEmbedding,
        match_count: matchCount,
      })
    );
  } else {
    searches.push(Promise.resolve({ data: [], error: null }));
  }

  if (shouldSearchProperty) {
    searches.push(
      supabase.rpc('search_property', {
        query_embedding: queryEmbedding,
        match_count: matchCount,
      })
    );
  } else {
    searches.push(Promise.resolve({ data: [], error: null }));
  }

  if (shouldSearchLand) {
    searches.push(
      supabase.rpc('search_land', {
        query_embedding: queryEmbedding,
        match_count: matchCount,
      })
    );
  } else {
    searches.push(Promise.resolve({ data: [], error: null }));
  }

  const [aptRes, propRes, landRes] = await Promise.all(searches);

  if (aptRes.error) {
    throw new Error(aptRes.error.message || 'Vector search failed for apartment');
  }
  if (propRes.error) {
    throw new Error(propRes.error.message || 'Vector search failed for property');
  }
  if (landRes.error) {
    throw new Error(landRes.error.message || 'Vector search failed for land');
  }

  const apartments = (aptRes.data || []).map(row => normalizeListing('apartment', row));
  const properties = (propRes.data || []).map(row => normalizeListing('property', row));
  const lands = (landRes.data || []).map(row => normalizeListing('land', row));

  let merged = [...apartments, ...properties, ...lands].filter(Boolean);

  // Attach real location data (province, city, subdistrict, village, etc.)
  // from the location table BEFORE filtering, so keyword filter can use it.
  await attachLocationData(merged);

  // Apply simple structured filters in JS
  if (minBedrooms != null) {
    merged = merged.filter(
      l => typeof l.bed_room === 'number' && l.bed_room >= minBedrooms
    );
  }

  if (minLandArea != null) {
    merged = merged.filter(l => {
      if (!l.land_area) return false;
      const parsed = Number(l.land_area);
      if (Number.isNaN(parsed)) return false;
      return parsed >= minLandArea;
    });
  }

  // If we have location keywords, require that at least one keyword appears in listing text
  // (including location table fields: province, city, subdistrict, village, location_detail);
  // otherwise treat it as "no match" instead of silently using a different area.
  if (locationKeywords.length) {
    const loweredKeywords = locationKeywords
      .filter(k => typeof k === 'string')
      .map(k => k.toLowerCase());

    const withLocationMatch = merged.filter(l => {
      const title = (l.title || '').toLowerCase();
      const zone = (l.zone || '').toLowerCase();
      const strategic = Array.isArray(l.strategic_location)
        ? l.strategic_location.join(' ').toLowerCase()
        : String(l.strategic_location || '').toLowerCase();

      // Include location table fields in the haystack
      const province = (l.province || '').toLowerCase();
      const city = (l.city || '').toLowerCase();
      const subdistrict = (l.subdistrict || '').toLowerCase();
      const village = (l.village || '').toLowerCase();
      const locationDetail = (l.location_detail || '').toLowerCase();

      const haystack = `${title} ${zone} ${strategic} ${province} ${city} ${subdistrict} ${village} ${locationDetail}`;
      return loweredKeywords.some(k => {
        // Use word-boundary matching to prevent partial matches (e.g. "Kuta" in "Kutahal")
        const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`\\b${escaped}\\b`, 'i').test(haystack);
      });
    });

    if (!withLocationMatch.length) {
      // No listing explicitly mentions the queried location → no good match.
      return [];
    }

    merged = withLocationMatch;
  }

  // Keep only top-N across tables (vector search already ordered by similarity in each table)
  return merged.slice(0, matchCount);
}

// ── Tiered display: count criteria to decide how many results to show ──

function countSearchCriteria(queryAnalysis) {
  let count = 0;
  // Location specified (e.g. "Canggu", "Ubud")
  if (queryAnalysis.location_keywords.length > 0) count++;
  // Bedroom constraint (e.g. "3 bedrooms")
  if (queryAnalysis.min_bedrooms != null) count++;
  // Land area constraint (e.g. "500 m²")
  if (queryAnalysis.min_land_area != null) count++;
  // Each hard constraint (e.g. "pool", "furnished", "garden")
  count += queryAnalysis.hard_constraints.length;
  return count;
}

function getDisplayCount(criteriaCount) {
  if (criteriaCount === 0) return 5;   // vague: "show me villas" → browse 5
  if (criteriaCount <= 2) return 3;    // moderate: "villa in Canggu with pool" → 3 options
  return 1;                            // specific: 3+ criteria → single best match
}

async function generateExplanations(userQuery, listings) {
  if (!process.env.GROQ_API_KEY) {
    // If no GROQ key configured, just return without explanations
    return listings.map(listing => ({
      ...listing,
      explanation: null
    }));
  }

  const simplified = listings.map(l => ({
    custom_uuid: l.custom_uuid,
    listing_type: l.listing_type,
    title: l.title,
    description: l.description,
    price: l.price,
    zone: l.zone,
    bed_room: l.bed_room,
    bath_room: l.bath_room,
    building_area: l.building_area,
    land_area: l.land_area,
    facilities: l.facilities,
    strategic_location: l.strategic_location,
    province: l.province,
    city: l.city,
    subdistrict: l.subdistrict,
    village: l.village,
    location_detail: l.location_detail,
  }));

  const systemPrompt = `
You are a real estate AI assistant.
The user will give a natural language request and a list of properties (apartments, properties, and land).
Your job is to pick the SINGLE best matching property and explain why it matches the user's request, WITHOUT inventing facts.

Hard requirements:
- You MUST respect the user's intent about type. For example, if they ask for "land", do NOT pick an apartment or villa.
- You MUST NOT invent geography or distances (do not say "X is close to Y" unless that is explicitly stated in the listing fields).
- If none of the provided listings are a good match, you MUST return best.custom_uuid = null and explanation explaining there is no good match.
- Each listing may include location fields: province, city, subdistrict, village, location_detail. Use these to determine the real location of the property (e.g. if subdistrict is "Denpasar Utara", the property IS in Denpasar Utara even if the title says something else).

Respond strictly as JSON with this exact shape:
{
  "best": {
    "custom_uuid": string | null,
    "explanation": string
  }
}

If you choose a listing, its "custom_uuid" MUST be one of the provided listings.
The explanation should be 1–3 short sentences focused only on information actually present in the listing fields (title, price, zone, bed_room, bath_room, building_area, land_area, facilities, strategic_location, province, city, subdistrict, village).
If there is no good match, set "custom_uuid" to null and explain briefly why.
  `.trim();

  const userPrompt = `
User query:
${userQuery}

Listings (JSON array):
${JSON.stringify(simplified)}
  `.trim();

  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0,
    }),
  });

  if (!response.ok) {
    throw new Error(`Groq API error: ${response.status} ${response.statusText}`);
  }

  const json = await response.json();
  const content = json.choices?.[0]?.message?.content;

  let parsed;
  try {
    parsed = typeof content === 'string' ? JSON.parse(content) : content;
  } catch {
    throw new Error('Failed to parse Groq best-match JSON');
  }

  const bestUuid = parsed?.best?.custom_uuid;
  const bestExplanation = parsed?.best?.explanation ?? null;

  if (!bestUuid) {
    // No good match selected by the model
    return [];
  }

  const bestListing = listings.find(l => l.custom_uuid === bestUuid);
  if (!bestListing) {
    throw new Error('Best custom_uuid from Groq does not match any listing');
  }

  return [
    {
      ...bestListing,
      explanation: bestExplanation,
    },
  ];
}

// ── Multi-result ranking with engaging, reranking-aware explanations ──

async function rankAndExplainMultiple(userQuery, listings, displayCount) {
  // If only 1 needed, delegate to the single-best-match function
  if (displayCount === 1) {
    const singleResults = await generateExplanations(userQuery, listings);
    return {
      results: singleResults,
      summary: singleResults.length ? singleResults[0].explanation : null,
    };
  }

  if (!process.env.GROQ_API_KEY) {
    return {
      results: listings.slice(0, displayCount).map(l => ({ ...l, explanation: null })),
      summary: null,
    };
  }

  const simplified = listings.map(l => ({
    custom_uuid: l.custom_uuid,
    listing_type: l.listing_type,
    title: l.title,
    description: l.description,
    price: l.price,
    zone: l.zone,
    bed_room: l.bed_room,
    bath_room: l.bath_room,
    building_area: l.building_area,
    land_area: l.land_area,
    facilities: l.facilities,
    strategic_location: l.strategic_location,
    province: l.province,
    city: l.city,
    subdistrict: l.subdistrict,
    village: l.village,
    location_detail: l.location_detail,
  }));

  const systemPrompt = `
You are a friendly, knowledgeable real estate assistant with an engaging personality.
The user is browsing properties and you need to pick the top ${displayCount} best matches from the candidates, ranked from best to good.

You must produce TWO things:

1. "summary": A single engaging message (3–6 sentences) that presents ALL your picks to the user in a conversational way. This is what the user reads in the chat. It should:
   - Open with an enthusiastic, natural intro (avoid robotic phrases like "Here are the results").
   - Briefly describe each pick IN ORDER, weaving in why it's ranked where it is (soft reranking). Use the property title or a friendly label for each.
   - For pick #1: highlight why it's the top match.
   - For picks #2+: contrast or complement against the ones above (e.g. "If you prefer more space…", "For a more budget-friendly option…", "This one stands out because…").
   - End with a warm call-to-action inviting the user to ask about any of them.
   - Keep it concise but lively — like a friend texting you about great finds.
   - When mentioning locations, use the most specific real address info available: subdistrict, village, city (e.g. "in Denpasar Utara" or "in Sanur, Denpasar Selatan"), NOT just the zone code.

2. "ranked": An array of objects, one per pick, with a short 1-sentence explanation for each (used as a caption on the property card).

ONLY reference facts actually present in the listing data (including location fields like province, city, subdistrict, village, location_detail). NEVER invent distances, amenities, or location details not in the fields.

Hard rules:
- Respect the user's intent about type. If they ask for "land", do NOT pick apartments or villas.
- Each custom_uuid MUST be from the provided listings. No duplicates.
- If fewer than ${displayCount} listings are genuinely good matches, return only the good ones (at least 1).
- If NONE of the listings match, return an empty "ranked" array and set summary to a brief "no match" message.
- Each listing may include location fields: province, city, subdistrict, village, location_detail. Use these to determine the real location (e.g. if subdistrict is "Denpasar Utara", the property IS in Denpasar Utara).

Respond strictly as JSON:
{
  "summary": string,
  "ranked": [
    { "custom_uuid": string, "explanation": string },
    ...
  ]
}
  `.trim();

  const userPrompt = `
User query:
${userQuery}

Candidate listings (JSON array):
${JSON.stringify(simplified)}
  `.trim();

  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.1,
    }),
  });

  if (!response.ok) {
    throw new Error(`Groq ranking error: ${response.status} ${response.statusText}`);
  }

  const json = await response.json();
  const content = json.choices?.[0]?.message?.content;

  let parsed;
  try {
    parsed = typeof content === 'string' ? JSON.parse(content) : content;
  } catch {
    throw new Error('Failed to parse Groq ranking JSON');
  }

  const ranked = Array.isArray(parsed?.ranked) ? parsed.ranked : [];
  const summary = typeof parsed?.summary === 'string' ? parsed.summary : null;

  if (!ranked.length) {
    return { results: [], summary: null };
  }

  // Map back to full listing objects, preserving LLM rank order
  const results = [];
  for (const item of ranked) {
    const listing = listings.find(l => l.custom_uuid === item.custom_uuid);
    if (listing) {
      results.push({
        ...listing,
        explanation: item.explanation ?? null,
      });
    }
  }

  return {
    results: results.slice(0, displayCount),
    summary,
  };
}

async function generateAlternativeSuggestion(userQuery, listings, queryAnalysis) {
  if (!process.env.GROQ_API_KEY) {
    return null;
  }

  const simplified = listings.map(l => ({
    custom_uuid: l.custom_uuid,
    listing_type: l.listing_type,
    title: l.title,
    description: l.description,
    price: l.price,
    zone: l.zone,
    bed_room: l.bed_room,
    bath_room: l.bath_room,
    building_area: l.building_area,
    land_area: l.land_area,
    facilities: l.facilities,
    strategic_location: l.strategic_location,
    province: l.province,
    city: l.city,
    subdistrict: l.subdistrict,
    village: l.village,
    location_detail: l.location_detail,
  }));

  const systemPrompt = `
You are a real estate AI assistant.
The user asked for properties that could not be matched exactly (for example, no listing mentions the exact requested location).
Each listing may include location fields: province, city, subdistrict, village, location_detail. Use these to determine the real location of the property.

You are given:
- The original user query.
- A list of similar or nearby properties.

Your job:
- Decide whether to recommend ONE alternative property.
- If you recommend one, explain clearly that there was no exact match and that this is an alternative suggestion.
- If none of the properties are good alternatives, say so.

Respond strictly as JSON with this shape:
{
  "alternative": {
    "custom_uuid": string | null,
    "explanation": string
  }
}

Rules:
- If you choose a property, its custom_uuid MUST be one of the provided listings.
- The explanation should be 1–3 sentences and must NOT invent exact distances or travel times (no "10 minutes away" unless explicitly stated).
- If there is no reasonable alternative, set custom_uuid to null and explain briefly that nothing close enough was found.
  `.trim();

  const userPrompt = `
Original user query:
${userQuery}

Structured analysis (for your context):
${JSON.stringify(queryAnalysis)}

Candidate alternative listings (JSON array):
${JSON.stringify(simplified)}
  `.trim();

  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    throw new Error(`Groq alternative-suggestion error: ${response.status} ${response.statusText}`);
  }

  const json = await response.json();
  const content = json.choices?.[0]?.message?.content;

  let parsed;
  try {
    parsed = typeof content === 'string' ? JSON.parse(content) : content;
  } catch {
    throw new Error('Failed to parse Groq alternative-suggestion JSON');
  }

  const altUuid = parsed?.alternative?.custom_uuid;
  const altExplanation = parsed?.alternative?.explanation ?? null;

  if (!altUuid || typeof altUuid !== 'string') {
    return null;
  }

  const altListing = listings.find(l => l.custom_uuid === altUuid);
  if (!altListing) {
    return null;
  }

  return {
    listing: altListing,
    explanation: altExplanation,
  };
}

export const aiSearchController = {
  async search(req, res) {
    try {
      const { query } = req.body || {};

      if (!query || typeof query !== 'string' || !query.trim()) {
        return res.status(400).json({
          success: false,
          message: 'Field "query" is required and must be a non-empty string',
        });
      }

      const trimmedQuery = query.trim();

      // 0. Analyze the query to extract lightweight structured filters and type preferences
      const queryAnalysis = await analyzeQueryWithGroq(trimmedQuery);

      // 1. Embed user query
      const queryEmbedding = await getQueryEmbedding(trimmedQuery);

      // 2. Vector search on apartment, property, and land (strict, honoring location_keywords etc.)
      const listings = await runVectorSearch(queryEmbedding, 10, queryAnalysis);

      if (!listings.length) {
        // No strict match. Try a relaxed search (ignore location keywords) to see
        // if there is a reasonable alternative we can *offer* but not auto-select.
        const relaxedAnalysis = {
          ...queryAnalysis,
          location_keywords: [],
        };
        const relaxedListings = await runVectorSearch(queryEmbedding, 10, relaxedAnalysis);

        if (!relaxedListings.length) {
          // Truly nothing close in the database.
          return res.status(200).json({
            success: true,
            data: [],
            explanation: 'No listings in our database are close enough to your request.',
          });
        }

        // Ask Groq to decide whether to suggest ONE alternative.
        const alternative = await generateAlternativeSuggestion(trimmedQuery, relaxedListings, queryAnalysis);

        if (!alternative) {
          return res.status(200).json({
            success: true,
            data: [],
            explanation: 'No listings in our database are close enough to your request.',
          });
        }

        // Return only minimal alternative info to the frontend
        const minimalAlternative = {
          custom_uuid: alternative.listing.custom_uuid,
          listing_type: alternative.listing.listing_type,
          explanation: alternative.explanation ?? null,
        };

        return res.status(200).json({
          success: true,
          data: [],
          alternative: minimalAlternative,
        });
      }

      // 3. Determine how many results to show based on query specificity
      const criteriaCount = countSearchCriteria(queryAnalysis);
      const displayCount = getDisplayCount(criteriaCount);

      // 4. Rank and explain the top N listings
      const { results: rankedListings, summary } = await rankAndExplainMultiple(trimmedQuery, listings, displayCount);

      // Only return minimal data to the frontend: custom_uuid + listing_type + explanation.
      const minimal = rankedListings.map(l => ({
        custom_uuid: l.custom_uuid,
        listing_type: l.listing_type,
        explanation: l.explanation ?? null,
      }));

      return res.status(200).json({
        success: true,
        data: minimal,
        summary,
        displayCount,
      });
    } catch (error) {
      console.error('AI search error:', error);
      return res.status(500).json({
        success: false,
        message: error?.message || 'AI search failed',
      });
    }
  },
};

