/**
 * Which machine's logs this window actually reads.
 *
 * `extensionKind: ["workspace", "ui"]` puts otak-usage on the remote side of a
 * Codespace, Dev Container, WSL or SSH remote by default — next to the CLIs
 * whose logs it reads. An installation that exists only on the local side falls
 * back to the `ui` kind instead, and then the status bar reports `~/.claude`
 * and `~/.codex` on the local machine while the user works inside the remote:
 * the same numbers, silently about the wrong computer.
 *
 * VS Code documents the two signals that separate those cases. `env.remoteName`
 * is defined in *every* extension host — local and remote alike — whenever a
 * remote extension host exists, and `Extension.extensionKind` says which side
 * this particular instance runs on. Neither is enough alone: `remoteName` does
 * not say where this extension landed, and running as a UI extension is the
 * ordinary, correct case in a window with no remote at all.
 */

/** Where this instance of the extension runs, relative to its window. */
export interface HostPlacement {
    /** `vscode.env.remoteName`: undefined when no remote extension host exists. */
    remoteName: string | undefined;
    /** Whether this instance runs in the local (UI) extension host. */
    local: boolean;
}

/**
 * Display name of the remote whose logs this window is *not* reading, or
 * undefined when it reads the right host — either because the extension runs on
 * the remote side, or because there is no remote in the picture at all.
 */
export function unscannedRemoteLabel(placement: HostPlacement): string | undefined {
    if (!placement.local) {
        return undefined;
    }
    const name = placement.remoteName?.trim();
    return name ? remoteHostLabel(name) : undefined;
}

/**
 * Remote authorities are machine names (`codespaces`, `ssh-remote`); a warning
 * should name the product the user recognizes. An authority this list has not
 * caught up with is shown verbatim rather than dropped — naming it imprecisely
 * still beats saying "a remote".
 */
export function remoteHostLabel(remoteName: string): string {
    const name = remoteName.trim();
    switch (name.toLowerCase()) {
        case 'codespaces':
            return 'GitHub Codespaces';
        case 'dev-container':
        case 'attached-container':
            return 'Dev Container';
        case 'wsl':
            return 'WSL';
        case 'ssh-remote':
            return 'SSH remote';
        case 'tunnel':
            return 'Remote Tunnel';
        default:
            return name;
    }
}
