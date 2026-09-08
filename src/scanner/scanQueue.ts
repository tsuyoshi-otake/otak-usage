/** One active scan and at most one coalesced refresh, shared by all callers. */
export class ScanQueue {
    private active: Promise<void> | undefined;
    private pendingRefresh: Promise<void> | undefined;

    tick(work: () => Promise<void>): Promise<void> {
        if (this.pendingRefresh) { return this.pendingRefresh; }
        if (this.active) { return this.active; }
        const task = Promise.resolve().then(work);
        this.active = task;
        void task.then(() => this.finish(task), () => this.finish(task));
        return task;
    }

    refresh(work: () => Promise<void>): Promise<void> {
        if (this.pendingRefresh) { return this.pendingRefresh; }
        const task = (async () => {
            // A failed scan still relinquishes ownership to the requested refresh.
            await this.active?.catch(() => undefined);
            await work();
        })();
        this.pendingRefresh = task;
        const finish = () => { if (this.pendingRefresh === task) { this.pendingRefresh = undefined; } };
        void task.then(finish, finish);
        return task;
    }

    private finish(task: Promise<void>): void {
        if (this.active === task) { this.active = undefined; }
    }
}
