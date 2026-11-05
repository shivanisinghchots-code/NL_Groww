/* Prompt builders shared by the page (inlined at build time) and the Vercel function (api/ai.js).
   One source of truth, so the browser and the server always send the model the same instructions. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SIPPrompts = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const SRC = { reddit: "Reddit", playstore: "Google Play", tradingqna: "TradingQ&A", youtube: "YouTube", appstore: "App Store", consumercomplaints: "ConsumerComplaints" };
  const VERDICTS = ["did_stop_or_pause", "did_reduce_or_skip", "seriously_considering", "not_a_continuation_event"];
  return function makePrompts(D) {
    const CB = D.codebook, M = D.motivation;
    const schemaText = () => Object.entries(CB.enums).map(([k, v]) => `- ${k}: one of ${JSON.stringify(v)}`).concat(
      Object.entries(CB.lists).map(([k, v]) => `- ${k}: list, subset of ${JSON.stringify(v)}`),
      ["- emotion_intensity: 1, 2 or 3", "- unmet_need: string or null", "- evidence: string", "- confidence: \"high\" | \"medium\" | \"low\""]).join("\n");
    const codePrompt = (text, src, plat) => `You are a qualitative researcher coding public Indian investor conversations about SIPs (systematic investment plans in mutual funds) for a product discovery study on why first-time investors stop their SIPs within 12 months.
    Code the item ONLY from what its text says. If something is not stated, use "unknown" / empty list / null. Do not give investment advice. Do not recommend funds or stocks. Texts may be English, Hindi or Hinglish.

    Fields:
    ${schemaText()}

    Coding guide:
    ${CB.guide}
    Reply with only one JSON object containing every field above.

    <item source="${src}"${plat ? ` platform="${plat}"` : ""}>
    ${text.slice(0, 3000)}
    </item>`;
    const verifyPrompt = text => `You verify one coding decision in a study of why investors discontinue their OWN SIP (monthly mutual fund investment). Read the text and answer strictly from it.
    verdict, one of ${JSON.stringify(VERDICTS)}:
    - did_stop_or_pause / did_reduce_or_skip: the WRITER stopped, paused, cancelled, reduced or skipped their own SIP instalments.
    - seriously_considering: the writer says they are thinking of stopping/pausing their own SIP and asks or explains why.
    - not_a_continuation_event: anything else, e.g. a failed one-off payment or refund complaint; units not allotted; a how-to question about cancelling with no stated intent; consolidating or switching funds while continuing; general opinions.
    reasons: list, subset of ${JSON.stringify(CB.lists.triggers)}, ONLY reasons the writer gives for THEIR discontinuation.
    reason_quote: exact contiguous quote (<=30 words) stating the reason, or "".
    Reply with only a JSON object {"verdict":..., "reasons":[...], "reason_quote":...}.

    <item>
    ${text.slice(0, 3000)}
    </item>`;
    const statsBrief = () => JSON.stringify({ stop_reasons_confirmed: D.stop_reasons.slice(0, 6), need_themes: D.needs.map(n => ({ theme: n.theme, pct: n.pct })),
      confusions: D.confusions.slice(0, 5), outside_help: D.outside_help.slice(0, 5), start_motives: M?.motives?.slice(0, 5), expectations: M?.expectation?.slice(0, 4),
      continuers_vs_stoppers: D.compare, market_corr: D.market_corr });
    const askPrompt = (q, hits) => `You answer questions for a product-discovery study about why first-time mutual fund SIP investors in India stop within 12 months.
    Rules:
    - Use ONLY the evidence posts and the aggregate stats below. No outside knowledge about funds, markets or Groww.
    - Any percentage you state must be copied exactly from the aggregate stats. Do not compute or invent numbers. If no stat fits, leave "stat" empty.
    - Cite every finding with post ids from the list below. Never cite an id that is not listed.
    - If the posts do not answer the question, say so and set "evidence_strength" to "insufficient".
    - Never recommend, rate or compare specific funds, stocks or schemes. If asked, set "declined" to true and explain in one sentence that this engine studies behaviour and gives no investment advice.
    Reply with only JSON:
    {"synthesis": "2-3 sentence answer for a product manager",
     "findings": [{"title": "short finding", "detail": "1-2 sentences", "stat": "a percentage copied from the stats with what it measures, or empty", "citations": ["post id", ...]}],
     "voices": ["post ids of the 2-3 most telling posts"],
     "evidence_strength": "strong"|"moderate"|"weak"|"insufficient", "declined": true|false}
    Use 2-4 findings.

    Aggregate stats (weighted % of relevant posts unless stated): ${statsBrief()}

    Evidence posts:
    ${hits.map(e => `[${e.id}] (${SRC[e.src] || e.src}, ${e.date}; action=${e.act}; first_time=${e.ft}${e.need ? "; need=" + e.need : ""}) ${e.x}`).join("\n")}

    Question: ${q}`;
    return { schemaText, codePrompt, verifyPrompt, statsBrief, askPrompt, VERDICTS };
  };
});
