/** Shortens a wallet address for display: `0x1234...cdef`. */
export function concealedAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
