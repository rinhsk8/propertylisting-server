# AI Property Search – Backend Prompt for Cursor

Use this document as the main prompt/spec when building the AI Assistant backend. Share it with Cursor in your backend repo so it understands the goal and the preferred semantic workflow.

---

## Context

We have a **property listing frontend** (Next.js). It has an **AI Assistant page** at `/ai` where users type natural-language requests, for example:

- *"I want a property near the beach with pool and pet friendly"*
- *"Villa with 3 bedrooms, garden, and parking"*
- *"Apartment in the city center, modern, under 2 billion IDR"*

The frontend will send the user’s **raw query string** to a backend API. The backend must:

1. **Understand** the request (semantic + optional structured filters).
2. **Search** our property data (in **Supabase**) using a **semantic workflow** (see below).
3. **Return** matching properties plus **AI-generated explanations** of why each property matches the user’s request.

---

## Preferred Approach: Semantic Workflow

We want a **semantic search–first** workflow, not only keyword or rigid filters.

### What “semantic workflow” means here

1. **Embeddings**
   - **Properties:** Each listing (or each searchable text blob: title, description, facilities, zone, strategic_location, etc.) should have an **embedding vector** stored in Supabase (e.g. in a dedicated column or table, using **pgvector**).
   - **User query:** The incoming user message is **embedded** with the same model (e.g. OpenAI `text-embedding-3-small` or similar).

2. **Search**
   - Use **vector similarity search** in Supabase (e.g. cosine or L2 distance) to get the top-K properties that are **semantically closest** to the user’s request.
   - Optionally combine with **structured filters** (e.g. price range, bedrooms, listing_type) if you extract them from the query (e.g. via a small LLM call) and your schema supports them. Semantic search remains the main ranking mechanism.

3. **Explanations**
   - After retrieving the top properties, call an **LLM** (e.g. OpenAI or Claude) with:
     - The user’s original query.
     - The list of returned properties (id, title, description, facilities, zone, etc.).
   - Ask the LLM to return, for each property, a **short explanation** (1–3 sentences) of why it matches the user’s request. Return these explanations with the same property list so the frontend can display them.

### What the backend should implement (semantic workflow)

- **Embedding pipeline**
  - When a property is created/updated, compute an embedding from a concatenation of: title, description, zone, facilities, strategic_location (and any other searchable text). Store the embedding in Supabase (pgvector column).
  - If embeddings don’t exist yet, add a migration to add the vector column and, if needed, a one-off job to backfill embeddings for existing rows.

- **Search endpoint**
  - Accept: `POST /api/ai-search` (or your chosen path) with body `{ "query": "<user natural language string>" }`.
  - Steps:
    1. Embed the user `query` with the same model you use for properties.
    2. Run a **vector similarity search** in Supabase (e.g. “order by embedding <=> query_embedding limit N”). Optionally apply safe structured filters (price, bedrooms, etc.) if you extract them and your schema supports them.
    3. Fetch full property rows for the top-K results (e.g. from `properties` and/or `apartment`, `land` tables, depending on your schema).
    4. Call the LLM with the user query and the list of properties; get back one explanation per property.
    5. Return a JSON response in the shape below.

- **Response shape** (so the frontend can render results and explanations)

  Return an array of objects that the frontend can map to property cards and explanations, for example:

  ```json
  {
    "success": true,
    "data": [
      {
        "custom_uuid": "...",
        "title": "...",
        "images": ["url1", "url2"],
        "price": 1234567890,
        "zone": "...",
        "bed_room": 3,
        "bath_room": 2,
        "building_area": "...",
        "land_area": "...",
        "facilities": ["pool", "..."],
        "strategic_location": ["beach", "..."],
        "explanation": "Short AI-generated text on why this property matches the user's request."
      }
    ]
  }
  ```

  Adjust field names to match your Supabase schema; the frontend expects at least: `custom_uuid`, `title`, an image URL (e.g. `images[0]`), `price`, and `explanation`.

---

## API Contract (for frontend–backend agreement)

