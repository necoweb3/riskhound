import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { createWalletChallenge, verifyWalletChallenge } from "./auth.js";

describe("wallet authentication", () => {
  it("accepts the matching wallet signature and rejects a changed message", async () => {
    const account = privateKeyToAccount("0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    const challenge = createWalletChallenge(account.address);
    const signature = await account.signMessage({ message: challenge.message });
    const valid = await verifyWalletChallenge({ ...challenge, signature });
    expect(valid?.address).toBe(account.address.toLowerCase());
    const invalid = await verifyWalletChallenge({ ...challenge, message: `${challenge.message}!`, signature });
    expect(invalid).toBeNull();
  });
});
