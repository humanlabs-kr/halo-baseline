/**
 * Turns a rejected promise into a value, so a caller can branch on failure
 * without wrapping half of its body in a `try` block.
 */
export type Result<T, E = Error> = { data: T; error: null } | { data: null; error: E };

export async function tryCatch<T>(promise: Promise<T>): Promise<Result<T>> {
  try {
    return { data: await promise, error: null };
  } catch (error) {
    return { data: null, error: error instanceof Error ? error : new Error(String(error)) };
  }
}
