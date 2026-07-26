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
 * true. Picking a rule swaps the snippet beside it.
 */
const RULES: Rule[] = [
  {
    n: "01",
    title: "Showable onchain",
    body: "Every risk signal links to the transaction, function or holder record that produced it.",
    file: "analysis/finding.ts",
    caption: "A finding without a reference is dropped before it can reach a report.",
    code: [
      [{ t: "if", c: "k" }, { t: " (!finding.evidence?.length) {" }],
      [{ t: "  throw new", c: "k" }, { t: " Error(" }],
      [{ t: "    `${finding.name} has no evidence`", c: "s" }],
      [{ t: "  );" }],
      [{ t: "}" }],
    ],
  },
  {
    n: "02",
    title: "Missing is not safe",
    body: "An unavailable data source is reported as a gap, never scored as an absence of risk.",
    file: "analysis/score.ts",
    caption: "A gap returns null, not zero. Zero would read as a clean result.",
    code: [
      [{ t: "if", c: "k" }, { t: " (source.status !== " }, { t: '"ok"', c: "s" }, { t: ") {" }],
      [{ t: "  return", c: "k" }, { t: " { score: " }, { t: "null", c: "k" }, { t: ", reason: " }, { t: '"data_gap"', c: "s" }, { t: " };" }],
      [{ t: "  // never 0, a gap is not a clean result", c: "c" }],
      [{ t: "}" }],
    ],
  },
  {
    n: "03",
    title: "No labels without evidence",
    body: "No automatic scammer labels. A confirmed event requires reviewable proof.",
    file: "events/classify.ts",
    caption: "Automatic detection and human review stay separate fields, so neither can silently become the other.",
    code: [
      [{ t: "const", c: "k" }, { t: " confirmed = " }, { t: "Boolean", c: "f" }, { t: "(" }],
      [{ t: "  event.reviewedBy && event.proofTx" }],
      [{ t: ");" }],
      [{ t: "return", c: "k" }, { t: " { detected: event.class, confirmed };" }],
    ],
  },
];

export function EnforcedInCode() {
  const [active, setActive] = useState(0);
  const rule = RULES[active];

  return (
    <div className="rk-enforce">
      <div className="rk-enforce__list" role="tablist" aria-label="Rules enforced in code">
        {RULES.map((r, i) => (
          <button
            key={r.n}
            type="button"
            role="tab"
            aria-selected={i === active}
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

      <div className="rk-enforce__pane">
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
