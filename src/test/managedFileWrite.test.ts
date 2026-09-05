import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeTextFileIfChanged } from '../coordination/atomicFile';
import { allowInPlaceCommit } from '../coordination/inPlaceCommit';

suite('managed provider file commits', () => {
    test('replaces through a sibling temp file that does not remain after rename', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-usage-atomic-'));
        const file = path.join(dir, 'settings.json');
        fs.writeFileSync(file, '{"keep":true}');

        const changed = await writeTextFileIfChanged(file, 'window-a', '{"keep":true}', '{"keep":true,"env":{}}');
        assert.strictEqual(changed, true);
        assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"keep":true,"env":{}}');
        const leftovers = fs.readdirSync(dir).filter(name => name.includes('.tmp'));
        assert.deepStrictEqual(leftovers, []);

        assert.strictEqual(await writeTextFileIfChanged(file, 'window-a', '{"keep":true,"env":{}}', '{"keep":true,"env":{}}'), false);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('automatic sync refuses a commit after the fence is no longer current', async () => {
        assert.strictEqual(await allowInPlaceCommit({
            requireFence: true,
            isLeader: true,
            isCurrent: async () => false,
        }), false);
        assert.strictEqual(await allowInPlaceCommit({
            requireFence: true,
            isLeader: true,
            isCurrent: async () => true,
        }), true);
    });

    test('an explicit Optimize command may commit without a live fence', async () => {
        assert.strictEqual(await allowInPlaceCommit({
            requireFence: false,
            isLeader: false,
            isCurrent: async () => false,
        }), true);
    });

    test('without a lock, automatic commits follow leadership only', async () => {
        assert.strictEqual(await allowInPlaceCommit({ requireFence: true, isLeader: true }), true);
        assert.strictEqual(await allowInPlaceCommit({ requireFence: true, isLeader: false }), false);
    });
});
