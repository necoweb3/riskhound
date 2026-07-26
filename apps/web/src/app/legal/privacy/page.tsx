import { redirect } from "next/navigation";

/** Folded into the single policy page. Kept so existing links still land. */
export default function PrivacyPage() {
  redirect("/legal/terms#privacy");
}
