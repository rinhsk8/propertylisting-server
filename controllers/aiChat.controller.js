import dotenv from 'dotenv';
import supabase from '../config/supabase.js';

dotenv.config();

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const PORT = process.env.PORT || 3000;
const BACKEND_BASE_URL = process.env.BACKEND_BASE_URL || `http://localhost:${PORT}`;

// ── Fetch full property from DB when contextProperty only has minimal data ──

async function fetchFullPropertyFromDB(customUuid, listingType) {
  const tableMap = {
    apartment: 'apartment',
    property: 'property',
    land: 'land',
  };

  const tableName = tableMap[listingType];
  if (!tableName) return null;

  // Fetch the listing and its location row in parallel
  const [listingRes, locationRes] = await Promise.all([
    supabase
      .from(tableName)
      .select('*')
      .eq('custom_uuid', customUuid)
      .single(),
    supabase
      .from('location')
      .select('*')
      .eq('product_uuid', customUuid)
      .maybeSingle(),
  ]);

  const { data, error } = listingRes;
  if (error || !data) return null;

  const facilities = Array.isArray(data.facilities)
    ? data.facilities
    : typeof data.facilities === 'string' ? [data.facilities] : [];
  const strategicLocation = Array.isArray(data.strategic_location)
    ? data.strategic_location
    : typeof data.strategic_location === 'string' ? [data.strategic_location] : [];

  const loc = locationRes.data;

  return {
    listing_type: listingType,
    id: data.id,
    custom_uuid: data.custom_uuid ?? null,
    title: data.title ?? data.name ?? null,
    description: data.description ?? null,
    images: Array.isArray(data.images) ? data.images
      : data.image_urls && Array.isArray(data.image_urls) ? data.image_urls : [],
    price: data.price ?? null,
    zone: data.zone ?? null,
    bed_room: data.bed_room ?? data.bedrooms ?? null,
    bath_room: data.bath_room ?? data.bathrooms ?? null,
    building_area: data.building_area ?? null,
    land_area: data.land_area ?? null,
    facilities,
    strategic_location: strategicLocation,
    // Location table fields
    province: loc?.province ?? null,
    city: loc?.city ?? null,
    subdistrict: loc?.subdistrict ?? null,
    village: loc?.village ?? null,
    location_detail: loc?.location_detail ?? null,
    postal_code: loc?.postal_code ?? null,
    longitude: loc?.longitude ?? null,
    latitude: loc?.latitude ?? null,
  };
}

async function ensureFullPropertyData(contextProperty) {
  if (!contextProperty?.custom_uuid) return null;

  // Check if we already have substantive data beyond just IDs
  const hasData = contextProperty.price != null
    || contextProperty.bed_room != null
    || contextProperty.bath_room != null
    || contextProperty.description != null;

  // Check if location data is already present
  const hasLocation = contextProperty.province != null
    || contextProperty.city != null
    || contextProperty.subdistrict != null
    || contextProperty.village != null;

  // If we have listing data but missing location, fetch just the location row
  if (hasData && !hasLocation) {
    const { data: loc } = await supabase
      .from('location')
      .select('*')
      .eq('product_uuid', contextProperty.custom_uuid)
      .maybeSingle();

    if (loc) {
      contextProperty.province = loc.province ?? null;
      contextProperty.city = loc.city ?? null;
      contextProperty.subdistrict = loc.subdistrict ?? null;
      contextProperty.village = loc.village ?? null;
      contextProperty.location_detail = loc.location_detail ?? null;
      contextProperty.postal_code = loc.postal_code ?? null;
      contextProperty.longitude = loc.longitude ?? null;
      contextProperty.latitude = loc.latitude ?? null;
    }
    return contextProperty;
  }

  if (hasData && hasLocation) return contextProperty;

  // Only have minimal data (custom_uuid + listing_type) – fetch full record from DB
  const full = await fetchFullPropertyFromDB(
    contextProperty.custom_uuid,
    contextProperty.listing_type
  );

  return full || contextProperty;
}

