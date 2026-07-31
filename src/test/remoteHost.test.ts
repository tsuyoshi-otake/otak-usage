import * as assert from 'assert';
import { remoteHostLabel, unscannedRemoteLabel } from '../remoteHost';

suite('remoteHost', () => {
    test('a workspace-side instance is reading the right host', () => {
        // The default placement: VS Code put the extension on the remote, next
        // to the CLIs, so there is nothing to warn about.
        assert.strictEqual(unscannedRemoteLabel({ remoteName: 'codespaces', local: false }), undefined);
        assert.strictEqual(unscannedRemoteLabel({ remoteName: undefined, local: false }), undefined);
    });

    test('a local instance with no remote in the window is the ordinary case', () => {
        // `extensionKind === UI` on its own is not a problem — it is what every
        // plain local window looks like.
        assert.strictEqual(unscannedRemoteLabel({ remoteName: undefined, local: true }), undefined);
        assert.strictEqual(unscannedRemoteLabel({ remoteName: '', local: true }), undefined);
        assert.strictEqual(unscannedRemoteLabel({ remoteName: '   ', local: true }), undefined);
    });

    test('a local instance in a remote window names the host it is not reading', () => {
        assert.strictEqual(unscannedRemoteLabel({ remoteName: 'codespaces', local: true }), 'GitHub Codespaces');
        assert.strictEqual(unscannedRemoteLabel({ remoteName: 'ssh-remote', local: true }), 'SSH remote');
    });

    test('known remote authorities are named as the products users recognize', () => {
        assert.strictEqual(remoteHostLabel('codespaces'), 'GitHub Codespaces');
        assert.strictEqual(remoteHostLabel('dev-container'), 'Dev Container');
        assert.strictEqual(remoteHostLabel('attached-container'), 'Dev Container');
        assert.strictEqual(remoteHostLabel('wsl'), 'WSL');
        assert.strictEqual(remoteHostLabel('ssh-remote'), 'SSH remote');
        assert.strictEqual(remoteHostLabel('tunnel'), 'Remote Tunnel');
    });

    test('an unrecognized authority is named verbatim rather than dropped', () => {
        // A remote kind this list has not caught up with still deserves a name.
        assert.strictEqual(remoteHostLabel('some-future-remote'), 'some-future-remote');
        assert.strictEqual(remoteHostLabel('  Codespaces  '), 'GitHub Codespaces');
    });
});
