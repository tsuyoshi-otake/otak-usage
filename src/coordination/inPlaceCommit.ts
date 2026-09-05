/**
 * In-place CLI files (settings.json, config.toml, hooks.json) cannot be named
 * by lease identity. A commit is therefore allowed only when this window still
 * owns the current fence — or when the caller is an explicit user command
 * (#19), which opts out of the fence.
 *
 * `isCurrent` missing means there is no shared lock (each window is on its
 * own). Then automatic commits follow `isLeader`.
 */
export async function allowInPlaceCommit(opts: {
    requireFence: boolean;
    isLeader: boolean;
    isCurrent?: () => Promise<boolean>;
}): Promise<boolean> {
    if (!opts.requireFence) {
        return true;
    }
    if (!opts.isCurrent) {
        return opts.isLeader;
    }
    return opts.isCurrent();
}