- **Method:** POST  
- **Path:** e.g. `POST /api/ai-search` or `POST /api/properties/ai-search` (your backend base URL is already used by the frontend; add this route there).  
- **Request body:** `{ "query": string }`  
- **Response:** `{ success: boolean, data: Array<PropertyWithExplanation> }`  
- **Errors:** Return appropriate status codes and a clear message so the frontend can show “No results” or “Something went wrong.”

The frontend will call this endpoint when the user clicks “Search” on the AI Assistant page and will display the returned list and explanations.

---

## Security and Safety

- **Never** run raw SQL or arbitrary queries generated by an LLM. Use only:
  - Parameterized / safe Supabase client calls (e.g. `.select()`, `.rpc()` with fixed function names), or
  - Vector search with the embedding passed as a parameter.
- Keep **LLM and embedding API keys** only on the backend (env vars). Do not expose them to the frontend.
- Use Supabase with a **server-side** key (e.g. service role or backend-only key) so the AI search logic cannot be bypassed by clients.

---

## Tech Hints

- **Supabase:** Use as source of truth for properties. Add a vector column (pgvector) for embeddings; run similarity search in SQL or via Supabase client.
- **Embeddings:** Same model for both indexing and query (e.g. OpenAI `text-embedding-3-small`). Normalize text (e.g. concatenate title + description + facilities + zone) before embedding.
- **LLM:** Use for (1) optional extraction of structured filters from the query, and (2) generating per-property explanations. One call for explanations after retrieval is enough; no need to let the LLM generate SQL or raw queries.

---

## Summary for Cursor (copy this into the backend chat)

**Goal:** Implement the backend for an “AI Property Search” feature using a **semantic workflow**.

1. **Semantic search:** Store embeddings for each property in Supabase (pgvector). Embed the user’s natural-language query and run vector similarity search to get the top matching properties.
2. **Optional:** Use an LLM to extract structured filters (price, bedrooms, etc.) and apply them in addition to vector search.
3. **Explanations:** After retrieval, call an LLM with the user query and the list of properties; return one short explanation per property.
4. **API:** Expose `POST /api/ai-search` (or your chosen path) with body `{ "query": "<user message>" }` and return `{ success, data: [ { custom_uuid, title, images, price, zone, ... , explanation } ] }`.
5. **Safety:** No raw SQL from the LLM; only parameterized Supabase calls and vector search. Keep API keys server-side.

The frontend already exists and will call this API; match the response shape above so property cards and explanations display correctly.

---

## Current Implementation Notes (as of this repo)

This section documents how the plan above has actually been implemented in this backend, so future changes can respect the existing design.

### Data model and embeddings

- Tables:
  - `apartment`, `property`, `land` – main listing tables.
  - `location` – each row has a `product_uuid` that points to the `custom_uuid` of a listing (apartment/property/land).
- Embedding columns:
  - `apartment.embedding vector(384)`
  - `property.embedding vector(384)`
  - `land.embedding vector(384)`
- Embedding generation:
  - Implemented via a Supabase Edge Function named **`full_embed`** using Supabase AI `gte-small` (384‑dim) with `{ mean_pool: true, normalize: true }`.
  - The Edge Function supports:
    - **Query mode:** body `{ "text": string }` → `{ "embedding": number[] }`.
    - **Batch mode:** body is an array of jobs `{ id, table, embeddingColumn, content? }`. If `content` is provided, that text is embedded and written to `<table>.<embeddingColumn>` for the given `id`.
  - Controllers always send a `content` string so the Edge Function does not need to know about locations.
- Combined embedding text for each listing includes:
  - Listing fields: `title`, `description`, `zone`, `facilities`, `strategic_location`.
  - Location fields: all string columns from the related `location` row (`location.product_uuid = listing.custom_uuid`).

This way, each listing’s embedding “sees” both its own description and its location context.

### When embeddings are written

- In `apartment.controller.js`, `property.controller.js`, `land.controller.js`:
  - After **create** and **update**, the controller:
    1. Loads the just‑created/updated row.
    2. Looks up its `location` row (if any) via `product_uuid = custom_uuid`.
    3. Builds a combined text string (listing + location).
    4. Calls `full_embed` with a single job `{ id, table, embeddingColumn: 'embedding', content }`.
  - Embedding errors are logged but do not fail the request (best‑effort).
