import OpenAI from 'openai';
import { bytesToBase64 } from '../base64';
import { normalizeReceiptImage } from './image';
import { LINE_ITEM_PROMPT } from './line-items-prompt';
import { buildReceiptUserPrompt, RECEIPT_SYSTEM_PROMPT } from './prompt';
import { RECEIPT_RESPONSE_JSON_SCHEMA } from './response-schema';
import { ReceiptSchema } from './zod';

/**
 * Reads a receipt photo into structured fields with a vision model.
 *
 * The API key is an argument and the client is built per call rather than once
 * at module scope. A module-scope client would need a global
 * `cloudflare:workers` env import, which cannot be swapped in a test and turns
 * a missing key into a cold-start failure of the whole Worker.
 */

/**
 * Receipt analysis goes through OpenRouter, not the OpenAI API.
 *
 * This is not a preference, it is the deployed configuration: production has
 * scored every receipt with `qwen/qwen3-vl-32b-instruct` via OpenRouter since
 * launch. The model is load-bearing in a way that is easy to miss — the point
 * award is `floor(BASE_POINT_PER_RECEIPT * qualityRate / 100)`, so whatever
 * `qualityRate` the model returns *is* the user's payout. Swapping the model
 * silently re-prices every scan and shifts the accept/reject boundary, which
 * makes it a product decision rather than an implementation detail.
 *
 * The prompt below was tuned against this model. Change one and you have to
 * re-validate the other against real receipts.
 */
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const VISION_MODEL = 'qwen/qwen3-vl-32b-instruct';

/** Zero temperature: the same photo must score the same way twice. */
const TEMPERATURE = 0;

export const ReceiptProcessor = {
  normalizeImage: normalizeReceiptImage,

  async process(apiKey: string, imageBytesArray: Uint8Array[], country: string) {
    const openai = new OpenAI({ apiKey, baseURL: OPENROUTER_BASE_URL });
    const base64Images = imageBytesArray.map(bytesToBase64);

    try {
      const completion = await openai.chat.completions.create({
        model: VISION_MODEL,
        temperature: TEMPERATURE,
        messages: [
          // Composed rather than merged: `RECEIPT_SYSTEM_PROMPT` decides whether
          // a receipt earns points and is calibrated against real submissions,
          // so a line-item change must not be able to edit it by accident.
          { role: 'system', content: `${RECEIPT_SYSTEM_PROMPT}\n${LINE_ITEM_PROMPT}` },
          {
            role: 'user',
            content: [
              { type: 'text', text: buildReceiptUserPrompt(country) },
              ...base64Images.map((base64Image) => ({
                type: 'image_url' as const,
                image_url: { url: `data:image/jpeg;base64,${base64Image}`, detail: 'auto' as const },
              })),
            ],
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'receipt_analysis',
            strict: true,
            schema: RECEIPT_RESPONSE_JSON_SCHEMA,
          },
        },
      });

      const content = completion.choices[0]?.message.content;

      if (!content) {
        throw new Error('Receipt analysis returned no content');
      }

      // Parsed a second time against zod: structured outputs guarantees the
      // shape, not that `countryCode` is two letters or `qualityRate` is in range.
      return ReceiptSchema.parse(JSON.parse(content));
    } catch (error) {
      if (error instanceof OpenAI.APIError) {
        throw new Error(`OpenAI API error: ${error.message} (${error.status})`);
      }
      throw error;
    }
  },
};
