# The SDK targets bun, not Node

The library uses `bun:sqlite` for the default storage adapter and `Bun.$` for command
steps, so consumers run it under bun. `node:sqlite` would have kept both runtimes and
stayed dependency-free, and `better-sqlite3` would have been portable at the cost of a
native module compiled at install time.

Bun was chosen because this SDK exists to run locally against a Claude Code subscription,
in the author's own bun application. Portability would be a cost paid now for a consumer
who may never exist, and storage is behind an adapter, so the bun dependency is contained
to one swappable implementation rather than spread through the SDK.
