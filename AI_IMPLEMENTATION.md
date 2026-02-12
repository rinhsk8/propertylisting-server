## AI Property Assistant – Implementation Summary

This document explains how the AI Assistant is implemented in this backend so future work can reuse the same design without re‑deriving everything.

---

### 1. High‑level architecture

- **Database**: Supabase (Postgres + pgvector)
  - Tables: `apartment`, `property`, `land`, `location`
  - Embedding columns:
    - `apartment.embedding vector(384)`
    - `property.embedding vector(384)`
    - `land.embedding vector(384)`
- **Embeddings**:
  - Generated via Supabase Edge Function `full_embed` using model `gte-small` (384‑dim).
  - Text used for each listing’s embedding is a **combination of listing fields and its location row**.
- **Search engine**:
  - `POST /api/ai-search` in `controllers/aiSearch.controller.js`
  - Does:
    1. Analyze the natural language query (Groq).
    2. Embed the query (Supabase Edge Function).
    3. Run vector search over `apartment` / `property` / `land` (with pgvector).
    4. Apply simple structured filters and location matching.
    5. Ask Groq to pick a single **best strict match** and explain it.
    6. If no strict match, optionally offer one **AI‑chosen alternative**.
- **Chat brain**:
  - `POST /api/ai-search/chat` in `controllers/aiChat.controller.js`
  - Orchestrates:
    - Intent classification (search vs chitchat vs accept/reject alternative).
    - Calls `/api/ai-search` when needed.
    - Returns assistant messages + minimal property references for the frontend to resolve.

**Important**: The frontend should talk only to `/api/ai-search/chat`. That endpoint is the combined “chat + search” brain.

---

### 2. Supabase & embeddings

#### 2.1 pgvector columns

Added in Supabase SQL editor:

```sql
alter table apartment add column if not exists embedding vector(384);
alter table property  add column if not exists embedding vector(384);
alter table land      add column if not exists embedding vector(384);
```

#### 2.2 Vector search functions

Defined in Supabase:

```sql
create or replace function search_apartment(query_embedding vector(384), match_count int)
returns setof apartment
language sql
as $$
  select *
  from apartment
  where embedding is not null
  order by embedding <=> query_embedding
  limit match_count;
$$;

create or replace function search_property(query_embedding vector(384), match_count int)
returns setof property
language sql
as $$
  select *
  from property
  where embedding is not null
  order by embedding <=> query_embedding
  limit match_count;
$$;

create or replace function search_land(query_embedding vector(384), match_count int)
returns setof land
language sql
as $$
  select *
  from land
  where embedding is not null
  order by embedding <=> query_embedding
  limit match_count;
$$;
```

#### 2.3 Edge Function `full_embed`

Edge function `full_embed` (in Supabase) supports two modes:

- **Query mode** – body `{ "text": string }`:
  - Runs `gte-small` with `{ mean_pool: true, normalize: true }`.
  - Returns `{ embedding: number[] }`.
- **Batch mode** – body is an array of jobs:
  - Each job: `{ id, table, embeddingColumn, content? }`.
  - If `content` is provided, it is used as the text to embed.
  - Otherwise, it builds text from `title`, `description`, `zone`, `facilities`, `strategic_location`.
  - Writes the embedding into `<table>.<embeddingColumn>` for the given `id`.

The backend **always** passes a computed `content` when (re)embedding listings, so the Edge Function does not need to know about locations directly.

---

### 3. Embedding pipeline in controllers

#### 3.1 Listing controllers

For `apartment`, `property`, and `land` controllers (`controllers/apartment.controller.js`, `property.controller.js`, `land.controller.js`), we modified **create** and **update** to:

1. Insert/update the row via Supabase.
2. Fetch the related `location` row (if any):
   - Join by `product_uuid = <listing>.custom_uuid`.
3. Build **combined content**:
   - `title`
   - `description`
   - `zone`
   - `facilities` (joined if array)
   - `strategic_location` (joined if array)
   - All string fields from the `location` row.
4. Call `supabase.functions.invoke('full_embed', { body: [{ id, table, embeddingColumn: 'embedding', content }] })`.
5. Errors in this embedding call are logged but **do not fail the CRUD** request (best‑effort).

This ensures new/updated listings have embeddings that “see” both their own fields and location text.

#### 3.2 Location controller

`controllers/location.controller.js` has a helper:

```ts
async function recomputeListingEmbeddingForLocation(locationRow) { ... }
```

On `createLocation` and `updateLocation`:

1. We find the related listing using `location.product_uuid` against:
   - `apartment.custom_uuid`
   - `property.custom_uuid`
   - `land.custom_uuid`