- In `location.controller.js`:
  - Helper `recomputeListingEmbeddingForLocation(locationRow)`:
    - Finds the associated listing in `apartment`, `property`, or `land` by `custom_uuid`.
    - Rebuilds combined content (listing + this location row) and calls `full_embed` to refresh the listing’s embedding.
  - `createLocation` and `updateLocation` call this helper after writing the location row.

### Backfill script

- `scripts/backfillEmbeddings.js`:
  - For each of the tables `apartment`, `property`, `land` where `embedding IS NULL`:
    - Loads each row and its `location` (by `custom_uuid` ↔ `product_uuid`).
    - Builds the same combined content as controllers.
    - Calls `full_embed` in batch mode for each row to populate `embedding`.

Run once with:

```bash
node scripts/backfillEmbeddings.js
```

### Vector search functions in Supabase

Defined in the Supabase SQL editor:

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

---

## AI Search Engine: `/api/ai-search`

The concrete implementation lives in `controllers/aiSearch.controller.js` and is wired from `routes/ai.routes.js`.

### Query analysis

- Before embedding or searching, we call Groq (Llama 3.1) to turn the raw query into structured intent:
  - `preferred_types`: subset of `["apartment","villa","land"]` (“villa” is mapped to the `property` table).
  - `must_be_land`: boolean – true when the user clearly wants land only.
  - `min_bedrooms`: optional minimum bedrooms.
  - `min_land_area`: optional minimum land area (m²).
  - `location_keywords`: important location names explicitly mentioned by the user (e.g. `"Canggu"`, `"Echo Beach"`).
  - `hard_constraints`: free‑form strings like `"has_pool"`.

This is used only as **input to our logic** (never to generate SQL directly).

### Vector search with filters

Given the query embedding and the analysis:

1. Decide which tables to search:
   - `"villa"` in `preferred_types` → search `property`.
   - `"apartment"` → search `apartment`.
   - `"land"` or `must_be_land: true` → search `land` (and, when `must_be_land` is true, skip `apartment`/`property`).
2. Call the Supabase RPC functions for those tables to get top‑K per table.
3. Normalize results into a unified listing shape with at least:
   - `listing_type` (`"apartment" | "property" | "land"`)
   - `custom_uuid`
   - `title`, `zone`, `bed_room`, `bath_room`, `building_area`, `land_area`, `facilities`, `strategic_location`
4. Apply JS‑side filters:
   - `min_bedrooms` → keep listings where `bed_room >= min_bedrooms`.
   - `min_land_area` → parse `land_area` as a number and keep listings where `land_area >= min_land_area`.
5. Apply **location keyword** filter:
   - Build a lowercase “haystack” from `title`, `zone`, and `strategic_location` joined as text.
   - If `location_keywords` is non‑empty:
     - Keep only listings where `haystack` includes at least one keyword (e.g. `"canggu"`).
     - If none match → return `[]` to signal **no strict match** for the requested location (so we don’t confuse “Munggu” with “Canggu”).
6. Return the merged candidate list, capped at the requested `matchCount`.

### Best match explanation

- If we have strict candidates:
  - Call Groq again with a prompt that:
    - Presents the user query and the candidate listings.
    - Asks it to choose a **single best** listing and explain in 1–3 sentences **why** it matches.
    - Forbids inventing geography or distances that aren’t stated in fields (no “10 minutes from Canggu” unless present in `strategic_location`).
    - Allows returning `"best.custom_uuid": null` when none are good.
  - We then:
    - If `custom_uuid` is valid → attach the explanation to that listing.
    - Map this to a **minimal** object for the frontend:

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

### Alternative suggestions

- If strict search returns no candidates (`[]`), we run a **relaxed** search:
  - Same filters, but `location_keywords` are ignored (so “villa in Canggu” can see villas in Pecatu, Sanur, etc.).
- If relaxed search also returns no listings:
  - We return `data: []` and a generic “no close matches” explanation.
