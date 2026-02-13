import dotenv from 'dotenv';

dotenv.config();

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const PORT = process.env.PORT || 3000;
const BACKEND_BASE_URL = process.env.BACKEND_BASE_URL || `http://localhost:${PORT}`;

async function classifyIntent(lastUserText, pendingAlternative) {
  if (!process.env.GROQ_API_KEY) {
    return {
      intent: 'chitchat',
      wants_results: false,
      query: '',
    };
  }

  const systemPrompt = `
You are an intent classifier for a real estate platform named Are Property. You are a chat assistant that helps users find properties in Bali.

You receive:
- lastUserText: the latest message from the user (string)
- hasPendingAlternative: whether there is an outstanding alternative suggestion (boolean)

You must return STRICT JSON with this shape:
{
  "intent": "search" | "chitchat" | "accept_alternative" | "reject_alternative",
  "wants_results": boolean,
  "query": string
}

Definitions:
- "search": the user is asking to find properties (e.g. "I want a villa in Canggu", "find land with pool", "I'm looking for an apartment").
- "chitchat": greetings, thanks, short acknowledgements, or general questions that are not explicit property search requests.
- "accept_alternative": the user is explicitly agreeing to see an alternative property you previously suggested (e.g. "yes please show it", "okay, show me that one").
- "reject_alternative": the user is explicitly declining an alternative (e.g. "no I don't want that", "that's not what I want").

Rules:
- When hasPendingAlternative is true and the user clearly says yes/accept, intent should be "accept_alternative".
- When hasPendingAlternative is true and the user clearly says no/reject, intent should be "reject_alternative".
- "wants_results" is true when the user expects property results to be shown now.
- "query" should be the best single-sentence representation of the user's current search intent, or an empty string for pure chitchat.
- Simple acknowledgements like "ok that's great", "thanks", "awesome" WITHOUT any property keywords should be treated as "chitchat" with wants_results = false.
- Only treat the message as "search" if it clearly expresses a desire to find, look for, or get details on properties.
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
    intent: parsed.intent || 'search',
    wants_results: Boolean(parsed.wants_results),
    query: typeof parsed.query === 'string' ? parsed.query : '',
  };
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
      const { messages, pendingAlternative } = req.body || {};

      if (!Array.isArray(messages) || !messages.length) {
        return res.status(400).json({
          success: false,
          message: 'Field "messages" is required and must be a non-empty array',
        });
      }

      const lastUser = [...messages].reverse().find(m => m.role === 'user');
      const lastText = (lastUser?.content || '').toLowerCase();

      let intent, wants_results, query;
      try {
        const intentInfo = await classifyIntent(lastUser?.content || '', pendingAlternative);
        intent = intentInfo.intent;
        wants_results = intentInfo.wants_results;
        query = intentInfo.query;
      } catch {
        intent = 'chitchat';
        wants_results = false;
        query = '';
      }

      // Hard intent gate: only search path when intent is search and wants_results is true
      if (intent !== 'search' || !wants_results) {
        intent = 'chitchat';
      }

      // Extra safety: simple regex override for yes/no when an alternative is pending,
      // in case the classifier mislabels the intent.
      if (pendingAlternative?.custom_uuid) {
        const positive =
          /\b(yes|yeah|yep|sure|ok|okay|please show|show it|show me)\b/.test(
            lastText
          );
        const negative =
          /\b(nope|no thanks|no thank|dont want|don't want|not interested|no)\b/.test(
            lastText
          );

        if (positive) {
          intent = 'accept_alternative';
          wants_results = true;
        } else if (negative) {
          intent = 'reject_alternative';
          wants_results = false;
        }
      }

      // For generic search intents (not explicit yes/no), always use the latest
      // user sentence as the active search query so we don't get stuck on an
      // old request like "villa in Canggu".
      if (intent === 'search' && lastUser?.content) {
        query = lastUser.content;
      }

      // Only upgrade chitchat to search when BOTH a search verb and a property noun exist.
      const hasSearchVerb = /\b(find|search|looking for|show me|recommend|get)\b/i.test(lastUser?.content || '');
      const hasPropertyNoun = /\b(villa|apartment|land|house|unit)\b/i.test(lastUser?.content || '');
      if (intent === 'chitchat' && hasSearchVerb && hasPropertyNoun) {
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

        const chatSystemPrompt = `
You are a real estate chat assistant for a specific property database.

You must follow these rules:
- You ONLY know about properties in the current backend database; do NOT claim you can search other websites, agencies, or generic "databases".
- You MUST NOT invent specific new properties, locations, or prices. Never say "we have a land in X" or "we have a villa in Y" unless the user has just seen that property as a result.
- You may mention a location name ONLY if it appears in the user's latest message (for example, if the user says "Canggu", you can mention Canggu, but you must not introduce new areas like "Kerobokan" on your own).
- If you have previously told the user there is no exact match for a location (for example, no villa in Canggu), you MUST NOT later say you can find one there.
- Instead, you may remind them that there is no listing in that exact area in the current database and offer to adjust the search (different area, budget, type, etc.).
- Stay honest about limitations. If something is not in the data, say so explicitly.

When the user is not explicitly asking for a search, you can answer questions, clarify their preferences, or suggest how to phrase a property request, but you must not promise specific listings or mention new areas that the user did not mention.
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
            temperature: 0.4,
          }),
        });

        if (!response.ok) {
          throw new Error(`Groq chat error: ${response.status} ${response.statusText}`);
        }

        const json = await response.json();
        const content = json.choices?.[0]?.message?.content || '';

        return res.status(200).json({
          success: true,
          messages: [{ role: 'assistant', content }],
          data: [],
        });
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

      // If we have a strict best match
      if (Array.isArray(searchResult.data) && searchResult.data.length > 0) {
        const best = searchResult.data[0];
        const explanation =
          best.explanation ||
          `I found a property that matches your request: ${best.title || best.custom_uuid}.`;

        return res.status(200).json({
          success: true,
          messages: [{ role: 'assistant', content: explanation }],
          data: [best],
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

