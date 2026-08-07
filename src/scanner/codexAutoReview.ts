/**
 * The model slug Codex emits for its automatic code-review turns. It is not a
 * billable OpenAI model id: it appears in neither OpenAI's pricing pages nor
 * LiteLLM's price table, so it carries no price of its own (openai/codex#20981).
 */
export const CODEX_AUTO_REVIEW_MODEL = 'codex-auto-review';

/**
 * The model auto-review turns bill as. OpenAI's usage dashboard reports these
 * requests under GPT-5.4 whenever they ran, so the slug prices flat at gpt-5.4
 * ($2.50 / $0.25 / $15.00 per MTok, long-context rates above 272K).
 *
 * This supersedes the date-based release table ported from ccusage's
 * `codex-auto-review-fallbacks.json`, which billed turns as whichever codex
 * model was current on the turn's own date and so charged everything from
 * 2026-04-23 onward at gpt-5.5's rates — about double what the dashboard shows.
 * getmaxim publishes the same flat gpt-5.4 rate card under the auto-review name.
 */
export const CODEX_AUTO_REVIEW_PRICED_AS = 'gpt-5.4';

/**
 * Resolve `codex-auto-review` to the model it bills as; every other model is
 * returned unchanged.
 *
 * Resolution belongs here, at parse time, rather than at pricing time: the
 * per-turn long-context check needs a real model id to find its 272K threshold,
 * which the bare slug cannot supply.
 */
export function resolveCodexModel(model: string): string {
    return model === CODEX_AUTO_REVIEW_MODEL ? CODEX_AUTO_REVIEW_PRICED_AS : model;
}
