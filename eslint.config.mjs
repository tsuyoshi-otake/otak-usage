import typescriptEslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import noInvisibleUnicode from "./eslint-rules/no-invisible-unicode.mjs";

export default [{
    // Flat config adds no implicit ignores beyond node_modules/, so a bare
    // `eslint .` would walk the downloaded VS Code build in .vscode-test/ and
    // exhaust the heap. Keep the scope to sources.
    ignores: [".vscode-test/**", "out/**", "dist/**", "node_modules/**"],
}, {
    files: ["**/*.ts"],
}, {
    plugins: {
        "@typescript-eslint": typescriptEslint,
        otak: {
            rules: {
                "no-invisible-unicode": noInvisibleUnicode,
            },
        },
    },

    languageOptions: {
        parser: tsParser,
        ecmaVersion: 2022,
        sourceType: "module",
    },

    rules: {
        "@typescript-eslint/naming-convention": ["warn", {
            selector: "import",
            format: ["camelCase", "PascalCase"],
        }],

        curly: "warn",
        eqeqeq: "warn",
        "no-throw-literal": "warn",
        semi: "warn",

        // GlassWorm and Trojan Source payloads are invisible during review.
        "otak/no-invisible-unicode": "error",
    },
}];
