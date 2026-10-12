// Synthetic public-address bytes only: 31 bytes of 0x11, followed by 1..8.
// No private keys or real host identities are used. All prefixes deliberately
// collide so browser checks distinguish full-address sorting from link labels.
const prefix = "29d2S7vB453rNYFdR5Ycwt7y9haRT5fwVwL9zTmBhfU";

export const SYNTHETIC_HOST_ADDRESSES = ["s", "m", "q", "k", "r", "n", "p", "o"]
  .map(suffix => prefix + suffix);

export const ASCENDING_HOST_ADDRESSES = ["k", "m", "n", "o", "p", "q", "r", "s"]
  .map(suffix => prefix + suffix);