2. Build combined content from the **listing** fields plus **location** fields.
3. Call `full_embed` with that content to refresh the corresponding listing’s embedding.

So when a location is created or changed, its listing’s embedding is recomputed to include the new location text.

#### 3.3 Backfill script

`scripts/backfillEmbeddings.js`:

- For each of `apartment`, `property`, `land` where `embedding is null`:
  - Fetch the row and its `location` (by `custom_uuid` ↔ `product_uuid`).
  - Build combined content in the same way as the controllers.
  - Call `full_embed` in batch mode to set embeddings.

Run once via:

```bash
node scripts/backfillEmbeddings.js
```

---

### 4. Search engine: `/api/ai-search`

Route wiring in `index.js`:

```js
import aiRoutes from './routes/ai.routes.js';
...
app.use('/api/ai-search', aiRoutes);
```

`routes/ai.routes.js`:

```js
router.post('/', search);        // /api/ai-search
router.post('/chat', chat);      // /api/ai-search/chat
```

#### 4.1 Query analysis (Groq)

In `aiSearch.controller.js`:

```ts
async function analyzeQueryWithGroq(userQuery) { ... }
```

Groq returns JSON:

```json
{
  "preferred_types": ["apartment","villa","land"], // subset
  "must_be_land": false,
  "min_bedrooms": 3 | null,
  "min_land_area": 200 | null,
  "location_keywords": ["Canggu"] | [],
  "hard_constraints": ["has_pool"]
}
```

This is used to:

- Decide which tables to search:
  - `"villa"` → search `property` table.
  - `"land"` / `must_be_land: true` → limit to `land` table.
  - `"apartment"` → search `apartment`.
- Apply numeric filters:
  - `min_bedrooms` → `bed_room >= min_bedrooms`.
  - `min_land_area` → `land_area >= min_land_area` (parsed as number).
- Extract `location_keywords` so we can check for exact textual matches (e.g. Canggu vs Munggu).

#### 4.2 Vector search & post‑filters

`runVectorSearch(queryEmbedding, matchCount, queryAnalysis)`:

1. Calls `search_apartment` / `search_property` / `search_land` via `supabase.rpc`.
2. Normalizes results into a common listing shape.
3. Applies structured filters:
   - `min_bedrooms`, `min_land_area`.
4. If `location_keywords` is non‑empty:
   - Compute a `haystack` string from `title`, `zone`, and `strategic_location`.
   - Keep only listings where `haystack` contains at least one location keyword (case‑insensitive).
   - If **no** listing mentions the requested location → return `[]` to mean “no strict match”.
5. Return at most `matchCount` merged listings.

This design avoids hallucinating that different places are the same (e.g. not treating “Munggu” as “Canggu” if the word “Canggu” never appears).

#### 4.3 Best match explanation

`generateExplanations(userQuery, listings)`:

- Sends `userQuery` and the `listings` array (minimal listing info) to Groq with a prompt:
  - Pick **one best** strict match.
  - Respect type constraints (don’t pick apartments when user asked for land).
  - Do not invent geography or distances.
  - If no good match: return `best.custom_uuid = null`.
- Returns an array with a single listing:

```ts
[{ ...listing, explanation }]
```

#### 4.4 Alternative suggestion

If strict search returns no listings:

1. Run a **relaxed** search (ignore `location_keywords`) but keep type/bedrooms/land_area filters.
2. If relaxed search also returns nothing → return:

```json
{ "success": true, "data": [], "explanation": "No listings in our database are close enough to your request." }
```

3. If relaxed search returns candidates:
   - Call `generateAlternativeSuggestion(userQuery, relaxedListings, queryAnalysis)`:
     - Prompt instructs Groq to:
       - Optionally choose ONE alternative listing.
       - Explain clearly that there was **no exact match** but this is a suggestion.
       - Not invent distances/times.
     - Returns:
       ```json
       { "alternative": { "custom_uuid": string | null, "explanation": string } }
       ```
4. If Groq chooses an alternative:
   - We return **only minimal info**:

```json
{
  "success": true,
  "data": [],
  "alternative": {
    "custom_uuid": "...",
    "listing_type": "property" | "apartment" | "land",
    "explanation": "..."
  }
}
```

#### 4.5 Minimal response shape

For strict best match:

```json
{
  "success": true,
  "data": [
    {
      "custom_uuid": "...",
      "listing_type": "property",
      "explanation": "Short reason..."
    }
  ]
}
```

For alternative suggestion:

```json
{
  "success": true,
  "data": [],
  "alternative": {
    "custom_uuid": "...",
    "listing_type": "property",
    "explanation": "No villa in Canggu, but this villa in Pecatu ..."
  }
}
```

