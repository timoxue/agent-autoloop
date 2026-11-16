// What a door answers when it says no. Each maps to one HTTP status in http.ts.
export class InputError extends Error {}
export class AuthError extends Error {}
export class Conflict extends Error {}
export class NotFound extends Error {}

const KEY_HOLDERS: Record<string, string> = {
  owner: "本人",
  worker: "接单程序",
  channel: "通道",
  source: "来源",
  person: "成员",
};
/** What a door of this kind says to a key that isn't one of its own: the same words at the door and where it's decided. */
export const notHolding = (kind: string) => new AuthError(`要${KEY_HOLDERS[kind]}自己的密钥`);
