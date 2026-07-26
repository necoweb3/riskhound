import { redirect } from "next/navigation";

/** Folded into the single policy page. Kept so existing links still land. */
export default function DisclaimerPage() {
  redirect("/legal/terms#disclaimer");
}
