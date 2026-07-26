/**
 * Blockscout API client (v1 module API + v2 REST).
 * Used for Arc Testnet (arcscan) and Robinhood Chain explorers.
 */

export interface BlockscoutClientOptions {
  apiUrl: string; // e.g. https://testnet.arcscan.app/api
  v2Url: string; // e.g. https://testnet.arcscan.app/api/v2
  chainKey: string;
  timeoutMs?: number;
}

export class BlockscoutError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: string
  ) {
    super(message);
    this.name = "BlockscoutError";
  }
}

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new BlockscoutError(`HTTP ${res.status} for ${url}`, res.status, text.slice(0, 500));
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new BlockscoutError(`Invalid JSON from ${url}`, res.status, text.slice(0, 200));
    }
  } finally {
    clearTimeout(t);
  }
}

function qs(params: Record<string, string | number | undefined | null>) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  }
  return sp.toString();
}

export interface BsTokenInfo {
  address?: string;
  address_hash?: string;
  name?: string;
  symbol?: string;
  decimals?: string | number;
  total_supply?: string;
  holders?: string | number;
  holders_count?: string | number;
  type?: string;
  exchange_rate?: string | null;
  circulating_market_cap?: string | null;
  icon_url?: string | null;
}

export interface BsAddressInfo {
  hash: string;
  is_contract: boolean;
  name?: string | null;
  implementation_name?: string | null;
  is_verified?: boolean;
  proxy_type?: string | null;
  implementations?: { address: string; name?: string }[];
  creation_tx_hash?: string | null;
  creator_address_hash?: string | null;
  token?: BsTokenInfo | null;
  coin_balance?: string;
}

export interface BsTx {
  hash: string;
  from?: { hash: string } | string;
  to?: { hash: string } | string | null;
  value?: string;
  status?: string;
  timestamp?: string;
  block_number?: number;
  method?: string | null;
  raw_input?: string;
  created_contract?: { hash: string } | null;
  fee?: { value: string };
  gas_used?: string;
  result?: string;
}

export interface BsTokenTransfer {
  transaction_hash: string;
  from: { hash: string } | string;
  to: { hash: string } | string;
  total?: { value: string; decimals?: string; token_id?: string };
  timestamp?: string;
  token?: BsTokenInfo;
  type?: string;
  method?: string;
  block_number?: number;
}

export interface BsLog {
  address: { hash: string } | string;
  data: string;
  topics: string[];
  transaction_hash: string;
  block_number: number;
  index: number;
  decoded?: unknown;
}

export class BlockscoutClient {
  readonly chainKey: string;
  private apiUrl: string;
  private v2Url: string;
  private timeoutMs: number;

  constructor(opts: BlockscoutClientOptions) {
    this.apiUrl = opts.apiUrl.replace(/\/$/, "");
    this.v2Url = opts.v2Url.replace(/\/$/, "");
    this.chainKey = opts.chainKey;
    this.timeoutMs = opts.timeoutMs ?? 25_000;
  }

  /** Health / latest block via v2 stats or blocks */
  async getLatestBlock(): Promise<{ number: number; timestamp?: string } | null> {
    try {
      const data = await fetchJson<{ items?: { height?: number; timestamp?: string }[] }>(
        `${this.v2Url}/blocks?type=block`,
        this.timeoutMs
      );
      const first = data.items?.[0];
      if (first?.height != null) return { number: first.height, timestamp: first.timestamp };
    } catch {
      // fallback module API
    }
    try {
      const data = await fetchJson<{ result?: string; status?: string }>(
        `${this.apiUrl}?${qs({ module: "proxy", action: "eth_blockNumber" })}`,
        this.timeoutMs
      );
      // The module API reports failures as a message string in `result`. Those
      // do not all parse to NaN ("Deprecated" reads as 0xde, "Error! ..." as
      // 0xe), so the whole value has to be a hex quantity before it may pass as
      // a head. Anything else is an unreadable explorer, not a block height.
      const raw = typeof data.result === "string" ? data.result.trim() : "";
      const height = /^(0x)?[0-9a-f]+$/i.test(raw) ? parseInt(raw, 16) : NaN;
      if (Number.isFinite(height)) return { number: height };
    } catch {
      return null;
    }
    return null;
  }

  async getToken(address: string): Promise<BsTokenInfo | null> {
    try {
      return await fetchJson<BsTokenInfo>(
        `${this.v2Url}/tokens/${address}`,
        this.timeoutMs
      );
    } catch (e) {
      if (e instanceof BlockscoutError && e.status === 404) return null;
      throw e;
    }
  }

  async getAddress(address: string): Promise<BsAddressInfo | null> {
    try {
      return await fetchJson<BsAddressInfo>(
        `${this.v2Url}/addresses/${address}`,
        this.timeoutMs
      );
    } catch (e) {
      if (e instanceof BlockscoutError && e.status === 404) return null;
      throw e;
    }
  }