async function classifyIntent(lastUserText, pendingAlternative, hasCurrentProperty) {
  if (!process.env.GROQ_API_KEY) {
    return {
      intent: hasCurrentProperty ? 'follow_up' : 'chitchat',
      wants_results: false,
      query: '',
    };
  }

  const systemPrompt = `
You are an intent classifier for a real estate platform named Are Property. You are a chat assistant that helps users find properties in Bali.

You receive:
- lastUserText: the latest message from the user (string)
- hasPendingAlternative: whether there is an outstanding alternative suggestion (boolean)
- hasCurrentProperty: whether a property is currently being displayed to the user (boolean)

You must return STRICT JSON with this shape:
{
  "intent": "search" | "follow_up" | "chitchat" | "accept_alternative" | "reject_alternative",
  "wants_results": boolean,
  "query": string
}

Definitions:
- "search": the user is asking to find NEW or DIFFERENT properties (e.g. "I want a villa in Canggu", "find land with pool", "I'm looking for an apartment", "show me something else", "find another one").
- "follow_up": the user is asking a question about the property currently being displayed, or requesting more information about it. This includes questions like "how many bedrooms?", "what's the price?", "tell me more", "does it have a pool?", "where is it located?", "what are the facilities?", "show me details of this villa", "tell me about this property". This applies even without explicit reference words like "this" or "it" — if a property is displayed and the user asks about property attributes, it IS a follow_up.
- "chitchat": greetings, thanks, short acknowledgements, or general questions not about properties or the displayed property.
- "accept_alternative": the user is explicitly agreeing to see an alternative property you previously suggested (e.g. "yes please show it", "okay, show me that one").
- "reject_alternative": the user is explicitly declining an alternative (e.g. "no I don't want that", "that's not what I want").

Rules:
- CRITICAL: When hasCurrentProperty is true and the user asks about property attributes (bedrooms, price, facilities, location, area, details, etc.), you MUST classify as "follow_up", NOT "search". Even "how many bedrooms?" without "this" or "it" is "follow_up" when hasCurrentProperty is true.
- Only classify as "search" when the user clearly wants to find DIFFERENT or NEW properties — look for phrases like "find me a…", "search for…", "I want a new…", "show me another…", "something else", or introduces a completely new search criteria (new location + new type).
- When hasPendingAlternative is true and the user clearly says yes/accept, intent should be "accept_alternative".
- When hasPendingAlternative is true and the user clearly says no/reject, intent should be "reject_alternative".
- "wants_results" is true when the user expects property results to be shown now.
- "query" should be the best single-sentence representation of the user's search intent, or an empty string for follow_up/chitchat.
- Simple acknowledgements like "ok that's great", "thanks", "awesome" WITHOUT any property keywords should be treated as "chitchat" with wants_results = false.
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
        {
          role: 'user',
          content: JSON.stringify({
            lastUserText,
            hasPendingAlternative: !!pendingAlternative,
            hasCurrentProperty: !!hasCurrentProperty,
          }),
        },
      ],
      temperature: 0,
    }),
  });

  if (!response.ok) {
    throw new Error(`Groq intent-classifier error: ${response.status} ${response.statusText}`);
  }

  const json = await response.json();
  const content = json.choices?.[0]?.message?.content;

  let parsed;
  try {
    parsed = typeof content === 'string' ? JSON.parse(content) : content;
  } catch {
    throw new Error('Failed to parse Groq intent-classifier JSON');
  }

  return {
    intent: parsed.intent || (hasCurrentProperty ? 'follow_up' : 'chitchat'),
    wants_results: Boolean(parsed.wants_results),
    query: typeof parsed.query === 'string' ? parsed.query : '',
  };
}

const NOT_SPECIFIED = "That information isn't specified in the listing.";

function buildFollowUpAnswer(text, property) {
  const t = (text || '').toLowerCase();
  const facilities = Array.isArray(property.facilities)
    ? property.facilities
    : typeof property.facilities === 'string'
      ? [property.facilities]
      : [];

  if (/\b(bedroom|bedrooms|bed)\b/.test(t)) {
    const v = property.bed_room ?? property.bedrooms;
    if (v != null && v !== '') return `That ${property.listing_type === 'property' ? 'villa' : property.listing_type || 'property'} has ${v} bedroom${Number(v) !== 1 ? 's' : ''}.`;
    return NOT_SPECIFIED;
  }
  if (/\b(bathroom|bathrooms|bath)\b/.test(t)) {
    const v = property.bath_room ?? property.bathrooms;
    if (v != null && v !== '') return `It has ${v} bathroom${Number(v) !== 1 ? 's' : ''}.`;
    return NOT_SPECIFIED;
  }
  if (/\b(price|how much|cost)\b/.test(t)) {
    const v = property.price;
    if (v != null && v !== '') return `The price is ${typeof v === 'number' ? v.toLocaleString() : v}.`;
    return NOT_SPECIFIED;
  }
  if (/\b(land size|land area|land)\b/.test(t)) {
    const v = property.land_area;
    if (v != null && v !== '') return `The land area is ${v}${typeof v === 'number' ? ' m²' : ''}.`;
    return NOT_SPECIFIED;
  }
  if (/\b(building size|building area)\b/.test(t)) {
    const v = property.building_area;
    if (v != null && v !== '') return `The building area is ${v}${typeof v === 'number' ? ' m²' : ''}.`;
    return NOT_SPECIFIED;
  }
  if (/\bpool\b/.test(t)) {
    if (!facilities.length) return NOT_SPECIFIED;
    const hasPool = facilities.some(f => String(f).toLowerCase().includes('pool'));
    return hasPool ? "Yes, it has a pool." : "No, it doesn't have a pool.";
  }
  if (/\bfacilities\b/.test(t)) {
    if (facilities.length) return `The listed facilities are: ${facilities.join(', ')}.`;
    return NOT_SPECIFIED;
  }
  if (/\b(location|where|located|area|address)\b/.test(t)) {
    const typeLabel = property.listing_type === 'property' ? 'villa' : property.listing_type || 'property';

    // Build location string from real location table data
    const locationParts = [
      property.village,
      property.subdistrict,
      property.city,
      property.province,
    ].filter(Boolean);

    // Fallback: parse from title if no location table data
    const locationStr = locationParts.length
      ? locationParts.join(', ')
      : extractLocationFromTitle(property.title);

    const zone = property.zone;
    const strategic = Array.isArray(property.strategic_location) && property.strategic_location.length
      ? property.strategic_location
      : typeof property.strategic_location === 'string' && property.strategic_location
        ? [property.strategic_location]
        : [];
    const detail = property.location_detail;

    const parts = [];
    if (locationStr) parts.push(`located in ${locationStr}`);
    if (zone) parts.push(`zone ${zone}`);
    if (detail) parts.push(`(${detail})`);
    if (strategic.length) parts.push(`near ${strategic.join(', ')}`);

    if (parts.length) {
      return `This ${typeLabel} is ${parts.join(', ')}.`;
    }
    return NOT_SPECIFIED;
  }
  return NOT_SPECIFIED;
}

function extractLocationFromTitle(title) {
  if (!title) return null;
  // Titles follow patterns like "LAND IN CEMAGI", "APARTMENT IN UNGASAN", "VILLA IN CANGGU"
  const match = title.match(/\bIN\s+(.+)$/i);
  if (match) {
    // Title-case the location: "CEMAGI" -> "Cemagi", "ECHO BEACH" -> "Echo Beach"
    return match[1].trim().replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  }
  return null;
}

function buildDetailSummary(property) {
  const typeLabel = property.listing_type === 'property' ? 'villa' : property.listing_type || 'property';
  const lines = [];

  if (property.title)
    lines.push(`**${property.title}**`);

  // Build full location from location table fields (real address hierarchy)
  const locationParts = [
    property.village,
    property.subdistrict,
    property.city,
    property.province,
  ].filter(Boolean);

  if (locationParts.length) {
    lines.push(`Location: ${locationParts.join(', ')}`);
  } else {
    // Fallback: parse from title if no location table data
    const titleLocation = extractLocationFromTitle(property.title);
    if (titleLocation) lines.push(`Location: ${titleLocation}`);
  }

  // Zone is a sub-area code (e.g. "PINK"), label it accurately
  if (property.zone)
    lines.push(`Zone: ${property.zone}`);

  if (property.location_detail)
    lines.push(`Address detail: ${property.location_detail}`);

  if (property.price != null)
    lines.push(`Price: ${typeof property.price === 'number' ? property.price.toLocaleString() : property.price}`);
  if (property.bed_room != null)
    lines.push(`Bedrooms: ${property.bed_room}`);
  if (property.bath_room != null)
    lines.push(`Bathrooms: ${property.bath_room}`);
  if (property.building_area != null)
    lines.push(`Building area: ${property.building_area} m²`);
  if (property.land_area != null)
    lines.push(`Land area: ${property.land_area} m²`);
  if (Array.isArray(property.facilities) && property.facilities.length)
    lines.push(`Facilities: ${property.facilities.join(', ')}`);

  // Include strategic location info (nearby landmarks, areas)
  const strategic = Array.isArray(property.strategic_location) && property.strategic_location.length
    ? property.strategic_location
    : typeof property.strategic_location === 'string' && property.strategic_location
      ? [property.strategic_location]
      : [];
  if (strategic.length)
    lines.push(`Strategic location: ${strategic.join(', ')}`);

  if (lines.length <= 1) {
    return `That ${typeLabel} doesn't have additional detailed information in our records.`;
  }

  return `Here are the details for this ${typeLabel}: --- ${lines.join(' --- ')}`;
}


