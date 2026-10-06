import OpenAI from 'openai';
import { EXTRACTION_SCHEMA } from './schema.js';
import { SYSTEM_PROMPT } from './prompt.js';
import { HttpError } from './errors.js';

// Returns extractPage(userPrompt) -> raw { page_type, fields, records } from the model.
// Structured outputs in strict mode guarantee the JSON matches EXTRACTION_SCHEMA.
export function createOpenAIExtractor({ apiKey, model }) {
  // Long tables mean long answers, so allow more than the usual minute.
  const client = new OpenAI({ apiKey, timeout: 120_000, maxRetries: 1 });

  return async function extractPage(userPrompt) {
    let completion;
    try {
      completion = await client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'page_records', strict: true, schema: EXTRACTION_SCHEMA },
        },
      });
    } catch (error) {
      if (error instanceof OpenAI.APIError) throw new HttpError(502, describeOpenAIError(error));
      throw error;
    }

    const message = completion.choices[0]?.message;
    if (message?.refusal) throw new HttpError(422, `The model declined this page: ${message.refusal}`);
    try {
      return JSON.parse(message?.content ?? '');
    } catch {
      throw new HttpError(502, 'The model returned an unreadable answer. Try again.');
    }
  };
}

function describeOpenAIError(error) {
  if (error.status === 401) return 'OpenAI rejected the API key. Check OPENAI_API_KEY on the server.';
  if (error.status === 429) return 'OpenAI rate limit or quota reached. Try again shortly.';
  if (error.status === 404) return 'The OpenAI model was not found. Check OPENAI_MODEL on the server.';
  return `OpenAI request failed${error.status ? ` (${error.status})` : ''}. Try again.`;
}
