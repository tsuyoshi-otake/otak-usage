import * as assert from 'assert';
import * as path from 'path';
import { pathToFileURL } from 'url';

interface InvisibleUnicodeFinding {
    index: number;
    line: number;
    column: number;
    codePoint: number;
    escape: string;
    categoryId: string;
    label: string;
    reason: string;
}

type ScanFn = (text: string, options?: { allowEmojiPresentation?: boolean }) => InvisibleUnicodeFinding[];

let scanTextForInvisibleUnicode: ScanFn;
let formatFinding: (finding: InvisibleUnicodeFinding, filePath: string) => string;

const cp = (...codePoints: number[]): string => String.fromCodePoint(...codePoints);

const ZERO_WIDTH_SPACE = 0x200b;
const VARIATION_SELECTOR_16 = 0xfe0f;
const BYTE_ORDER_MARK = 0xfeff;
const CHECK_MARK = 0x2705;
const GRINNING_FACE = 0x1f600;
const COMBINING_KEYCAP = 0x20e3;

suite('Invisible Unicode detector (GlassWorm)', () => {
    suiteSetup(async () => {
        const moduleSpecifier = pathToFileURL(
            path.resolve(__dirname, '../..', 'scripts/lib/invisible-unicode.mjs')
        ).href;
        const module = await import(moduleSpecifier);
        scanTextForInvisibleUnicode = module.scanTextForInvisibleUnicode;
        formatFinding = module.formatFinding;
    });

    test('accepts ordinary and visible Unicode text', () => {
        const source = '{ "status": "利用状況", "ar": "الاستخدام" }\n\t';
        assert.deepStrictEqual(scanTextForInvisibleUnicode(source), []);
    });

    test('detects GlassWorm tag and variation-selector payloads', () => {
        const tagFindings = scanTextForInvisibleUnicode(`const a = 1;${cp(0xe0041)}`);
        assert.strictEqual(tagFindings[0].categoryId, 'tag');
        assert.strictEqual(tagFindings[0].escape, 'U+E0041');

        const selectorFindings = scanTextForInvisibleUnicode(cp(0xe0100, 0xe0101, 0xe0102));
        assert.strictEqual(selectorFindings.length, 3);
        assert.ok(selectorFindings.every(f => f.categoryId === 'variation-selector-supplement'));
    });

    test('detects zero-width, bidi, separators, and control characters', () => {
        const cases: Array<[number, string]> = [
            [0x200b, 'zero-width'],
            [0x200d, 'zero-width'],
            [0x202e, 'bidi-control'],
            [0x2066, 'bidi-isolate'],
            [0x200e, 'directional-mark'],
            [0x061c, 'arabic-letter-mark'],
            [0x2060, 'invisible-operator'],
            [0x2028, 'line-separator'],
            [0x00ad, 'soft-hyphen'],
            [0x180e, 'mongolian-format'],
            [0xfff9, 'interlinear-annotation'],
            [0x0085, 'c1-control'],
            [0x0001, 'c0-control'],
            [0x007f, 'delete-control']
        ];

        for (const [codePoint, expectedCategory] of cases) {
            const findings = scanTextForInvisibleUnicode(`x${cp(codePoint)}y`);
            assert.strictEqual(findings.length, 1, expectedCategory);
            assert.strictEqual(findings[0].categoryId, expectedCategory);
        }
    });

    test('allows tab, LF, CR, and a BOM only at offset zero', () => {
        assert.deepStrictEqual(scanTextForInvisibleUnicode('a\tb\r\nc'), []);
        assert.deepStrictEqual(scanTextForInvisibleUnicode(`${cp(BYTE_ORDER_MARK)}const a = 1;`), []);
        assert.strictEqual(scanTextForInvisibleUnicode(`a${cp(BYTE_ORDER_MARK)}b`).length, 1);
    });

    test('allows legitimate emoji presentation without allowing selector runs', () => {
        assert.deepStrictEqual(scanTextForInvisibleUnicode(`- ${cp(CHECK_MARK, VARIATION_SELECTOR_16)} done`), []);
        assert.deepStrictEqual(scanTextForInvisibleUnicode(`1${cp(VARIATION_SELECTOR_16, COMBINING_KEYCAP)}`), []);
        assert.strictEqual(scanTextForInvisibleUnicode(`token${cp(VARIATION_SELECTOR_16)}`).length, 1);

        const run = scanTextForInvisibleUnicode(
            cp(CHECK_MARK, VARIATION_SELECTOR_16, VARIATION_SELECTOR_16, VARIATION_SELECTOR_16)
        );
        assert.strictEqual(run.length, 2);
        assert.strictEqual(
            scanTextForInvisibleUnicode(cp(CHECK_MARK, VARIATION_SELECTOR_16), { allowEmojiPresentation: false }).length,
            1
        );
    });

    test('reports editor-compatible UTF-16 locations and clickable output', () => {
        const [finding] = scanTextForInvisibleUnicode(`line one\n${cp(GRINNING_FACE, ZERO_WIDTH_SPACE)}`);
        assert.strictEqual(finding.line, 2);
        assert.strictEqual(finding.column, 3);

        const formatted = formatFinding(finding, 'src/extension.ts');
        assert.ok(formatted.startsWith('src/extension.ts:2:3'), formatted);
        assert.ok(formatted.includes('U+200B'), formatted);
    });
});
