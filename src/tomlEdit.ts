import { AST, parseTOML } from 'toml-eslint-parser';

/** Edit only syntax-node ranges; never interpret string contents as TOML. */
export function editToml(text: string, key: string[], value?: string): string {
    const ast = parseTOML(text);
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const equal = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((v, i) => v === b[i]);
    const prefix = (a: readonly unknown[]) => a.length < key.length && a.every((v, i) => v === key[i]);
    let found: AST.TOMLKeyValue | undefined;
    let inline: { node: AST.TOMLInlineTable; path: string[] } | undefined;
    let table: AST.TOMLTable | undefined;
    let features: AST.TOMLTable | undefined;
    const visit = (nodes: AST.TOMLKeyValue[], parent: string[]) => {
        for (const node of nodes) {
            const full = [...parent, ...node.key.keys.map(k => k.type === 'TOMLBare' ? k.name : k.value)];
            if (equal(full, key)) { found = node; }
            if (node.value.type === 'TOMLInlineTable' && prefix(full)) {
                inline = { node: node.value, path: full };
                visit(node.value.body, full);
            }
        }
    };
    for (const node of ast.body[0].body) {
        if (node.type === 'TOMLKeyValue') { visit([node], []); }
        else {
            if (equal(node.resolvedKey, key.slice(0, -1))) { table = node; }
            if (equal(node.resolvedKey, ['features'])) { features = node; }
            visit(node.body, node.resolvedKey as string[]);
        }
    }
    const splice = (start: number, end: number, replacement: string) => text.slice(0, start) + replacement + text.slice(end);
    const lineEnd = (at: number) => { const end = text.indexOf('\n', at); return end < 0 ? text.length : end + 1; };
    const lineStart = (at: number) => text.lastIndexOf('\n', at - 1) + 1;
    let next = text;
    if (found) {
        if (value !== undefined) { next = splice(found.value.range[0], found.value.range[1], value); }
        else if (found.parent.type === 'TOMLInlineTable') {
            const siblings = found.parent.body;
            const i = siblings.indexOf(found);
            const start = i === 0 ? found.range[0] : siblings[i - 1].range[1];
            const end = i === 0 && siblings.length > 1 ? siblings[1].range[0] : found.range[1];
            next = splice(start, end, '');
        } else {
            const start = found.parent.type === 'TOMLTable' && found.parent.body.length === 1 && equal(found.parent.resolvedKey, ['features', 'context_management'])
                ? lineStart(found.parent.range[0]) : lineStart(found.range[0]);
            next = splice(start, lineEnd(found.range[1]), '');
        }
    } else if (value !== undefined) {
        if (inline) {
            const at = inline.node.range[1] - 1;
            next = splice(at, at, `${inline.node.body.length ? ', ' : ''}${key.slice(inline.path.length).join('.')} = ${value}`);
        } else if (key.length === 1) {
            next = `${key[0]} = ${value}${eol}${text}`;
        } else if (table) {
            const at = lineEnd(table.key.range[1]);
            next = splice(at, at, `${at > 0 && text[at - 1] !== '\n' ? eol : ''}${key.at(-1)} = ${value}${eol}`);
        } else {
            const at = features ? lineEnd(features.range[1]) : text.length;
            next = splice(at, at, `${at > 0 && text[at - 1] !== '\n' ? eol : ''}[${key.slice(0, -1).join('.')}]${eol}${key.at(-1)} = ${value}${eol}`);
        }
    }
    // Unsupported structural conflicts must fail before any managed-file commit.
    parseTOML(next);
    return next;
}
