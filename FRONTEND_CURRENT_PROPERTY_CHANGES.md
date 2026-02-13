# Frontend changes for follow-up property questions (multi-result support)

The backend now returns **1, 3, or 5 properties** depending on query specificity.
Follow-ups work automatically for single results, but for multi-result views the frontend needs to track which properties are displayed so the user can say things like "tell me about the first one".

---

## 1. Add `displayedResults` state

Next to `currentProperty`, add a state to track the multi-result list:

```ts
const [displayedResults, setDisplayedResults] = useState<CurrentPropertyContext[]>([]);
```

---

## 2. Update `loadPropertyResults` to collect full contexts

Your `loadPropertyResults` already builds a `fullContext` for each property but throws it away for multi-result. Collect them and return them:

Change the function signature and body to collect all contexts:

```ts
const loadPropertyResults = async (refs: MinimalListingRef[]): Promise<CurrentPropertyContext[]> => {
  if (!refs.length) return [];

  const fullContexts: CurrentPropertyContext[] = [];

  for (const ref of refs) {
    try {
      const detailRes = await fetch(getDetailUrl(ref), {
        credentials: "include",
      });
      if (!detailRes.ok) continue;
      const detailJson = await detailRes.json();

      const raw =
        Array.isArray(detailJson?.data) && detailJson.data.length > 0
          ? detailJson.data[0]
          : detailJson?.data ?? detailJson;

      // Build FULL context for follow-up questions
      const fullContext: CurrentPropertyContext = {
        custom_uuid: ref.custom_uuid,
        listing_type: ref.listing_type,
        title: raw.title || null,              // ← REQUIRED for title-based selection
        description: raw.description || null,
        price: raw.price,
        bed_room: raw.bed_room,
        bath_room: raw.bath_room,
        land_area: raw.land_area,
        building_area: raw.building_area,
        facilities: raw.facilities,
        zone: raw.zone,
        strategic_location: raw.strategic_location || [],
      };

      fullContexts.push(fullContext);

      if (!raw) continue;

      let imageSrc = "/villa1.png";
      if (Array.isArray(raw.images) && raw.images.length > 0) {
        imageSrc = raw.images[0];
      }

      const price =
        typeof raw.price !== "undefined" && raw.price !== null
          ? raw.price
          : 0;

      const property: PropertyResult = {
        custom_uuid: ref.custom_uuid,
        title: raw.title || "Untitled Property",
        imageSrc,
        price,
        zone: raw.zone,
        bedRoom: raw.bed_room,
        bathRoom: raw.bath_room,
        building_area: raw.building_area,
        explanation: ref.explanation || undefined,
      };

      pushChatItem({
        role: "assistant",
        kind: "property",
        property,
      });
    } catch (error) {
      console.error("Error loading property detail", error);
    }
  }

  return fullContexts;
};
```

---

## 3. Update `handleSubmit` response handler

Replace the current data handling block:

```ts
// OLD:
if (Array.isArray(data.data) && data.data.length > 0) {
  await loadPropertyResults(data.data);
  setPendingAlternative(null);
} else if (data.alternative) {
  // ...
```

With:

```ts
if (Array.isArray(data.data) && data.data.length > 0) {
  const fullContexts = await loadPropertyResults(data.data);
  setPendingAlternative(null);

  if (fullContexts.length === 1) {
    // Single result → direct follow-up context
    setCurrentProperty(fullContexts[0]);
    setDisplayedResults([]);
  } else {
    // Multiple results → no single context yet, track the list
    setCurrentProperty(null);
    setDisplayedResults(fullContexts);
  }
} else if (data.alternative) {
  setPendingAlternative(data.alternative);
  setCurrentProperty(null);
  setDisplayedResults([]);
} else {
  setPendingAlternative(null);
  setCurrentProperty(null);
  setDisplayedResults([]);
  if (data.explanation) {
    const expl: ChatMessage = {
      role: "assistant",
      content: data.explanation,
    };
    setMessages((prev) => [...prev, expl]);
    pushChatItem({
      role: "assistant",
      kind: "text",
      content: expl.content,
    });
  }
}
```

