import { describe, expect, it } from "vitest";
import {
  getArcProtocolContract,
  getObservedArcMainnetContract,
  isOfficialArcProtocolContract,
} from "./arc-protocols.js";

describe("Arc protocol registry", () => {
  it("recognizes the documented Arc Testnet CCTP messenger", () => {
    const contract = getArcProtocolContract("0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa");
    expect(contract?.key).toBe("cctp_token_messenger_v2");
    expect(contract?.environment).toBe("arc_testnet");
    expect(isOfficialArcProtocolContract(contract!.address)).toBe(true);
  });

  it("does not promote a community-reported address to official", () => {
    expect(isOfficialArcProtocolContract("0x81d40f21f12a8f0e3252bccb954d722d4c464b64")).toBe(false);
    expect(
      getObservedArcMainnetContract("0x81d40f21f12a8f0e3252bccb954d722d4c464b64")
        ?.environment
    ).toBe("arc_unannounced_mainnet");
  });
});