// ── LLM-powered follow-up: answers ANY question about the displayed property ──

async function generateFollowUpAnswer(userQuestion, property) {
  const regexAnswer = buildFollowUpAnswer(userQuestion, property);
  const lower = (userQuestion || '').toLowerCase();

  // 1. General overview/summary request → structured detail summary (no LLM needed)
  const isDetailRequest =
    /\b(all details|all detail|full details|full detail|all information|detail information|tell me more|more details)\b/i.test(lower)
    || /\b(know about|know more|tell me about|what about|info on|information about|details of|details on|describe)\b/i.test(lower)
    || /\b(more about (this|that|it|the))\b/i.test(lower)
    || /\b(about (this|that) (property|villa|apartment|land|unit|house|place))\b/i.test(lower)
    || /\b(know about the (first|second|third|fourth|fifth|last))\b/i.test(lower);

  if (isDetailRequest) {
    return buildDetailSummary(property);
  }

  // 2. Specific or open-ended question → use LLM for an engaging, conversational answer
  //    The LLM has the full property data and temperature 0.2 (slightly warm for personality,
  //    but still factual). Regex answer serves as fallback if LLM is unavailable.
  if (!process.env.GROQ_API_KEY) {
    return regexAnswer !== NOT_SPECIFIED ? regexAnswer : NOT_SPECIFIED;
  }

  const typeLabel = property.listing_type === 'property' ? 'villa' : property.listing_type || 'property';

  const propertyData = {
    type: typeLabel,
    title: property.title,
    description: property.description,
    price: property.price,
    zone: property.zone,
    bedrooms: property.bed_room,
    bathrooms: property.bath_room,
    building_area: property.building_area,
    land_area: property.land_area,
    facilities: property.facilities,
    strategic_location: property.strategic_location,
    province: property.province,
    city: property.city,
    subdistrict: property.subdistrict,
    village: property.village,
    location_detail: property.location_detail,
  };

  const systemPrompt = `
You are a friendly, knowledgeable real estate assistant. A user is asking about a ${typeLabel} they are currently viewing.

Here is ALL the data for this ${typeLabel}:
${JSON.stringify(propertyData, null, 2)}

Your personality:
- Be warm, conversational, and enthusiastic — like a helpful friend who knows real estate well.
- Give a direct answer first, then add a brief helpful comment or context when relevant (e.g. mentioning how the feature compares, or what it's great for).
- Keep it concise: 2–4 sentences max. Don't ramble.
- End with a light invitation like "Anything else you'd like to know?" or "Want to know more about something else?" (vary the phrasing).

Hard rules:
- Answer ONLY from the data provided above. Do NOT invent, assume, or fabricate any information.
- If the requested information is not available, say something like: "Hmm, that specific detail isn't listed for this property. Anything else I can help with?"
- Do NOT mention other properties or suggest new searches.
- Do NOT say "based on the data" or similar meta-phrases. Just answer naturally.
- The property's real location is: province, city, subdistrict, village (NOT the "zone" field — that's an internal code).
- When talking about price, format it nicely (e.g. "300 million IDR" or "IDR 300,000,000").
  `.trim();

  try {
    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userQuestion },
        ],
        temperature: 0.2,
      }),
    });

    if (!response.ok) {
      return regexAnswer !== NOT_SPECIFIED ? regexAnswer : NOT_SPECIFIED;
    }

    const json = await response.json();
    return json.choices?.[0]?.message?.content || (regexAnswer !== NOT_SPECIFIED ? regexAnswer : NOT_SPECIFIED);
  } catch {
    return regexAnswer !== NOT_SPECIFIED ? regexAnswer : NOT_SPECIFIED;
  }
}

