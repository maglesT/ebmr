/**
 * Pools of kernel test databases that can be ended right before a forced DROP DATABASE without racing it. This is the
 * kernel's own copy of the test-kit's openPool/endPool (packages/test-kit/src/db.ts): the kernel imports nothing else
 * in the repository, and the Phase 2 plan leaves the kernel's test/support as it is.
 *
 * pg-pool's end() resolves as soon as it has asked its idle clients to end. Each client has then written its Terminate
 * message, but its backend may not have read it yet. A DROP DATABASE ... WITH (FORCE) run at that moment terminates the
 * backend (FATAL 57P01). The client, still ending, receives that while idle, the pool re-emits it as an 'error' event,
 * and with no listener Vitest reports an unhandled error that fails the run although every test passed.
 */
import pg from 'pg';

/** A pool that endPool() ends; it follows every connection it opens until that connection's socket has closed. */
class FollowedPool extends pg.Pool {
  /** One promise per connection still open, settled once its socket has closed. */
  readonly #open = new Set<Promise<void>>();

  constructor(config: pg.PoolConfig) {
    super(config);
    this.on('connect', (client) => {
      const closed = new Promise<void>((resolve) => {
        client.once('end', () => {
          this.#open.delete(closed);
          resolve();
        });
      });
      this.#open.add(closed);
    });
  }

  /** Refused: pg-pool's own end() resolves before the backends have exited; endPool() ends this pool. */
  override end(): never {
    throw new Error('a pool made by openPool() is ended with endPool(): pg-pool\'s end() resolves before its backends have exited, so a forced drop after it can end them under the pool (FATAL 57P01)');
  }

  /** pg-pool's end(), then the close of the socket of every connection still open. */
  static async endAndWait(pool: FollowedPool): Promise<void> {
    await pool.#endPool();
    await Promise.all([...pool.#open]);
  }

  #endPool(): Promise<void> {
    return super.end();
  }
}

/** A pool whose connections endPool() waits for. Its own end() refuses, so it cannot be ended the racy way. */
export function openPool(config: pg.PoolConfig): pg.Pool {
  return new FollowedPool(config);
}

/**
 * Ends a pool made by openPool and resolves once the socket of every connection the pool opened has closed, including
 * a client pg-pool has already let go and that is still ending (its idle timeout, 10 s by default, or an error while
 * idle, took it off the pool's lists, so pg-pool's own end() no longer sees it).
 *
 * A connection pg ends cleanly (the usual case: an idle client sends its Terminate message) is closed by PostgreSQL
 * only when its backend process exits, so once its socket has closed that backend is gone and a drop that follows
 * cannot reach it. pg closes the socket itself instead when the connection is already broken or still has a query
 * running; that backend may outlive the wait (a running query ends when the forced drop terminates it), but a closed
 * socket receives nothing, so the drop cannot raise an error in the client. Nothing is swallowed: an error a connection
 * reports while it closes still reaches the pool, which has no listener here.
 */
export async function endPool(pool: pg.Pool): Promise<void> {
  if (!(pool instanceof FollowedPool)) throw new Error('endPool() waits only for pools made by openPool(); the connections of any other pool cannot be followed');
  await FollowedPool.endAndWait(pool);
}

/** `adminUrl` with its database part replaced by `database`, and its user by `user` when given. */
export function urlOn(adminUrl: string, database: string, user?: { name: string; password: string }): string {
  const url = new URL(adminUrl);
  url.pathname = `/${encodeURIComponent(database)}`;
  if (user) {
    url.username = user.name;
    url.password = user.password;
  }
  return url.toString();
}
