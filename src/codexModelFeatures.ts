/**
 * Codex model-picker settings that otak-usage enables on activation.
 *
 * The Codex desktop picker keeps its available reasoning levels in the
 * `[desktop]` table.  Keep the rewrite text-based so comments, ordering, and
 * settings owned by Codex (or another tool) remain intact.
 */

/** The levels currently accepted by the Codex model controls. */
export const CODEX_ALL_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'ultra', 'max'] as const;

export const CODEX_DESKTOP_TABLE = 'desktop';
export const CODEX_ENABLED_REASONING_EFFORTS_KEY = 'enabled-reasoning-efforts';
export const CODEX_SHOW_ULTRA_IN_MODEL_PICKER_SLIDER_KEY = 'show-ultra-in-model-picker-slider';

function detectEol(text: string): string {
    return text.includes('\r\n') ? '\r\n' : '\n';
}

function isTableHeader(line: string): boolean {
    return /^\s*\[{1,2}/.test(line);
}

function isDesktopHeader(line: string): boolean {
    return /^\s*\[\s*desktop\s*\]\s*(?:#.*)?$/.test(line);
}

function tableEnd(lines: string[], start: number): number {
    for (let i = start + 1; i < lines.length; i++) {
        if (isTableHeader(lines[i])) {
            return i;
        }
    }
    return lines.length;
}

function assignmentRegex(key: string): RegExp {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^(\\s*)${escaped}\\s*=\\s*(.*)$`);
}

function inlineComment(value: string): string {
    // These managed values contain only simple strings/booleans, so a hash
    // after the assignment is an inline TOML comment.
    const match = value.match(/(\s+#.*)$/);
    return match?.[1] ?? '';
}

function quotedValues(value: string): string[] {
    const values: string[] = [];
    const pattern = /(["'])(.*?)\1/g;
    for (const match of value.matchAll(pattern)) {
        if (match[2] !== undefined && !values.includes(match[2])) {
            values.push(match[2]);
        }
    }
    return values;
}

function arrayAssignmentEnd(lines: string[], start: number, sectionEnd: number, firstValue: string): number {
    if (firstValue.includes(']')) {
        return start;
    }
    for (let i = start + 1; i < sectionEnd; i++) {
        if (lines[i].includes(']')) {
            return i;
        }
    }
    return start;
}

function allReasoningEffortsValue(existing: string): string {
    const values = quotedValues(existing);
    for (const effort of CODEX_ALL_REASONING_EFFORTS) {
        if (!values.includes(effort)) {
            values.push(effort);
        }
    }
    return `[${values.map((value) => JSON.stringify(value)).join(', ')}]`;
}

function rewriteDesktopAssignment(
    lines: string[],
    sectionStart: number,
    key: string,
    value: string,
    array: boolean,
): boolean {
    const sectionEnd = tableEnd(lines, sectionStart);
    const matcher = assignmentRegex(key);
    for (let i = sectionStart + 1; i < sectionEnd; i++) {
        const match = lines[i].match(matcher);
        if (!match) {
            continue;
        }
        const end = array ? arrayAssignmentEnd(lines, i, sectionEnd, match[2]) : i;
        const comment = inlineComment(match[2]);
        lines.splice(i, end - i + 1, `${match[1]}${key} = ${value}${comment}`);
        return true;
    }
    lines.splice(sectionEnd, 0, `${key} = ${value}`);
    return true;
}

function appendDesktopTable(lines: string[]): void {
    let insertAt = lines.length;
    while (insertAt > 0 && lines[insertAt - 1] === '') {
        insertAt--;
    }
    const separator = insertAt > 0 ? [''] : [];
    lines.splice(
        insertAt,
        0,
        ...separator,
        `[${CODEX_DESKTOP_TABLE}]`,
        `${CODEX_ENABLED_REASONING_EFFORTS_KEY} = [${CODEX_ALL_REASONING_EFFORTS.map((value) => JSON.stringify(value)).join(', ')}]`,
        `${CODEX_SHOW_ULTRA_IN_MODEL_PICKER_SLIDER_KEY} = true`,
    );
}

/**
 * Ensure that every supported reasoning level is available in the Codex
 * desktop model controls and that Ultra is offered by the slider.
 *
 * Existing values are kept and the supported levels are appended, which means
 * a user-specific value such as `minimal` is not discarded.  The function is
 * idempotent and only touches the exact `[desktop]` table.
 */
export function applyCodexModelFeaturesToml(text: string): string {
    const eol = detectEol(text);
    const lines = text.split(/\r?\n/);
    const sectionStart = lines.findIndex(isDesktopHeader);
    if (sectionStart < 0) {
        appendDesktopTable(lines);
        return lines.join(eol);
    }

    const sectionEnd = tableEnd(lines, sectionStart);
    const effortMatcher = assignmentRegex(CODEX_ENABLED_REASONING_EFFORTS_KEY);
    let currentEfforts = '';
    for (let i = sectionStart + 1; i < sectionEnd; i++) {
        const match = lines[i].match(effortMatcher);
        if (match) {
            const end = arrayAssignmentEnd(lines, i, sectionEnd, match[2]);
            currentEfforts = lines.slice(i, end + 1).join('\n');
            break;
        }
    }
    const efforts = allReasoningEffortsValue(currentEfforts);
    rewriteDesktopAssignment(lines, sectionStart, CODEX_ENABLED_REASONING_EFFORTS_KEY, efforts, true);
    const updatedSectionStart = lines.findIndex(isDesktopHeader);
    rewriteDesktopAssignment(lines, updatedSectionStart, CODEX_SHOW_ULTRA_IN_MODEL_PICKER_SLIDER_KEY, 'true', false);
    return lines.join(eol);
}