// ── Resolve which property the user means from a multi-result list ──

function resolveFromDisplayedResults(text, displayedResults) {
  if (!Array.isArray(displayedResults) || !displayedResults.length) return null;
  const t = (text || '').toLowerCase();

  // 1. Ordinal references ("first one", "second", "#3", etc.)
  const ordinals = [
    { patterns: [/\b(first|1st|number one|number 1|#1|top pick|top one)\b/], index: 0 },
    { patterns: [/\b(second|2nd|number two|number 2|#2|middle one)\b/], index: 1 },
    { patterns: [/\b(third|3rd|number three|number 3|#3)\b/], index: 2 },
    { patterns: [/\b(fourth|4th|number four|number 4|#4)\b/], index: 3 },
    { patterns: [/\b(fifth|5th|number five|number 5|#5)\b/], index: 4 },
  ];

  for (const { patterns, index } of ordinals) {
    if (index < displayedResults.length) {
      for (const pattern of patterns) {
        if (pattern.test(t)) {
          return displayedResults[index];
        }
      }
    }
  }

  // "last one" / "last" → last item
  if (/\b(last one|the last|last)\b/.test(t) && displayedResults.length > 0) {
    return displayedResults[displayedResults.length - 1];
  }

  // 2. Title matching — check if the user mentions a displayed property by name.
  //    e.g. "I want the VILLA IN SANUR" matches a displayed result titled "VILLA IN SANUR".
  //    Only match if the user is NOT explicitly requesting a *new/different* search.
  // "more" is excluded here because it's ambiguous — "know more about X" means more info,
  // not more/different results. "more" as in "show me more options" is covered by "other"/"another".
  const wantsDifferent = /\b(another|different|new|other|else|instead)\b/i.test(t);
  if (!wantsDifferent) {
    // Try full title match first (most specific → safest)
    for (const result of displayedResults) {
      const title = (result.title || '').toLowerCase();
      if (title && title.length > 3 && t.includes(title)) {
        return result;
      }
    }

    // Try matching by the location part of the title (e.g. "sanur" from "VILLA IN SANUR")
    // Only if there's a single match to avoid ambiguity.
    const locationMatches = [];
    for (const result of displayedResults) {
      const title = (result.title || '');
      const locMatch = title.match(/\bIN\s+(.+)$/i);
      if (locMatch) {
        const locationName = locMatch[1].trim().toLowerCase();
        // Check the user mentioned this location AND a property type that matches
        if (locationName.length > 2 && t.includes(locationName)) {
          locationMatches.push(result);
        }
      }
    }
    // Only resolve if exactly one displayed result matches the location to avoid ambiguity
    if (locationMatches.length === 1) {
      return locationMatches[0];
    }
  }

  return null;
}

async function callAiSearch(query) {
  const response = await fetch(`${BACKEND_BASE_URL}/api/ai-search`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });

  if (!response.ok) {
    throw new Error(`ai-search HTTP error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

export const aiChatController = {
  async chat(req, res) {
    try {
      const { messages, pendingAlternative, currentProperty, displayedResults } = req.body || {};

      if (!Array.isArray(messages) || !messages.length) {
        return res.status(400).json({
          success: false,
          message: 'Field "messages" is required and must be a non-empty array',
        });
      }

      const lastUser = [...messages].reverse().find(m => m.role === 'user');
      const lastText = (lastUser?.content || '').toLowerCase();

      // ── Determine context property and enrich from DB if needed ──
      let contextProperty =
        pendingAlternative?.custom_uuid
          ? pendingAlternative
          : currentProperty?.custom_uuid || currentProperty?.id
            ? currentProperty
            : null;

      // If no single contextProperty but multiple results are displayed,
      // try to resolve which one the user is asking about (ordinal or title references).
      let resolvedFromDisplayed = false;
      if (!contextProperty && Array.isArray(displayedResults) && displayedResults.length > 1) {
        // Ensure displayed results have titles for title-based matching.
        // Frontend may only send minimal data (custom_uuid, listing_type, price, etc.)
        // without the title — fetch titles from DB if missing.
        const needsTitles = displayedResults.some(r => !r.title && r.custom_uuid);
        if (needsTitles) {
          const uuids = displayedResults.map(r => r.custom_uuid).filter(Boolean);
          const tables = ['apartment', 'property', 'land'];
          const titleLookups = await Promise.all(
            tables.map(table =>
              supabase
                .from(table)
                .select('custom_uuid, title')
                .in('custom_uuid', uuids)
            )
          );
          const titleMap = {};
          for (const { data } of titleLookups) {
            if (data) {
              for (const row of data) {
                if (row.custom_uuid && row.title) {
                  titleMap[row.custom_uuid] = row.title;
                }
              }
            }
          }
          for (const r of displayedResults) {
            if (!r.title && r.custom_uuid && titleMap[r.custom_uuid]) {
              r.title = titleMap[r.custom_uuid];
            }
          }
        }

        const resolved = resolveFromDisplayedResults(lastText, displayedResults);
        if (resolved) {
          contextProperty = resolved;
          resolvedFromDisplayed = true;
        }
      }

      if (contextProperty) {
        contextProperty = await ensureFullPropertyData(contextProperty);
      }

      // ── Intent classification (now context-aware) ──
      let intent, wants_results, query;
      try {
        const intentInfo = await classifyIntent(
          lastUser?.content || '',
          pendingAlternative,
          !!contextProperty  // tell classifier whether a property is displayed
        );
        intent = intentInfo.intent;
        wants_results = intentInfo.wants_results;
        query = intentInfo.query;
      } catch {
        intent = contextProperty ? 'follow_up' : 'chitchat';
        wants_results = false;
        query = '';
      }

      // ── Extra safety: regex override for yes/no when alternative is pending ──
      if (pendingAlternative?.custom_uuid) {
        const positive =
          /\b(yes|yeah|yep|sure|ok|okay|alright|go ahead|why not|please show|show it|show me|let me see|let's see|sounds good|that works|fine|i don't mind|i dont mind|whatever|wherever|up to you)\b/.test(
            lastText
          );
        const negative =
          /\b(nope|no thanks|no thank|dont want|don't want|not interested|no|skip|pass|never mind|nevermind)\b/.test(
            lastText
          );

        if (positive && !negative) {
          intent = 'accept_alternative';
          wants_results = true;
        } else if (negative) {
          intent = 'reject_alternative';
          wants_results = false;
        }
      }

      // ── Selection from displayed results: force follow-up ──
      // When the user picked a specific property from the displayed list (by ordinal
      // or by title, e.g. "I want the VILLA IN SANUR"), always treat as follow-up —
      // they're selecting, not searching for something new.
      if (resolvedFromDisplayed && contextProperty) {
        intent = 'follow_up';
      }

      // ── Follow-up safety net: catch misclassified follow-ups ──
      // If the classifier said "search" but a property is displayed and the user
      // is asking ABOUT it (not requesting a different property), override to follow_up.
      if (contextProperty && intent === 'search' && !resolvedFromDisplayed) {
        const isExplicitNewSearch =
          /\b(find|search|looking for|i want a|i need a|show me a)\b/i.test(lastText)
          || /\b(another|different|new|other|else|instead)\b/i.test(lastText);
        const isAskingAboutCurrent =
          /\b(\?|how many|how much|what('s| is| are)|where|does it|is it|is there|tell me|detail|more about|info|about this|about that|about the)\b/i.test(lastText);

        if (isAskingAboutCurrent && !isExplicitNewSearch) {
          intent = 'follow_up';
        }
      }

      // ── Follow-up: answer from property context ──
      if (intent === 'follow_up' && contextProperty) {
        // If the user selected a property from displayed results (by title or ordinal),
        // show the full detail summary directly — don't send to LLM which might hallucinate.
        const answer = resolvedFromDisplayed
          ? buildDetailSummary(contextProperty)
          : await generateFollowUpAnswer(lastUser?.content || '', contextProperty);
        return res.status(200).json({
          success: true,
          messages: [{ role: 'assistant', content: answer }],
          data: [contextProperty],
        });
      }

      // ── Hard intent gate: only proceed to search when intent is search + wants_results ──
      if (intent !== 'search' || !wants_results) {
        if (intent !== 'accept_alternative' && intent !== 'reject_alternative') {
          intent = 'chitchat';
        }
      }

      // For search intents, always use the latest user sentence as the query
      if (intent === 'search' && lastUser?.content) {
        query = lastUser.content;
      }

      // Only upgrade chitchat to search when there's NO current property displayed
      // and BOTH a search verb and a property noun exist.
      // GUARD: Don't hijack follow-ups like "show me details of this villa".
      const hasSearchVerb = /\b(find|search|looking for|i want a|i need a|recommend)\b/i.test(lastUser?.content || '');
      const hasPropertyNoun = /\b(villa|apartment|land|house|unit)\b/i.test(lastUser?.content || '');
      if (intent === 'chitchat' && !contextProperty && hasSearchVerb && hasPropertyNoun) {
        intent = 'search';
        wants_results = true;
        query = lastUser?.content || query;
      }

      // Chitchat: talk normally, but stay within the scope of this system
      // (real-estate assistant that only knows this database).
      if (intent === 'chitchat' || !wants_results) {
        if (!process.env.GROQ_API_KEY) {
          return res.status(200).json({
            success: true,
            messages: [
              {
                role: 'assistant',
                content:
                  "I'm currently configured only for property search. Please tell me what kind of property or location you're interested in.",
              },
            ],
            data: [],
          });
        }

        // If a property is currently displayed, inject its data so the LLM can
        // answer stray questions that slipped past the follow-up gate.
        const propertyContext = contextProperty
          ? `\n\nThe user is currently viewing this property:\n${JSON.stringify({
              type: contextProperty.listing_type === 'property' ? 'villa' : contextProperty.listing_type,
              title: contextProperty.title,
              price: contextProperty.price,
              zone: contextProperty.zone,
              bedrooms: contextProperty.bed_room,
              bathrooms: contextProperty.bath_room,
              building_area: contextProperty.building_area,
              land_area: contextProperty.land_area,
              facilities: contextProperty.facilities,
              strategic_location: contextProperty.strategic_location,
              province: contextProperty.province,
              city: contextProperty.city,
              subdistrict: contextProperty.subdistrict,
              village: contextProperty.village,
              location_detail: contextProperty.location_detail,
            }, null, 2)}\nIf the user asks about this property, answer ONLY from this data. Do NOT invent information not listed here. The real location of this property is determined by the province/city/subdistrict/village fields, NOT the "zone" field.`
          : '';

        const chatSystemPrompt = `
You are a real estate chat assistant for a specific property database.

You must follow these rules:
- You ONLY know about properties in the current backend database; do NOT claim you can search other websites, agencies, or generic "databases".
- You MUST NOT invent specific new properties, locations, or prices. Never say "we have a land in X" or "we have a villa in Y" unless the user has just seen that property as a result.
- You may mention a location name ONLY if it appears in the user's latest message (for example, if the user says "Canggu", you can mention Canggu, but you must not introduce new areas like "Kerobokan" on your own).
- If you have previously told the user there is no exact match for a location (for example, no villa in Canggu), you MUST NOT later say you can find one there.
- Instead, you may remind them that there is no listing in that exact area in the current database and offer to adjust the search (different area, budget, type, etc.).
- Stay honest about limitations. If something is not in the data, say so explicitly.

When the user is not explicitly asking for a search, you can answer questions, clarify their preferences, or suggest how to phrase a property request, but you must not promise specific listings or mention new areas that the user did not mention.${propertyContext}${
          pendingAlternative?.custom_uuid
            ? '\n\nIMPORTANT: There is a pending alternative property suggestion that the user has not yet accepted or rejected. Do NOT describe this property with specific details (bedrooms, price, area, facilities, etc.) because you do not know those details. Instead, gently remind them that you suggested an alternative and ask if they would like to see it.'
            : ''
        }
        `.trim();

        const response = await fetch(GROQ_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          },
          body: JSON.stringify({
            model: 'llama-3.1-8b-instant',
            messages: [
              { role: 'system', content: chatSystemPrompt },
              ...messages,
            ],
            temperature: pendingAlternative?.custom_uuid ? 0.1 : 0.4,
          }),
        });

        if (!response.ok) {
          throw new Error(`Groq chat error: ${response.status} ${response.statusText}`);
        }

        const json = await response.json();
        const content = json.choices?.[0]?.message?.content || '';

        // IMPORTANT: If there's still a pending alternative, echo it back so
        // the frontend doesn't clear it. Otherwise the user can't say "yes"
        // after a chitchat turn to accept the alternative.
        const chitchatResponse = {
          success: true,
          messages: [{ role: 'assistant', content }],
          data: [],
        };
        if (pendingAlternative?.custom_uuid) {
          chitchatResponse.alternative = pendingAlternative;
        }

        return res.status(200).json(chitchatResponse);
      }

      // Accepting an alternative suggestion: show the pending alternative listing
      if (intent === 'accept_alternative' && pendingAlternative?.custom_uuid) {
        const typeLabel =
          pendingAlternative.listing_type === 'property'
            ? 'villa'
            : pendingAlternative.listing_type;

        return res.status(200).json({
          success: true,
          messages: [
            {
              role: 'assistant',
              content: `Great, here is the ${typeLabel} I mentioned. Let me know if you'd like to adjust your search or explore another area.`,
            },
          ],
          data: [pendingAlternative],
        });
      }

      // Rejecting an alternative suggestion: acknowledge and invite a new search
      if (intent === 'reject_alternative' && pendingAlternative) {
        return res.status(200).json({
          success: true,
          messages: [
            {
              role: 'assistant',
              content:
                "Got it, I won't show that one. Tell me another area or type of property and I'll search again.",
            },
          ],
          data: [],
        });
      }

      // Default: search intent – call ai-search as the engine
      const searchResult = await callAiSearch(query || '');

      // If we have results (1, 3, or 5 depending on query specificity)
      if (Array.isArray(searchResult.data) && searchResult.data.length > 0) {
        const results = searchResult.data;

        // Use the AI-generated summary which includes engaging soft reranking.
        // Falls back to the first item's explanation for single results,
        // or a generic message if no summary was generated.
        const summaryMessage =
          searchResult.summary
          || results[0]?.explanation
          || 'I found some properties matching your request!';

        return res.status(200).json({
          success: true,
          messages: [{ role: 'assistant', content: summaryMessage }],
          data: results,
        });
      }

      // No strict match; maybe we have an AI-suggested alternative
      if (searchResult.alternative?.custom_uuid) {
        let altText =
          searchResult.alternative.explanation ||
          'I could not find an exact match, but I found an alternative property.';

        // Make sure the message clearly asks the user whether they want to see it
        const trimmedAlt = altText.trim();
        if (!trimmedAlt.endsWith('?')) {
          altText = `${trimmedAlt} Would you like to see it?`;
        }

        return res.status(200).json({
          success: true,
          messages: [
            {
              role: 'assistant',
              content: altText,
            },
          ],
          data: [],
          alternative: searchResult.alternative,
        });
      }

      // Truly no good match
      return res.status(200).json({
        success: true,
        messages: [
          {
            role: 'assistant',
            content:
              searchResult.explanation ||
              "I couldn't find any properties that are close enough to your request in our current listings.",
          },
        ],
        data: [],
      });
    } catch (error) {
      console.error('AI chat error:', error);
      return res.status(500).json({
        success: false,
        message: error?.message || 'AI chat failed',
      });
    }
  },
};