---

## 4. Send `displayedResults` in the request body

In `handleSubmit`, update the body to include `displayedResults` when active:

```ts
const body = {
  messages: nextMessages,
  ...(pendingAlternative ? { pendingAlternative } : {}),
  ...(currentProperty ? { currentProperty } : {}),
  ...(displayedResults.length > 1 ? { displayedResults } : {}),
};
```

The backend uses `displayedResults` to resolve ordinal references like "the first one", "tell me about the second", "the last one".

---

## 5. Persist and restore `displayedResults`

**Save** (in the `useEffect` that writes to `localStorage`):

```ts
const state = {
  messages,
  chatItems,
  pendingAlternative,
  currentProperty,
  displayedResults,
};
window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
```

**Load** (in the `useEffect` that reads from `localStorage`):

```ts
const parsed = JSON.parse(saved) as {
  messages?: ChatMessage[];
  chatItems?: ChatItem[];
  pendingAlternative?: AlternativeSuggestion | null;
  currentProperty?: CurrentPropertyContext | null;
  displayedResults?: CurrentPropertyContext[];
};
// ... existing restores for messages, chatItems, pendingAlternative, currentProperty ...
if (Array.isArray(parsed.displayedResults) && parsed.displayedResults.length > 0) {
  setDisplayedResults(parsed.displayedResults);
}
```

Add `displayedResults` to the `useEffect` dependency array:

```ts
}, [messages, chatItems, pendingAlternative, currentProperty, displayedResults]);
```

---

## 6. Clear on reset

In `handleReset`, add:

```ts
const handleReset = () => {
  setMessages([]);
  setChatItems([]);
  setPendingAlternative(null);
  setCurrentProperty(null);
  setDisplayedResults([]);
  setHasStarted(false);
  nextItemIdRef.current = 1;
  if (typeof window !== "undefined") {
    window.localStorage.removeItem(STORAGE_KEY);
  }
};
```

---

## How follow-ups work with multi-result

| User action | What happens |
|---|---|
| Backend returns 1 result | `currentProperty = result`, follow-ups work immediately |
| Backend returns 3 or 5 results | `currentProperty = null`, `displayedResults = [all results]` |
| User says "tell me about the first one" | Backend resolves "first" → `displayedResults[0]`, answers from that property |
| User says "what's the price of the second?" | Backend resolves "second" → `displayedResults[1]`, answers from that property |
| User says "the last one" | Backend resolves "last" → last item in `displayedResults` |
| User starts a new search | `displayedResults` is cleared, fresh results replace it |

The backend handles ordinal resolution (`first`, `second`, `1st`, `2nd`, `#1`, `top pick`, `last`, etc.) automatically from the `displayedResults` array. No frontend ordinal parsing needed.

---

## Formatting: `---` section markers in assistant messages

When the backend returns multi-result summaries, the assistant message may contain `---` as a **section separator** between the intro, each property paragraph, and the closing call-to-action. For example:

```
Hey, great finds for you! --- My top pick is 'VILLA X' because... --- If you prefer something bigger, 'VILLA Y' is... --- Let me know which one catches your eye!
```

The frontend should split on `---` and render each section as its own paragraph with spacing. Example React implementation:

```tsx
function renderAssistantMessage(content: string) {
  // Split on --- marker and render each section as a separate paragraph
  const sections = content.split(/\s*---\s*/).filter(Boolean);
  return (
    <div className="space-y-3">
      {sections.map((section, i) => (
        <p key={i}>{section.trim()}</p>
      ))}
    </div>
  );
}
```

This gives clean visual spacing between the intro, each property description, and the CTA — without the LLM needing to produce `\n` characters in JSON.

---

## Summary of all state

| State | Purpose |
|---|---|
| `currentProperty` | Single property shown → backend uses for direct follow-ups |
| `displayedResults` | Multiple properties shown → backend resolves ordinals from this list |
| `pendingAlternative` | Alternative suggestion waiting for yes/no |
| `messages` | Chat message history sent to backend |
| `chatItems` | UI-only chat items (text bubbles + property cards) |
