# Mutation analysis — Issue #43

Mutation score: **90.71%** (166/183 detected).

Statuses: CompileError=98, Killed=166, Survived=17.

| Mutant | File | Status | Classification | High risk | Rationale / evidence |
|---|---|---|---|---:|---|
| 76 | src/aggregator.ts | Survived | equivalent | false | Model rows are unique by provider/model Map key, so a.model can never equal b.model; < and <= are observationally identical. Evidence: src/aggregator.ts row Map invariant and domain summary ordering examples |
| 79 | src/aggregator.ts | Survived | equivalent | false | After the preceding a.model < b.model guard is false, unique model ids imply a.model > b.model; replacing that second guard with true is identical. Evidence: src/aggregator.ts unique row key invariant |
| 80 | src/aggregator.ts | Survived | equivalent | false | For Array.sort, returning -1 for a<b and 0 otherwise induces the same ascending order over unique model ids; the positive branch is redundant for this comparator domain. Evidence: domain examples cover both insertion orders and unique lexical model ids |
| 81 | src/aggregator.ts | Survived | equivalent | false | Equality is excluded by unique model rows, therefore > and >= are identical in the second comparator guard. Evidence: src/aggregator.ts unique row key invariant |
| 82 | src/aggregator.ts | Survived | equivalent | false | When the first < guard is false, substituting <= in the second guard yields false for greater ids and 0; the resulting -1/0 comparator still produces the same stable ascending order over unique ids. Evidence: domain examples cover reversed lexical insertion and unique row ids |
| 96 | src/pricing.ts | Survived | equivalent | false | Removing the exact-order early return falls through to longest-prefix search, which selects the same unique exact key and index. Evidence: defaultPricingOrder exact and dated-prefix examples |
| 98 | src/pricing.ts | Survived | equivalent | false | An empty exact-order branch has the same fallthrough equivalence as mutant 96. Evidence: defaultPricingOrder exact and dated-prefix examples |
| 99 | src/pricing.ts | Survived | equivalent | false | Every built-in pricing key has length greater than one, so initializing bestLen to -1 or +1 admits the same candidates. Evidence: DEFAULT_PRICING_KEYS construction in src/pricing.ts |
| 109 | src/pricing.ts | Survived | equivalent | false | Two distinct equal-length strings cannot both be prefixes of one model; > and >= therefore select the same longest matching key. Evidence: longest-prefix lookup invariant and dated model examples |
| 114 | src/pricing.ts | Survived | equivalent | false | Without base and override pricing, falling through calls withDefaults({}), which returns undefined exactly like the early return. Evidence: unknown-model and incomplete-override examples |
| 118 | src/pricing.ts | Survived | equivalent | false | Removing the no-price block has the same withDefaults({}) fallthrough equivalence as mutant 114. Evidence: unknown-model and incomplete-override examples |
| 122 | src/pricing.ts | Survived | equivalent | false | Removing lookup's exact early return makes longest-prefix lookup select the same exact table entry and revisions. Evidence: exact, scheduled-revision, and dated-prefix examples |
| 123 | src/pricing.ts | Survived | equivalent | false | An empty exact lookup branch has the same longest-prefix fallthrough equivalence as mutant 122. Evidence: exact, scheduled-revision, and dated-prefix examples |
| 124 | src/pricing.ts | Survived | equivalent | false | All pricing table keys have length greater than one, so bestLen -1 and +1 choose the same candidate set. Evidence: DEFAULT_PRICING and override key requirements |
| 130 | src/pricing.ts | Survived | equivalent | false | Distinct equal-length keys cannot both prefix the same model, making > and >= identical for longest-prefix replacement. Evidence: exact and longest-prefix model examples |
| 142 | src/pricing.ts | Survived | equivalent | false | For a missing revision list, the injected string has no from/pricing fields; its comparison is false and resolved pricing remains unchanged just like an empty list. Evidence: override-only effective-day example |
| 164 | src/pricing.ts | Survived | equivalent | false | Both model and key are already required to end in -fast; removing that common suffix cannot change whether the model starts with the key's non-fast prefix. Evidence: dated fast-model lookup example and matches guards |

Stale classification IDs: none.
