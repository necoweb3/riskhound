import Link from "next/link";
import { HomeSearch } from "@/components/HomeSearch";

/**
 * A 404 here is usually a mistyped or truncated contract address, so the
 * search box is the answer rather than a decoration.
 */
export default function NotFound() {
  return (
    <div className="rk-notfound">
      <span className="rk-eyebrow">404</span>
      <h1>That page does not exist</h1>
      <p className="rk-lead">
        If you were opening a token report, the address may be incomplete. A contract address is
        <code> 0x</code> followed by 40 hex characters. Paste the full one below.
      </p>

      <div className="rk-notfound__search">
        <HomeSearch />
      </div>

      <div className="rk-notfound__links">
        <Link href="/feed">Discover tokens</Link>
        <Link href="/scan">Check a contract</Link>
        <Link href="/wallets">Creators</Link>
        <Link href="/bridge-watch">Bridge watch</Link>
        <Link href="/methodology">How it works</Link>
      </div>
    </div>
  );
}
