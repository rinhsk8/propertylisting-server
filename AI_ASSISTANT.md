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
