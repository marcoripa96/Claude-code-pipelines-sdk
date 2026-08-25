# Storage is a pluggable adapter, with bun:sqlite as the default

Run state and Claude transcripts are written through a write-only `StorageAdapter`
interface rather than to a storage layer the SDK owns. Consumers that already have a
database — the task application this SDK is built to serve — implement the adapter
against it instead of running a second store alongside their own. Reads are not part of
the interface: it is the consumer's database, queried with the consumer's own SQL.

Storage is history, not the live view. Because the SDK is a library, the application
that wants to watch a run is the same process that runs it, so live progress comes from
subscribing to events in memory. The store is written for what someone wants to inspect
afterwards.

## Consequences

Retention is the adapter's business; the SDK never deletes. The default `bun:sqlite`
adapter keeps the bun-only dependency contained to one swappable implementation rather
than to the SDK as a whole. The opt-in cache needs read-your-writes and so lives behind
its own small `CacheAdapter`, leaving `StorageAdapter` genuinely write-only.