  async getTokenHolders(address: string, params?: Record<string, unknown> | null) {
    // Blockscout v2 pages by echoing the previous response's next_page_params
    // back as the query string. These were previously accepted and dropped,
    // so every caller only ever saw page one. A null page param has to go back
    // as the literal "null" like it does in getTokens: dropping the key makes
    // the explorer serve page one again, which would let getAllTokenHolders
    // collect the same holders repeatedly and overstate concentration.
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params ?? {})) {
      search.set(key, value == null ? "null" : String(value));
    }
    const q = search.toString();
    const url = `${this.v2Url}/tokens/${address}/holders${q ? `?${q}` : ""}`;
    // A holder read that failed is an unknown holder set, not an empty one.
    // Returning [] here would let concentration analysis treat an explorer
    // outage as "nobody holds a large share".
    return fetchJson<{
      items: {
        address: { hash: string } | string;
        value: string;
        token?: BsTokenInfo;
      }[];
      next_page_params?: Record<string, unknown> | null;
    }>(url, this.timeoutMs);
  }

  /**
   * Follow the holder cursor so concentration is computed over the real
   * holder set rather than the first page. Bounded, and it reports whether
   * it reached the end so callers can tell a full list from a truncated one.
   */
  async getAllTokenHolders(address: string, maxPages = 8) {
    const items: { address: { hash: string } | string; value: string; token?: BsTokenInfo }[] = [];
    let cursor: Record<string, unknown> | null = null;
    let complete = false;

    for (let page = 0; page < maxPages; page++) {
      const res = await this.getTokenHolders(address, cursor);
      items.push(...(res.items ?? []));
      cursor = (res.next_page_params ?? null) as Record<string, unknown> | null;
      if (!cursor || !Object.keys(cursor).length || !(res.items ?? []).length) {
        complete = true;
        break;
      }
    }

    return { items, complete };
  }

  // The v2 transfer endpoints page by echoing next_page_params, not by page
  // number, so no pagination argument is accepted here rather than accepting
  // one and dropping it.
  async getTokenTransfers(
    tokenAddress: string
  ): Promise<{ items: BsTokenTransfer[]; next_page_params?: unknown }> {
    // An explorer that cannot answer for this token has told us nothing about
    // its transfer history. "No transfers" is a claim we may only make from a
    // successful response.
    return fetchJson(
      `${this.v2Url}/tokens/${tokenAddress}/transfers`,
      this.timeoutMs
    );
  }

  async getAddressTransactions(
    address: string
  ): Promise<{ items: BsTx[]; next_page_params?: unknown }> {
    return fetchJson(
      `${this.v2Url}/addresses/${address}/transactions`,
      this.timeoutMs
    );
  }

  async getAddressTokenTransfers(
    address: string
  ): Promise<{ items: BsTokenTransfer[] }> {
    return fetchJson(
      `${this.v2Url}/addresses/${address}/token-transfers`,
      this.timeoutMs
    );
  }

  async getTransaction(hash: string): Promise<BsTx | null> {
    try {
      return await fetchJson(`${this.v2Url}/transactions/${hash}`, this.timeoutMs);
    } catch (e) {
      if (e instanceof BlockscoutError && e.status === 404) return null;
      throw e;
    }
  }

  async getContractSource(address: string): Promise<{
    is_verified?: boolean;
    source_code?: string | null;
    abi?: unknown;
    name?: string;
    compiler_version?: string;
    optimization_enabled?: boolean;
    constructor_args?: string | null;
    implementations?: unknown;
  } | null> {
    try {
      // v2 smart-contracts endpoint
      return await fetchJson(`${this.v2Url}/smart-contracts/${address}`, this.timeoutMs);
    } catch (e) {
      if (e instanceof BlockscoutError && e.status === 404) return null;
      throw e;
    }
  }

  /** Recent token contracts (discovery) */
  async getTokens(params?: { type?: string; q?: string; cursor?: Record<string, unknown> | null }) {
    const search = new URLSearchParams({ type: params?.type ?? "ERC-20" });
    if (params?.q) search.set("q", params.q);
    for (const [key, value] of Object.entries(params?.cursor ?? {})) {
      search.set(key, value == null ? "null" : String(value));
    }
    const q = search.toString();
    // Discovery callers record source health from this call. Swallowing the
    // error into an empty page would mark a broken explorer healthy and read
    // downstream as "no tokens exist".
    return fetchJson<{
      items: BsTokenInfo[];
      next_page_params?: Record<string, unknown> | null;
    }>(`${this.v2Url}/tokens?${q}`, this.timeoutMs);
  }

  /** Search */
  async search(query: string) {
    return fetchJson<{
      items: {
        type: string;
        address?: string;
        name?: string;
        symbol?: string;
        url?: string;
      }[];
    }>(`${this.v2Url}/search?${qs({ q: query })}`, this.timeoutMs);
  }

  /** Module API: get contract creation tx */
  async getContractCreation(address: string): Promise<{
    contractAddress: string;
    contractCreator: string;
    txHash: string;
  } | null> {
    // Errors propagate: callers record which explorer sources answered, and a
    // swallowed failure would be filed as "this contract has no known creator".
    const data = await fetchJson<{
      status: string;
      result?: { contractAddress: string; contractCreator: string; txHash: string }[] | string;
      message?: string;
    }>(
      `${this.apiUrl}?${qs({
        module: "contract",
        action: "getcontractcreation",
        contractaddresses: address,
      })}`,
      this.timeoutMs
    );
    // The module API answers "no data" with a plain string in `result`, which
    // index 0 would turn into a single character posing as a row.
    const row = Array.isArray(data.result) ? data.result[0] : undefined;
    if (!row) return null;
    return row;
  }

  /** Module API: token info */
  async getTokenInfoModule(address: string) {
    const data = await fetchJson<{
      status: string;
      result?: Record<string, string> | Record<string, string>[] | string;
    }>(
      `${this.apiUrl}?${qs({ module: "token", action: "getToken", contractaddress: address })}`,
      this.timeoutMs
    );
    if (Array.isArray(data.result)) return data.result[0] ?? null;
    if (typeof data.result !== "object" || data.result === null) return null;
    return data.result;
  }

  addrHash(from: { hash: string } | string | null | undefined): string | null {
    if (!from) return null;
    if (typeof from === "string") return from.toLowerCase();
    return from.hash?.toLowerCase() ?? null;
  }
}
