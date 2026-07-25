/**
 * The model slug Codex emits for its automatic code-review turns. It is not a
 * billable OpenAI model id: it appears in neither OpenAI's pricing pages nor
 * LiteLLM's price table, so pricing it directly is impossible (openai/codex#20981).
 */
export const CODEX_AUTO_REVIEW_MODEL = 'codex-auto-review';

/** Used when a line predates the table or carries an unusable timestamp. */
const OLDEST_MODEL = 'gpt-5';

/**
 * Release dates of the codex model that auto-review ran on, newest first. A
 * line dated on or after an entry prices as that model.
 *
 * Ported from ccusage's `codex-auto-review-fallbacks.json`, which sources the
 * dates from a models.dev snapshot; robinebers/openusage carries the same table.
 * Third-party cost calculators that publish a flat price for the slug instead
 * are unreliable — getmaxim's row is gpt-5.4's rate card republished under the
 * auto-review name, and routin.ai disagrees with it entirely.
 *
 * These figures are therefore an estimate, not an OpenAI-published rate.
 */
export const CODEX_AUTO_REVIEW_FALLBACKS: ReadonlyArray<{ releasedOn: string; model: string }> = [
    { releasedOn: '2026-04-23', model: 'gpt-5.5' },
    { releasedOn: '2026-03-05', model: 'gpt-5.4' },
    { releasedOn: '2026-02-05', model: 'gpt-5.3-codex' },
    { releasedOn: '2025-12-11', model: 'gpt-5.2-codex' },
    { releasedOn: '2025-11-13', model: 'gpt-5.1-codex' },
    { releasedOn: '2025-09-15', model: 'gpt-5-codex' },
    { releasedOn: '2025-08-07', model: OLDEST_MODEL },
];

/**
 * The YYYY-MM-DD prefix of an ISO timestamp, or undefined if it is not one.
 * Deliberately the literal prefix rather than a parsed local date: rollout
 * timestamps are UTC, and converting would shift a line across a table boundary
 * whenever the local offset happens to straddle midnight.
 */
function isoDate(timestamp: unknown): string | undefined {
    if (typeof timestamp !== 'string' || timestamp.length < 10) {
        return undefined;
    }
    const date = timestamp.slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined;
}

/**
 * Resolve `codex-auto-review` to the codex model that was current on the line's
 * own date; every other model is returned unchanged.
 *
 * Resolution belongs here, at parse time, rather than at pricing time:
 * `summarize()` prices a whole month's usage with today's date, so a month
 * containing a transition — both 2026-03-05 and 2026-04-23 fall mid-month —
 * would bill its earlier days at the later model's rate.
 */
export function resolveCodexModel(model: string, timestamp: unknown): string {
    if (model !== CODEX_AUTO_REVIEW_MODEL) {
        return model;
    }
    const date = isoDate(timestamp);
    if (!date) {
        return OLDEST_MODEL;
    }
    return CODEX_AUTO_REVIEW_FALLBACKS.find((f) => date >= f.releasedOn)?.model ?? OLDEST_MODEL;
}