- If relaxed search returns listings:
  - We call a separate Groq prompt that:
    - Knows that **no exact match** was found.
    - Decides whether to recommend **one alternative** from the candidates.
    - Returns:

      ```json
      {
        "alternative": {
          "custom_uuid": "PRT3018",
          "explanation": "We couldn't find a villa in Canggu, but this villa in Pecatu..."
        }
      }
      ```

  - We then expose to the frontend:

    ```json
    {
      "success": true,
      "data": [],
      "alternative": {
        "custom_uuid": "...",
        "listing_type": "property",
        "explanation": "..."
      }
    }
    ```

The frontend can use `custom_uuid`/`listing_type` to fetch details and only show the alternative if the user explicitly agrees (“yes please show it”).

---

## Chat orchestration: `/api/ai-search/chat`

`controllers/aiChat.controller.js` implements `aiChatController.chat` which is the **single endpoint** the frontend’s AI Assistant page should use.

### Input shape

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
  messages: ChatMessage[];        // full conversation
  pendingAlternative?: AlternativeRef; // only when waiting for yes/no
}
```

The frontend maintains `messages` and `pendingAlternative` in its own state and sends them on every turn.

### Intent classification (using Groq)

`classifyIntent(lastUserText, pendingAlternative)`:

- System prompt clearly defines intents:
  - `"search"` – explicit property search (“I want a villa in Canggu”, “find land with pool”).
  - `"chitchat"` – greetings/thanks/general Q&A with no explicit search.
  - `"accept_alternative"` – user clearly agrees to see suggested property (yes/ok/show it).
  - `"reject_alternative"` – user clearly declines suggested property (no/nope/not interested).
- Also defines rules:
  - Simple acknowledgements like “ok that’s great”, “thanks” → `chitchat` with `wants_results: false`.
  - Only treat as `"search"` when the latest text clearly expresses a desire to find or get details on a property.
- Input to the model:

```json
{
  "lastUserText": "user's latest message",
  "hasPendingAlternative": true | false
}
```

We then get back:

```json
{
  "intent": "search" | "chitchat" | "accept_alternative" | "reject_alternative",
  "wants_results": true | false,
  "query": "normalized search text"
}
```

We still apply small regex overrides for explicit yes/no when `pendingAlternative` exists, to be robust if the classifier mislabels a clear “yes please show it” or “no I don’t want that”.

### Behavior by intent

1. **Chitchat (`intent === 'chitchat'` or `!wants_results`)**
   - Use a separate **chat system prompt** to keep the model honest:
     - Only knows this database.
     - Must not invent new properties or areas not mentioned by the user.
     - Must not contradict earlier “no exact match” statements.
   - Returns `messages: [assistantMessage]`, `data: []`.

2. **Accept alternative (`accept_alternative`)**
   - Uses `pendingAlternative` as the property ref.
   - Returns:

```json
{
  "success": true,
  "messages": [
    {
      "role": "assistant",
      "content": "Great, here is the villa I mentioned..."
    }
  ],
  "data": [ pendingAlternative ]
}
```

3. **Reject alternative (`reject_alternative`)**
   - Acknowledges rejection and invites a new search; no property is shown.

4. **Search (`intent === 'search'`)**
   - Uses the **latest user sentence** as the query:

```ts
if (intent === 'search' && lastUser?.content) {
  query = lastUser.content;
}
```

   - Calls `callAiSearch(query)` → `/api/ai-search` engine.
   - If engine returns a strict best match (`data` non‑empty):
     - Sends an explanation as chat and returns `data` with minimal `{ custom_uuid, listing_type, explanation }`.
   - If engine returns an `alternative` but no strict `data`:
     - Asks the user if they want to see it, appending “Would you like to see it?” if missing.
     - Returns `alternative` so frontend can store it as `pendingAlternative`.
   - If engine returns neither:
     - Sends a “no good match” message as chat.

This orchestrator endpoint is what the frontend should call on every user message. It decides whether to:

- Just chat,
- Run a search and show a result, or
- Offer an alternative and wait for “yes/no” before showing it.

