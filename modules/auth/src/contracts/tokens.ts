/** tvc_ is the recovery case handle. */
export type OpaqueTokenPrefix = 'tvp_' | 'tva_' | 'tvr_' | 'tvc_';

export interface OpaqueTokenCodec {
  issue(prefix: OpaqueTokenPrefix): { readonly token: string; readonly hash: Buffer };
  /** Returns undefined for any malformed value, without throwing. */
  hash(prefix: OpaqueTokenPrefix, candidate: unknown): Buffer | undefined;
}
