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
  };
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

  // If we have location keywords, require that at least one keyword appears in listing text;
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

      const haystack = `${title} ${zone} ${strategic}`;
      return loweredKeywords.some(k => haystack.includes(k));
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
  }));

  const systemPrompt = `
You are a real estate AI assistant.
The user will give a natural language request and a list of properties (apartments, properties, and land).
Your job is to pick the SINGLE best matching property and explain why it matches the user's request, WITHOUT inventing facts.

Hard requirements:
- You MUST respect the user's intent about type. For example, if they ask for "land", do NOT pick an apartment or villa.
- You MUST NOT invent geography or distances (do not say "X is close to Y" unless that is explicitly stated in the listing fields).
- If none of the provided listings are a good match, you MUST return best.custom_uuid = null and explanation explaining there is no good match.

Respond strictly as JSON with this exact shape:
{
  "best": {
    "custom_uuid": string | null,
    "explanation": string
  }
}

If you choose a listing, its "custom_uuid" MUST be one of the provided listings.
The explanation should be 1–3 short sentences focused only on information actually present in the listing fields (title, price, zone, bed_room, bath_room, building_area, land_area, facilities, strategic_location).
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
      temperature: 0.3,
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
  }));

  const systemPrompt = `
You are a real estate AI assistant.
The user asked for properties that could not be matched exactly (for example, no listing mentions the exact requested location).

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

      // 3. Ask Groq to select the single best strict match and explain it
      const bestListingWithExplanation = await generateExplanations(trimmedQuery, listings);

      // Only return minimal data to the frontend: custom_uuid + listing_type + explanation.
      const minimal = bestListingWithExplanation.map(l => ({
        custom_uuid: l.custom_uuid,
        listing_type: l.listing_type,
        explanation: l.explanation ?? null,
      }));

      return res.status(200).json({
        success: true,
        data: minimal,
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

