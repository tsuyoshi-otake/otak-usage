/**
 * Shared detector for invisible and display-spoofing Unicode code points.
 *
 * GlassWorm-style payloads use characters that survive parsing and copy/paste
 * while rendering as nothing. Trojan Source bidirectional controls create the
 * same review gap. Keep this dependency-free so ESLint and CI can run it before
 * TypeScript compilation.
 */

export const INVISIBLE_CATEGORIES = Object.freeze([
    {
        id: 'tag',
        label: 'Unicode tag character',
        start: 0xe0000,
        end: 0xe007f,
        reason: 'Invisible tag characters can carry a hidden payload (GlassWorm).'
    },
    {
        id: 'variation-selector-supplement',
        label: 'variation selector supplement',
        start: 0xe0100,
        end: 0xe01ef,
        reason: 'Variation selectors encode arbitrary bytes invisibly (GlassWorm).'
    },
    {
        id: 'variation-selector',
        label: 'variation selector',
        start: 0xfe00,
        end: 0xfe0f,
        reason: 'Variation selectors encode arbitrary bytes invisibly (GlassWorm).'
    },
    {
        id: 'bidi-control',
        label: 'bidirectional override',
        start: 0x202a,
        end: 0x202e,
        reason: 'Bidi overrides make displayed code differ from parsed code (Trojan Source).'
    },
    {
        id: 'bidi-isolate',
        label: 'bidirectional isolate',
        start: 0x2066,
        end: 0x2069,
        reason: 'Bidi isolates make displayed code differ from parsed code (Trojan Source).'
    },
    {
        id: 'directional-mark',
        label: 'directional mark',
        start: 0x200e,
        end: 0x200f,
        reason: 'Invisible directional marks can reorder displayed text.'
    },
    {
        id: 'arabic-letter-mark',
        label: 'Arabic letter mark',
        start: 0x061c,
        end: 0x061c,
        reason: 'Invisible directional mark; same reordering risk as U+200E/U+200F.'
    },
    {
        id: 'zero-width',
        label: 'zero-width character',
        start: 0x200b,
        end: 0x200d,
        reason: 'Zero-width characters are invisible and can hide or split identifiers.'
    },
    {
        id: 'invisible-operator',
        label: 'invisible operator / word joiner',
        start: 0x2060,
        end: 0x2064,
        reason: 'Invisible formatting characters with no legitimate use in sources.'
    },
    {
        id: 'line-separator',
        label: 'line/paragraph separator',
        start: 0x2028,
        end: 0x2029,
        reason: 'Separators terminate lines for the parser but not for most viewers.'
    },
    {
        id: 'soft-hyphen',
        label: 'soft hyphen',
        start: 0x00ad,
        end: 0x00ad,
        reason: 'Invisible in most renderings; can hide a break inside a token.'
    },
    {
        id: 'mongolian-format',
        label: 'Mongolian format control',
        start: 0x180b,
        end: 0x180e,
        reason: 'Invisible format controls with no legitimate use in sources.'
    },
    {
        id: 'interlinear-annotation',
        label: 'interlinear annotation',
        start: 0xfff9,
        end: 0xfffb,
        reason: 'Annotation controls can hide text from the reader.'
    },
    {
        id: 'byte-order-mark',
        label: 'zero-width no-break space / BOM',
        start: 0xfeff,
        end: 0xfeff,
        reason: 'A BOM anywhere but the first offset is an invisible embedded character.'
    },
    {
        id: 'c1-control',
        label: 'C1 control',
        start: 0x0080,
        end: 0x009f,
        reason: 'Non-printable control characters do not belong in sources.'
    },
    {
        id: 'c0-control',
        label: 'C0 control',
        start: 0x0000,
        end: 0x001f,
        reason: 'Non-printable control characters do not belong in sources.'
    },
    {
        id: 'delete-control',
        label: 'DEL control',
        start: 0x007f,
        end: 0x007f,
        reason: 'Non-printable control character.'
    }
]);

const ALLOWED_C0 = new Set([0x09, 0x0a, 0x0d]);
const EMOJI_BASE_PATTERN = /\p{Extended_Pictographic}/u;
const KEYCAP_BASE_PATTERN = /[0-9#*]/;

function categoryOf(codePoint) {
    for (const category of INVISIBLE_CATEGORIES) {
        if (codePoint >= category.start && codePoint <= category.end) {
            return category;
        }
    }
    return undefined;
}

function isEmojiPresentationBase(codePoint) {
    if (codePoint < 0) {
        return false;
    }
    const char = String.fromCodePoint(codePoint);
    return EMOJI_BASE_PATTERN.test(char) || KEYCAP_BASE_PATTERN.test(char);
}

function isExemptOccurrence(occurrence) {
    const { codePoint, index, previousCodePoint, previousWasSelector, allowEmojiPresentation } = occurrence;

    if (ALLOWED_C0.has(codePoint)) {
        return true;
    }
    if (codePoint === 0xfeff) {
        return index === 0;
    }
    if ((codePoint === 0xfe0e || codePoint === 0xfe0f) && allowEmojiPresentation) {
        return !previousWasSelector && isEmojiPresentationBase(previousCodePoint);
    }
    return false;
}

/**
 * Scan text for invisible or display-spoofing code points.
 *
 * A BOM is allowed only at offset zero. One emoji presentation selector is
 * allowed directly after a pictographic or keycap base; runs remain forbidden
 * because they can encode a hidden byte stream.
 *
 * @param {string} text
 * @param {{ allowEmojiPresentation?: boolean }} [options]
 */
export function scanTextForInvisibleUnicode(text, options = {}) {
    const { allowEmojiPresentation = true } = options;
    const findings = [];

    let index = 0;
    let line = 1;
    let column = 1;
    let previousCodePoint = -1;
    let previousWasSelector = false;

    for (const char of text) {
        const codePoint = char.codePointAt(0) ?? 0;
        const category = categoryOf(codePoint);
        const isPresentationSelector = codePoint === 0xfe0e || codePoint === 0xfe0f;
        const exempt = isExemptOccurrence({
            codePoint,
            index,
            previousCodePoint,
            previousWasSelector,
            allowEmojiPresentation
        });

        if (category && !exempt) {
            findings.push({
                index,
                line,
                column,
                codePoint,
                escape: formatCodePoint(codePoint),
                categoryId: category.id,
                label: category.label,
                reason: category.reason
            });
        }

        if (char === '\n') {
            line += 1;
            column = 1;
        } else {
            column += char.length;
        }
        index += char.length;
        previousCodePoint = codePoint;
        previousWasSelector = isPresentationSelector;
    }

    return findings;
}

export function formatCodePoint(codePoint) {
    return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
}

export function formatFinding(finding, filePath) {
    return `${filePath}:${finding.line}:${finding.column}  ${finding.escape} (${finding.label}) - ${finding.reason}`;
}
