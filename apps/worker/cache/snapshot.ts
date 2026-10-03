/** Compatibility entry point for cache consumers. The codec is platform-free;
 * the KV adapter owns I/O and physical expiration only. */
export { SNAPSHOT_SCHEMA_VERSION, decodeSnapshot, encodeSnapshot } from './snapshot-codec';
export type { Snapshot, SnapshotFreshness, SnapshotDataValidator } from './snapshot-codec';
export { MIN_KV_EXPIRATION_TTL_SECONDS, readSnapshot, writeSnapshot } from '../platform/kv-snapshots';