The frontend is responsible for using `custom_uuid` and `listing_type` to fetch full details via existing REST routes.

---

### 5. Chat orchestrator: `/api/ai-search/chat`

`controllers/aiChat.controller.js` provides `aiChatController.chat`, wired at:

```js
router.post('/chat', chat);  // /api/ai-search/chat
```

#### 5.1 Request shape

```ts
interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AlternativeRef {
  custom_uuid: string;
  listing_type: 'apartment' | 'property' | 'land';
  explanation: string | null;
}

interface ChatRequestBody {
  messages: ChatMessage[];        // full history
  pendingAlternative?: AlternativeRef; // ONLY while waiting for yes/no
}
```

The frontend maintains `messages` and optionally `pendingAlternative`, and always sends the full conversation.

#### 5.2 Intent classifier

`classifyIntent(messages, pendingAlternative)` calls Groq and expects:

```json
{
  "intent": "search" | "chitchat" | "accept_alternative" | "reject_alternative",
  "wants_results": boolean,
  "query": string
}
```

We then:

- Apply **regex overrides** on the last user message when a `pendingAlternative` exists:
  - Phrases like “yes”, “yeah”, “sure”, “please show”, “show it” → force `intent = 'accept_alternative'`.
  - Phrases like “nope”, “no thanks”, “don’t want”, “not interested” → force `intent = 'reject_alternative'`.
- For generic `intent === 'search'`, we **always** set:

```ts
const lastUser = [...messages].reverse().find(m => m.role === 'user');
if (lastUser?.content) query = lastUser.content;
```

This ensures we search using the **latest** user sentence (e.g. “I want something different”), not an older query like “villa in Canggu”.

#### 5.3 Branches

1. **Chitchat or `!wants_results`**:
   - If no `GROQ_API_KEY` → simple fallback message.
   - Else call Groq chat directly with `messages` and return:
     ```json
     { "success": true, "messages": [ { role: 'assistant', content } ], "data": [] }
     ```

2. **Accept alternative** (`intent === 'accept_alternative'` and `pendingAlternative` present):
   - Respond with:
     ```json
     {
       "success": true,
       "messages": [
         { "role": "assistant", "content": "Great, here is the villa I mentioned..." }
       ],
       "data": [ pendingAlternative ]   // minimal ref
     }
     ```

3. **Reject alternative**:
   - Respond with:
     ```json
     {
       "success": true,
       "messages": [
         { "role": "assistant", "content": "Got it, I won't show that one..." }
       ],
       "data": []
     }
     ```

4. **Search intent** (default):
   - Call `callAiSearch(query)` which POSTs to `/api/ai-search`.
   - If `searchResult.data` (strict best match):
     - Pick `best = searchResult.data[0]`.
     - Respond:
       ```json
       {
         "success": true,
         "messages": [ { "role": "assistant", "content": best.explanation || "I found a property..." } ],
         "data": [ best ]
       }
       ```
   - Else if `searchResult.alternative`:
     - Build a user‑facing suggestion message:
       - If not ending with `?`, append `" Would you like to see it?"`.
     - Respond:
       ```json
       {
         "success": true,
         "messages": [ { "role": "assistant", "content": altText } ],
         "data": [],
         "alternative": searchResult.alternative
       }
       ```
   - Else (no good match at all):
     - Respond with a friendly “no match” message and no data.

The frontend then decides, based on `alternative`, whether it is currently in a “yes/no” decision phase.

---

### 6. Frontend expectations (summary)

Although the frontend is in a separate repo, its behavior is important for this backend:

- Always call **`POST /api/ai-search/chat`** from the AI Assistant page.
- Maintain:
  - `messages: ChatMessage[]`
  - `pendingAlternative: AlternativeRef | null`
- For each submit:
  1. Append user message to `messages`.
  2. Send `{ messages, pendingAlternative? }` to `/api/ai-search/chat`.
  3. Append `response.messages` to `messages`.
  4. If `response.data.length > 0`:
     - Clear `pendingAlternative`.
     - Fetch full property details by `custom_uuid` / `listing_type`.
  5. Else if `response.alternative` present:
     - Set `pendingAlternative = response.alternative`.
     - Do not fetch property yet; wait for “yes/no”.
  6. Else:
     - Clear `pendingAlternative`, no property to show.

With this design, the assistant:

- Understands when the user is just chatting vs searching.
- Avoids hallucinating wrong locations (e.g., not treating Munggu as Canggu).
- Can suggest alternatives and react properly to “yes/no” or “something different” follow‑ups, without getting stuck on the same property.

