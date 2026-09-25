/**
 * Receipt image storage.
 *
 * The bucket binding is an argument rather than a module-level
 * `import { env } from 'cloudflare:workers'`: a global import cannot be
 * substituted in a test, and it defers "this binding is missing" from build
 * time to the first request that happens to need it.
 */
export const R2 = {
  async saveReceiptImage(bucket: R2Bucket, image: Uint8Array, key?: string): Promise<{ key: string }> {
    const fileKey = key ?? crypto.randomUUID();

    try {
      await bucket.put(fileKey, image, { httpMetadata: { contentType: 'image/jpeg' } });
    } catch (error) {
      console.error('Failed to save receipt image to R2:', error);
      throw error;
    }

    return { key: fileKey };
  },

  async downloadReceiptImage(bucket: R2Bucket, key: string): Promise<Uint8Array> {
    const object = await bucket.get(key);

    if (!object) {
      throw new Error(`Receipt image not found: ${key}`);
    }

    return new Uint8Array(await object.arrayBuffer());
  },
};
