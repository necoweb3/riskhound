"use client";

import { useState } from "react";

type Rule = {
  n: string;
  title: string;
  body: string;
  file: string;
  caption: string;
  code: { t: string; c?: "k" | "s" | "c" | "f" }[][];
};

/**
 * "Enforced in code" is a claim, so the section shows the guard that makes it
 * true. Every snippet below is copied from the file named above it. If one of
 * these guards changes, change it here too, otherwise the section is a lie.
 */
const RULES: Rule[] = [
  {
    n: "01",
    title: "Showable onchain",
    body: "Every risk signal links to the transaction, function or holder record that produced it.",
    file: "packages/analysis/src/scoring.ts",
    caption:
      "A finding that cannot point at a record is not deleted, it is moved to data gaps. Hiding it would be worse than showing it as unproven.",
    code: [
      [{ t: "function", c: "k" }, { t: " " }, { t: "requireEvidence", c: "f" }, { t: "(finding: RiskFinding) {" }],
      [{ t: "  if", c: "k" }, { t: " (finding.evidence.length > " }, { t: "0", c: "k" }, { t: ") " }, { t: "return", c: "k" }, { t: " finding;" }],
      [{ t: "  return", c: "k" }, { t: " {" }],
      [{ t: "    ...finding," }],
      [{ t: "    category: " }, { t: '"data_gaps"', c: "s" }, { t: "," }],
      [{ t: "    status: " }, { t: '"theoretical"', c: "s" }, { t: "," }],
      [{ t: "  };" }],
      [{ t: "}" }],
    ],
  },
  {
    n: "02",
    title: "Missing is not safe",
    body: "An unavailable data source is reported as a gap, never scored as an absence of risk.",
    file: "packages/shared/src/risk.ts",
    caption:
      "With severe gaps and nothing actually observed, the verdict is insufficient_data. There is no path from an empty result to low risk.",
    code: [
      [{ t: "const", c: "k" }, { t: " scored = categories." }, { t: "filter", c: "f" }, { t: "(" }],
      [{ t: "  (c) => c.category !== " }, { t: '"data_gaps"', c: "s" }],
      [{ t: ");" }],
      [{ t: "const", c: "k" }, { t: " nothingObserved = scored." }, { t: "every", c: "f" }, { t: "(" }],
      [{ t: "  (c) => c.findings.length === " }, { t: "0", c: "k" }],
      [{ t: ");" }],
      [{ t: "" }],
      [{ t: "if", c: "k" }, { t: " (dataGapScore >= " }, { t: "80", c: "k" }, { t: " && nothingObserved) {" }],
      [{ t: "  return", c: "k" }, { t: " " }, { t: '"insufficient_data"', c: "s" }, { t: ";" }],
      [{ t: "}" }],
    ],
  },
  {
    n: "03",
    title: "No labels without evidence",
    body: "No automatic scammer labels. A confirmed event requires reviewable proof.",
    file: "packages/analysis/src/crosschain.ts",
    caption:
      "Creator history becomes a warning only after a human confirmed it and the event carries evidence. Activity on another chain is never the warning by itself.",
    code: [
      [{ t: "const", c: "k" }, { t: " relatedRiskEvents = rhRiskEvents." }, { t: "filter", c: "f" }, { t: "(" }],
      [{ t: "  (event) =>" }],
      [{ t: "    event.manualStatus === " }, { t: '"confirmed"', c: "s" }, { t: " &&" }],
      [{ t: "    event.eventClass !== " }, { t: '"insufficient_evidence"', c: "s" }, { t: " &&" }],
      [{ t: "    event.evidence.length > " }, { t: "0", c: "k" }, { t: " &&" }],
      [{ t: "    event.addresses." }, { t: "some", c: "f" }, { t: "((a) => a." }, { t: "toLowerCase", c: "f" }, { t: "() === addr)" }],
      [{ t: ");" }],
    ],
  },
];

export function EnforcedInCode() {
  const [active, setActive] = useState(0);
  const rule = RULES[active];

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const next = e.key === "ArrowDown" ? active + 1 : active - 1;
    setActive((next + RULES.length) % RULES.length);
  }

  return (
    <div className="rk-enforce">
      <div
        className="rk-enforce__list"
        role="tablist"
        aria-label="Rules enforced in code"
        aria-orientation="vertical"
        onKeyDown={onKeyDown}
      >
        {RULES.map((r, i) => (
          <button
            key={r.n}
            type="button"
            role="tab"
            id={`rk-enforce-tab-${r.n}`}
            aria-selected={i === active}
            aria-controls="rk-enforce-panel"
            tabIndex={i === active ? 0 : -1}
            className={`rk-enforce__item${i === active ? " is-active" : ""}`}
            onClick={() => setActive(i)}
            onMouseEnter={() => setActive(i)}
          >
            <span className="rk-enforce__n">{r.n}</span>
            <span>
              <span className="rk-enforce__t">{r.title}</span>
              <span className="rk-enforce__b">{r.body}</span>
            </span>
          </button>
        ))}
      </div>

      <div
        className="rk-enforce__pane"
        role="tabpanel"
        id="rk-enforce-panel"
        aria-labelledby={`rk-enforce-tab-${rule.n}`}
      >
        <div className="rk-enforce__file">
          <b>{rule.file}</b>
          <span>Guard {rule.n} of 03</span>
        </div>
        <pre className="rk-enforce__code" key={rule.n}>
          <code>
            {rule.code.map((line, i) => (
              <span key={i}>
                {line.map((tok, j) => (
                  <span key={j} className={tok.c}>{tok.t}</span>
                ))}
                {"\n"}
              </span>
            ))}
          </code>
        </pre>
        <p className="rk-enforce__caption">{rule.caption}</p>
      </div>
    </div>
  );
}
